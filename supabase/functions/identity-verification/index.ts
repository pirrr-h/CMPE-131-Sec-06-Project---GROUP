// Poolr Identity Verification — Supabase Edge Function
//
// Why this exists: Kyaw's rule is that a Poolr account gets access to
// nothing until the user's identity is verified. Verification runs through
// Stripe Identity (a hosted document scan — the ID images go to Stripe,
// never to this server or the database). When Stripe confirms the scan,
// users.is_verified flips to true, and that one flag is what unlocks
// everything else: the app stops showing the verify screen, and the
// database's verified_ok() gate (turned on by Poolr-Identity-Gate-Patch.sql
// via app_settings.require_verified_users = 'true') starts letting the
// matching / posting / requesting functions through.
//
// Actions (all act ONLY on the signed-in caller's own row):
//   { action: "start", returnUrl } -> create a Stripe Identity
//        VerificationSession for the caller, remember its id on the user
//        row, and return the hosted URL the app redirects the browser to.
//        returnUrl is where Stripe sends the browser back afterwards (the
//        app passes its own /verify page). If the caller is already
//        verified, returns { verified: true } and creates nothing.
//   { action: "status" }           -> { verified, status }. Re-reads the
//        caller's saved session from Stripe; the moment Stripe reports it
//        verified, this writes users.is_verified = true itself, so no
//        webhook is required for the flag to land — the app calls this
//        when the user returns from the scan and on every login while
//        unverified, which also self-heals a scan that finished after the
//        user closed the tab.
//
// Failed attempts also notify: when the status action finds the saved
// session canceled, or back at requires_input with a Stripe error on it
// (a scan that did not pass), it writes a notification through the
// database's notify_user helper, so the pop-up display and push drainer
// can tell the user even if they closed the tab. Failures are deduped
// per Stripe session (see notifyIdentityFailure), and the app calls
// status on every login while unverified, so the dedupe is what keeps
// that from stacking copies.
//
// The user id comes only from the caller's JWT; nothing about identity or
// verification state is ever trusted from client input.

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

// Wrap a value as a JSON HTTP response with the CORS headers attached.
function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

// Return an error message as a JSON HTTP response.
function fail(message: string, status = 400) {
  return json({ error: message }, status);
}

// Resolve the signed-in caller from the Authorization header. The returned
// user id is the only identity this function trusts.
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

// Load the caller's own users row, including the verification fields.
async function getProfile(userId: string) {
  const { data, error } = await admin
    .from("users")
    .select("user_id, full_name, is_verified, stripe_identity_session_id")
    .eq("user_id", userId)
    .single();
  if (error || !data) throw new Error("Profile not found.");
  return data;
}

// Save the caller's latest VerificationSession id on their users row so the
// status action can find the session again on later calls.
async function saveSessionId(userId: string, sessionId: string) {
  const { error } = await admin
    .from("users")
    .update({ stripe_identity_session_id: sessionId })
    .eq("user_id", userId);
  if (error) throw new Error("Could not save your verification session. Try again.");
}

// Mark the caller verified in the database — the write that unlocks the app
// gate and the database's verified_ok() gate at the same time.
async function markVerified(userId: string) {
  const { error } = await admin
    .from("users")
    .update({ is_verified: true })
    .eq("user_id", userId);
  if (error) throw new Error("Could not save your verified status. Try again.");
}

// Write one notification row for the user through the database helper
// the trip workflows use, so the pop-up display and the push drainer
// deliver it with no app changes. Best effort on purpose: a failed
// notification write must never change the verification outcome, so
// the result and any error are ignored here.
async function notifyUser(userId: string, type: string, title: string, body: string) {
  await admin.rpc("notify_user", {
    p_user_id: userId,
    p_type: type,
    p_title: title,
    p_body: body,
    p_trip_id: null,
    p_request_id: null,
  });
}

