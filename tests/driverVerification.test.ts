// Tests for the pure helpers in src/lib/driverChecks.ts: the
// name/VIN/date logic behind the document cross-checks and the vehicle
// document badge. The Edge Function runs the same rules server-side;
// these tests pin the shared semantics.
import {
  deriveVehicleStatus,
  evaluateDocument,
  isPastDate,
  namesMatch,
  normalizeName,
  normalizeVin,
} from '../src/lib/driverChecks'
import type { DocFields } from '../src/lib/driverChecks'

const TODAY = '2026-11-12'

// Builds a valid registration field set, overridable per test.
function fields(patch: Partial<DocFields> = {}): DocFields {
  return {
    docType: 'registration',
    holderName: 'Kyaw Myo Lwin',
    vin: '1HGCM82633A004352',
    expiryDate: '',
    ...patch,
  }
}

describe('normalizeName', () => {
  // Lowercases, fixes spacing, and drops punctuation.
  it('normalizes case, whitespace, and punctuation', () => {
    expect(normalizeName('  Kyaw   Myo-Lwin ')).toBe('kyaw myo lwin')
  })
})

describe('namesMatch', () => {
  // Same name in different cases matches.
  it('matches the same name in different cases', () => {
    expect(namesMatch('Kyaw Myo Lwin', 'KYAW MYO LWIN')).toBe(true)
  })

  // A middle name present on one side only still matches.
  it('matches when one side drops the middle name', () => {
    expect(namesMatch('Kyaw Lwin', 'Kyaw Myo Lwin')).toBe(true)
  })

  // Different people do not match.
  it('rejects different names', () => {
    expect(namesMatch('Kyaw Myo Lwin', 'Jenny Rosen')).toBe(false)
  })

  // Missing names never match.
  it('rejects missing names', () => {
    expect(namesMatch(null, 'Kyaw Myo Lwin')).toBe(false)
    expect(namesMatch('Kyaw Myo Lwin', '')).toBe(false)
  })
})

describe('normalizeVin', () => {
  // VINs compare uppercase with spaces and dashes removed.
  it('uppercases and strips separators', () => {
    expect(normalizeVin('1hg cm826-33a')).toBe('1HGCM82633A')
  })
})

describe('isPastDate', () => {
  // Yesterday is past, today and tomorrow are not.
  it('compares against the given today', () => {
    expect(isPastDate('2026-11-11', TODAY)).toBe(true)
    expect(isPastDate('2026-11-12', TODAY)).toBe(false)
    expect(isPastDate('2026-11-13', TODAY)).toBe(false)
  })
})

describe('evaluateDocument', () => {
  const base = {
    licenseName: 'Kyaw Myo Lwin',
    profileName: 'Kyaw Myo Lwin',
    vehicleVin: '1HGCM82633A004352',
    today: TODAY,
  }

  // A registration whose holder and VIN line up passes cleanly.
  it('passes a registration that matches name and VIN', () => {
    expect(evaluateDocument({ ...base, fields: fields() })).toEqual({ passed: true, problems: [] })
  })

  // The profile name alone is enough when the license name differs
  // (Stripe test mode stores a fictional license name).
  it('passes on the profile name when the license name differs', () => {
    const res = evaluateDocument({ ...base, licenseName: 'Jenny Rosen', fields: fields() })
    expect(res.passed).toBe(true)
  })

  // A holder name matching neither verified name fails.
  it('fails when the holder name matches neither verified name', () => {
    const res = evaluateDocument({ ...base, fields: fields({ holderName: 'Someone Else' }) })
    expect(res.passed).toBe(false)
    expect(res.problems.join(' ')).toMatch(/holder name/)
  })

  // A VIN that differs from the vehicle's VIN fails.
  it('fails when the document VIN differs from the vehicle VIN', () => {
    const res = evaluateDocument({ ...base, fields: fields({ vin: 'JTDBR32E862000000' }) })
    expect(res.passed).toBe(false)
    expect(res.problems.join(' ')).toMatch(/VIN/)
  })

  // With no vehicle VIN on file yet, any document VIN is accepted (the
  // first passed document sets the vehicle's VIN server-side).
  it('accepts any VIN while the vehicle has none', () => {
    const res = evaluateDocument({ ...base, vehicleVin: null, fields: fields({ vin: 'JTDBR32E862000000' }) })
    expect(res.passed).toBe(true)
  })

  // Insurance without an expiry date fails.
  it('fails insurance with no expiry date', () => {
    const res = evaluateDocument({ ...base, fields: fields({ docType: 'insurance', expiryDate: '' }) })
    expect(res.passed).toBe(false)
    expect(res.problems.join(' ')).toMatch(/expiry/)
  })

  // Insurance that already expired fails.
  it('fails expired insurance', () => {
    const res = evaluateDocument({ ...base, fields: fields({ docType: 'insurance', expiryDate: '2026-11-01' }) })
    expect(res.passed).toBe(false)
    expect(res.problems.join(' ')).toMatch(/expired/)
  })

  // Unexpired insurance passes.
  it('passes unexpired insurance', () => {
    const res = evaluateDocument({ ...base, fields: fields({ docType: 'insurance', expiryDate: '2027-05-01' }) })
    expect(res.passed).toBe(true)
  })
})

describe('deriveVehicleStatus', () => {
  const doc = (doc_type: 'registration' | 'rental_agreement' | 'insurance', check_status: string, expiry_date: string | null = null) => ({
    doc_type,
    check_status: check_status as 'passed' | 'failed' | 'pending' | 'needs_review',
    expiry_date,
  })

  // Exempt (pre-patch) vehicles are always verified.
  it('keeps exempt vehicles verified with no documents', () => {
    expect(deriveVehicleStatus({ exempt: true, docs: [], today: TODAY })).toBe('verified')
  })

  // Passed registration plus unexpired passed insurance verifies.
  it('verifies with passed ownership and unexpired insurance', () => {
    const docs = [doc('registration', 'passed'), doc('insurance', 'passed', '2027-05-01')]
    expect(deriveVehicleStatus({ exempt: false, docs, today: TODAY })).toBe('verified')
  })

  // A rental agreement counts as the ownership document too.
  it('verifies with a rental agreement instead of a registration', () => {
    const docs = [doc('rental_agreement', 'passed'), doc('insurance', 'passed', '2027-05-01')]
    expect(deriveVehicleStatus({ exempt: false, docs, today: TODAY })).toBe('verified')
  })

  // Passed insurance that has since expired does not verify.
  it('does not verify when the passed insurance has expired', () => {
    const docs = [doc('registration', 'passed'), doc('insurance', 'passed', '2026-11-01')]
    expect(deriveVehicleStatus({ exempt: false, docs, today: TODAY })).toBe('pending')
  })

  // Ownership alone is not enough.
  it('stays pending with ownership but no insurance', () => {
    const docs = [doc('registration', 'passed')]
    expect(deriveVehicleStatus({ exempt: false, docs, today: TODAY })).toBe('pending')
  })

  // A failed document flags the vehicle for review.
  it('flags needs_review when any document failed', () => {
    const docs = [doc('registration', 'failed'), doc('insurance', 'passed', '2027-05-01')]
    expect(deriveVehicleStatus({ exempt: false, docs, today: TODAY })).toBe('needs_review')
  })

  // No documents at all is pending.
  it('is pending with no documents', () => {
    expect(deriveVehicleStatus({ exempt: false, docs: [], today: TODAY })).toBe('pending')
  })
})
