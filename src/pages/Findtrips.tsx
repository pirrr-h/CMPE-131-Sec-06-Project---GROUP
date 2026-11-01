// FindTrips — the rider's find-a-trip and request-a-seat page.
//
// What this page does:
//   A rider enters where they are leaving from, where they are going,
//   roughly when, and how many seats they need. The page geocodes both
//   addresses (the same Mapbox helper PublishRoute uses) and asks the
//   database for matching published trips:
//     - find_drivers_for_route(origin, destination, departure, seats,
//       radius, window) -> ranked matches. The function itself enforces
//       the matching rules (posted trips only, enough seats, departure
//       inside the time window, both endpoints inside the radius, the
//       two-way preference / rating / age filters) and returns AREA
//       labels plus rounded coordinates only — a driver’s exact
//       addresses unlock after they accept the request.
//   Each match gets a "Request seat" button:
//     - a plain insert into trip_requests with rider_id = the caller
//       and the pickup set to the rider's own "From" address. The
//       database sets the fare (fare_per_seat x seats) before insert,
//       checks seat capacity and preference compatibility, and the
//       driver then answers from their Requests page
//       (respond_to_request) — accepting is what later lets the rider
//       place the payment hold.
//   Under the results, "My requests" lists the rider's own requests:
//     - list_my_requests() -> status, fare, driver and route labels
//       (exact addresses only once accepted).
//     - cancel_request(request_id, reason) -> the Cancel button. A
//       reason is required for an accepted request; cancelling queues
//       the refund-policy release job for any held payment.

import { useCallback, useEffect, useState } from 'react'
import type { FormEvent } from 'react'
import { Alert, Badge, Button, Card, Col, Form, ListGroup, Row, Spinner } from 'react-bootstrap'
import { geocode } from '../lib/geocode'
import type { Place } from '../lib/geocode'
import { supabase } from '../lib/supabase'

// One row of find_drivers_for_route(). Field names match the function's
// RETURNS TABLE exactly. The numeric columns arrive as strings from
// Postgres numerics, so they are typed string | number and converted
// with Number() when displayed. origin_area / destination_area are the
// only location labels — exact addresses are never returned here.
interface MatchRow {
  trip_id: string
  driver_id: string
  driver_name: string | null
  driver_rating: number | string | null
  vehicle_make: string | null
  vehicle_model: string | null
  car_type: string | null
  departure_time: string
  available_seats: number
  origin_area: string | null
  destination_area: string | null
  origin_distance_miles: number | string | null
  dest_distance_miles: number | string | null
  minutes_apart: number | string | null
  match_score: number | string | null
}

// One row of list_my_requests() (the fields this page shows). Labels
// are area strings until the request is accepted, then exact addresses.
interface MyRequestRow {
  request_id: string
  trip_id: string
  request_status: string
  trip_status: string
  seat_requested: number
  fare_amount: number | string | null
  departure_time: string
  driver_name: string | null
  driver_rating: number | string | null
  vehicle_make: string | null
  vehicle_model: string | null
  origin_label: string | null
  destination_label: string | null
  cancel_reason: string | null
}

// Badge colour per request status — same mapping as the driver's
// TripRequests page, so a status looks identical on both sides.
function statusVariant(status: string): string {
  switch (status) {
    case 'accepted': return 'success'
    case 'pending': return 'warning'
    case 'declined': return 'secondary'
    case 'cancelled': return 'dark'
    case 'completed': return 'primary'
    default: return 'info'
  }
}

// defaultDeparture: the search form's starting departure value — one
// hour from now, formatted for a datetime-local input in local time.
function defaultDeparture(): string {
  const d = new Date(Date.now() + 60 * 60 * 1000)
  const local = new Date(d.getTime() - d.getTimezoneOffset() * 60 * 1000)
  return local.toISOString().slice(0, 16)
}

