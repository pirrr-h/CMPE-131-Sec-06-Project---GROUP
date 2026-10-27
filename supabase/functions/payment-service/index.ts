

import { createClient } from "npm:@supabase/supabase-js@2";
import Stripe from "npm:stripe@17.7.0";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const STRIPE_SECRET_KEY = Deno.env.get("STRIPE_SECRET_KEY")!;
const PLATFORM_FEE_BPS = Number(Deno.env.get("PLATFORM_FEE_BPS") ?? "0");

const stripe = new Stripe(STRIPE_SECRET_KEY, {
  apiVersion: "2025-02-24.acacia",
  httpClient: Stripe.createFetchHttpClient(),
});

const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

const corsHeaders = {
  "Access-Control-Allow-Origin": Deno.env.get("APP_ORIGIN") ?? "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function fail(message: string, status = 400) {
  return json({ error: message }, status);
}

function dollarsToCents(value: number | string | null | undefined): number {
  const amount = Number(value);
  if (!Number.isFinite(amount) || amount <= 0) throw new Error("Invalid fare amount.");
  const cents = Math.round(amount * 100);
  if (cents < 50) throw new Error("The payment amount is below Stripe's minimum.");
  return cents;
}

async function getCaller(req: Request) {
  const authorization = req.headers.get("Authorization");
  if (!authorization?.startsWith("Bearer ")) throw new Error("Sign in required.");
  const token = authorization.slice("Bearer ".length);
  const userClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: `Bearer ${token}` } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data, error } = await userClient.auth.getUser(token);
  if (error || !data.user) throw new Error("Invalid or expired session.");
  return data.user;
}

async function getPayment(paymentId: string) {
  const { data, error } = await admin
    .from("payments")
    .select("*")
    .eq("payment_id", paymentId)
    .single();
  if (error || !data) throw new Error("Payment not found.");
  return data;
}

async function holdPayment(userId: string, requestId: string, paymentMethodId: string) {
  if (!requestId || !paymentMethodId) throw new Error("requestId and paymentMethodId are required.");

  const { data: request, error: requestError } = await admin
    .from("trip_requests")
    // FIX 1: fare_amount, not offer_fare
    .select("request_id, trip_id, rider_id, fare_amount, request_status")
    .eq("request_id", requestId)
    .single();
  if (requestError || !request) throw new Error("Trip request not found.");
  if (request.rider_id !== userId) throw new Error("Only the rider who made this request can pay.");
  if (request.request_status !== "accepted") {
    throw new Error("The trip request must be accepted before placing a payment hold.");
  }
  // FIX 1 (cont.): fare_amount is set by the database (set_request_fare /
  // respond_to_offer); offer_fare is only the rider's proposal and is null
  // for bookings that came from a ride offer.
  if (request.fare_amount == null) throw new Error("The accepted request has no fare.");

  const { data: trip, error: tripError } = await admin
    .from("trips")
    .select("trip_id, creator_id, trip_status")
    .eq("trip_id", request.trip_id)
    .single();
  if (tripError || !trip) throw new Error("Trip not found.");
  if (trip.trip_status !== "posted") throw new Error("This trip is no longer available for payment.");

  const { data: rider, error: riderError } = await admin
    .from("users")
    .select("stripe_customer_id")
    .eq("user_id", userId)
    .single();
  if (riderError || !rider?.stripe_customer_id) {
    throw new Error("Set up your Stripe customer/payment method before booking.");
  }

  const { data: driver, error: driverError } = await admin
    .from("users")
    .select("stripe_account_id")
    .eq("user_id", trip.creator_id)
    .single();
  if (driverError || !driver?.stripe_account_id) {
    throw new Error("The driver has not completed payout setup yet.");
  }

  // If this request already has a PaymentIntent, retrieve its live status first.
  // This is important for SCA: the client may have completed authentication since the last call.
  const { data: existingPayment } = await admin
    .from("payments")
    .select("payment_id, payment_status, stripe_payment_intent_id, payment_intent_status")
    .eq("request_id", request.request_id)
    .maybeSingle();

  if (existingPayment?.stripe_payment_intent_id) {
    const existingIntent = await stripe.paymentIntents.retrieve(existingPayment.stripe_payment_intent_id);
    if (existingIntent.status === "requires_action") {
      return {
        paymentId: existingPayment.payment_id,
        status: "requires_action",
        paymentIntentId: existingIntent.id,
        clientSecret: existingIntent.client_secret,
        message: "Additional card authentication is required.",
      };
    }
    if (existingIntent.status === "requires_capture" || existingIntent.status === "succeeded") {
      const chargeId = typeof existingIntent.latest_charge === "string"
        ? existingIntent.latest_charge
        : existingIntent.latest_charge?.id ?? null;
      const { error: syncError } = await admin
        .from("payments")
        .update({
          payment_status: existingIntent.status === "succeeded" ? "captured" : "held",
          payment_intent_status: existingIntent.status,
          stripe_charge_id: chargeId,
        })
        .eq("payment_id", existingPayment.payment_id);
      if (syncError) throw new Error("Authorized payment status could not be synchronized.");
      return {
        paymentId: existingPayment.payment_id,
        status: existingIntent.status === "succeeded" ? "captured" : "held",
        amount: Number(request.fare_amount), // FIX 1
        currency: "usd",
      };
    }
    throw new Error(`The existing payment needs attention (Stripe status: ${existingIntent.status}). Contact support before trying another payment method.`);
  }

  // Confirm the supplied payment method belongs to this rider's Stripe customer.
  const method = await stripe.paymentMethods.retrieve(paymentMethodId);
  const methodCustomer = typeof method.customer === "string" ? method.customer : method.customer?.id;
  if (methodCustomer !== rider.stripe_customer_id) {
    throw new Error("That payment method is not attached to your account.");
  }
  const amount = dollarsToCents(request.fare_amount); // FIX 1
  const platformFee = Math.min(amount, Math.round(amount * Math.max(0, PLATFORM_FEE_BPS) / 10_000));

  // Idempotency prevents duplicate authorizations on client retries.
  const intent = await stripe.paymentIntents.create({
    amount,
    currency: "usd",
    customer: rider.stripe_customer_id,
    payment_method: paymentMethodId,
    capture_method: "manual",
    confirm: true,
    description: `Poolr ride request ${request.request_id}`,
    metadata: {
      poolr_request_id: request.request_id,
      poolr_trip_id: request.trip_id,
      poolr_rider_id: userId,
      poolr_driver_id: trip.creator_id,
    },
    transfer_group: `poolr_trip_${request.trip_id}`,
  }, { idempotencyKey: `poolr-hold-${request.request_id}` });

  if (!["requires_action", "requires_capture", "succeeded"].includes(intent.status)) {
    throw new Error(`Payment authorization was not completed (status: ${intent.status}).`);
  }

  const chargeId = typeof intent.latest_charge === "string"
    ? intent.latest_charge
    : intent.latest_charge?.id ?? null;

  // Record the intent even when SCA is required so retries and webhooks can reconcile it.
  // payment_intent_status distinguishes pending customer authentication from a true hold.
  const paymentRow = {
    trip_id: request.trip_id,
    request_id: request.request_id,
    payer_id: userId,
    payee_id: trip.creator_id,
    amount_total: Number(request.fare_amount), // FIX 1
    platform_fee: platformFee / 100,
    gas_reimbursement: 0,
    stripe_charge_id: chargeId,
    stripe_payment_intent_id: intent.id,
    payment_status: intent.status === "succeeded" ? "captured" : "held",
    payment_intent_status: intent.status,
  };

  const { data: saved, error: saveError } = await admin
    .from("payments")
    .upsert(paymentRow, { onConflict: "request_id" })
    .select("payment_id, payment_status")
    .single();
  if (saveError || !saved) {
    console.error("Failed to persist payment intent", saveError?.message);
    throw new Error("Payment intent was created but could not be recorded. Contact support before retrying.");
  }

  if (intent.status === "requires_action") {
    return {
      paymentId: saved.payment_id,
      status: "requires_action",
      paymentIntentId: intent.id,
      clientSecret: intent.client_secret,
      message: "Additional card authentication is required.",
    };
  }

  return {
    paymentId: saved.payment_id,
    status: saved.payment_status,
    amount: Number(request.fare_amount), // FIX 1
    currency: "usd",
  };
}

