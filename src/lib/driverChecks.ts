// Pure check logic for driver + vehicle verification: name and VIN
// normalization, the document cross-checks, and the vehicle document
// badge. No imports and no I/O, so the Jest suite can pin the exact
// rules. The driver-verification Edge Function runs the same rules
// server-side, where the verdict counts; src/lib/driverVerification.ts
// re-exports everything here for the app.

export type VehicleDocType = 'registration' | 'rental_agreement' | 'insurance'
export type DocCheckStatus = 'pending' | 'passed' | 'failed' | 'needs_review'
export type VehicleDocumentsStatus = 'pending' | 'verified' | 'needs_review'

export interface VehicleDoc {
  doc_id: string
  vehicle_id: string
  doc_type: VehicleDocType
  holder_name: string | null
  vin: string | null
  expiry_date: string | null
  check_status: DocCheckStatus
  check_notes: string | null
  created_at: string
}

export interface DocFields {
  docType: VehicleDocType
  holderName: string
  vin: string
  expiryDate: string
}

/** Normalize a person's name for comparison: lowercase, collapse whitespace, drop punctuation. */
export function normalizeName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/** True when two names match exactly after normalization, or differ only by a middle name. */
export function namesMatch(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b) return false
  const na = normalizeName(a)
  const nb = normalizeName(b)
  if (!na || !nb) return false
  if (na === nb) return true
  const wa = na.split(' ')
  const wb = nb.split(' ')
  const [shorter, longer] = wa.length <= wb.length ? [wa, wb] : [wb, wa]
  return shorter.every((word) => longer.indexOf(word) >= 0)
}

/** Normalize a VIN for comparison: uppercase, no spaces or dashes. */
export function normalizeVin(vin: string): string {
  return vin.toUpperCase().replace(/[^A-Z0-9]/g, '')
}

/** True when a yyyy-mm-dd date is before the given yyyy-mm-dd today. */
export function isPastDate(isoDate: string, todayIso: string): boolean {
  return isoDate < todayIso
}

/** Formats a one- or two-digit number as exactly two digits. */
export function pad2(n: number): string {
  return ('0' + n).slice(-2)
}

/** Today's date as a yyyy-mm-dd string in local time. */
export function todayIso(): string {
  const now = new Date()
  return `${now.getFullYear()}-${pad2(now.getMonth() + 1)}-${pad2(now.getDate())}`
}

// Pre-runs the document cross-checks: holder name matches the verified
// driver, document VIN matches the vehicle VIN (when the vehicle has
// one yet), and insurance carries an unexpired expiry.
export function evaluateDocument(input: {
  fields: DocFields
  licenseName: string | null
  profileName: string | null
  vehicleVin: string | null
  today: string
}): { passed: boolean; problems: string[] } {
  const problems: string[] = []
  const { fields } = input
  if (!namesMatch(fields.holderName, input.licenseName) && !namesMatch(fields.holderName, input.profileName)) {
    problems.push('holder name does not match the verified driver name')
  }
  if (input.vehicleVin && normalizeVin(fields.vin) !== normalizeVin(input.vehicleVin)) {
    problems.push('document VIN does not match the vehicle VIN')
  }
  if (fields.docType === 'insurance') {
    if (!fields.expiryDate) problems.push('insurance expiry date is required')
    else if (isPastDate(fields.expiryDate, input.today)) problems.push('insurance has expired')
  }
  return { passed: problems.length === 0, problems }
}

// Derives a vehicle's document badge from its document rows, mirroring
// the database refresh function: exempt vehicles stay verified, a
// passed ownership document plus unexpired passed insurance verifies,
// any failed or needs-review document flags review, else pending.
export function deriveVehicleStatus(input: {
  exempt: boolean
  docs: Pick<VehicleDoc, 'doc_type' | 'check_status' | 'expiry_date'>[]
  today: string
}): VehicleDocumentsStatus {
  if (input.exempt) return 'verified'
  const ownershipPassed = input.docs.some(
    (d) => (d.doc_type === 'registration' || d.doc_type === 'rental_agreement') && d.check_status === 'passed',
  )
  const insurancePassed = input.docs.some(
    (d) =>
      d.doc_type === 'insurance' &&
      d.check_status === 'passed' &&
      d.expiry_date !== null &&
      !isPastDate(d.expiry_date, input.today),
  )
  if (ownershipPassed && insurancePassed) return 'verified'
  if (input.docs.some((d) => d.check_status === 'failed' || d.check_status === 'needs_review')) {
    return 'needs_review'
  }
  return 'pending'
}
