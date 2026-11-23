// Poolr Stripe Webhook — Supabase Edge Function
// Receives Stripe payment events, verifies each signature against the raw
// body, and keeps the matching payments row in sync with Stripe — including
// releasing a row that is still marked held when Stripe cancels its intent.
//
// Duplicate and out-of-order deliveries: Stripe delivers every event at
// least once, and retries can arrive late or out of order. This handler is
// built for that:
//   - Every update is keyed on the Stripe payment intent id, the same id
//     payment-service records on the payments row when the hold is placed.
//   - A payment_status is only ever moved FORWARD, along the same
//     transitions the database guard (guard_payment_consistency) allows:
//     held -> captured / released / failed, captured -> refunded /
//     partially_refunded, partially_refunded -> refunded. A late event
//     that would move a row backwards — an old amount_capturable_updated
//     landing after the capture, a succeeded landing after the refund —
//     still refreshes payment_intent_status and the charge id, but the
//     status itself is left alone. Applying the same event twice is
//     therefore a no-op the second time.
//   - A status change is written with the status it was read at still in
//     the WHERE clause, so if another writer moved the row first, this
//     write lands on zero rows instead of overwriting the newer state.
//   - If no payments row carries the event's intent id yet, the handler
//     answers 500 so Stripe redelivers: payment-service writes the row
//     synchronously when the hold is placed, so an event that beats it is
//     simply early. The handler never fabricates a partial payments row
//     from an event — a row needs the fare, payer and payee, which an
//     event does not carry.

import { createClient } from "npm:@supabase/supabase-js@2";
import Stripe from "npm:stripe@17.7.0";

const stripeSecret = Deno.env.get("STRIPE_SECRET_KEY");
const endpointSecret = Deno.env.get("STRIPE_WEBHOOK_SECRET");
const supabaseUrl = Deno.env.get("SUPABASE_URL");
const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

if (!stripeSecret || !endpointSecret || !supabaseUrl || !serviceRoleKey) {
  throw new Error("Required Stripe or Supabase environment secrets are missing.");
}

const stripe = new Stripe(stripeSecret, {
  apiVersion: "2025-02-24.acacia",
  httpClient: Stripe.createFetchHttpClient(),
});

const admin = createClient(supabaseUrl, serviceRoleKey, {
  auth: {
    persistSession: false,
    autoRefreshToken: false,
  },
});

// The forward payment_status moves a webhook event may apply, mirroring
// the transition map in the database's guard_payment_consistency: money
// states only ever advance, they never go back.
const FORWARD_TRANSITIONS: Record<string, string[]> = {
  held: ["captured", "released", "failed"],
  captured: ["refunded", "partially_refunded"],
  partially_refunded: ["refunded"],
};

// The payments-row fields this handler reads: the row's id (for the
// update) and its current status (to judge whether an event's move is
// forward).
type PaymentSyncRow = {
  payment_id: string;
  payment_status: string;
};

// Tells whether moving a payment from its current status to the target
// status is a forward move (or no move at all, when they are equal —
// re-applying an already-applied event must stay harmless).
function isForwardTransition(current: string, target: string): boolean {
  if (current === target) return true;
  return (FORWARD_TRANSITIONS[current] ?? []).includes(target);
}

// Loads the payments row that carries the given Stripe payment intent
// id, or null when no row has it yet.
async function loadPaymentByIntent(intentId: string): Promise<PaymentSyncRow | null> {
  const { data, error } = await admin
    .from("payments")
    .select("payment_id, payment_status")
    .eq("stripe_payment_intent_id", intentId)
    .maybeSingle();
  if (error) throw error;
  return data;
}

// Writes one sync update to a payments row. The intent-status and charge
// fields are always written (they describe Stripe's latest word on the
// intent itself). The payment_status is included only when targetStatus
// is given AND the move from the row's current status is a forward one;
// a backwards or sideways target is dropped, so a late or duplicate
// event can never undo a state the row has already reached. When the
// status does change, the update is guarded on the status read above
// still being current, so a row another writer just moved is never
// overwritten — the guarded update simply lands on zero rows.
async function applyPaymentSync(
  row: PaymentSyncRow,
  fields: Record<string, unknown>,
  targetStatus: string | null,
) {
  const update: Record<string, unknown> = { ...fields };
  const movesStatus = targetStatus !== null && targetStatus !== row.payment_status
    && isForwardTransition(row.payment_status, targetStatus);
  if (targetStatus !== null && isForwardTransition(row.payment_status, targetStatus)) {
    update.payment_status = targetStatus;
  }

  let query = admin
    .from("payments")
    .update(update)
    .eq("payment_id", row.payment_id);
  if (movesStatus) {
    query = query.eq("payment_status", row.payment_status);
  }
  const { error } = await query;
  if (error) throw error;
}

