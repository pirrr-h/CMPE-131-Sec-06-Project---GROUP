// Poolr Payment Drainer — Supabase Edge Function
//
// What this function does, in one paragraph:
//   The database queues a row in payment_jobs whenever money needs to move
//   AFTER a trip changes state: transition_trip() queues a 'capture' job
//   for every held payment when a trip completes, and a 'release' job when
//   a trip is cancelled (the trip timers queue releases the same way when
//   they auto-cancel a trip). Until now nothing read that queue, so the
//   money would have sat still. This function is the reader: each run claims
//   the oldest pending jobs (see the claiming note under Safety), performs the Stripe call for each one
//   (capture + pay the driver, or cancel/refund the hold), updates the
//   payments row, and marks the job done. A job whose Stripe call fails
//   stays pending and is retried on the next run; after 5 failed attempts
//   it is marked 'failed' with the error saved, for a human to look at.
//
// How it runs:
//   pg_cron calls it every minute (see Poolr-Drainer-Cron.sql) through
//   pg_net. There is no user involved, so instead of a user login it
//   checks a shared secret header (x-drainer-secret vs the DRAINER_SECRET
//   function secret). Deploy it with --no-verify-jwt (like stripe-webhook)
//   because the cron call carries no Supabase user token; the secret check
//   inside is the gate.
//
// Refund policy on release jobs:
//   A release job carries the database's refund_percent, decided at
//   cancel time (see Poolr-Refund-Policy-Patch.sql): 100 = the rider
//   gets everything back (plain release/refund, below); 1–99 = a
//   distance-based split — capture the fare, refund that percent to
//   the rider and pay the driver the rest as a maintenance share (no
//   platform fee); 0 = the trip was already in progress — capture the
//   fare, no refund, the driver keeps it all. Jobs written before the
//   policy carry NULL, which is treated as 100.
//
// Safety:
//   - Each job is CLAIMED before any Stripe call: one atomic update
//     flips it from 'pending' to 'processing' (stamping claimed_at and
//     bumping attempts) only if it is still 'pending'. Two drainer runs
//     overlapping — pg_cron fires every minute, and a run can outlast
//     that — can both SEE the same pending job, but only one can claim
//     it; the other gets no row back and skips it. A job left in
//     'processing' by a run that died mid-job is returned to 'pending'
//     once its claim is 10 minutes old, so no job is stranded forever.
//   - The Stripe calls below mirror payment-service's capture/release
//     step for step and reuse the SAME idempotency keys
//     (poolr-capture-<payment_id>, poolr-transfer-<payment_id>,
//     poolr-release-<payment_id>, poolr-refund-<payment_id>,
//     poolr-prefund-<payment_id>), so if this
//     drainer and payment-service ever touch the same payment, Stripe
//     still performs the money movement only once.
//   - Jobs whose payment is already in the target state (already captured
//     and paid out, already released or refunded) are marked done without
//     calling Stripe — running the drainer twice is harmless.
//   - State guards are kept: a capture only runs on a completed trip, a
//     release only on a cancelled trip or cancelled/declined request. A
//     job that fails its guard is retried like any other failure and then
//     marked failed — the drainer never forces money to move.
//
// Requires Poolr-Drainer-Patch.sql on the database first (adds the
// attempts counter column to payment_jobs),
// Poolr-Refund-Policy-Patch.sql (adds refund_percent), and
// Poolr-Drainer-Processing-Patch.sql (adds the 'processing' job
// status and the claimed_at column the claiming below relies on).

import { createClient } from "npm:@supabase/supabase-js@2";
import Stripe from "npm:stripe@17.7.0";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const STRIPE_SECRET_KEY = Deno.env.get("STRIPE_SECRET_KEY")!;
const DRAINER_SECRET = Deno.env.get("DRAINER_SECRET")!;

// How many pending jobs one run works through, and how many failed
// attempts a job gets before it is parked as 'failed'.
const BATCH_SIZE = 20;
const MAX_ATTEMPTS = 5;

// How old a 'processing' claim must be before another run treats the
// job as abandoned (its drainer died mid-job) and requeues it. Stripe
// calls take seconds, so 10 minutes is far beyond a live claim.
const STALE_CLAIM_MINUTES = 10;

// On a cancellation where the rider does not get a full refund, the
// fare splits two ways with no platform fee: the rider is refunded the
// job's refund_percent and the driver keeps the rest as a maintenance
// share for the distance already covered toward the ride.