export default function FindTrips({ userId }: { userId: string }) {
  const [origin, setOrigin] = useState('')
  const [destination, setDestination] = useState('')
  const [departure, setDeparture] = useState(defaultDeparture)
  const [seats, setSeats] = useState(1)
  const [radius, setRadius] = useState(5)
  const [matches, setMatches] = useState<MatchRow[]>([])
  const [searched, setSearched] = useState(false)
  const [searching, setSearching] = useState(false)
  const [myRequests, setMyRequests] = useState<MyRequestRow[]>([])
  const [error, setError] = useState('')
  const [success, setSuccess] = useState('')
  // The trip_id a request insert is currently running for.
  const [requestingId, setRequestingId] = useState<string | null>(null)
  // The request_id a cancel is currently running for.
  const [cancellingId, setCancellingId] = useState<string | null>(null)
  // The rider's geocoded "From" place from the last search — it becomes
  // the pickup on any request sent from those results.
  const [pickup, setPickup] = useState<Place | null>(null)

  // loadMyRequests: (re)fetches the rider's own requests. Called on
  // first load, and again after a request is sent or cancelled so the
  // list and the already-requested buttons stay current.
  const loadMyRequests = useCallback(async () => {
    const { data, error } = await supabase.rpc('list_my_requests')
    if (error) {
      setError(error.message)
      return
    }
    setMyRequests((data as MyRequestRow[]) ?? [])
  }, [])

  // First load: my existing requests (also drives which match buttons
  // show "Requested" instead of "Request seat").
  useEffect(() => {
    let cancelled = false
    supabase.rpc('list_my_requests').then(({ data, error }) => {
      if (cancelled) return
      if (error) {
        setError(error.message)
        return
      }
      setMyRequests((data as MyRequestRow[]) ?? [])
    })
    return () => { cancelled = true }
  }, [])

  // Trips I already have a live (pending or accepted) request on — a
  // second request for the same trip would just be refused or duplicate.
  const liveRequestByTrip = new Map(
    myRequests
      .filter((r) => r.request_status === 'pending' || r.request_status === 'accepted')
      .map((r) => [r.trip_id, r.request_status]),
  )

  // search: the Find trips form. Geocodes both addresses, then calls
  // find_drivers_for_route with a ±120-minute departure window (wide
  // enough to catch a trip leaving a little earlier or later than the
  // rider typed) and keeps the geocoded origin as the pickup for any
  // request sent from the results.
  async function search(e: FormEvent) {
    e.preventDefault()
    setError('')
    setSuccess('')
    setSearching(true)
    try {
      const from = await geocode(origin)
      const to = await geocode(destination)
      const { data, error } = await supabase.rpc('find_drivers_for_route', {
        p_origin_lat: from.latitude,
        p_origin_lng: from.longitude,
        p_dest_lat: to.latitude,
        p_dest_lng: to.longitude,
        p_departure: new Date(departure).toISOString(),
        p_seats: seats,
        p_radius_miles: radius,
        p_window_minutes: 120,
        p_limit: 20,
      })
      if (error) throw new Error(error.message)
      setPickup(from)
      setMatches((data as MatchRow[]) ?? [])
      setSearched(true)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong.')
    }
    setSearching(false)
  }

  // requestSeat: the Request seat button on a match. Inserts the
  // rider's request row (pickup = the rider's own From address from
  // this search); the database fills in fare_amount from the trip's
  // fare_per_seat and enforces capacity/preference rules. The driver
  // sees the request on their Requests page and accepts or declines.
  async function requestSeat(match: MatchRow) {
    if (!pickup) return
    setError('')
    setSuccess('')
    setRequestingId(match.trip_id)
    const { error } = await supabase.from('trip_requests').insert({
      trip_id: match.trip_id,
      rider_id: userId,
      seat_requested: seats,
      pick_up_address: pickup.address,
      pick_up_latitude: pickup.latitude,
      pick_up_longitude: pickup.longitude,
    })
    if (error) {
      setError(error.message)
    } else {
      setSuccess('Request sent! The driver will see it on their Requests page.')
      await loadMyRequests()
    }
    setRequestingId(null)
  }

  // cancelMine: the Cancel button on one of my requests. Asks for a
  // reason first (the database requires one for an accepted request),
  // then calls cancel_request — it frees the seat and queues the
  // refund-policy release job for any held payment, so a paid hold
  // comes back through the drainer at the policy percent.
  async function cancelMine(req: MyRequestRow) {
    const reason = window.prompt('Reason for cancelling this request (the driver will see it):', '')
    if (reason === null) return
    if (req.request_status === 'accepted' && reason.trim() === '') {
      setError('A reason is required to cancel an accepted request.')
      return
    }
    setError('')
    setSuccess('')
    setCancellingId(req.request_id)
    const { error } = await supabase.rpc('cancel_request', {
      p_request_id: req.request_id,
      p_reason: reason.trim() === '' ? null : reason.trim(),
    })
    if (error) setError(error.message)
    else await loadMyRequests()
    setCancellingId(null)
  }

  return (
    <>
      <h2 className="mt-4">Find a trip</h2>
      {error && <Alert variant="danger">{error}</Alert>}
      {success && <Alert variant="success">{success}</Alert>}

      <Card className="mb-4">
        <Card.Body>
          <Form onSubmit={search}>
            <Row className="g-3">
              <Col md={6}>
                <Form.Label>From (your pickup)</Form.Label>
                <Form.Control required placeholder="e.g. 1 Washington Sq, San Jose" value={origin} onChange={(e) => setOrigin(e.target.value)} />
              </Col>
              <Col md={6}>
                <Form.Label>To</Form.Label>
                <Form.Control required placeholder="e.g. 50 Phelan Ave, San Francisco" value={destination} onChange={(e) => setDestination(e.target.value)} />
              </Col>
              <Col md={4}>
                <Form.Label>Departure around</Form.Label>
                <Form.Control type="datetime-local" required value={departure} onChange={(e) => setDeparture(e.target.value)} />
              </Col>
              <Col md={4}>
                <Form.Label>Seats</Form.Label>
                <Form.Control type="number" min={1} max={8} required value={seats} onChange={(e) => setSeats(Number(e.target.value))} />
              </Col>
              <Col md={4}>
                <Form.Label>Search radius (miles)</Form.Label>
                <Form.Control type="number" min={1} max={25} required value={radius} onChange={(e) => setRadius(Number(e.target.value))} />
              </Col>
            </Row>
            <Button type="submit" className="mt-3" disabled={searching}>
              {searching ? 'Searching…' : 'Find trips'}
            </Button>
          </Form>
        </Card.Body>
      </Card>

      {searched && (
        <>
          <h3>Matching trips</h3>
          {matches.length === 0 ? (
            <Alert variant="info">
              No published trips match that route and time yet. Try a wider radius or a
              departure closer to a posted trip.
            </Alert>
          ) : (
            matches.map((m) => {
              const liveStatus = liveRequestByTrip.get(m.trip_id)
              return (
                <Card key={m.trip_id} className="mb-3">
                  <Card.Body className="d-flex justify-content-between align-items-center">
                    <div>
                      <strong>{m.origin_area ?? 'Pickup area'}</strong> → <strong>{m.destination_area ?? 'Destination area'}</strong>{' '}
                      {m.match_score != null && <Badge bg="info">match {Number(m.match_score).toFixed(0)}</Badge>}
                      <div className="text-muted" style={{ fontSize: '0.9em' }}>
                        Driver {m.driver_name ?? '—'}
                        {m.driver_rating != null && <> · ★ {Number(m.driver_rating).toFixed(1)}</>}
                        {(m.vehicle_make || m.vehicle_model) && <> · {m.vehicle_make} {m.vehicle_model}</>}
                      </div>
                      <div style={{ fontSize: '0.9em' }}>
                        Departs {new Date(m.departure_time).toLocaleString()} · {m.available_seats} seat(s) open
                        {m.origin_distance_miles != null && <> · pickup {Number(m.origin_distance_miles).toFixed(1)} mi away</>}
                        {m.dest_distance_miles != null && <> · drop-off {Number(m.dest_distance_miles).toFixed(1)} mi away</>}
                      </div>
                    </div>
                    {liveStatus ? (
                      <Badge bg={statusVariant(liveStatus)}>Requested · {liveStatus}</Badge>
                    ) : (
                      <Button
                        variant="success"
                        disabled={requestingId === m.trip_id}
                        onClick={() => requestSeat(m)}
                      >
                        {requestingId === m.trip_id ? 'Sending…' : 'Request seat'}
                      </Button>
                    )}
                  </Card.Body>
                </Card>
              )
            })
          )}
        </>
      )}

      <h3 className="mt-4">My requests</h3>
      {myRequests.length === 0 ? (
        <p className="text-muted">
          {searched ? 'No requests yet — send one from the matches above.' : 'No requests yet.'}
        </p>
      ) : (
        <ListGroup>
          {myRequests.map((r) => (
            <ListGroup.Item key={r.request_id} className="d-flex justify-content-between align-items-center">
              <div>
                <div>
                  <strong>{r.origin_label ?? 'Pickup'}</strong> → <strong>{r.destination_label ?? 'Destination'}</strong>{' '}
                  <Badge bg={statusVariant(r.request_status)}>{r.request_status}</Badge>{' '}
                  <Badge bg={r.trip_status === 'posted' ? 'success' : 'secondary'}>trip {r.trip_status}</Badge>
                </div>
                <small className="text-muted">
                  Driver {r.driver_name ?? '—'} · departs {new Date(r.departure_time).toLocaleString()} ·{' '}
                  {r.seat_requested} seat(s)
                  {r.fare_amount != null && <> · fare ${Number(r.fare_amount).toFixed(2)}</>}
                  {r.cancel_reason && <> · {r.cancel_reason}</>}
                </small>
              </div>
              {(r.request_status === 'pending' || r.request_status === 'accepted')
                && (r.trip_status === 'posted' || r.trip_status === 'in_progress') && (
                <Button
                  size="sm"
                  variant="outline-danger"
                  disabled={cancellingId === r.request_id}
                  onClick={() => cancelMine(r)}
                >
                  {cancellingId === r.request_id ? 'Cancelling…' : 'Cancel'}
                </Button>
              )}
            </ListGroup.Item>
          ))}
        </ListGroup>
      )}

      {searching && (
        <p className="mt-3">
          <Spinner animation="border" size="sm" /> Searching…
        </p>
      )}
    </>
  )
}
