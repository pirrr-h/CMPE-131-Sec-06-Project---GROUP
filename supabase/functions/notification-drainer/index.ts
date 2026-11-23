// Poolr Notification Drainer — Supabase Edge Function
//
// What this function does, in one paragraph:
//   Poolr's database already writes an in-app notification row for every
//   important event (new request, accept / decline / cancel, arrival,
//   trip start / completion, reconfirm reminders, no-match alerts). Until
//   now nothing turned those rows into phone-style pushes. This function
//   is the delivery worker: each run claims the oldest rows still marked
//   'pending', looks up the recipient's Firebase Cloud Messaging tokens
//   in push_tokens, sends one FCM push per token through the FCM HTTP v1
//   API, and records the outcome on the notification row (sent, no
//   device, retry, or failed). Delivery never changes what the row
//   says — and a user whose app is open sees the event as an in-app
//   pop-up over Realtime whether or not a push went out.
//
// How it runs:
//   pg_cron calls it every minute (see Poolr-Notifications-Cron.sql)
//   through pg_net. There is no user involved, so instead of a user
//   login it checks a shared secret header (x-notification-secret vs the
//   NOTIFICATION_DRAINER_SECRET function secret). Deploy it with
//   --no-verify-jwt (like payment-drainer) because the cron call carries
//   no Supabase user token; the secret check inside is the gate.
//
// Firebase access:
//   FCM_SERVICE_ACCOUNT_JSON holds the full contents of the Firebase
//   service account JSON file Kyaw downloaded (set with
//   `supabase secrets set`, never committed). The function turns it into
//   a short-lived Google OAuth token by signing a JWT with the service
//   account's private key (WebCrypto RS256, no external JWT library),
//   then calls the FCM HTTP v1 send endpoint for project poolr-74494.
//
// Safety:
//   - Each notification is CLAIMED before any FCM call: one atomic
//     update flips it from 'pending' to 'processing' (stamping
//     push_claimed_at and bumping push_attempts) only while it is still
//     'pending', so two overlapping runs can never push the same row
//     twice. A claim older than 10 minutes is treated as abandoned and
//     returned to 'pending'.
//   - A user with no registered token is marked 'no_device' and never
//     retried — an open app still shows the event as a pop-up.
//   - A token Firebase reports as UNREGISTERED is deleted from
//     push_tokens, so dead browsers stop being tried.
//   - A temporary FCM failure returns the row to 'pending' with the
//     error saved; after 5 attempts the row is parked as 'failed' for a
//     human to look at.
//   - Rows created before the notifications patch are marked
//     'preexisting' by the SQL and are never pushed retroactively.
//
// Requires Poolr-Notifications-Patch.sql on the database first (adds the
// push_* columns and the push_tokens table).

import { createClient } from "npm:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const NOTIFICATION_DRAINER_SECRET = Deno.env.get("NOTIFICATION_DRAINER_SECRET")!;
const FCM_SERVICE_ACCOUNT_JSON = Deno.env.get("FCM_SERVICE_ACCOUNT_JSON")!;

// How many pending notifications one run works through, and how many
// failed attempts a row gets before it is parked as 'failed'.
const BATCH_SIZE = 20;
const MAX_ATTEMPTS = 5;

// How old a 'processing' claim must be before another run treats the
// row as abandoned (its drainer died mid-send) and requeues it. FCM
// calls take seconds, so 10 minutes is far beyond a live claim.
const STALE_CLAIM_MINUTES = 10;

const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

// NotificationRow: the notifications-table fields this function reads.
type NotificationRow = {
  notification_id: string;
  user_id: string;
  type: string;
  title: string;
  body: string | null;
  trip_id: string | null;
  request_id: string | null;
  push_attempts: number | null;
};

// ServiceAccount: the Firebase service account fields the JWT and the
// FCM endpoint URL are built from.
type ServiceAccount = {
  project_id: string;
  client_email: string;
  private_key: string;
};

