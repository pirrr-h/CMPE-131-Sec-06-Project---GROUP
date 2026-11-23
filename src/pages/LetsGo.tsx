import { useState } from 'react'
import type { FormEvent } from 'react'
import { Alert, Button, Card, Col, Form, Row } from 'react-bootstrap'
import { supabase } from '../lib/supabase'
import { geocode } from '../lib/geocode'
import MapView from '../components/MapView'

export default function LetsGo({ userId }: { userId: string }) {
  const [origin, setOrigin] = useState('')
  const [destination, setDestination] = useState('')
  const [departureDate, setDepartureDate] = useState('')
  const [departureTime, setDepartureTime] = useState('')
  const [seatsNeeded, setSeatsNeeded] = useState(1)
  const [searchRadius, setSearchRadius] = useState(5)

  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [success, setSuccess] = useState('')

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault()
    setError('')
    setSuccess('')
    setBusy(true)

    try {
      if (!departureDate || !departureTime) {
        throw new Error('Choose a departure date and time.')
      }

      const departure = new Date(
        `${departureDate}T${departureTime}`,
      )

      if (departure.getTime() <= Date.now()) {
        throw new Error('Departure time must be in the future.')
      }

      const from = await geocode(origin)
      const to = await geocode(destination)

      const { error: insertError } = await supabase
        .from('rider_routes')
        .insert({
          rider_id: userId,
          departure_time: departure.toISOString(),
          seats_needed: seatsNeeded,
          search_radius_miles: searchRadius,

          origin_address: from.address,
          origin_latitude: from.latitude,
          origin_longitude: from.longitude,

          destination_address: to.address,
          destination_latitude: to.latitude,
          destination_longitude: to.longitude,
        })

      if (insertError) {
        throw new Error(insertError.message)
      }

      setOrigin('')
      setDestination('')
      setDepartureDate('')
      setDepartureTime('')
      setSeatsNeeded(1)
      setSearchRadius(5)
      setSuccess('Your ride request was saved. We will look for matching drivers.')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <h2 className="mt-4">Let&apos;s Go!</h2>

      <p className="text-muted">
        Tell us where you want to go, when you want to leave, and what kind
        of ride you need.
      </p>

      {error && <Alert variant="danger">{error}</Alert>}
      {success && <Alert variant="success">{success}</Alert>}

      <Card>
        <Card.Body>
          <Form onSubmit={submit}>
            <Row className="g-3">
              <Col md={6}>
                <Form.Label>Meeting spot</Form.Label>
                <Form.Control
                  required
                  placeholder="e.g. Daly City BART"
                  value={origin}
                  onChange={(e) => setOrigin(e.target.value)}
                />
              </Col>

              <Col md={6}>
                <Form.Label>Destination</Form.Label>
                <Form.Control
                  required
                  placeholder="e.g. San Jose State University"
                  value={destination}
                  onChange={(e) => setDestination(e.target.value)}
                />
              </Col>

              <Col md={6}>
                <Form.Label>Departure date</Form.Label>
                <Form.Control
                  type="date"
                  required
                  value={departureDate}
                  onChange={(e) => setDepartureDate(e.target.value)}
                />
              </Col>

              <Col md={6}>
                <Form.Label>Departure time</Form.Label>
                <Form.Control
                  type="time"
                  required
                  value={departureTime}
                  onChange={(e) => setDepartureTime(e.target.value)}
                />
              </Col>

              <Col md={6}>
                <Form.Label>Seats needed</Form.Label>
                <Form.Control
                  type="number"
                  min={1}
                  max={12}
                  required
                  value={seatsNeeded}
                  onChange={(e) => setSeatsNeeded(Number(e.target.value))}
                />
              </Col>

              <Col md={6}>
                <Form.Label>Matching radius</Form.Label>
                <Form.Select
                  value={searchRadius}
                  onChange={(e) => setSearchRadius(Number(e.target.value))}
                >
                  <option value={1}>Within 1 mile</option>
                  <option value={5}>Within 5 miles</option>
                  <option value={10}>Within 10 miles</option>
                  <option value={25}>Within 25 miles</option>
                </Form.Select>
              </Col>
            </Row>

            <Button type="submit" className="mt-4" disabled={busy}>
              {busy ? 'Saving…' : 'Find matching drivers'}
            </Button>
          </Form>
        </Card.Body>
      </Card>

      <MapView
        origin={origin}
        destination={destination}
      />
    </>
  )
}