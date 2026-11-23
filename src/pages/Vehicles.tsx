import { useCallback, useEffect, useState } from 'react'
import type { FormEvent } from 'react'
import { Alert, Badge, Button, Card, Col, Form, ListGroup, Row } from 'react-bootstrap'
import { Link } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import type {
  DocFields,
  DriverOverview,
  OverviewVehicle,
  VehicleDocType,
} from '../lib/driverVerification'
import {
  deriveVehicleStatus,
  evaluateDocument,
  getDriverOverview,
  getLicenseStatus,
  startLicenseVerification,
  submitVehicleDocument,
  todayIso,
  uploadVehicleDocumentFile,
} from '../lib/driverVerification'

interface Vehicle {
  vehicle_id: string
  make: string
  model: string
  year: number
  seat_count: number
  car_type: string
}

interface DocFormState {
  docType: VehicleDocType
  holderName: string
  vin: string
  expiryDate: string
  file: File | null
  busy: boolean
  message: string
}

// Queries the vehicles table for this user's vehicles.
function fetchVehicles(userId: string) {
  return supabase
    .from('vehicles')
    .select('vehicle_id, make, model, year, seat_count, car_type')
    .eq('user_id', userId)
}

// Blank document-form state for one vehicle.
function blankDocForm(): DocFormState {
  return {
    docType: 'registration',
    holderName: '',
    vin: '',
    expiryDate: '',
    file: null,
    busy: false,
    message: '',
  }
}

// Human label for a document type value.
function docTypeLabel(docType: string) {
  if (docType === 'registration') return 'Registration'
  if (docType === 'rental_agreement') return 'Rental agreement'
  if (docType === 'insurance') return 'Insurance'
  return docType
}

// Badge color for a document or vehicle status value.
function statusVariant(status: string) {
  if (status === 'passed' || status === 'verified') return 'success'
  if (status === 'failed') return 'danger'
  if (status === 'needs_review') return 'warning'
  return 'secondary'
}