// json: turns a value into a JSON HTTP response with the given status.
function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

// parseServiceAccount: reads and validates the FCM_SERVICE_ACCOUNT_JSON
// secret once per send batch.
function parseServiceAccount(): ServiceAccount {
  const parsed = JSON.parse(FCM_SERVICE_ACCOUNT_JSON) as Partial<ServiceAccount>;
  if (!parsed.project_id || !parsed.client_email || !parsed.private_key) {
    throw new Error("FCM_SERVICE_ACCOUNT_JSON is missing project_id, client_email, or private_key.");
  }
  return parsed as ServiceAccount;
}

// base64UrlEncode: encodes bytes as base64url (the JWT alphabet: no
// padding, '-' and '_' instead of '+' and '/').
function base64UrlEncode(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

// base64UrlEncodeText: encodes a text string as base64url for a JWT part.
function base64UrlEncodeText(text: string): string {
  return base64UrlEncode(new TextEncoder().encode(text));
}

// importPrivateKey: converts the service account's PEM private key into
// a WebCrypto signing key (RSASSA-PKCS1-v1_5 with SHA-256).
async function importPrivateKey(pem: string) {
  const base64 = pem
    .replace("-----BEGIN PRIVATE KEY-----", "")
    .replace("-----END PRIVATE KEY-----", "")
    .replace(/\s+/g, "");
  const der = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
  return crypto.subtle.importKey(
    "pkcs8",
    der,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"],
  );
}

// The Google access token is cached across runs of the same function
// instance; Google issues it for one hour and re-signing every minute
// would be wasted work.
let cachedAccessToken: { token: string; expiresAt: number } | null = null;

// getGoogleAccessToken: signs a service-account JWT and exchanges it at
// Google's OAuth endpoint for an access token scoped to FCM sends.
async function getGoogleAccessToken(account: ServiceAccount): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  if (cachedAccessToken && cachedAccessToken.expiresAt - 60 > now) {
    return cachedAccessToken.token;
  }

  const header = base64UrlEncodeText(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claims = base64UrlEncodeText(JSON.stringify({
    iss: account.client_email,
    scope: "https://www.googleapis.com/auth/firebase.messaging",
    aud: "https://oauth2.googleapis.com/token",
    iat: now,
    exp: now + 3600,
  }));
  const unsigned = `${header}.${claims}`;
  const key = await importPrivateKey(account.private_key);
  const signature = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    key,
    new TextEncoder().encode(unsigned),
  );
  const jwt = `${unsigned}.${base64UrlEncode(new Uint8Array(signature))}`;

  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: jwt,
    }),
  });
  const payload = await response.json().catch(() => ({})) as {
    access_token?: string;
    expires_in?: number;
    error_description?: string;
  };
  if (!response.ok || !payload.access_token) {
    throw new Error(`Google OAuth exchange failed: ${payload.error_description ?? response.status}`);
  }
  cachedAccessToken = {
    token: payload.access_token,
    expiresAt: now + Number(payload.expires_in ?? 3600),
  };
  return payload.access_token;
}

// sendPushToToken: sends one notification to one FCM token and reports
// the outcome without throwing — 'sent' with Firebase's message name,
// 'unregistered' when Firebase says the token is dead, or 'error' with
// the message for anything else.
async function sendPushToToken(
  account: ServiceAccount,
  accessToken: string,
  token: string,
  notification: NotificationRow,
): Promise<{ outcome: "sent" | "unregistered" | "error"; messageId?: string; error?: string }> {
  const response = await fetch(
    `https://fcm.googleapis.com/v1/projects/${account.project_id}/messages:send`,
    {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        message: {
          token,
          notification: {
            title: notification.title,
            body: notification.body ?? "",
          },
          data: {
            notification_id: notification.notification_id,
            type: notification.type,
            trip_id: notification.trip_id ?? "",
            request_id: notification.request_id ?? "",
          },
          webpush: {
            fcm_options: { link: "/" },
          },
        },
      }),
    },
  );
  const payload = await response.json().catch(() => ({})) as {
    name?: string;
    error?: { message?: string; details?: Array<{ errorCode?: string }> };
  };
  if (response.ok && payload.name) {
    return { outcome: "sent", messageId: payload.name };
  }
  const errorCode = payload.error?.details?.find((d) => d.errorCode)?.errorCode;
  if (errorCode === "UNREGISTERED") return { outcome: "unregistered" };
  return {
    outcome: "error",
    error: payload.error?.message ?? `FCM send failed with HTTP ${response.status}.`,
  };
}

