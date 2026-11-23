import { useCallback, useEffect, useState } from 'react'
import { Alert, Badge, Button, Card, Col, Row, Spinner } from 'react-bootstrap'
import { Link, useNavigate } from 'react-router-dom'
import HomeMap, { type HomeMapMarker } from '../components/HomeMap'
import type { Profile } from '../lib/useProfile'
import { supabase } from '../lib/supabase'

interface HomeProps {
  userId: string
  profile: Profile | null
}

interface RiderRoute {
  route_id: string
  rider_id: string
  departure_time: string
  seats_needed: number
  search_radius_miles: number
  origin_address: string
  origin_latitude: number
  origin_longitude: number
  destination_address: string
  destination_latitude: number
  destination_longitude: number
}

interface DriverMatch {
  trip_id: string
  driver_id: string
  driver_name: string | null
  driver_rating: number | null
  vehicle_make: string
  vehicle_model: string
  departure_time: string
  available_seats: number
  approx_origin_lat: number
  approx_origin_lng: number
  origin_distance_miles: number
  dest_distance_miles: number
  minutes_apart: number
  match_score: number
}

interface RiderMatch {
  route_id: string
  rider_id: string
  rider_name: string | null
  rider_rating: number | null
  departure_time: string
  seats_needed: number
  approx_origin_lat: number
  approx_origin_lng: number
  origin_distance_miles: number
  dest_distance_miles: number
  minutes_apart: number
  match_score: number
}

interface PublishedTrip {
  trip_id: string
  departure_time: string
  available_seats: number
  origin_address: string
  destination_address: string
}

type Mode = 'rider' | 'driver'