// Vehicles page: license verification, the user's vehicles, and each
// vehicle's ownership / insurance document checks.
export default function Vehicles({ userId }: { userId: string }) {
  const [vehicles, setVehicles] = useState<Vehicle[]>([])
  const [overview, setOverview] = useState<DriverOverview | null>(null)
  const [profileName, setProfileName] = useState<string | null>(null)
  const [error, setError] = useState('')
  const [make, setMake] = useState('')
  const [model, setModel] = useState('')
  const [year, setYear] = useState(new Date().getFullYear() - 5)
  const [seatCount, setSeatCount] = useState(5)
  const [carType, setCarType] = useState('sedan')
  const [mpg, setMpg] = useState('')
  const [licenseBusy, setLicenseBusy] = useState(false)
  const [licenseNote, setLicenseNote] = useState('')
  const [docForms, setDocForms] = useState<Record<string, DocFormState>>({})
  const [vinDrafts, setVinDrafts] = useState<Record<string, string>>({})

  // Reloads the user's plain vehicle list into state.
  const loadVehicles = useCallback(async () => {
    const { data, error } = await fetchVehicles(userId)
    if (error) setError(error.message)
    else setVehicles(data as Vehicle[])
  }, [userId])

  // Reloads the verification overview (license state + vehicles with
  // their documents) from the driver-verification function.
  const loadOverview = useCallback(async () => {
    try {
      const data = await getDriverOverview()
      setOverview(data)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load verification state.')
    }
  }, [])

  useEffect(() => {
    fetchVehicles(userId).then(({ data, error }) => {
      if (error) setError(error.message)
      else setVehicles(data as Vehicle[])
    })
    supabase
      .from('users')
      .select('full_name')
      .eq('user_id', userId)
      .single()
      .then(({ data }) => setProfileName((data?.full_name as string | null) ?? null))
    // Sync the license state first (this is where an identity scan that
    // used a driver license gets adopted, and where a finished license
    // scan lands), then load the overview that displays it.
    getLicenseStatus()
      .then((status) => {
        if (status.adoptedFromIdentity) {
          setLicenseNote('Your identity check used a driver license, so this step was already done.')
        }
      })
      .catch(() => undefined)
      .finally(() => loadOverview())
  }, [userId, loadVehicles, loadOverview])

  // Starts the license scan: asks the function for the hosted Stripe
  // URL and sends the browser there, returning to this page afterwards.
  async function startLicense() {
    setLicenseBusy(true)
    setError('')
    try {
      const res = await startLicenseVerification(`${window.location.origin}/vehicles`)
      if (res.url) {
        window.location.href = res.url
        return
      }
      if (res.licenseVerified) {
        setLicenseNote('Your identity check used a driver license, so this step was already done.')
        await loadOverview()
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not start license verification.')
    } finally {
      setLicenseBusy(false)
    }
  }

  // Inserts the form's vehicle for the user, then clears the form and
  // reloads both lists.
  async function add(e: FormEvent) {
    e.preventDefault()
    setError('')
    const { error } = await supabase.from('vehicles').insert({
      user_id: userId,
      make,
      model,
      year,
      seat_count: seatCount,
      car_type: carType,
      mpg: mpg ? Number(mpg) : null,
    })
    if (error) setError(error.message)
    else {
      setMake('')
      setModel('')
      setMpg('')
      loadVehicles()
      loadOverview()
    }
  }

  // Reads one vehicle's document-form state, creating it on first use.
  function docFormFor(vehicleId: string): DocFormState {
    return docForms[vehicleId] ?? blankDocForm()
  }

  // Patches one vehicle's document-form state.
  function patchDocForm(vehicleId: string, patch: Partial<DocFormState>) {
    setDocForms((prev) => ({ ...prev, [vehicleId]: { ...docFormFor(vehicleId), ...patch } }))
  }

  // Stores the file picked for one vehicle's document form.
  function onDocFile(vehicleId: string, file: File | null) {
    patchDocForm(vehicleId, { file })
  }

  // Saves the VIN typed for a vehicle onto the vehicle row.
  async function saveVin(vehicle: OverviewVehicle) {
    const vin = (vinDrafts[vehicle.vehicle_id] ?? '').trim()
    if (!vin) return
    const { error } = await supabase.from('vehicles').update({ vin }).eq('vehicle_id', vehicle.vehicle_id)
    if (error) setError(error.message)
    else loadOverview()
  }

  // Uploads the picked document file, pre-checks the typed fields in
  // the browser, then asks the function to record and verify them.
  async function submitDoc(vehicle: OverviewVehicle, e: FormEvent) {
    e.preventDefault()
    const form = docFormFor(vehicle.vehicle_id)
    if (!form.file) {
      patchDocForm(vehicle.vehicle_id, { message: 'Pick the document photo or scan first.' })
      return
    }
    const fields: DocFields = {
      docType: form.docType,
      holderName: form.holderName.trim(),
      vin: form.vin.trim(),
      expiryDate: form.expiryDate.trim(),
    }
    const precheck = evaluateDocument({
      fields,
      licenseName: overview?.licenseName ?? null,
      profileName,
      vehicleVin: vehicle.vin,
      today: todayIso(),
    })
    if (!precheck.passed) {
      patchDocForm(vehicle.vehicle_id, { message: `Check the fields: ${precheck.problems.join('; ')}.` })
      return
    }
    patchDocForm(vehicle.vehicle_id, { busy: true, message: '' })
    try {
      const storagePath = await uploadVehicleDocumentFile(userId, vehicle.vehicle_id, fields.docType, form.file)
      const result = await submitVehicleDocument({ vehicleId: vehicle.vehicle_id, storagePath, fields })
      patchDocForm(vehicle.vehicle_id, {
        busy: false,
        file: null,
        message: `Saved: ${result.docStatus}. ${result.notes}`,
      })
      loadOverview()
    } catch (err) {
      patchDocForm(vehicle.vehicle_id, {
        busy: false,
        message: err instanceof Error ? err.message : 'Could not save the document.',
      })
    }
  }

  const licenseVerified = overview?.licenseVerified ?? false

  return (
    <>
      <h2 className="mt-4">My vehicles</h2>
      {error && <Alert variant="danger">{error}</Alert>}

      <Card className="mb-3">
        <Card.Body>
          <Card.Title>Driver license</Card.Title>
          {licenseVerified ? (
            <Alert variant="success" className="mb-0">
              License verified
              {overview?.licenseName ? ` — ${overview.licenseName}` : ''}
              {overview?.licenseExpiry ? `, expires ${overview.licenseExpiry}` : ''}.{' '}
              {licenseNote}
            </Alert>
          ) : (
            <>
              <p className="mb-2">
                Before you can add a vehicle, Poolr checks your driver license with Stripe
                Identity. Only a driver license is accepted here; a passport or ID card proves
                who you are, not that you may drive. If your identity check already used a
                driver license, this step completes by itself.
              </p>
              {licenseNote && <Alert variant="info">{licenseNote}</Alert>}
              <Button onClick={startLicense} disabled={licenseBusy}>
                {licenseBusy ? 'Opening…' : 'Verify driver license'}
              </Button>
            </>
          )}
        </Card.Body>
      </Card>

      <ListGroup className="mb-3">
        {vehicles.length === 0 && <ListGroup.Item>No vehicles yet. Add one below.</ListGroup.Item>}
        {vehicles.map((v) => (
          <ListGroup.Item key={v.vehicle_id}>
            {v.year} {v.make} {v.model} ({v.car_type}, {v.seat_count} seats)
          </ListGroup.Item>
        ))}
      </ListGroup>
      {vehicles.length > 0 && (
        <p>
          <Link to="/publish">Next: publish a route →</Link>
        </p>
      )}

      {overview?.vehicles.map((vehicle) => {
        const form = docFormFor(vehicle.vehicle_id)
        const badgeStatus = deriveVehicleStatus({
          exempt: vehicle.documents_exempt,
          docs: vehicle.documents,
          today: todayIso(),
        })
        return (
          <Card key={vehicle.vehicle_id} className="mb-3">
            <Card.Body>
              <Card.Title>
                Documents — {vehicle.year} {vehicle.make} {vehicle.model}{' '}
                <Badge bg={statusVariant(badgeStatus)}>{badgeStatus}</Badge>
              </Card.Title>
              {vehicle.documents_exempt ? (
                <p className="text-muted">
                  This vehicle was added before document checks existed, so its documents count
                  as verified.
                </p>
              ) : (
                <>
                  <p className="mb-2">
                    This vehicle can be used for trips once one ownership document (registration
                    or rental agreement) and valid insurance pass their checks: the name on each
                    document must match your verified name, the VIN must match the vehicle, and
                    insurance must be unexpired. Type the values exactly as printed on the
                    document.
                  </p>
                  <Row className="g-2 align-items-end mb-3">
                    <Col md={8}>
                      <Form.Label className="small mb-0">Vehicle VIN</Form.Label>
                      <Form.Control
                        placeholder={vehicle.vin ?? 'e.g. 1HGCM82633A004352'}
                        value={vinDrafts[vehicle.vehicle_id] ?? ''}
                        onChange={(e) =>
                          setVinDrafts((prev) => ({ ...prev, [vehicle.vehicle_id]: e.target.value }))
                        }
                      />
                    </Col>
                    <Col md={4}>
                      <Button variant="outline-primary" onClick={() => saveVin(vehicle)}>
                        Save VIN
                      </Button>
                    </Col>
                  </Row>
                  <ListGroup className="mb-3">
                    {vehicle.documents.length === 0 && (
                      <ListGroup.Item>No documents submitted yet.</ListGroup.Item>
                    )}
                    {vehicle.documents.map((doc) => (
                      <ListGroup.Item key={doc.doc_id}>
                        {docTypeLabel(doc.doc_type)} — <Badge bg={statusVariant(doc.check_status)}>{doc.check_status}</Badge>
                        {doc.expiry_date ? ` · expires ${doc.expiry_date}` : ''}
                        {doc.check_notes ? <div className="small text-muted">{doc.check_notes}</div> : null}
                      </ListGroup.Item>
                    ))}
                  </ListGroup>
                  <Form onSubmit={(e) => submitDoc(vehicle, e)}>
                    <Row className="g-2">
                      <Col md={4}>
                        <Form.Label className="small mb-0">Document type</Form.Label>
                        <Form.Select
                          value={form.docType}
                          onChange={(e) =>
                            patchDocForm(vehicle.vehicle_id, { docType: e.target.value as VehicleDocType })
                          }
                        >
                          <option value="registration">Registration (I own it)</option>
                          <option value="rental_agreement">Rental agreement (I rent it)</option>
                          <option value="insurance">Insurance</option>
                        </Form.Select>
                      </Col>
                      <Col md={4}>
                        <Form.Label className="small mb-0">Document file</Form.Label>
                        <Form.Control
                          type="file"
                          accept="image/*,.pdf"
                          onChange={(e) => onDocFile(vehicle.vehicle_id, (e.target as HTMLInputElement).files?.[0] ?? null)}
                        />
                      </Col>
                      <Col md={4}>
                        <Form.Label className="small mb-0">Name printed on the document</Form.Label>
                        <Form.Control
                          required
                          value={form.holderName}
                          onChange={(e) => patchDocForm(vehicle.vehicle_id, { holderName: e.target.value })}
                        />
                      </Col>
                      <Col md={4}>
                        <Form.Label className="small mb-0">VIN printed on the document</Form.Label>
                        <Form.Control
                          required
                          value={form.vin}
                          onChange={(e) => patchDocForm(vehicle.vehicle_id, { vin: e.target.value })}
                        />
                      </Col>
                      <Col md={4}>
                        <Form.Label className="small mb-0">
                          Expiry date {form.docType === 'insurance' ? '(required for insurance)' : '(if shown)'}
                        </Form.Label>
                        <Form.Control
                          type="date"
                          value={form.expiryDate}
                          onChange={(e) => patchDocForm(vehicle.vehicle_id, { expiryDate: e.target.value })}
                        />
                      </Col>
                    </Row>
                    {form.message && (
                      <Alert variant="info" className="mt-2 mb-0">
                        {form.message}
                      </Alert>
                    )}
                    <Button type="submit" className="mt-3" disabled={form.busy}>
                      {form.busy ? 'Checking…' : 'Submit document'}
                    </Button>
                  </Form>
                </>
              )}
            </Card.Body>
          </Card>
        )
      })}

      {licenseVerified ? (
        <Card>
          <Card.Body>
            <Card.Title>Add a vehicle</Card.Title>
            <Form onSubmit={add}>
              <Row className="g-2">
                <Col md={4}>
                  <Form.Control placeholder="Make (Toyota)" required value={make} onChange={(e) => setMake(e.target.value)} />
                </Col>
                <Col md={4}>
                  <Form.Control placeholder="Model (Camry)" required value={model} onChange={(e) => setModel(e.target.value)} />
                </Col>
                <Col md={4}>
                  <Form.Control type="number" min={1980} max={2100} required value={year} onChange={(e) => setYear(Number(e.target.value))} />
                </Col>
                <Col md={4}>
                  <Form.Label className="small mb-0">Seats (including driver)</Form.Label>
                  <Form.Control type="number" min={2} max={12} required value={seatCount} onChange={(e) => setSeatCount(Number(e.target.value))} />
                </Col>
                <Col md={4}>
                  <Form.Label className="small mb-0">Type</Form.Label>
                  <Form.Select value={carType} onChange={(e) => setCarType(e.target.value)}>
                    <option value="sedan">Sedan</option>
                    <option value="suv">SUV</option>
                    <option value="coupe">Coupe</option>
                    <option value="van">Van</option>
                  </Form.Select>
                </Col>
                <Col md={4}>
                  <Form.Label className="small mb-0">MPG (optional)</Form.Label>
                  <Form.Control type="number" step="0.1" min={1} value={mpg} onChange={(e) => setMpg(e.target.value)} />
                </Col>
              </Row>
              <Button type="submit" className="mt-3">Add vehicle</Button>
            </Form>
          </Card.Body>
        </Card>
      ) : (
        <Alert variant="warning">
          Verify your driver license above to add a vehicle.
        </Alert>
      )}
    </>
  )
}