// reclaimStaleClaims: returns notifications stuck in 'processing' to
// 'pending' when their claim is older than STALE_CLAIM_MINUTES — the
// run that claimed such a row died before recording an outcome.
async function reclaimStaleClaims() {
  const cutoff = new Date(Date.now() - STALE_CLAIM_MINUTES * 60_000).toISOString();
  const { error } = await admin
    .from("notifications")
    .update({ push_status: "pending", push_claimed_at: null })
    .eq("push_status", "processing")
    .lt("push_claimed_at", cutoff);
  if (error) console.error(`stale claim reclaim failed: ${error.message}`);
}

// claimNotification: atomically claims ONE pending notification for
// this run. The update only lands while the row is still 'pending', so
// when two runs race for the same row exactly one gets a row back.
async function claimNotification(notification: NotificationRow) {
  const { data, error } = await admin
    .from("notifications")
    .update({
      push_status: "processing",
      push_claimed_at: new Date().toISOString(),
      push_attempts: Number(notification.push_attempts ?? 0) + 1,
    })
    .eq("notification_id", notification.notification_id)
    .eq("push_status", "pending")
    .select()
    .maybeSingle();
  if (error) throw new Error(`Could not claim notification: ${error.message}`);
  return data as NotificationRow | null;
}

// getUserTokens: loads every FCM token registered to a user (one per
// browser or device they signed in on).
async function getUserTokens(userId: string): Promise<string[]> {
  const { data, error } = await admin
    .from("push_tokens")
    .select("token")
    .eq("user_id", userId);
  if (error) throw new Error(`Could not read push tokens: ${error.message}`);
  return (data ?? []).map((row) => row.token as string);
}

// deleteToken: removes a token Firebase reported as unregistered, so
// dead browsers stop being tried on every later notification.
async function deleteToken(token: string) {
  const { error } = await admin.from("push_tokens").delete().eq("token", token);
  if (error) console.error(`could not delete dead token: ${error.message}`);
}

// recordOutcome: writes a finished notification's delivery result back
// to its row, guarded on the row still being in 'processing' so this
// run can never overwrite another run's result.
async function recordOutcome(
  notificationId: string,
  fields: Record<string, unknown>,
) {
  const { error } = await admin
    .from("notifications")
    .update({ ...fields, push_claimed_at: null })
    .eq("notification_id", notificationId)
    .eq("push_status", "processing");
  if (error) console.error(`could not record outcome for ${notificationId}: ${error.message}`);
}