const stripe = new Stripe(STRIPE_SECRET_KEY, {
  apiVersion: "2025-02-24.acacia",
  httpClient: Stripe.createFetchHttpClient(),
});

const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

// PaymentRow: the payments-table fields this function reads. Amounts
// arrive as number or string (Postgres numeric), and the Stripe ids
// are null until the matching Stripe object exists.
type PaymentRow = {
  payment_id: string;
  trip_id: string;
  request_id: string;
  payee_id: string;
  amount_total: number | string;
  platform_fee: number | string | null;
  payment_status: string;
  stripe_payment_intent_id: string | null;
  stripe_transfer_id: string | null;
};

// PaymentJobRow: the payment_jobs fields this function reads — the
// job's identity, what to do, the policy percent stamped on it, and
// its attempts counter.
type PaymentJobRow = {
  job_id: string;
  payment_id: string;
  action: string;
  refund_percent: number | null;
  attempts: number | null;
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

// dollarsToCents: converts a dollar amount from a payments row into the
// integer cents Stripe expects, rejecting non-positive amounts. Same
// helper as payment-service, kept identical on purpose.
function dollarsToCents(value: number | string | null | undefined): number {
  const amount = Number(value);
  if (!Number.isFinite(amount) || amount <= 0) throw new Error("Invalid fare amount.");
  const cents = Math.round(amount * 100);
  if (cents < 50) throw new Error("The payment amount is below Stripe's minimum.");
  return cents;
}

// getPayment: loads one payments row by id, or throws if it is gone.
async function getPayment(paymentId: string) {
  const { data, error } = await admin
    .from("payments")
    .select("*")
    .eq("payment_id", paymentId)
    .single();
  if (error || !data) throw new Error("Payment not found.");
  return data;
}

// captureForJob: performs a 'capture' job's money movement. Mirrors
// payment-service's capturePayment minus the user checks (the drainer is
// a trusted system caller): captures the held PaymentIntent, then
// transfers the fare minus the platform fee to the driver's Connect
// account, then records captured + transfer id on the payments row.
// Safe to run more than once: an already-captured payment with a
// transfer id returns immediately, and the Stripe calls reuse
// payment-service's idempotency keys.
async function captureForJob(payment: PaymentRow) {
  const { data: trip, error: tripError } = await admin
    .from("trips")
    .select("trip_id, creator_id, trip_status")
    .eq("trip_id", payment.trip_id)
    .single();
  if (tripError || !trip) throw new Error("Trip not found.");
  if (trip.trip_status !== "completed") {
    throw new Error("Payment can only be captured after the trip is marked completed.");
  }
  if (payment.payment_status === "captured" && payment.stripe_transfer_id) {
    return { paymentId: payment.payment_id, status: "captured", transferId: payment.stripe_transfer_id };
  }
  if (!payment.stripe_payment_intent_id) throw new Error("Payment has no Stripe PaymentIntent.");

  let intent = await stripe.paymentIntents.retrieve(payment.stripe_payment_intent_id);
  if (intent.status === "requires_capture") {
    intent = await stripe.paymentIntents.capture(intent.id, {}, {
      idempotencyKey: `poolr-capture-${payment.payment_id}`,
    });
  }
  if (intent.status !== "succeeded") {
    throw new Error(`Cannot capture payment in Stripe status ${intent.status}.`);
  }

  // Transfer funds to the driver's Stripe Connect account after capture.
  const { data: driver, error: driverError } = await admin
    .from("users")
    .select("stripe_account_id")
    .eq("user_id", payment.payee_id)
    .single();
  if (driverError || !driver?.stripe_account_id) {
    throw new Error("Driver payout account is missing. Payment captured; payout requires support.");
  }

  const totalCents = dollarsToCents(payment.amount_total);
  const feeCents = Math.min(totalCents, Math.max(0, Math.round(Number(payment.platform_fee ?? 0) * 100)));
  const payoutCents = totalCents - feeCents;
  if (payoutCents <= 0) throw new Error("Calculated driver payout must be positive.");

  const chargeId = typeof intent.latest_charge === "string"
    ? intent.latest_charge
    : intent.latest_charge?.id;
  if (!chargeId) throw new Error("Captured payment has no charge ID.");

  const transfer = await stripe.transfers.create({
    amount: payoutCents,
    currency: "usd",
    destination: driver.stripe_account_id,
    source_transaction: chargeId,
    transfer_group: `poolr_trip_${payment.trip_id}`,
    metadata: { poolr_payment_id: payment.payment_id, poolr_trip_id: payment.trip_id },
  }, { idempotencyKey: `poolr-transfer-${payment.payment_id}` });

  const { error: updateError } = await admin
    .from("payments")
    .update({
      payment_status: "captured",
      payment_intent_status: "succeeded",
      stripe_charge_id: chargeId,
      stripe_transfer_id: transfer.id,
    })
    .eq("payment_id", payment.payment_id);
  if (updateError) {
    console.error("Failed to save captured payment/payout", updateError.message);
    throw new Error("Payment and payout were processed but the database update failed. Retry safely.");
  }

  return { paymentId: payment.payment_id, status: "captured", transferId: transfer.id };
}

// settlePartialOrNone: performs a 'release' job whose rider does NOT
// get a full refund (refundPercent 0–99, stamped by the database's
// distance-based cancellation policy). Mirrors payment-service's
// function of the same name: the hold is captured in full first; then
// the rider is refunded refundPercent of the fare and the driver is
// transferred the remaining (100 - refundPercent)% as a maintenance
// share for the distance already covered — there is no platform fee.
// The payments row ends 'captured' (0%: no refund at all, the driver
// keeps the whole fare) or 'partially_refunded'.
async function settlePartialOrNone(payment: PaymentRow, refundPercent: number) {
  if (!payment.stripe_payment_intent_id) throw new Error("Payment has no Stripe PaymentIntent.");
  const totalCents = dollarsToCents(payment.amount_total);

  let intent = await stripe.paymentIntents.retrieve(payment.stripe_payment_intent_id);
  if (intent.status === "requires_capture") {
    intent = await stripe.paymentIntents.capture(intent.id, {}, {
      idempotencyKey: `poolr-capture-${payment.payment_id}`,
    });
  }
  if (intent.status !== "succeeded") {
    throw new Error(`Cannot settle a cancelled payment in Stripe status ${intent.status}.`);
  }
  const chargeId = typeof intent.latest_charge === "string"
    ? intent.latest_charge
    : intent.latest_charge?.id;
  if (!chargeId) throw new Error("Captured payment has no charge ID.");

  if (payment.payment_status !== "captured") {
    const { error: captureSaveError } = await admin
      .from("payments")
      .update({
        payment_status: "captured",
        payment_intent_status: "succeeded",
        stripe_charge_id: chargeId,
      })
      .eq("payment_id", payment.payment_id);
    if (captureSaveError) throw new Error("Capture succeeded but database update failed. Retry safely.");
  }

  const driverPercent = 100 - refundPercent;

  if (refundPercent > 0) {
    const refund = await stripe.refunds.create({
      payment_intent: payment.stripe_payment_intent_id,
      amount: Math.round(totalCents * refundPercent / 100),
      reason: "requested_by_customer",
      metadata: { poolr_payment_id: payment.payment_id },
    }, { idempotencyKey: `poolr-prefund-${payment.payment_id}` });
    if (refund.status === "failed" || refund.status === "canceled") {
      throw new Error("Stripe could not refund this payment. Contact support.");
    }
  }

  // Pay the driver's maintenance share — everything the rider did not
  // get back — to their connected account.
  const { data: driver, error: driverError } = await admin
    .from("users")
    .select("stripe_account_id")
    .eq("user_id", payment.payee_id)
    .single();
  if (driverError || !driver?.stripe_account_id) {
    throw new Error("Driver payout account is missing. Refund done; driver share requires support.");
  }
  const transfer = await stripe.transfers.create({
    amount: Math.round(totalCents * driverPercent / 100),
    currency: "usd",
    destination: driver.stripe_account_id,
    source_transaction: chargeId,
    transfer_group: `poolr_trip_${payment.trip_id}`,
    metadata: { poolr_payment_id: payment.payment_id, poolr_trip_id: payment.trip_id },
  }, { idempotencyKey: `poolr-transfer-${payment.payment_id}` });

  const settledStatus = refundPercent === 0 ? "captured" : "partially_refunded";
  const { error: finalSaveError } = await admin
    .from("payments")
    .update({
      payment_status: settledStatus,
      stripe_transfer_id: transfer.id,
    })
    .eq("payment_id", payment.payment_id);
  if (finalSaveError) throw new Error("Refund and driver share succeeded but database update failed. Retry safely.");

  return { paymentId: payment.payment_id, status: settledStatus, refundPercent, transferId: transfer.id };
}

// releaseForJob: performs a 'release' job's money movement. Mirrors
// payment-service's releasePayment minus the user checks: a payment that
// was never captured gets its authorization cancelled (a RELEASE — the
// rider's hold simply disappears); a payment that WAS captured (rare on
// this path) is refunded instead. The payments row is set to 'released'
// or 'refunded' to match, which is the only split the DB guard allows.
// A job stamped with refund_percent below 100 settles through
// settlePartialOrNone instead.
async function releaseForJob(payment: PaymentRow, refundPercent = 100) {
  const { data: trip, error: tripError } = await admin
    .from("trips")
    .select("trip_id, creator_id, trip_status")
    .eq("trip_id", payment.trip_id)
    .single();
  if (tripError || !trip) throw new Error("Trip not found.");

  const { data: request, error: requestError } = await admin
    .from("trip_requests")
    .select("request_status")
    .eq("request_id", payment.request_id)
    .single();
  if (requestError || !request) throw new Error("Trip request not found.");

  const isCancelled = trip.trip_status === "cancelled"
    || request.request_status === "cancelled"
    || request.request_status === "declined";
  if (!isCancelled) {
    throw new Error("Payment can only be released when the trip or request is cancelled/declined.");
  }
  if (payment.payment_status === "refunded" || payment.payment_status === "released"
    || payment.payment_status === "partially_refunded") {
    return { paymentId: payment.payment_id, status: payment.payment_status };
  }

  // Policy settlement: anything below a full refund goes through the
  // capture-first path (partial refund + driver share, or no refund).
  if (refundPercent < 100) return settlePartialOrNone(payment, refundPercent);

  // Track whether money was actually captured. A cancelled authorization
  // (never captured) is a RELEASE, not a refund — the database guard
  // rejects held -> refunded.
  let wasCaptured = payment.payment_status === "captured";

  if (wasCaptured) {
    if (!payment.stripe_payment_intent_id) throw new Error("Payment has no Stripe PaymentIntent.");
    const refund = await stripe.refunds.create({
      payment_intent: payment.stripe_payment_intent_id,
      reason: "requested_by_customer",
      metadata: { poolr_payment_id: payment.payment_id },
    }, { idempotencyKey: `poolr-refund-${payment.payment_id}` });
    if (refund.status === "failed" || refund.status === "canceled") {
      throw new Error("Stripe could not refund this payment. Contact support.");
    }
  } else if (payment.stripe_payment_intent_id) {
    const intent = await stripe.paymentIntents.retrieve(payment.stripe_payment_intent_id);
    if (intent.status === "requires_capture" || intent.status === "requires_confirmation"
      || intent.status === "requires_payment_method") {
      await stripe.paymentIntents.cancel(intent.id, {}, {
        idempotencyKey: `poolr-release-${payment.payment_id}`,
      });
    } else if (intent.status === "succeeded") {
      wasCaptured = true;
      await stripe.refunds.create({
        payment_intent: intent.id,
        reason: "requested_by_customer",
        metadata: { poolr_payment_id: payment.payment_id },
      }, { idempotencyKey: `poolr-refund-${payment.payment_id}` });
    }
    // If the intent is already 'canceled' (e.g. the hold expired on its
    // own), no Stripe call is needed — the row update below closes out
    // the ghost hold.
  }

  const finalStatus = wasCaptured ? "refunded" : "released";
  const { error: updateError } = await admin
    .from("payments")
    .update({
      payment_status: finalStatus,
      payment_intent_status: wasCaptured ? "succeeded" : "canceled",
    })
    .eq("payment_id", payment.payment_id);
  if (updateError) throw new Error("Stripe release/refund succeeded but database update failed. Retry safely.");

  return { paymentId: payment.payment_id, status: finalStatus };
}

// reclaimStaleJobs: returns jobs stuck in 'processing' to 'pending'
// when their claim is older than STALE_CLAIM_MINUTES — the run that
// claimed such a job died before finishing it (deploy, crash, timeout),
// and without this the job would sit in 'processing' forever. Attempts
// are not bumped here; the next claim bumps them. Live claims are far
// younger than the cutoff, so a job another run is actively working is
// never touched.
async function reclaimStaleJobs() {
  const cutoff = new Date(Date.now() - STALE_CLAIM_MINUTES * 60_000).toISOString();
  const { error } = await admin
    .from("payment_jobs")
    .update({ job_status: "pending", claimed_at: null })
    .eq("job_status", "processing")
    .lt("claimed_at", cutoff);
  if (error) console.error(`stale job reclaim failed: ${error.message}`);
}

// claimJob: atomically claims ONE pending job for this run. The update
// only lands while the row is still 'pending', so when two drainer runs
// race for the same job exactly one gets a row back — the loser gets
// null and skips the job. Claiming stamps claimed_at (the stale
// reclaim above ages claims by it) and bumps attempts, so an attempt
// is counted exactly once, by the run that actually works the job.
async function claimJob(job: PaymentJobRow) {
  const { data, error } = await admin
    .from("payment_jobs")
    .update({
      job_status: "processing",
      claimed_at: new Date().toISOString(),
      attempts: Number(job.attempts ?? 0) + 1,
    })
    .eq("job_id", job.job_id)
    .eq("job_status", "pending")
    .select()
    .maybeSingle();
  if (error) throw new Error(`Could not claim payment job: ${error.message}`);
  return data;
}

// processJob: runs ONE already-claimed job end to end and records the
// outcome on the job row itself. Success marks the job 'done'. A
// failure saves the error and returns the job to 'pending' (so the
// next run retries it) until its attempts reach MAX_ATTEMPTS, when it
// is parked as 'failed' for a human. Attempts were already bumped by
// claimJob. Every outcome update is guarded on the row still being in
// 'processing', so this run can never overwrite another run's result.
// One job's failure never stops the rest of the batch — the error is
// returned to the caller, not thrown.
async function processJob(job: PaymentJobRow) {
  const attempts = Number(job.attempts ?? 0);
  try {
    const payment = await getPayment(job.payment_id);
    const result = job.action === "capture"
      ? await captureForJob(payment)
      : await releaseForJob(payment, Number(job.refund_percent ?? 100));

    const { error } = await admin
      .from("payment_jobs")
      .update({ job_status: "done", error: null, processed_at: new Date().toISOString(), claimed_at: null })
      .eq("job_id", job.job_id)
      .eq("job_status", "processing");
    if (error) throw new Error(`Job finished but its row could not be updated: ${error.message}`);
    return { jobId: job.job_id, action: job.action, outcome: "done", result };
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown drainer error.";
    const parked = attempts >= MAX_ATTEMPTS;
    await admin
      .from("payment_jobs")
      .update({
        job_status: parked ? "failed" : "pending",
        error: message,
        processed_at: parked ? new Date().toISOString() : null,
        claimed_at: null,
      })
      .eq("job_id", job.job_id)
      .eq("job_status", "processing");
    console.error(`payment job ${job.job_id} (${job.action}) attempt ${attempts} failed: ${message}`);
    return { jobId: job.job_id, action: job.action, outcome: parked ? "failed" : "retry", error: message };
  }
}

// The HTTP entry point. pg_cron (via pg_net) POSTs here every minute with
// the x-drainer-secret header and an empty JSON body. The run first
// requeues any stale 'processing' claims, then reads the oldest pending
// jobs up to BATCH_SIZE as candidates, claims each one atomically
// (candidates another run claimed first are counted as skipped, never
// worked twice), processes its claimed jobs one by one, and answers
// with a summary — which is also what you see when you invoke the
// function by hand to test it.
Deno.serve(async (req: Request) => {
  if (req.method !== "POST") return json({ error: "Method not allowed." }, 405);
  if (!DRAINER_SECRET || req.headers.get("x-drainer-secret") !== DRAINER_SECRET) {
    return json({ error: "Forbidden." }, 403);
  }

  await reclaimStaleJobs();

  const { data: jobs, error } = await admin
    .from("payment_jobs")
    .select("*")
    .eq("job_status", "pending")
    .order("created_at", { ascending: true })
    .limit(BATCH_SIZE);
  if (error) return json({ error: `Could not read payment_jobs: ${error.message}` }, 500);

  const results = [];
  let skipped = 0;
  for (const job of jobs ?? []) {
    const claimed = await claimJob(job);
    if (!claimed) {
      skipped += 1;
      continue;
    }
    results.push(await processJob(claimed));
  }

  return json({
    checked: results.length,
    done: results.filter((r) => r.outcome === "done").length,
    retrying: results.filter((r) => r.outcome === "retry").length,
    failed: results.filter((r) => r.outcome === "failed").length,
    skipped,
    results,
  });
});
