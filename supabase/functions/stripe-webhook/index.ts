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
