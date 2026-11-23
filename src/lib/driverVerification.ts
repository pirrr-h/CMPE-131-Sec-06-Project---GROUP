// Client helpers for the driver-verification Edge Function.
// Every call goes through supabase.functions.invoke, which attaches the
// signed-in user's JWT automatically — the function trusts only that
// token and re-runs every check server-side, where the verdict counts.
// The pure check helpers live in ./driverChecks (no imports, so Jest
// can pin them) and are re-exported here for the app's convenience.
import { supabase } from './supabase'
import type {
  DocCheckStatus,
  DocFields,
  VehicleDoc,
  VehicleDocType,
  VehicleDocumentsStatus,
} from './driverChecks'

export * from './driverChecks'
export type { DocFields, VehicleDoc }

export interface LicenseStart {
  licenseVerified?: boolean
  sessionId?: string
  url?: string
  // True when no new scan was needed: the identity check the user
  // already passed had itself used a driver license.
  adoptedFromIdentity?: boolean
}

export interface LicenseStatus {
  licenseVerified: boolean
  // Session/check outcome: not_started | requires_input | processing |
  // verified | canceled | name_mismatch | license_expired |
  // document_not_verified | missing_report.
  status: string
  licenseName?: string | null
  licenseExpiry?: string | null
  // matched | mismatch | skipped_test_mode — live keys only enforce a
  // match; Stripe test documents are fictional people.
  nameChecked?: string
  // True when the license check was adopted from the identity check
  // (the identity scan itself used a driver license).
  adoptedFromIdentity?: boolean
}

export interface OverviewVehicle {
  vehicle_id: string
  make: string
  model: string
  year: number
  seat_count: number
  car_type: string
  vin: string | null
  documents_status: VehicleDocumentsStatus
  documents_exempt: boolean
  documents: VehicleDoc[]
}

export interface DriverOverview {
  licenseVerified: boolean
  licenseName: string | null
  licenseExpiry: string | null
  vehicles: OverviewVehicle[]
}

export interface DocSubmitResult {
  docStatus: DocCheckStatus
  notes: string
  vehicleStatus: VehicleDocumentsStatus
}

// Send one action to the driver-verification function and unwrap its
// reply, surfacing the function's own error message when it sends one.
async function callDriverVerification<T>(body: Record<string, unknown>): Promise<T> {
  const { data, error } = await supabase.functions.invoke('driver-verification', { body })
  if (error) {
    let message = error.message
    const ctx = (error as { context?: Response }).context
    if (ctx && typeof ctx.clone === 'function') {
      try {
        const parsed = (await ctx.clone().json()) as { error?: string }
        if (parsed?.error) message = parsed.error
      } catch {
        // keep the generic message
      }
    }
    throw new Error(message)
  }
  return data as T
}

/** Start the license-only Stripe Identity scan; the caller redirects the browser to the returned url. */
export function startLicenseVerification(returnUrl: string) {
  return callDriverVerification<LicenseStart>({ action: 'license-start', returnUrl })
}

/** Current license state; the function flips driver_license_verified itself once Stripe confirms. */
export function getLicenseStatus() {
  return callDriverVerification<LicenseStatus>({ action: 'license-status' })
}

/** Record one uploaded document and run its cross-checks server-side. */
export function submitVehicleDocument(input: { vehicleId: string; storagePath: string; fields: DocFields }) {
  return callDriverVerification<DocSubmitResult>({
    action: 'doc-submit',
    vehicleId: input.vehicleId,
    storagePath: input.storagePath,
    docType: input.fields.docType,
    holderName: input.fields.holderName,
    vin: input.fields.vin,
    expiryDate: input.fields.expiryDate,
  })
}

/** Load the caller's license state and all vehicles with their documents. */
export function getDriverOverview() {
  return callDriverVerification<DriverOverview>({ action: 'overview' })
}

// Uploads one document file into the caller's own folder of the private
// vehicle-documents bucket and returns the storage path for doc-submit.
export async function uploadVehicleDocumentFile(
  userId: string,
  vehicleId: string,
  docType: VehicleDocType,
  file: File,
): Promise<string> {
  const ext = file.name.includes('.') ? file.name.split('.').pop()!.toLowerCase() : 'bin'
  const stamp = Math.floor(Date.now() / 1000)
  const path = `${userId}/${vehicleId}/${docType}-${stamp}.${ext}`
  const { error } = await supabase.storage.from('vehicle-documents').upload(path, file, { upsert: false })
  if (error) throw new Error(error.message)
  return path
}