async function capturePayment(userId: string, paymentId: string) {
  if (!paymentId) throw new Error("paymentId is required.");
  const payment = await getPayment(paymentId);

  const { data: trip, error: tripError } = await admin
    .from("trips")
    .select("trip_id, creator_id, trip_status")
    .eq("trip_id", payment.trip_id)
    .single();
  if (tripError || !trip) throw new Error("Trip not found.");
  if (userId !== trip.creator_id && userId !== payment.payer_id) {
    throw new Error("You are not a participant in this payment.");
  }
  if (trip.trip_status !== "completed") {
    throw new Error("Payment can only be captured after the trip is marked completed.");
  }
  if (payment.payment_status === "captured" && payment.stripe_transfer_id) {
    return { paymentId, status: "captured", transferId: payment.stripe_transfer_id };
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

  return { paymentId, status: "captured", transferId: transfer.id };
}

async function releasePayment(userId: string, paymentId: string) {
  if (!paymentId) throw new Error("paymentId is required.");
  const payment = await getPayment(paymentId);

  const { data: trip, error: tripError } = await admin
    .from("trips")
    .select("trip_id, creator_id, trip_status")
    .eq("trip_id", payment.trip_id)
    .single();
  if (tripError || !trip) throw new Error("Trip not found.");

  if (userId !== payment.payer_id && userId !== trip.creator_id) {
    throw new Error("Only the rider or trip driver can release this payment.");
  }
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
    return { paymentId, status: payment.payment_status };
  }

  // FIX 2: track whether money was actually captured. A cancelled
  // authorization (never captured) is a RELEASE, not a refund — the
  // database guard rejects held -> refunded.
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
  }

  const finalStatus = wasCaptured ? "refunded" : "released"; // FIX 2
  const { error: updateError } = await admin
    .from("payments")
    .update({
      payment_status: finalStatus,
      payment_intent_status: wasCaptured ? "succeeded" : "canceled",
    })
    .eq("payment_id", payment.payment_id);
  if (updateError) throw new Error("Stripe release/refund succeeded but database update failed. Retry safely.");

  return { paymentId, status: finalStatus };
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return fail("Method not allowed.", 405);

  try {
    const caller = await getCaller(req);
    const body = await req.json();
    const action = body?.action;

    let result;
    if (action === "hold") {
      result = await holdPayment(caller.id, body.requestId, body.paymentMethodId);
    } else if (action === "capture") {
      result = await capturePayment(caller.id, body.paymentId);
    } else if (action === "release") {
      result = await releasePayment(caller.id, body.paymentId);
    } else {
      return fail("Unsupported action. Use hold, capture, or release.");
    }

    return json(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unexpected payment error.";
    console.error("Poolr payment service error:", message);
    const status = /sign in|session/i.test(message) ? 401
      : /not found|not a participant|only the rider|not authorized/i.test(message) ? 403
      : 400;
    return fail(message, status);
  }
});
