import { useCallback, useEffect, useState } from 'react'
import type { FormEvent } from 'react'
import { Alert, Button, Card, Col, Form, ListGroup, Row } from 'react-bootstrap'
import { Link } from 'react-router-dom'
import { supabase } from '../lib/supabase'

interface Vehicle {
  vehicle_id: string
  make: string
  model: string
  year: number
  seat_count: number
  car_type: string
  mpg: number | null
}

function fetchVehicles(userId: string) {
  return supabase
    .from('vehicles')
    .select('vehicle_id, make, model, year, seat_count, car_type, mpg')
    .eq('user_id', userId)
}

export default function Vehicles({ userId }: { userId: string }) {
  const [vehicles, setVehicles] = useState<Vehicle[]>([])
  const [error, setError] = useState('')
  const [make, setMake] = useState('')
  const [model, setModel] = useState('')
  const [year, setYear] = useState(new Date().getFullYear() - 5)
  const [seatCount, setSeatCount] = useState(5)
  const [carType, setCarType] = useState('sedan')
  const [mpgLoading, setMpgLoading] = useState(false)

  const load = useCallback(async () => {
    const { data, error } = await fetchVehicles(userId)

    if (error) {
      setError(error.message)
    } else {
      setVehicles((data ?? []) as Vehicle[])
    }
  }, [userId])

  useEffect(() => {
    load()
  }, [load])

  async function add(e: FormEvent) {
    e.preventDefault()
    setError('')
    setMpgLoading(true)

    // Ask the Supabase Edge Function to find the MPG through CarAPI
    const { data: mpgData, error: mpgError } =
      await supabase.functions.invoke('get-vehicle-mpg', {
        body: {
          make,
          model,
          year,
          carType,
        },
      })

    if (mpgError) {
      setMpgLoading(false)
      setError(mpgError.message)
      return
    }

    const foundMpg = Number(mpgData?.mpg)

    if (!Number.isFinite(foundMpg) || foundMpg <= 0) {
      setMpgLoading(false)
      setError('Could not find MPG for this vehicle.')
      return
    }

    // Save the vehicle and the MPG returned by CarAPI
    const { error: insertError } = await supabase.from('vehicles').insert({
      user_id: userId,
      make,
      model,
      year,
      seat_count: seatCount,
      car_type: carType,
      mpg: foundMpg,
    })

    setMpgLoading(false)

    if (insertError) {
      setError(insertError.message)
      return
    }

    setMake('')
    setModel('')
    setYear(new Date().getFullYear() - 5)
    setSeatCount(5)
    setCarType('sedan')

    await load()
  }

  return (
    <>
      <h2 className="mt-4">My vehicles</h2>

      {error && <Alert variant="danger">{error}</Alert>}

      <ListGroup className="mb-3">
        {vehicles.length === 0 && (
          <ListGroup.Item>
            No vehicles yet. Add one below.
          </ListGroup.Item>
        )}

        {vehicles.map((vehicle) => (
          <ListGroup.Item key={vehicle.vehicle_id}>
            {vehicle.year} {vehicle.make} {vehicle.model} (
            {vehicle.car_type}, {vehicle.seat_count} seats,{' '}
            {vehicle.mpg ?? 'Unknown'} MPG
            )
          </ListGroup.Item>
        ))}
      </ListGroup>

      {vehicles.length > 0 && (
        <p>
          <Link to="/publish">Next: publish a route →</Link>
        </p>
      )}

      <Card>
        <Card.Body>
          <Card.Title>Add a vehicle</Card.Title>

          <Form onSubmit={add}>
            <Row className="g-2">
              <Col md={4}>
                <Form.Label>Make</Form.Label>
                <Form.Control
                  placeholder="Toyota"
                  required
                  value={make}
                  onChange={(e) => setMake(e.target.value)}
                />
              </Col>

              <Col md={4}>
                <Form.Label>Model</Form.Label>
                <Form.Control
                  placeholder="Camry"
                  required
                  value={model}
                  onChange={(e) => setModel(e.target.value)}
                />
              </Col>

              <Col md={4}>
                <Form.Label>Year</Form.Label>
                <Form.Control
                  type="number"
                  min={1980}
                  max={2100}
                  required
                  value={year}
                  onChange={(e) => setYear(Number(e.target.value))}
                />
              </Col>

              <Col md={4}>
                <Form.Label>Seats including driver</Form.Label>
                <Form.Control
                  type="number"
                  min={2}
                  max={12}
                  required
                  value={seatCount}
                  onChange={(e) => setSeatCount(Number(e.target.value))}
                />
              </Col>

              <Col md={4}>
                <Form.Label>Type</Form.Label>
                <Form.Select
                  value={carType}
                  onChange={(e) => setCarType(e.target.value)}
                >
                  <option value="sedan">Sedan</option>
                  <option value="suv">SUV</option>
                  <option value="coupe">Coupe</option>
                  <option value="van">Van</option>
                </Form.Select>
              </Col>
            </Row>

            <Button
              type="submit"
              className="mt-3"
              disabled={mpgLoading}
            >
              {mpgLoading ? 'Finding MPG...' : 'Add Vehicle'}
            </Button>
          </Form>
        </Card.Body>
      </Card>
    </>
  )
}