// Poolr Stripe Webhook — Supabase Edge Function (lightly corrected 2026-10-27)
// The original was already correct in structure (signature verification,
// raw body, async construct, 500-on-error so Stripe retries). One fix,
// marked "FIX": when Stripe cancels an authorization on its own (holds
// expire after ~7 days, or a cancel happens outside the release function),
// the original left the database row at payment_status = 'held' forever —
// a ghost hold. Now a canceled intent releases a still-held row.
// Also: Stripe apiVersion bumped to "2025-02-24.acacia" to match
// stripe@17.7.0's types ("2024-06-20" failed deno check).

import { createClient } from "npm:@supabase/supabase-js@2";
import Stripe from "npm:stripe@17.7.0";

const stripeSecret = Deno.env.get("STRIPE_SECRET_KEY");
const endpointSecret = Deno.env.get("STRIPE_WEBHOOK_SECRET");
const supabaseUrl = Deno.env.get("SUPABASE_URL");
const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

// STARTUP / SETUP — When this function boots, it loads four secrets from
// the environment: the Stripe secret key, the webhook signing secret
// (proves incoming calls really come from Stripe), and the Supabase URL +
// service-role key for writing to the database. If any is missing, the
// function refuses to start at all — better to fail loudly at boot than
// to silently drop payment events later. It then creates the Stripe
// client and a service-role Supabase client (bypasses row-level security;
// this function is called by Stripe, never by a logged-in user).
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

// MAIN HANDLER — the only entry point. Stripe calls this URL (HTTP POST)
// every time a payment event happens. It processes the event in stages:
// verify -> interpret -> update the payments table -> acknowledge.
Deno.serve(async (req: Request) => {
  if (req.method !== "POST") {
    return new Response("Method not allowed", { status: 405 });
  }

  // STAGE 1a — Require the signature header. Every genuine Stripe call
  // carries a "stripe-signature" header; without one, the request is not
  // from Stripe and is rejected (400) before any work happens.
  const signature = req.headers.get("stripe-signature");
  if (!signature) {
    return new Response("Missing Stripe signature", { status: 400 });
  }

  let event: Stripe.Event;

  // STAGE 1b — Verify the signature against the RAW request body and the
  // webhook signing secret. The body must be read as raw text (not parsed
  // JSON), because the signature was computed over the exact bytes Stripe
  // sent. If verification throws, the call is forged or corrupted: reject
  // with 400 and process nothing.
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
    // STAGE 2a — PaymentIntent events: keep the matching payments row in
    // sync with Stripe. amount_capturable_updated means the card hold was
    // authorized -> row becomes "held". succeeded means the money was
    // captured -> row becomes "captured". For all payment_intent events
    // the row's payment_intent_status and stripe_charge_id are refreshed.
    if (event.type.startsWith("payment_intent.")) {
      const intent = event.data.object as Stripe.PaymentIntent;

      const update: Record<string, unknown> = {
        payment_intent_status: intent.status,
      };

      if (event.type === "payment_intent.amount_capturable_updated") {
        update.payment_status = "held";
      } else if (event.type === "payment_intent.succeeded") {
        update.payment_status = "captured";
      }

      // A cancelled authorization is not a refund.
      // Record its Stripe status without falsely marking it refunded.
      if (
        event.type === "payment_intent.amount_capturable_updated" ||
        event.type === "payment_intent.succeeded" ||
        event.type === "payment_intent.canceled"
      ) {
        const chargeId =
          typeof intent.latest_charge === "string"
            ? intent.latest_charge
            : intent.latest_charge?.id ?? null;

        update.stripe_charge_id = chargeId;

        const { error } = await admin
          .from("payments")
          .update(update)
          .eq("stripe_payment_intent_id", intent.id);

        if (error) throw error;

        // FIX: if the intent was cancelled while our row still says "held"
        // (expired hold, or a cancel that didn't go through the release
        // function), mark the row released. Scoped to status = 'held' so a
        // captured/refunded row is never touched.
        if (event.type === "payment_intent.canceled") {
          const { error: releaseError } = await admin
            .from("payments")
            .update({ payment_status: "released" })
            .eq("stripe_payment_intent_id", intent.id)
            .eq("payment_status", "held");
          if (releaseError) throw releaseError;
        }
      }
    // STAGE 2b — Refund events: if the refunded amount equals the full
    // charge, the row becomes "refunded"; if only part was returned, it
    // becomes "partially_refunded". This catches refunds issued from the
    // Stripe dashboard or anywhere else outside our own release function.
    } else if (event.type === "charge.refunded") {
      const charge = event.data.object as Stripe.Charge;

      const intentId =
        typeof charge.payment_intent === "string"
          ? charge.payment_intent
          : charge.payment_intent?.id;

      if (intentId) {
        const paymentStatus =
          charge.amount_refunded >= charge.amount
            ? "refunded"
            : "partially_refunded";

        const { error } = await admin
          .from("payments")
          .update({
            payment_status: paymentStatus,
            payment_intent_status: "succeeded",
            stripe_charge_id: charge.id,
          })
          .eq("stripe_payment_intent_id", intentId);

        if (error) throw error;
      }
    }

    // STAGE 3 — Acknowledge success with HTTP 200 and {received: true}.
    // Stripe treats any non-200 response as "not delivered" and retries,
    // so 200 is returned only after the database update has succeeded.
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
