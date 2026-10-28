// Poolr Stripe Onboarding — Supabase Edge Function (NEW 2026-10-28)
//
// Why this exists: payment-service's holdPayment() requires
//   users.stripe_customer_id (rider) and users.stripe_account_id (driver),
// and until now nothing in the app created either one — every hold failed
// with "Set up your Stripe customer/payment method before booking."
//
// Actions (all act ONLY on the signed-in caller's own row):
//   { action: "rider_setup" }                          -> create/reuse the rider's
//        Stripe Customer, open a SetupIntent, return its client_secret so the
//        app can collect a card with Stripe Elements (card data never touches
//        this server or the database).
//   { action: "rider_complete", setupIntentId }        -> after Elements confirms
//        the SetupIntent, verify it succeeded for THIS rider's customer and set
//        the new card as the customer's default payment method.
//   { action: "rider_status" }                         -> { customerReady, card }
//        plus the default paymentMethodId — the exact value the app passes to
//        payment-service's "hold" action.
//   { action: "driver_start" }                         -> create/reuse the driver's
//        Stripe Connect Express account and return a hosted onboarding URL.
//   { action: "driver_status" }                        -> { accountReady,
//        detailsSubmitted, chargesEnabled, payoutsEnabled } live from Stripe.
//
// Identities and amounts are never trusted from client input: the user id
// comes from the caller's JWT, and Stripe ids are read from Postgres.

import { createClient } from "npm:@supabase/supabase-js@2";
import Stripe from "npm:stripe@17.7.0";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const STRIPE_SECRET_KEY = Deno.env.get("STRIPE_SECRET_KEY")!;
const APP_ORIGIN = Deno.env.get("APP_ORIGIN") ?? "*";

const stripe = new Stripe(STRIPE_SECRET_KEY, {
  apiVersion: "2025-02-24.acacia",
  httpClient: Stripe.createFetchHttpClient(),
});

const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

