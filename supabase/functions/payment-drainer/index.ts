// Poolr Payment Drainer — Supabase Edge Function
//
// What this function does, in one paragraph:
//   The database queues a row in payment_jobs whenever money needs to move
//   AFTER a trip changes state: transition_trip() queues a 'capture' job
//   for every held payment when a trip completes, and a 'release' job when
//   a trip is cancelled (the trip timers queue releases the same way when
//   they auto-cancel a trip). Until now nothing read that queue, so the
//   money would have sat still. This function is the reader: each run takes
//   the oldest pending jobs, performs the Stripe call for each one
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
// Safety:
//   - The Stripe calls below mirror payment-service's capture/release
//     step for step and reuse the SAME idempotency keys
//     (poolr-capture-<payment_id>, poolr-transfer-<payment_id>,
//     poolr-release-<payment_id>, poolr-refund-<payment_id>), so if this
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
// attempts counter column to payment_jobs).

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

const stripe = new Stripe(STRIPE_SECRET_KEY, {
  apiVersion: "2025-02-24.acacia",
  httpClient: Stripe.createFetchHttpClient(),
});

const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

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
async function captureForJob(payment: any) {
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

// releaseForJob: performs a 'release' job's money movement. Mirrors
// payment-service's releasePayment minus the user checks: a payment that
// was never captured gets its authorization cancelled (a RELEASE — the
// rider's hold simply disappears); a payment that WAS captured (rare on
// this path) is refunded instead. The payments row is set to 'released'
// or 'refunded' to match, which is the only split the DB guard allows.
async function releaseForJob(payment: any) {
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
  if (payment.payment_status === "refunded" || payment.payment_status === "released") {
    return { paymentId: payment.payment_id, status: payment.payment_status };
  }

  // Track whether money was actually captured. A cancelled authorization
  // (never captured) is a RELEASE, not a refund — the database guard
  // rejects held -> refunded.
  let wasCaptured = payment.payment_status === "captured";

  if (wasCaptured) {
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

// processJob: runs ONE job end to end and records the outcome on the job
// row itself. Success marks the job 'done'. A failure bumps the attempts
// counter and saves the error: the job stays 'pending' (so the next run
// retries it) until it reaches MAX_ATTEMPTS, when it is parked as
// 'failed' for a human. One job's failure never stops the rest of the
// batch — the error is returned to the caller, not thrown.
async function processJob(job: any) {
  const attempts = Number(job.attempts ?? 0) + 1;
  try {
    const payment = await getPayment(job.payment_id);
    const result = job.action === "capture"
      ? await captureForJob(payment)
      : await releaseForJob(payment);

    const { error } = await admin
      .from("payment_jobs")
      .update({ job_status: "done", error: null, processed_at: new Date().toISOString(), attempts })
      .eq("job_id", job.job_id);
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
        attempts,
      })
      .eq("job_id", job.job_id);
    console.error(`payment job ${job.job_id} (${job.action}) attempt ${attempts} failed: ${message}`);
    return { jobId: job.job_id, action: job.action, outcome: parked ? "failed" : "retry", error: message };
  }
}

// The HTTP entry point. pg_cron (via pg_net) POSTs here every minute with
// the x-drainer-secret header and an empty JSON body. The run fetches the
// oldest pending jobs up to BATCH_SIZE, processes them one by one, and
// answers with a summary — which is also what you see when you invoke the
// function by hand to test it.
Deno.serve(async (req: Request) => {
  if (req.method !== "POST") return json({ error: "Method not allowed." }, 405);
  if (!DRAINER_SECRET || req.headers.get("x-drainer-secret") !== DRAINER_SECRET) {
    return json({ error: "Forbidden." }, 403);
  }

  const { data: jobs, error } = await admin
    .from("payment_jobs")
    .select("*")
    .eq("job_status", "pending")
    .order("created_at", { ascending: true })
    .limit(BATCH_SIZE);
  if (error) return json({ error: `Could not read payment_jobs: ${error.message}` }, 500);

  const results = [];
  for (const job of jobs ?? []) {
    results.push(await processJob(job));
  }

  return json({
    checked: results.length,
    done: results.filter((r) => r.outcome === "done").length,
    retrying: results.filter((r) => r.outcome === "retry").length,
    failed: results.filter((r) => r.outcome === "failed").length,
    results,
  });
});
