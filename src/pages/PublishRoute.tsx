import { useCallback, useEffect, useMemo, useState } from 'react'
import type { FormEvent } from 'react'
import { Alert, Badge, Button, Card, Col, Form, ListGroup, Row } from 'react-bootstrap'
import { Link } from 'react-router-dom'
import MapView from '../components/MapView'
import type { MapPin } from '../components/MapView'
import { geocode, getRoute } from '../lib/geocode'
import { supabase } from '../lib/supabase'

interface Vehicle {
  vehicle_id: string
  make: string
  model: string
  seat_count: number
}

interface Trip {
  trip_id: string
  trip_status: string
  departure_time: string
  available_seats: number
  origin_address: string
  destination_address: string
  origin_latitude: number | null
  origin_longitude: number | null
  destination_latitude: number | null
  destination_longitude: number | null
  route_polyline: string | null
}

function fetchTrips(userId: string) {
  return supabase
    .from('trips')
        .select(
      'trip_id, trip_status, departure_time, available_seats, origin_address, destination_address, origin_latitude, origin_longitude, destination_latitude, destination_longitude, route_polyline',
    )
    .eq('creator_id', userId)
    .order('departure_time', { ascending: false })
}

export default function PublishRoute({ userId }: { userId: string }) {
  const [vehicles, setVehicles] = useState<Vehicle[]>([])
  const [trips, setTrips] = useState<Trip[]>([])
  const [vehicleId, setVehicleId] = useState('')
  const [origin, setOrigin] = useState('')
  const [destination, setDestination] = useState('')
  const [departure, setDeparture] = useState('')
  const [seats, setSeats] = useState(1)
  const [error, setError] = useState('')
  const [success, setSuccess] = useState('')
  const [busy, setBusy] = useState(false)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const shownTrip = trips.find((t) => t.trip_id === selectedId) ?? trips[0]

  const pins = useMemo<MapPin[]>(() => {
    if (
      !shownTrip ||
      shownTrip.origin_latitude == null ||
      shownTrip.origin_longitude == null ||
      shownTrip.destination_latitude == null ||
      shownTrip.destination_longitude == null
    ) {
      return []
    }
    return [
      {
        lat: shownTrip.origin_latitude,
        lng: shownTrip.origin_longitude,
        label: `From: ${shownTrip.origin_address}`,
        color: '#16a34a',
      },
      {
        lat: shownTrip.destination_latitude,
        lng: shownTrip.destination_longitude,
        label: `To: ${shownTrip.destination_address}`,
        color: '#dc2626',
      },
    ]
  }, [shownTrip])

  const loadTrips = useCallback(async () => {
    const { data } = await fetchTrips(userId)
    setTrips((data as Trip[]) ?? [])
  }, [userId])

  useEffect(() => {
    supabase
      .from('vehicles')
      .select('vehicle_id, make, model, seat_count')
      .eq('user_id', userId)
      .then(({ data }) => {
        const list = (data as Vehicle[]) ?? []
        setVehicles(list)
        if (list[0]) setVehicleId(list[0].vehicle_id)
      })
    fetchTrips(userId).then(({ data }) => setTrips((data as Trip[]) ?? []))
  }, [userId])

  const vehicle = vehicles.find((v) => v.vehicle_id === vehicleId)
  const maxSeats = vehicle ? Math.max(1, vehicle.seat_count - 1) : 1

  async function publish(e: FormEvent) {
    e.preventDefault()
    setError('')
    setSuccess('')
    if (new Date(departure).getTime() <= Date.now()) {
      setError('Departure time must be in the future.')
      return
    }
    setBusy(true)
    try {
      const from = await geocode(origin)
      const to = await geocode(destination)
      const route = await getRoute(from, to)
      const { error } = await supabase.from('trips').insert({
        creator_id: userId,
        vehicle_id: vehicleId,
        departure_time: new Date(departure).toISOString(),
        available_seats: seats,
        origin_address: from.address,
        origin_latitude: from.latitude,
        origin_longitude: from.longitude,
        destination_address: to.address,
        destination_latitude: to.latitude,
        destination_longitude: to.longitude,
        route_polyline: route?.polyline ?? null,
        total_distance: route?.distanceMiles ?? null,
        estimated_duration: route?.durationMinutes ?? null,
      })
      if (error) throw new Error(error.message)
      setSuccess('Route published! Riders nearby can now find it.')
      setOrigin('')
      setDestination('')
      loadTrips()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong.')
    }
    setBusy(false)
  }

  async function cancelTrip(tripId: string) {
    const { error } = await supabase.from('trips').update({ trip_status: 'cancelled' }).eq('trip_id', tripId)
    if (error) setError(error.message)
    else loadTrips()
  }

  if (vehicles.length === 0) {
    return (
      <Alert variant="info" className="mt-4">
        You need a vehicle before you can publish a route. <Link to="/vehicles">Add one here</Link>.
      </Alert>
    )
  }

  return (
    <>
      <h2 className="mt-4">Publish a route</h2>
      {error && <Alert variant="danger">{error}</Alert>}
      {success && <Alert variant="success">{success}</Alert>}
      <Card className="mb-4">
        <Card.Body>
          <Form onSubmit={publish}>
            <Row className="g-3">
              <Col md={6}>
                <Form.Label>Vehicle</Form.Label>
                <Form.Select
                  value={vehicleId}
                  onChange={(e) => {
                    setVehicleId(e.target.value)
                    setSeats(1)
                  }}
                >
                  {vehicles.map((v) => (
                    <option key={v.vehicle_id} value={v.vehicle_id}>
                      {v.make} {v.model}
                    </option>
                  ))}
                </Form.Select>
              </Col>
              <Col md={6}>
                <Form.Label>Open seats for riders (max {maxSeats})</Form.Label>
                <Form.Control type="number" min={1} max={maxSeats} required value={seats} onChange={(e) => setSeats(Number(e.target.value))} />
              </Col>
              <Col md={6}>
                <Form.Label>From</Form.Label>
                <Form.Control required placeholder="e.g. 50 Phelan Ave, San Francisco" value={origin} onChange={(e) => setOrigin(e.target.value)} />
              </Col>
              <Col md={6}>
                <Form.Label>To</Form.Label>
                <Form.Control required placeholder="e.g. 1 Washington Sq, San Jose" value={destination} onChange={(e) => setDestination(e.target.value)} />
              </Col>
              <Col md={6}>
                <Form.Label>Departure</Form.Label>
                <Form.Control type="datetime-local" required value={departure} onChange={(e) => setDeparture(e.target.value)} />
              </Col>
            </Row>
            <Button type="submit" className="mt-3" disabled={busy}>
              {busy ? 'Publishing…' : 'Publish route'}
            </Button>
          </Form>
        </Card.Body>
      </Card>

      <h3>My published routes</h3>
      {shownTrip && (
        <Card className="mb-3">
          <Card.Body>
            <MapView pins={pins} routePolyline={shownTrip.route_polyline} height={320} />
          </Card.Body>
        </Card>
      )}
      <ListGroup>
        {trips.length === 0 && <ListGroup.Item>Nothing published yet.</ListGroup.Item>}
        {trips.map((t) => (
          <ListGroup.Item
            key={t.trip_id}
            className="d-flex justify-content-between align-items-center"
            active={t.trip_id === shownTrip?.trip_id}
            onClick={() => setSelectedId(t.trip_id)}
            style={{ cursor: 'pointer' }}
          >
            <div>
              <div>
                {t.origin_address} → {t.destination_address}
              </div>
              <small className="text-muted">
                {new Date(t.departure_time).toLocaleString()} · {t.available_seats} seats left{' '}
                <Badge bg={t.trip_status === 'posted' ? 'success' : 'secondary'}>{t.trip_status}</Badge>
              </small>
            </div>
            {t.trip_status === 'posted' && (
              <Button
                size="sm"
                variant="outline-danger"
                onClick={(e) => {
                  e.stopPropagation()
                  cancelTrip(t.trip_id)
                }}
              >
                Cancel
              </Button>
            )}
          </ListGroup.Item>
        ))}
      </ListGroup>
    </>
  )
}
