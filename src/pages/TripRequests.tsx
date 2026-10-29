// TripRequests — the driver's incoming-requests page.
//
// What this page does:
//   Lists every trip the signed-in driver has published, and under each
//   trip the seat requests riders have sent for it. Pending requests get
//   Accept / Decline buttons; everything else is shown as a status badge.
//   All data comes from the database functions built for exactly this:
//     - list_trip_requests(trip_id)  -> the requests on one of MY trips
//       (the function itself refuses if the trip is not the caller's).
//       Pickup privacy is handled inside it: a pending request shows only
//       the rider's approximate area; the exact pickup address unlocks
//       once the request is accepted.
//     - respond_to_request(request_id, accept) -> accept or decline.
//       Accepting is what later lets the rider place a payment hold
//       (payment-service requires an accepted request), and the function
//       enforces the trip's seat capacity, so over-accepting is refused
//       by the database, not by this page.
//   The trips themselves are read with the same query PublishRoute uses.

import { useCallback, useEffect, useState } from 'react'
import { Alert, Badge, Button, Card, ListGroup, Spinner } from 'react-bootstrap'
import { Link } from 'react-router-dom'
import { supabase } from '../lib/supabase'

interface Trip {
  trip_id: string
  trip_status: string
  departure_time: string
  available_seats: number
  origin_address: string
  destination_address: string
}

// One row of list_trip_requests(). Field names match the function's
// RETURNS TABLE exactly. rider_rating is null for a rider with no
// completed rated trips yet; pick_up_label is the approximate area until
// the request is accepted, then the exact pickup address.
interface TripRequestRow {
  request_id: string
  rider_id: string
  rider_name: string | null
  rider_rating: number | null
  seat_requested: number
  fare_amount: number | null
  request_status: string
  pick_up_label: string | null
  is_exact: boolean
  rider_reconfirmed: boolean
  rider_at_pickup: boolean
  created_at: string
}

// Badge colour per request status, matching the trip-status colours used
// elsewhere in the app.
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

export default function TripRequests({ userId }: { userId: string }) {
  const [trips, setTrips] = useState<Trip[]>([])
  // Requests grouped by trip_id, loaded with the trips.
  const [requestsByTrip, setRequestsByTrip] = useState<Record<string, TripRequestRow[]>>({})
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  // The request_id currently being accepted/declined, so only its buttons spin.
  const [busyId, setBusyId] = useState<string | null>(null)

  // loadRequests: (re)fetches the request list for one trip. Called on
  // first load for every trip, and again for a single trip after an
  // accept/decline so the row's status updates in place.
  const loadRequests = useCallback(async (tripId: string) => {
    const { data, error } = await supabase.rpc('list_trip_requests', { p_trip_id: tripId })
    if (error) {
      setError(error.message)
      return
    }
    setRequestsByTrip((prev) => ({ ...prev, [tripId]: (data as TripRequestRow[]) ?? [] }))
  }, [])

  // First load: my trips (same select as PublishRoute), then each trip's
  // requests.
  useEffect(() => {
    let cancelled = false
    supabase
      .from('trips')
      .select('trip_id, trip_status, departure_time, available_seats, origin_address, destination_address')
      .eq('creator_id', userId)
      .order('departure_time', { ascending: false })
      .then(async ({ data, error }) => {
        if (cancelled) return
        if (error) {
          setError(error.message)
          setLoading(false)
          return
        }
        const list = (data as Trip[]) ?? []
        setTrips(list)
        await Promise.all(list.map((t) => loadRequests(t.trip_id)))
        if (!cancelled) setLoading(false)
      })
    return () => { cancelled = true }
  }, [userId, loadRequests])

  // respond: the Accept / Decline buttons. Calls respond_to_request with
  // the driver's session (the function checks the caller owns the trip),
  // then reloads that trip's requests so the new status shows.
  async function respond(tripId: string, requestId: string, accept: boolean) {
    setError('')
    setBusyId(requestId)
    const { error } = await supabase.rpc('respond_to_request', {
      p_request_id: requestId,
      p_accept: accept,
    })
    if (error) setError(error.message)
    else await loadRequests(tripId)
    setBusyId(null)
  }

  if (loading) {
    return (
      <p className="mt-4">
        <Spinner animation="border" size="sm" /> Loading your trips and requests…
      </p>
    )
  }

  if (trips.length === 0) {
    return (
      <Alert variant="info" className="mt-4">
        You have not published any routes yet, so there are no requests to show.{' '}
        <Link to="/publish">Publish a route first</Link>.
      </Alert>
    )
  }

  return (
    <>
      <h2 className="mt-4">Trip requests</h2>
      {error && <Alert variant="danger">{error}</Alert>}

      {trips.map((trip) => {
        const requests = requestsByTrip[trip.trip_id] ?? []
        return (
          <Card key={trip.trip_id} className="mb-3">
            <Card.Header>
              <strong>{trip.origin_address}</strong> → <strong>{trip.destination_address}</strong>{' '}
              <Badge bg={trip.trip_status === 'posted' ? 'success' : 'secondary'}>{trip.trip_status}</Badge>
              <div className="text-muted" style={{ fontSize: '0.9em' }}>
                Departs {new Date(trip.departure_time).toLocaleString()} · {trip.available_seats} seat(s) open
              </div>
            </Card.Header>
            {requests.length === 0 ? (
              <Card.Body className="text-muted">No requests yet for this trip.</Card.Body>
            ) : (
              <ListGroup variant="flush">
                {requests.map((r) => (
                  <ListGroup.Item key={r.request_id} className="d-flex justify-content-between align-items-center">
                    <div>
                      <strong>{r.rider_name ?? 'Rider'}</strong>{' '}
                      {r.rider_rating != null
                        ? <span className="text-muted">★ {Number(r.rider_rating).toFixed(1)}</span>
                        : <span className="text-muted">(new rider)</span>}
                      <div style={{ fontSize: '0.9em' }}>
                        {r.seat_requested} seat(s)
                        {r.fare_amount != null && <> · fare ${Number(r.fare_amount).toFixed(2)}</>}
                        {r.pick_up_label && (
                          <> · pickup: {r.pick_up_label}{!r.is_exact && ' (approximate until accepted)'}</>
                        )}
                      </div>
                      <div>
                        <Badge bg={statusVariant(r.request_status)}>{r.request_status}</Badge>{' '}
                        {r.rider_reconfirmed && <Badge bg="info">reconfirmed</Badge>}{' '}
                        {r.rider_at_pickup && <Badge bg="primary">at pickup</Badge>}
                      </div>
                    </div>
                    {r.request_status === 'pending' && trip.trip_status === 'posted' && (
                      <div className="d-flex gap-2">
                        <Button
                          size="sm"
                          variant="success"
                          disabled={busyId === r.request_id}
                          onClick={() => respond(trip.trip_id, r.request_id, true)}
                        >
                          {busyId === r.request_id ? 'Working…' : 'Accept'}
                        </Button>
                        <Button
                          size="sm"
                          variant="outline-danger"
                          disabled={busyId === r.request_id}
                          onClick={() => respond(trip.trip_id, r.request_id, false)}
                        >
                          Decline
                        </Button>
                      </div>
                    )}
                  </ListGroup.Item>
                ))}
              </ListGroup>
            )}
          </Card>
        )
      })}
    </>
  )
}