// True when this identity failure was already notified for the Stripe
// session that produced it: a notification with the same type and
// title written after the session was created means an earlier status
// check already told the user. A later session has a later creation
// time, so a genuinely new failure still notifies.
async function identityFailureAlreadyNotified(
  userId: string,
  title: string,
  sessionCreatedUnix: number | null,
) {
  let query = admin
    .from("notifications")
    .select("created_at")
    .eq("user_id", userId)
    .eq("type", "identity_verification_failed")
    .eq("title", title);
  if (sessionCreatedUnix) {
    query = query.gt("created_at", new Date(sessionCreatedUnix * 1000).toISOString());
  }
  const { data } = await query.limit(1);
  return (data?.length ?? 0) > 0;
}

// Tell the user an identity verification failed, once per session and
// failure kind, so repeated status checks cannot spam them with
// copies of the same failure.
async function notifyIdentityFailure(
  userId: string,
  title: string,
  body: string,
  sessionCreatedUnix: number | null,
) {
  if (await identityFailureAlreadyNotified(userId, title, sessionCreatedUnix)) return;
  await notifyUser(userId, "identity_verification_failed", title, body);
}

// Create a new Stripe Identity VerificationSession (document scan) for the
// caller and return the hosted URL the browser should be sent to.
async function startVerification(userId: string, returnUrl: unknown) {
  if (typeof returnUrl !== "string" || !/^https?:\/\//.test(returnUrl)) {
    throw new Error("A valid returnUrl is required.");
  }
  const session = await stripe.identity.verificationSessions.create({
    type: "document",
    metadata: { poolr_user_id: userId },
    return_url: returnUrl,
    options: {
      document: {
        allowed_types: ["driving_license", "passport", "id_card"],
        require_matching_selfie: false,
      },
    },
  });
  await saveSessionId(userId, session.id);
  return { sessionId: session.id, url: session.url };
}

// Report the caller's verification state, syncing it from Stripe first: if
// the saved session has reached "verified" at Stripe, flip is_verified in
// the database before answering.
async function getVerificationStatus(userId: string) {
  const profile = await getProfile(userId);
  if (profile.is_verified) return { verified: true, status: "verified" };

  const sessionId = profile.stripe_identity_session_id as string | null;
  if (!sessionId) return { verified: false, status: "not_started" };

  const session = await stripe.identity.verificationSessions.retrieve(sessionId);
  if (session.status === "verified") {
    await markVerified(userId);
    return { verified: true, status: "verified" };
  }
  // A failed attempt returns the session to requires_input. Stripe
  // usually attaches last_error, but a failed attempt can also come
  // back carrying only its failed verification report, so the
  // notification below accepts either shape as the failure signal.
  if (session.status === "canceled") {
    await notifyIdentityFailure(
      userId,
      "Identity verification canceled",
      "Your identity verification was canceled before it finished. Open Poolr to start it again.",
      session.created,
    );
  } else if (
    session.status === "requires_input" &&
    (session.last_error || session.last_verification_report)
  ) {
    await notifyIdentityFailure(
      userId,
      "Identity verification failed",
      "Your identity verification did not pass. Open Poolr to see the state of the check and try again.",
      session.created,
    );
  }
  return { verified: false, status: session.status };
}

// Route one request to the action named in its JSON body.
async function handle(req: Request) {
  const caller = await getCaller(req);
  const body = (await req.json().catch(() => ({}))) as {
    action?: string;
    returnUrl?: unknown;
  };

  if (body.action === "start") {
    const profile = await getProfile(caller.id);
    if (profile.is_verified) return json({ verified: true, status: "verified" });
    return json(await startVerification(caller.id, body.returnUrl));
  }

  if (body.action === "status") {
    return json(await getVerificationStatus(caller.id));
  }

  return fail("Unknown action.");
}

// Serve one HTTP request: answer CORS preflights, reject non-POST calls,
// and hand POSTs to the action router, turning any thrown error into a
// JSON failure the app can show.
Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return fail("Method not allowed.", 405);
  try {
    return await handle(req);
  } catch (error) {
    return fail(error instanceof Error ? error.message : "Verification failed.", 400);
  }
});
