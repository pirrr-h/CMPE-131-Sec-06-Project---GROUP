// Poolr Driver Verification — Supabase Edge Function
//
// Why this exists: the identity gate proves who a user is, and any
// government ID passes it — passport, state ID card, license. Kyaw's
// rule (2026-11-12) is that driving takes more than identity:
//
//   { action: "license-start", returnUrl }
//       Creates a Stripe Identity VerificationSession restricted to
//       driving_license documents ONLY. A passport or ID card is turned
//       away inside Stripe's own flow. The session id is saved on the
//       user row; the app redirects the browser to the returned URL.
//   { action: "license-status" }
//       Re-reads the saved session. The moment Stripe reports it
//       verified, this reads the VerificationReport and confirms the
//       document really was a driving license, reads the name and
//       expiry off it, and flips users.driver_license_verified — but
//       only when the license name matches the account name and the
//       license is unexpired. Name matching is enforced on live keys;
//       in Stripe test mode the sample document name is stored but
//       cannot block (the test documents are fictional people).
//
//   No double scan: both actions first check the VerificationReport of
//   the identity session the user already passed. If that document was
//   itself a driving license (and unexpired, name matching), the check
//   is adopted on the spot — users who verified their identity with a
//   license are never asked to scan it again.
//   { action: "doc-submit", vehicleId, docType, storagePath,
//     holderName, vin, expiryDate }
//       Records one uploaded vehicle document (registration,
//       rental_agreement, or insurance) and runs the automated
//       cross-checks immediately: holder name matches the verified
//       driver name, the document VIN matches the vehicle's VIN (the
//       first document to name a VIN sets it on the vehicle), and an
//       insurance document must carry an unexpired expiry date. The
//       outcome lands in vehicle_documents.check_status and the
//       vehicle's documents_status badge is refreshed.
//   { action: "overview" }
//       One call for the Vehicles page: the caller's license state plus
//       every vehicle with its documents and badge status.
//
// Verification failures also notify: a failed license check and a
// failed vehicle document write a notification through the database's
// notify_user helper, so the existing pop-up display and push drainer
// tell the user even when they are not looking at the Vehicles page.
// License failures are deduped per Stripe session (see
// notifyLicenseFailure), so repeated status checks cannot stack
// copies of the same failure.
//
// The fields on doc-submit are the values read off the document. In
// this version the driver reads and types them (the uploader is the
// person holding the document); the payload shape is exactly what an
// OCR step would produce, so OCR can replace the typing later without
// schema or check changes.
//
// The user id comes only from the caller's JWT; document rows are
// written with the service key only after ownership is proven here.

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

const DOC_TYPES = ["registration", "rental_agreement", "insurance"];

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