// processNotification: delivers ONE already-claimed notification end to
// end and records the outcome. No tokens ends as 'no_device'; at least
// one successful token ends as 'sent'; all-temporary-failures returns
// to 'pending' until the attempts reach MAX_ATTEMPTS, then 'failed'.
// One notification's failure never stops the rest of the batch — the
// outcome is returned to the caller, not thrown.
async function processNotification(
  account: ServiceAccount,
  notification: NotificationRow,
) {
  const attempts = Number(notification.push_attempts ?? 0);
  try {
    const tokens = await getUserTokens(notification.user_id);
    if (tokens.length === 0) {
      await recordOutcome(notification.notification_id, {
        push_status: "no_device",
        push_error: "No FCM token registered for this user.",
      });
      return { notificationId: notification.notification_id, outcome: "no_device" };
    }

    const accessToken = await getGoogleAccessToken(account);
    let sentMessageId: string | null = null;
    let lastError: string | null = null;
    let liveTokens = 0;
    for (const token of tokens) {
      const result = await sendPushToToken(account, accessToken, token, notification);
      if (result.outcome === "sent") {
        sentMessageId = result.messageId ?? sentMessageId;
        liveTokens += 1;
      } else if (result.outcome === "unregistered") {
        await deleteToken(token);
      } else {
        liveTokens += 1;
        lastError = result.error ?? "Unknown FCM error.";
      }
    }

    if (sentMessageId) {
      await recordOutcome(notification.notification_id, {
        push_status: "sent",
        push_sent_at: new Date().toISOString(),
        push_message_id: sentMessageId,
        push_error: null,
      });
      return { notificationId: notification.notification_id, outcome: "sent" };
    }

    if (liveTokens === 0) {
      await recordOutcome(notification.notification_id, {
        push_status: "no_device",
        push_error: "Every registered token was unregistered and has been removed.",
      });
      return { notificationId: notification.notification_id, outcome: "no_device" };
    }

    const parked = attempts >= MAX_ATTEMPTS;
    await recordOutcome(notification.notification_id, {
      push_status: parked ? "failed" : "pending",
      push_error: lastError,
    });
    return {
      notificationId: notification.notification_id,
      outcome: parked ? "failed" : "retry",
      error: lastError,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown delivery error.";
    const parked = attempts >= MAX_ATTEMPTS;
    await recordOutcome(notification.notification_id, {
      push_status: parked ? "failed" : "pending",
      push_error: message,
    });
    console.error(`notification ${notification.notification_id} attempt ${attempts} failed: ${message}`);
    return {
      notificationId: notification.notification_id,
      outcome: parked ? "failed" : "retry",
      error: message,
    };
  }
}

// The HTTP entry point. pg_cron (via pg_net) POSTs here every minute
// with the x-notification-secret header and an empty JSON body. The run
// first requeues any stale 'processing' claims, then reads the oldest
// pending notifications up to BATCH_SIZE, claims each one atomically
// (candidates another run claimed first are counted as skipped), sends
// their pushes one by one, and answers with a summary — which is also
// what you see when you invoke the function by hand to test it.
Deno.serve(async (req: Request) => {
  if (req.method !== "POST") return json({ error: "Method not allowed." }, 405);
  if (!NOTIFICATION_DRAINER_SECRET
    || req.headers.get("x-notification-secret") !== NOTIFICATION_DRAINER_SECRET) {
    return json({ error: "Forbidden." }, 403);
  }

  let account: ServiceAccount;
  try {
    account = parseServiceAccount();
  } catch (err) {
    const message = err instanceof Error ? err.message : "Bad FCM service account secret.";
    return json({ error: message }, 500);
  }

  await reclaimStaleClaims();

  const { data: pending, error } = await admin
    .from("notifications")
    .select("*")
    .eq("push_status", "pending")
    .order("created_at", { ascending: true })
    .limit(BATCH_SIZE);
  if (error) return json({ error: `Could not read notifications: ${error.message}` }, 500);

  const results = [];
  let skipped = 0;
  for (const row of (pending ?? []) as NotificationRow[]) {
    const claimed = await claimNotification(row);
    if (!claimed) {
      skipped += 1;
      continue;
    }
    results.push(await processNotification(account, claimed));
  }

  return json({
    checked: results.length,
    sent: results.filter((r) => r.outcome === "sent").length,
    noDevice: results.filter((r) => r.outcome === "no_device").length,
    retrying: results.filter((r) => r.outcome === "retry").length,
    failed: results.filter((r) => r.outcome === "failed").length,
    skipped,
    results,
  });
});