// Syncs the payments row for one payment_intent event. targetStatus is
// the payment_status this event type stands for, or null for events that
// only carry intent-status news. Throws when no row carries the intent
// yet, so the caller answers 500 and Stripe redelivers the event once
// payment-service has recorded the hold.
async function syncFromIntent(intent: Stripe.PaymentIntent, targetStatus: string | null) {
  const row = await loadPaymentByIntent(intent.id);
  if (!row) {
    throw new Error(`No payments row recorded for intent ${intent.id} yet.`);
  }
  const chargeId = typeof intent.latest_charge === "string"
    ? intent.latest_charge
    : intent.latest_charge?.id ?? null;
  await applyPaymentSync(row, {
    payment_intent_status: intent.status,
    stripe_charge_id: chargeId,
  }, targetStatus);
}

// Syncs the payments row for one charge.refunded event: the row becomes
// 'refunded' when the charge is fully refunded, 'partially_refunded'
// when only part of it came back — but only when that is a forward move
// from the row's current status (a refund event replayed after the row
// already reached 'refunded' changes nothing). Throws when no row
// carries the charge's intent yet, for the same redelivery reason as
// syncFromIntent.
async function syncFromRefund(charge: Stripe.Charge) {
  const intentId = typeof charge.payment_intent === "string"
    ? charge.payment_intent
    : charge.payment_intent?.id;
  if (!intentId) return;
  const row = await loadPaymentByIntent(intentId);
  if (!row) {
    throw new Error(`No payments row recorded for intent ${intentId} yet.`);
  }
  const targetStatus = charge.amount_refunded >= charge.amount
    ? "refunded"
    : "partially_refunded";
  await applyPaymentSync(row, {
    payment_intent_status: "succeeded",
    stripe_charge_id: charge.id,
  }, targetStatus);
}

// Entry point: Stripe calls this URL (HTTP POST) for every payment event;
// the handler verifies, interprets and records each event.
Deno.serve(async (req: Request) => {
  if (req.method !== "POST") {
    return new Response("Method not allowed", { status: 405 });
  }

  const signature = req.headers.get("stripe-signature");
  if (!signature) {
    return new Response("Missing Stripe signature", { status: 400 });
  }

  let event: Stripe.Event;

  try {
    const rawBody = await req.text();
    event = await stripe.webhooks.constructEventAsync(
      rawBody,
      signature,
      endpointSecret,
    );
  } catch (error) {
    console.error("Stripe signature verification failed:", error);
    return new Response("Invalid signature", { status: 400 });
  }

  try {
    if (event.type.startsWith("payment_intent.")) {
      const intent = event.data.object as Stripe.PaymentIntent;

      // Each intent event type maps to at most one payment_status:
      //   succeeded                 -> captured (the hold was taken)
      //   canceled                  -> released (the authorization was
      //                              cancelled before capture; a
      //                              cancelled authorization is not a
      //                              refund, so 'refunded' is never set
      //                              from an intent event)
      //   payment_failed            -> failed (the authorization died)
      //   amount_capturable_updated -> no status of its own: the row is
      //                              born 'held' when the hold is placed,
      //                              and no forward move leads back into
      //                              'held', so this event only syncs
      //                              the intent status and charge id.
      //   anything else             -> intent status sync only.
      let targetStatus: string | null = null;
      if (event.type === "payment_intent.succeeded") {
        targetStatus = "captured";
      } else if (event.type === "payment_intent.canceled") {
        targetStatus = "released";
      } else if (event.type === "payment_intent.payment_failed") {
        targetStatus = "failed";
      }

      await syncFromIntent(intent, targetStatus);
    } else if (event.type === "charge.refunded") {
      await syncFromRefund(event.data.object as Stripe.Charge);
    }

    return new Response(JSON.stringify({ received: true }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  } catch (error) {
    console.error("Stripe webhook processing failed:", error);

    // A server error asks Stripe to retry the event.
    return new Response("Webhook processing failed", { status: 500 });
  }
});