// Normalize a person's name for comparison: lowercase, collapse runs of
// whitespace, drop punctuation, trim the ends.
function normalizeName(name: string) {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// True when two names refer to the same person: equal after
// normalization, or one is the other with a middle name added/dropped
// (every word of the shorter name appears in the longer one).
function namesMatch(a: string | null | undefined, b: string | null | undefined) {
  if (!a || !b) return false;
  const na = normalizeName(a);
  const nb = normalizeName(b);
  if (!na || !nb) return false;
  if (na === nb) return true;
  const wa = na.split(" ");
  const wb = nb.split(" ");
  const [shorter, longer] = wa.length <= wb.length ? [wa, wb] : [wb, wa];
  return shorter.every((word) => longer.includes(word));
}

// Normalize a VIN for comparison: uppercase, no spaces or dashes.
function normalizeVin(vin: string) {
  return vin.toUpperCase().replace(/[^A-Z0-9]/g, "");
}

// True when a yyyy-mm-dd date string is before today (UTC).
function isPastDate(isoDate: string) {
  const today = new Date().toISOString().slice(0, 10);
  return isoDate < today;
}

// Build a yyyy-mm-dd date from Stripe's date parts, or null when any
// part is missing or out of range.
function stripeDateToIso(parts: { day?: number; month?: number; year?: number } | null) {
  if (!parts || !parts.day || !parts.month || !parts.year) return null;
  const mm = String(parts.month).padStart(2, "0");
  const dd = String(parts.day).padStart(2, "0");
  return `${parts.year}-${mm}-${dd}`;
}

// Resolve the signed-in caller from the Authorization header. The
// returned user id is the only identity this function trusts.
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

// Load the caller's own users row, including both verification tracks.
async function getProfile(userId: string) {
  const { data, error } = await admin
    .from("users")
    .select(
      "user_id, full_name, is_verified, stripe_identity_session_id, " +
        "driver_license_verified, driver_license_session_id, " +
        "driver_license_name, driver_license_expiry",
    )
    .eq("user_id", userId)
    .single();
  if (error || !data) throw new Error("Profile not found.");
  return data;
}

// Save the caller's latest license VerificationSession id so the status
// action can find the session again on later calls.
async function saveLicenseSessionId(userId: string, sessionId: string) {
  const { error } = await admin
    .from("users")
    .update({ driver_license_session_id: sessionId })
    .eq("user_id", userId);
  if (error) throw new Error("Could not save your license session. Try again.");
}

// Record a passed license check: flips the flag the database gates read
// and keeps the name and expiry Stripe read off the license.
async function markLicenseVerified(userId: string, name: string | null, expiry: string | null) {
  const { error } = await admin
    .from("users")
    .update({
      driver_license_verified: true,
      driver_license_name: name,
      driver_license_expiry: expiry,
    })
    .eq("user_id", userId);
  if (error) throw new Error("Could not save your license status. Try again.");
}

// Write one notification row for the user through the database helper
// the trip workflows use, so the pop-up display and the push drainer
// deliver it with no app changes. Best effort on purpose: a failed
// notification write must never change the verification outcome, so
// an error here is only logged, never thrown.
async function notifyUser(userId: string, type: string, title: string, body: string) {
  const { error } = await admin.rpc("notify_user", {
    p_user_id: userId,
    p_type: type,
    p_title: title,
    p_body: body,
    p_trip_id: null,
    p_request_id: null,
  });
  if (error) console.log("notify_user write failed:", error.message);
  else console.log("notify_user wrote:", type, "for user", userId);
}

// True when this license failure was already notified for the Stripe
// session that produced it: a notification with the same type and
// title written after the session was created means an earlier status
// check already told the user. A later session has a later creation
// time, so a genuinely new failure still notifies.
async function licenseFailureAlreadyNotified(
  userId: string,
  title: string,
  sessionCreatedUnix: number | null,
) {
  let query = admin
    .from("notifications")
    .select("created_at")
    .eq("user_id", userId)
    .eq("type", "license_verification_failed")
    .eq("title", title);
  if (sessionCreatedUnix) {
    query = query.gt("created_at", new Date(sessionCreatedUnix * 1000).toISOString());
  }
  const { data } = await query.limit(1);
  return (data?.length ?? 0) > 0;
}

// Tell the user a license check failed, once per session and failure
// kind, so status polling from the Vehicles page cannot spam them
// with copies of the same failure.
async function notifyLicenseFailure(
  userId: string,
  title: string,
  body: string,
  sessionCreatedUnix: number | null,
) {
  if (await licenseFailureAlreadyNotified(userId, title, sessionCreatedUnix)) {
    console.log("license-status: this failure was already notified, skipping");
    return;
  }
  console.log("license-status: writing failure notification:", title);
  await notifyUser(userId, "license_verification_failed", title, body);
}

// Adopt the identity check the user already passed as their license
// check when it qualifies: the identity session is verified, its
// VerificationReport shows the document was a driving license, the
// license is unexpired, and the name matches the account (live keys
// only — test documents are fictional people). On success this flips
// driver_license_verified, points the license session id at the
// proving identity session, and returns the verified status; returns
// null when the identity document was anything else, so the caller
// falls through to a fresh license-only session.
async function adoptIdentityLicense(
  userId: string,
  profile: {
    full_name: string | null;
    stripe_identity_session_id: string | null;
    driver_license_session_id: string | null;
  },
) {
  const identitySessionId = profile.stripe_identity_session_id;
  if (!identitySessionId) return null;

  const session = await stripe.identity.verificationSessions.retrieve(identitySessionId);
  if (session.status !== "verified" || !session.last_verification_report) return null;

  const report = await stripe.identity.verificationReports.retrieve(
    session.last_verification_report,
  );
  const doc = report.document;
  const docType = (doc as unknown as { type?: string } | null)?.type;
  if (!doc || doc.status !== "verified" || docType !== "driving_license") return null;
  if (!doc.first_name || !doc.last_name) return null;

  const licenseName = `${doc.first_name} ${doc.last_name}`;
  const licenseExpiry = stripeDateToIso(doc.expiration_date ?? null);
  if (licenseExpiry && isPastDate(licenseExpiry)) return null;

  const nameChecked = session.livemode
    ? namesMatch(licenseName, profile.full_name)
      ? "matched"
      : "mismatch"
    : "skipped_test_mode";
  if (nameChecked === "mismatch") return null;

  await markLicenseVerified(userId, licenseName, licenseExpiry);
  if (!profile.driver_license_session_id) {
    await saveLicenseSessionId(userId, identitySessionId);
  }
  return {
    licenseVerified: true,
    status: "verified",
    licenseName,
    licenseExpiry,
    nameChecked,
    adoptedFromIdentity: true,
  };
}

// Create the license-only Stripe Identity session for the caller and
// return the hosted URL the browser should be sent to.
async function startLicenseVerification(userId: string, returnUrl: unknown) {
  if (typeof returnUrl !== "string" || !/^https?:\/\//.test(returnUrl)) {
    throw new Error("A valid returnUrl is required.");
  }
  const session = await stripe.identity.verificationSessions.create({
    type: "document",
    metadata: { poolr_user_id: userId, purpose: "driver_license" },
    return_url: returnUrl,
    options: {
      document: {
        allowed_types: ["driving_license"],
        require_id_number: true,
        require_matching_selfie: false,
      },
    },
  });
  await saveLicenseSessionId(userId, session.id);
  return { sessionId: session.id, url: session.url };
}

// Report the caller's license state, syncing from Stripe first. A
// verified session only flips the flag after the report proves the
// document was a driving license, the name matches the account (live
// keys only; test documents are fictional people), and the license has
// not expired.
async function getLicenseStatus(userId: string) {
  const profile = await getProfile(userId);
  console.log(
    "license-status: user",
    userId,
    "license flag:",
    profile.driver_license_verified,
  );
  if (profile.driver_license_verified) {
    return {
      licenseVerified: true,
      status: "verified",
      licenseName: profile.driver_license_name,
      licenseExpiry: profile.driver_license_expiry,
    };
  }

  // Adoption is an optional shortcut: if reading the identity session
  // throws, log it and fall through to the license session below
  // instead of letting the whole status check die silently.
  let adopted: Awaited<ReturnType<typeof adoptIdentityLicense>> = null;
  try {
    adopted = await adoptIdentityLicense(userId, profile);
  } catch (err) {
    console.log(
      "license-status: adoption check threw:",
      err instanceof Error ? err.message : String(err),
    );
  }
  console.log("license-status: adopted:", adopted ? "yes" : "no");
  if (adopted) return adopted;

  const sessionId = profile.driver_license_session_id as string | null;
  console.log("license-status: tracked session:", sessionId);
  if (!sessionId) return { licenseVerified: false, status: "not_started" };

  const session = await stripe.identity.verificationSessions.retrieve(sessionId);
  console.log(
    "license-status: session state:",
    session.status,
    "| last_error:",
    session.last_error ? (session.last_error.code ?? "present") : "none",
    "| report:",
    session.last_verification_report ? "present" : "none",
  );
  // A failed attempt returns the session to requires_input. Stripe
  // usually attaches last_error, but a failed attempt can also come
  // back carrying only its failed verification report, so the
  // notification below accepts either shape as the failure signal.
  if (session.status !== "verified") {
    if (session.status === "canceled") {
      await notifyLicenseFailure(
        userId,
        "Driver license check canceled",
        "Your driver license check was canceled before it finished. Open Vehicles to start it again.",
        session.created,
      );
    } else if (
      session.status === "requires_input" &&
      (session.last_error || session.last_verification_report)
    ) {
      await notifyLicenseFailure(
        userId,
        "Driver license check failed",
        "Your last driver license check did not pass. Open Vehicles to see the state of the check and try again.",
        session.created,
      );
    }
    return { licenseVerified: false, status: session.status };
  }

  const reportId = session.last_verification_report;
  if (!reportId) {
    await notifyLicenseFailure(
      userId,
      "Driver license check failed",
      "We could not read the result of your driver license check. Open Vehicles to try again.",
      session.created,
    );
    return { licenseVerified: false, status: "missing_report" };
  }
  const report = await stripe.identity.verificationReports.retrieve(reportId);
  const doc = report.document;
  if (!doc || doc.status !== "verified" || !doc.first_name || !doc.last_name) {
    await notifyLicenseFailure(
      userId,
      "Driver license check failed",
      "Stripe could not verify the license document you scanned. Open Vehicles to try again with a clearer scan.",
      session.created,
    );
    return { licenseVerified: false, status: "document_not_verified" };
  }

  const licenseName = `${doc.first_name} ${doc.last_name}`;
  const licenseExpiry = stripeDateToIso(doc.expiration_date ?? null);

  if (licenseExpiry && isPastDate(licenseExpiry)) {
    await notifyLicenseFailure(
      userId,
      "Driver license check failed",
      `The driver license you scanned expired on ${licenseExpiry}, so the check did not pass.`,
      session.created,
    );
    return { licenseVerified: false, status: "license_expired", licenseName, licenseExpiry };
  }

  const nameChecked = session.livemode
    ? namesMatch(licenseName, profile.full_name as string | null)
      ? "matched"
      : "mismatch"
    : "skipped_test_mode";
  if (nameChecked === "mismatch") {
    await notifyLicenseFailure(
      userId,
      "Driver license check failed",
      "The name on your driver license does not match the name on your account, so the check did not pass.",
      session.created,
    );
    return { licenseVerified: false, status: "name_mismatch", licenseName, licenseExpiry };
  }

  await markLicenseVerified(userId, licenseName, licenseExpiry);
  return {
    licenseVerified: true,
    status: "verified",
    licenseName,
    licenseExpiry,
    nameChecked,
  };
}

// Load one vehicle and prove the caller owns it.
async function getOwnedVehicle(userId: string, vehicleId: unknown) {
  if (typeof vehicleId !== "string" || !vehicleId) throw new Error("vehicleId is required.");
  const { data, error } = await admin
    .from("vehicles")
    .select("vehicle_id, user_id, vin, documents_status, documents_exempt")
    .eq("vehicle_id", vehicleId)
    .single();
  if (error || !data) throw new Error("Vehicle not found.");
  if (data.user_id !== userId) throw new Error("That vehicle belongs to a different account.");
  return data;
}

// Human-readable label for a vehicle document type, for messages.
function docTypeTitle(docType: string) {
  if (docType === "registration") return "Registration";
  if (docType === "rental_agreement") return "Rental agreement";
  return "Insurance";
}

// Run the automated cross-checks for one submitted document and return
// the outcome plus a human-readable note per failed check.
function checkDocument(
  profile: { full_name: string | null; driver_license_name: string | null },
  vehicleVin: string | null,
  doc: { docType: string; holderName: string; vin: string; expiryDate: string },
) {
  const problems: string[] = [];

  const nameOk =
    namesMatch(doc.holderName, profile.driver_license_name) ||
    namesMatch(doc.holderName, profile.full_name);
  if (!nameOk) problems.push("holder name does not match the verified driver name");

  let vinOk = true;
  if (vehicleVin) {
    vinOk = normalizeVin(doc.vin) === normalizeVin(vehicleVin);
    if (!vinOk) problems.push("document VIN does not match the vehicle VIN");
  }

  let expiryOk = true;
  if (doc.docType === "insurance") {
    if (!doc.expiryDate) {
      expiryOk = false;
      problems.push("insurance expiry date is required");
    } else if (isPastDate(doc.expiryDate)) {
      expiryOk = false;
      problems.push("insurance has expired");
    }
  }

  return {
    checkStatus: problems.length === 0 ? "passed" : "failed",
    notes: problems.length === 0 ? "all checks passed" : problems.join("; "),
  };
}

// Record one uploaded document, run its cross-checks, stamp the outcome
// on the row, set the vehicle's VIN from the first document that names
// one, and refresh the vehicle's status badge.
async function submitDocument(
  userId: string,
  body: {
    vehicleId?: unknown;
    docType?: unknown;
    storagePath?: unknown;
    holderName?: unknown;
    vin?: unknown;
    expiryDate?: unknown;
  },
) {
  const profile = await getProfile(userId);
  if (!profile.driver_license_verified) {
    throw new Error("Verify your driver license before adding vehicle documents.");
  }
  const vehicle = await getOwnedVehicle(userId, body.vehicleId);

  const docType = body.docType;
  if (typeof docType !== "string" || !DOC_TYPES.includes(docType)) {
    throw new Error("docType must be registration, rental_agreement, or insurance.");
  }
  const storagePath = body.storagePath;
  const expectedPrefix = `${userId}/${vehicle.vehicle_id}/`;
  if (typeof storagePath !== "string" || !storagePath.startsWith(expectedPrefix)) {
    throw new Error("storagePath must point at your own upload for this vehicle.");
  }
  const holderName = typeof body.holderName === "string" ? body.holderName.trim() : "";
  const vin = typeof body.vin === "string" ? body.vin.trim() : "";
  const expiryDate = typeof body.expiryDate === "string" ? body.expiryDate.trim() : "";
  if (!holderName) throw new Error("holderName (the name printed on the document) is required.");
  if (!vin) throw new Error("vin (printed on the document) is required.");
  if (expiryDate && !/^\d{4}-\d{2}-\d{2}$/.test(expiryDate)) {
    throw new Error("expiryDate must be yyyy-mm-dd.");
  }

  const { checkStatus, notes } = checkDocument(profile, vehicle.vin as string | null, {
    docType,
    holderName,
    vin,
    expiryDate,
  });

  const { error: insertError } = await admin.from("vehicle_documents").insert({
    vehicle_id: vehicle.vehicle_id,
    user_id: userId,
    doc_type: docType,
    storage_path: storagePath,
    holder_name: holderName,
    vin,
    expiry_date: expiryDate || null,
    check_status: checkStatus,
    check_notes: notes,
  });
  if (insertError) throw new Error("Could not save the document. Try again.");

  if (!vehicle.vin && checkStatus === "passed") {
    const { error: vinError } = await admin
      .from("vehicles")
      .update({ vin })
      .eq("vehicle_id", vehicle.vehicle_id);
    if (vinError) throw new Error("Document saved, but the vehicle VIN could not be set.");
  }

  const { data: status, error: refreshError } = await admin.rpc(
    "refresh_vehicle_documents_status",
    { p_vehicle_id: vehicle.vehicle_id },
  );
  if (refreshError) throw new Error("Document saved, but the vehicle status could not refresh.");

  if (checkStatus === "failed") {
    await notifyUser(
      userId,
      "vehicle_document_failed",
      "Vehicle document check failed",
      `${docTypeTitle(docType)} did not pass: ${notes}. Open Vehicles to fix it and resubmit.`,
    );
  }

  return { docStatus: checkStatus, notes, vehicleStatus: status };
}

// Assemble the Vehicles page payload: license state plus every vehicle
// the caller owns with its documents and current badge status.
async function getOverview(userId: string) {
  const profile = await getProfile(userId);
  const { data: vehicles, error: vehiclesError } = await admin
    .from("vehicles")
    .select("vehicle_id, make, model, year, seat_count, car_type, vin, documents_status, documents_exempt")
    .eq("user_id", userId)
    .order("created_at", { ascending: true });
  if (vehiclesError) throw new Error("Could not load your vehicles.");

  const { data: docs, error: docsError } = await admin
    .from("vehicle_documents")
    .select("doc_id, vehicle_id, doc_type, holder_name, vin, expiry_date, check_status, check_notes, created_at")
    .eq("user_id", userId)
    .order("created_at", { ascending: false });
  if (docsError) throw new Error("Could not load your documents.");

  return {
    licenseVerified: profile.driver_license_verified as boolean,
    licenseName: profile.driver_license_name,
    licenseExpiry: profile.driver_license_expiry,
    vehicles: (vehicles ?? []).map((v) => ({
      ...v,
      documents: (docs ?? []).filter((d) => d.vehicle_id === v.vehicle_id),
    })),
  };
}

// Route one request to the action named in its JSON body.
async function handle(req: Request) {
  const caller = await getCaller(req);
  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;

  if (body.action === "license-start") {
    const profile = await getProfile(caller.id);
    if (profile.driver_license_verified) {
      return json({ licenseVerified: true, status: "verified" });
    }
    const adopted = await adoptIdentityLicense(caller.id, profile);
    if (adopted) return json(adopted);
    return json(await startLicenseVerification(caller.id, body.returnUrl));
  }

  if (body.action === "license-status") {
    return json(await getLicenseStatus(caller.id));
  }

  if (body.action === "doc-submit") {
    return json(await submitDocument(caller.id, body));
  }

  if (body.action === "overview") {
    return json(await getOverview(caller.id));
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
    const message = error instanceof Error ? error.message : "Driver verification failed.";
    console.log("driver-verification: request failed:", message);
    return fail(message, 400);
  }
});