const corsHeaders = {
  "Access-Control-Allow-Origin": APP_ORIGIN,
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

// Same caller check as payment-service: the Bearer token must be a real
// Supabase session; the returned user id is the only identity we trust.
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

async function getProfile(userId: string) {
  const { data, error } = await admin
    .from("users")
    .select("user_id, full_name, stripe_customer_id, stripe_account_id")
    .eq("user_id", userId)
    .single();
  if (error || !data) throw new Error("Profile not found.");
  return data;
}

async function saveStripeIds(
  userId: string,
  patch: { stripe_customer_id?: string; stripe_account_id?: string },
) {
  const { error } = await admin.from("users").update(patch).eq("user_id", userId);
  if (error) throw new Error("Could not save your Stripe setup. Try again.");
}

// ---------------------------------------------------------------- rider ---

// Create the rider's Stripe Customer on first use and remember its id.
// Returns the customer id (existing or newly created).
async function ensureCustomer(userId: string, email?: string, fullName?: string | null) {
  const profile = await getProfile(userId);
  if (profile.stripe_customer_id) return profile.stripe_customer_id;

  const customer = await stripe.customers.create({
    email: email ?? undefined,
    name: fullName ?? undefined,
    metadata: { poolr_user_id: userId },
  });
  await saveStripeIds(userId, { stripe_customer_id: customer.id });
  return customer.id;
}

function cardSummary(method: Stripe.PaymentMethod) {
  if (method.type !== "card" || !method.card) return null;
  return {
    brand: method.card.brand,
    last4: method.card.last4,
    expMonth: method.card.exp_month,
    expYear: method.card.exp_year,
  };
}

// Resolve the customer's default payment method. If a card was attached but
// never marked default (e.g. the app closed before rider_complete ran), adopt
// the most recent card and mark it default — self-healing instead of an error.
async function getDefaultMethod(customerId: string) {
  const customer = await stripe.customers.retrieve(customerId);
  if (customer.deleted) throw new Error("Stripe customer no longer exists.");
  const defaultId = typeof customer.invoice_settings?.default_payment_method === "string"
    ? customer.invoice_settings.default_payment_method
    : customer.invoice_settings?.default_payment_method?.id ?? null;

  if (defaultId) {
    const method = await stripe.paymentMethods.retrieve(defaultId);
    return { paymentMethodId: method.id, card: cardSummary(method) };
  }

  const list = await stripe.paymentMethods.list({ customer: customerId, type: "card", limit: 1 });
  const first = list.data[0];
  if (!first) return { paymentMethodId: null, card: null };

  await stripe.customers.update(customerId, {
    invoice_settings: { default_payment_method: first.id },
  });
  return { paymentMethodId: first.id, card: cardSummary(first) };
}

async function riderSetup(userId: string, email?: string) {
  const profile = await getProfile(userId);
  const customerId = await ensureCustomer(userId, email, profile.full_name);

  // SetupIntent = Stripe's "save a card for later" object. usage off_session
  // because Poolr places the hold later, when the rider is not on the page.
  // automatic_payment_methods with allow_redirects "never" keeps this to
  // card-style methods: no redirect, no return_url needed (this account has
  // redirect methods enabled, which otherwise force a return_url at confirm).
  const setupIntent = await stripe.setupIntents.create({
    customer: customerId,
    usage: "off_session",
    automatic_payment_methods: { enabled: true, allow_redirects: "never" },
    metadata: { poolr_user_id: userId },
  });

  return {
    customerId,
    setupIntentId: setupIntent.id,
    clientSecret: setupIntent.client_secret,
  };
}

async function riderComplete(userId: string, setupIntentId: string) {
  if (!setupIntentId) throw new Error("setupIntentId is required.");
  const profile = await getProfile(userId);
  if (!profile.stripe_customer_id) throw new Error("No Stripe customer for this rider yet.");

  const setupIntent = await stripe.setupIntents.retrieve(setupIntentId);
  const intentCustomer = typeof setupIntent.customer === "string"
    ? setupIntent.customer
    : setupIntent.customer?.id ?? null;
  if (intentCustomer !== profile.stripe_customer_id) {
    throw new Error("That card setup belongs to a different account.");
  }
  if (setupIntent.status !== "succeeded") {
    throw new Error(`Card setup is not finished (Stripe status: ${setupIntent.status}).`);
  }
  const paymentMethodId = typeof setupIntent.payment_method === "string"
    ? setupIntent.payment_method
    : setupIntent.payment_method?.id ?? null;
  if (!paymentMethodId) throw new Error("Card setup finished without a payment method.");

  // Mark the new card as the customer's default — rider_status (and therefore
  // the payment hold) always uses the default method.
  await stripe.customers.update(profile.stripe_customer_id, {
    invoice_settings: { default_payment_method: paymentMethodId },
  });

  const method = await stripe.paymentMethods.retrieve(paymentMethodId);
  return { customerReady: true, paymentMethodId, card: cardSummary(method) };
}

async function riderStatus(userId: string) {
  const profile = await getProfile(userId);
  if (!profile.stripe_customer_id) {
    return { customerReady: false, paymentMethodId: null, card: null };
  }
  const { paymentMethodId, card } = await getDefaultMethod(profile.stripe_customer_id);
  return { customerReady: paymentMethodId != null, paymentMethodId, card };
}

// --------------------------------------------------------------- driver ---
// Accounts v2 (rewritten 2026-10-28): this Stripe platform rejects v1
// Express account creation for new Connect integrations ("Stripe no longer
// recommends Accounts v1... Create connected accounts with
// POST /v2/core/accounts instead"), so driver accounts are managed through
// Stripe's v2 REST endpoints directly. The pinned SDK (17.7.0) predates
// reliable v2 support, so these calls use fetch with the Stripe-Version
// header Stripe itself specified for this account. The rider side above
// still uses the v1 SDK — Customers/SetupIntents are unaffected — and v2
// account ids are plain acct_... ids that payment-service's v1 transfer
// call accepts unchanged.

const STRIPE_V2_VERSION = "2026-09-30.endive";

// The slices of the v2 Account object this function reads. Configuration
// sub-objects come back null unless named in the retrieve's include list.
interface V2Account {
  id: string;
  identity?: { country?: string; entity_type?: string | null } | null;
  configuration?: {
    merchant?: {
      capabilities?: { card_payments?: { status?: string } };
    } | null;
    recipient?: {
      capabilities?: {
        stripe_balance?: { stripe_transfers?: { status?: string } };
      };
    } | null;
  } | null;
}

async function stripeV2<T>(path: string, method: string, body?: unknown): Promise<T> {
  const res = await fetch(`https://api.stripe.com${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${STRIPE_SECRET_KEY}`,
      "Stripe-Version": STRIPE_V2_VERSION,
      "Content-Type": "application/json",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data: unknown = await res.json().catch(() => null);
  if (!res.ok) {
    const message = (data as { error?: { message?: string } } | null)?.error?.message ??
      `Stripe v2 request failed (${res.status}).`;
    throw new Error(message);
  }
  return data as T;
}

function retrieveV2Account(accountId: string) {
  const include = [
    "configuration.merchant",
    "configuration.recipient",
    "identity",
    "requirements",
  ]
    .map((name, i) => `include[${i}]=${name}`)
    .join("&");
  return stripeV2<V2Account>(`/v2/core/accounts/${accountId}?${include}`, "GET");
}

async function driverStart(userId: string, email?: string) {
  const profile = await getProfile(userId);

  let accountId = profile.stripe_account_id;
  if (accountId) {
    // A saved id should resolve in v2 (v2 reads v1-era accounts too). Only
    // a genuinely missing account falls through to creating a fresh one —
    // any other Stripe error is the caller's to see, not a cue to duplicate.
    try {
      await retrieveV2Account(accountId);
    } catch (error) {
      if (!/no such/i.test(error instanceof Error ? error.message : "")) throw error;
      accountId = null;
    }
  }
  if (!accountId) {
    // Express dashboard = Stripe hosts the identity/bank paperwork; Poolr
    // never sees tax ids or bank details. fees/losses collector
    // "application" = the platform (not Stripe, not the driver) absorbs
    // fees and negative balances, matching the old Express setup. The
    // merchant capability lets the account take card payments; the
    // recipient capability lets Poolr transfer trip money into its Stripe
    // balance. Save the id BEFORE sending the driver to Stripe, so a
    // refresh/retry continues the same account instead of duplicating it.
    const account = await stripeV2<V2Account>("/v2/core/accounts", "POST", {
      contact_email: email ?? undefined,
      identity: { country: "US" },
      dashboard: "express",
      defaults: {
        responsibilities: { fees_collector: "application", losses_collector: "application" },
      },
      configuration: {
        merchant: { capabilities: { card_payments: { requested: true } } },
        recipient: {
          capabilities: { stripe_balance: { stripe_transfers: { requested: true } } },
        },
      },
      metadata: { poolr_user_id: userId },
    });
    accountId = account.id;
    await saveStripeIds(userId, { stripe_account_id: accountId });
  }

  // Account links are single-use and short-lived, so a fresh one is minted
  // on every call: refresh_url is where Stripe sends the driver when a link
  // expires or needs a restart, return_url when they finish (or bail out).
  // collection_options "eventually_due" collects the full paperwork up
  // front, like the old Express flow did.
  const link = await stripeV2<{ url: string }>("/v2/core/account_links", "POST", {
    account: accountId,
    use_case: {
      type: "account_onboarding",
      account_onboarding: {
        configurations: ["merchant", "recipient"],
        collection_options: { fields: "eventually_due" },
        refresh_url: `${APP_ORIGIN}/payments?driver=refresh`,
        return_url: `${APP_ORIGIN}/payments?driver=return`,
      },
    },
  });

  return { accountId, url: link.url };
}

async function driverStatus(userId: string) {
  const profile = await getProfile(userId);
  if (!profile.stripe_account_id) {
    return {
      accountReady: false,
      detailsSubmitted: false,
      chargesEnabled: false,
      payoutsEnabled: false,
    };
  }
  const account = await retrieveV2Account(profile.stripe_account_id);
  const chargesEnabled =
    account.configuration?.merchant?.capabilities?.card_payments?.status === "active";
  // v1's payouts_enabled has no direct v2 twin. The gate payment-service
  // actually needs is transfers INTO the driver's balance, so payoutsEnabled
  // tracks the recipient stripe_transfers capability; bank payouts from the
  // balance are then scheduled by Stripe under the recipient configuration.
  const payoutsEnabled =
    account.configuration?.recipient?.capabilities?.stripe_balance?.stripe_transfers
      ?.status === "active";
  // v2 has no details_submitted flag either. identity.entity_type is only
  // set once the driver has been through Stripe's hosted flow and declared
  // individual/company, so it stands in for "details submitted".
  const detailsSubmitted = Boolean(account.identity?.entity_type);
  return {
    accountId: profile.stripe_account_id,
    detailsSubmitted,
    chargesEnabled,
    payoutsEnabled,
    // Ready = Stripe will actually let capturePayment() transfer to them.
    accountReady: chargesEnabled && payoutsEnabled,
  };
}

// ---------------------------------------------------------------- entry ---

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return fail("Method not allowed.", 405);

  try {
    const caller = await getCaller(req);
    const body = await req.json();
    const action = body?.action;

    let result;
    if (action === "rider_setup") {
      result = await riderSetup(caller.id, caller.email);
    } else if (action === "rider_complete") {
      result = await riderComplete(caller.id, body.setupIntentId);
    } else if (action === "rider_status") {
      result = await riderStatus(caller.id);
    } else if (action === "driver_start") {
      result = await driverStart(caller.id, caller.email);
    } else if (action === "driver_status") {
      result = await driverStatus(caller.id);
    } else {
      return fail(
        "Unsupported action. Use rider_setup, rider_complete, rider_status, driver_start, or driver_status.",
      );
    }

    return json(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unexpected onboarding error.";
    console.error("Poolr stripe onboarding error:", message);
    const status = /sign in|session/i.test(message) ? 401
      : /not found|different account/i.test(message) ? 403
      : 400;
    return fail(message, status);
  }
});