export default function Home({ userId, profile }: HomeProps) {
  const navigate = useNavigate()

  const canRide =
    profile?.role === 'rider' ||
    profile?.role === 'both' ||
    profile?.role === 'admin'

  const canDrive =
    profile?.role === 'driver' ||
    profile?.role === 'both' ||
    profile?.role === 'admin'

  const defaultMode: Mode | null =
    profile?.role === 'rider' ? 'rider' :
    profile?.role === 'driver' ? 'driver' :
    null

  const [mode, setMode] = useState<Mode | null>(defaultMode)
  const [route, setRoute] = useState<RiderRoute | null>(null)
  const [driverMatches, setDriverMatches] = useState<DriverMatch[]>([])
  const [riderMatches, setRiderMatches] = useState<RiderMatch[]>([])
  const [requestedTripIds, setRequestedTripIds] = useState<string[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [success, setSuccess] = useState('')

  const loadRiderMatches = useCallback(async () => {
    setLoading(true)
    setError('')
    setSuccess('')

    const { data: routeData, error: routeError } = await supabase
      .from('rider_routes')
      .select(
        'route_id, rider_id, departure_time, seats_needed, search_radius_miles, ' +
          'origin_address, origin_latitude, origin_longitude, ' +
          'destination_address, destination_latitude, destination_longitude',
      )
      .eq('rider_id', userId)
      .eq('route_status', 'open')
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle()

    if (routeError) {
      setError(routeError.message)
      setLoading(false)
      return
    }

    if (!routeData) {
      setRoute(null)
      setDriverMatches([])
      setLoading(false)
      return
    }

    const currentRoute = routeData as unknown as RiderRoute
    setRoute(currentRoute)

    const { data, error: matchError } = await supabase.rpc(
      'find_drivers_for_route',
      {
        p_origin_lat: currentRoute.origin_latitude,
        p_origin_lng: currentRoute.origin_longitude,
        p_dest_lat: currentRoute.destination_latitude,
        p_dest_lng: currentRoute.destination_longitude,
        p_departure: currentRoute.departure_time,
        p_seats: currentRoute.seats_needed,
        p_radius_miles: Number(currentRoute.search_radius_miles),
        p_window_minutes: 60,
        p_limit: 10,
      },
    )

    if (matchError) setError(matchError.message)
    else setDriverMatches((data as DriverMatch[]) ?? [])

    setLoading(false)
  }, [userId])

  const loadRiderMatchesForDriver = useCallback(async () => {
    setLoading(true)
    setError('')
    setSuccess('')

    const { data: trips, error: tripError } = await supabase
      .from('trips')
      .select(
        'trip_id, departure_time, available_seats, origin_address, destination_address',
      )
      .eq('creator_id', userId)
      .eq('trip_status', 'posted')
      .order('departure_time', { ascending: true })

    if (tripError) {
      setError(tripError.message)
      setLoading(false)
      return
    }

    const matches: RiderMatch[] = []

    for (const trip of (trips as PublishedTrip[]) ?? []) {
      const { data, error: matchError } = await supabase.rpc(
        'find_riders_for_trip',
        {
          p_trip_id: trip.trip_id,
          p_radius_miles: 5,
          p_window_minutes: 60,
          p_limit: 10,
        },
      )

      if (matchError) {
        setError(matchError.message)
        continue
      }

      for (const rider of (data as RiderMatch[]) ?? []) {
        matches.push(rider)
      }
    }

    setRiderMatches(matches)
    setLoading(false)
  }, [userId])

  // Loads the matches for the chosen mode whenever the mode changes.
  // The loaders reset the loading and message state before fetching,
  // which the set-state-in-effect rule flags; that reset is intentional,
  // so the rule is disabled for the loader call inside this effect.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (mode === 'rider') void loadRiderMatches()
    if (mode === 'driver') void loadRiderMatchesForDriver()
  }, [mode, loadRiderMatches, loadRiderMatchesForDriver])

  async function requestRide(match: DriverMatch) {
    if (!route) return

    setError('')
    setSuccess('')

    const { error: requestError } = await supabase
      .from('trip_requests')
      .insert({
        trip_id: match.trip_id,
        rider_id: userId,
        seat_requested: route.seats_needed,
        pick_up_address: route.origin_address,
        pick_up_latitude: route.origin_latitude,
        pick_up_longitude: route.origin_longitude,
        request_status: 'pending',
      })

    if (requestError) {
      setError(requestError.message)
      return
    }

    setRequestedTripIds((current) => [...current, match.trip_id])
    setSuccess('Ride request sent to the driver.')
  }

  const driverMarkers: HomeMapMarker[] = driverMatches.map((match) => ({
    id: match.trip_id,
    longitude: Number(match.approx_origin_lng),
    latitude: Number(match.approx_origin_lat),
    title: match.driver_name ?? 'Available driver',
    details: `${match.vehicle_make} ${match.vehicle_model} · ${match.origin_distance_miles} miles away`,
    color: '#2563eb',
  }))

  const riderMarkers: HomeMapMarker[] = riderMatches.map((match) => ({
    id: match.route_id,
    longitude: Number(match.approx_origin_lng),
    latitude: Number(match.approx_origin_lat),
    title: match.rider_name ?? 'Potential rider',
    details: `${match.seats_needed} seat(s) · ${match.origin_distance_miles} miles away`,
    color: '#16a34a',
  }))

  if (!mode && canRide && canDrive) {
    return (
      <>
        <h1 className="mt-4">Welcome to Poolr</h1>
        <p>What are you looking for today?</p>

        <Row className="g-4 mt-2">
          <Col md={6}>
            <Card className="text-center">
              <Card.Body>
                <Card.Title>Rider</Card.Title>
                <Card.Text>Find a driver for your trip.</Card.Text>
                <Button size="lg" onClick={() => setMode('rider')}>
                  Find a ride
                </Button>
              </Card.Body>
            </Card>
          </Col>

          <Col md={6}>
            <Card className="text-center">
              <Card.Body>
                <Card.Title>Driver</Card.Title>
                <Card.Text>Find riders near your route.</Card.Text>
                <Button size="lg" variant="success" onClick={() => setMode('driver')}>
                  Find riders
                </Button>
              </Card.Body>
            </Card>
          </Col>
        </Row>
      </>
    )
  }

  return (
    <>
      <div className="d-flex justify-content-between align-items-center mt-4">
        <div>
          <h2>{mode === 'rider' ? 'Find a ride' : 'Find riders'}</h2>
          <p className="text-muted mb-0">
            {mode === 'rider'
              ? 'Browse drivers that match your route.'
              : 'Browse riders that match your published routes.'}
          </p>
        </div>

        {profile?.role === 'both' && (
          <Button
            variant="outline-secondary"
            onClick={() => setMode(mode === 'rider' ? 'driver' : 'rider')}
          >
            Switch to {mode === 'rider' ? 'Driver' : 'Rider'}
          </Button>
        )}
      </div>

      {error && <Alert variant="danger" className="mt-3">{error}</Alert>}
      {success && <Alert variant="success" className="mt-3">{success}</Alert>}

      {loading ? (
        <p className="mt-4">
          <Spinner animation="border" size="sm" /> Finding matches…
        </p>
      ) : mode === 'rider' && !route ? (
        <Alert variant="info" className="mt-4">
          Create a ride request first.{' '}
          <Link to="/lets-go">Set your ride preferences</Link>.
        </Alert>
      ) : (
        <>
          <div className="mt-4">
            <HomeMap
              markers={mode === 'rider' ? driverMarkers : riderMarkers}
              emptyMessage={
                mode === 'rider'
                  ? 'No matching drivers found yet.'
                  : 'No matching riders found yet.'
              }
              onMarkerClick={(marker) => {
                if (mode === 'driver') {
                  navigate('/requests')
                } else {
                  document
                    .getElementById(`driver-${marker.id}`)
                    ?.scrollIntoView({ behavior: 'smooth' })
                }
              }}
            />
          </div>

          <Row className="g-3 mt-2">
            {mode === 'rider'
              ? driverMatches.map((match) => (
                  <Col md={6} key={match.trip_id}>
                    <Card id={`driver-${match.trip_id}`}>
                      <Card.Body>
                        <Card.Title>
                          {match.driver_name ?? 'Driver'}
                        </Card.Title>
                        <Card.Text>
                          {match.vehicle_make} {match.vehicle_model}
                          <br />
                          Departure:{' '}
                          {new Date(match.departure_time).toLocaleString()}
                          <br />
                          {match.origin_distance_miles} miles from pickup
                          <br />
                          Match score: {match.match_score}
                        </Card.Text>

                        <Button
                          disabled={requestedTripIds.includes(match.trip_id)}
                          onClick={() => requestRide(match)}
                        >
                          {requestedTripIds.includes(match.trip_id)
                            ? 'Request sent'
                            : 'Request ride'}
                        </Button>
                      </Card.Body>
                    </Card>
                  </Col>
                ))
              : riderMatches.map((match) => (
                  <Col md={6} key={match.route_id}>
                    <Card>
                      <Card.Body>
                        <Card.Title>
                          {match.rider_name ?? 'Rider'}
                        </Card.Title>
                        <Card.Text>
                          {match.seats_needed} seat(s)
                          <br />
                          Departure:{' '}
                          {new Date(match.departure_time).toLocaleString()}
                          <br />
                          {match.origin_distance_miles} miles from your route
                          <br />
                          Match score: {match.match_score}
                        </Card.Text>
                        <Badge bg="info">View in Requests</Badge>
                      </Card.Body>
                    </Card>
                  </Col>
                ))}
          </Row>
        </>
      )}
    </>
  )
}
