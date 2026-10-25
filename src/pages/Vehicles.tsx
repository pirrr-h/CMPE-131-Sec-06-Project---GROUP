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
}

function fetchVehicles(userId: string) {
  return supabase
    .from('vehicles')
    .select('vehicle_id, make, model, year, seat_count, car_type')
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
  const [mpg, setMpg] = useState('')

  const load = useCallback(async () => {
    const { data, error } = await fetchVehicles(userId)
    if (error) setError(error.message)
    else setVehicles(data as Vehicle[])
  }, [userId])

  useEffect(() => {
    fetchVehicles(userId).then(({ data, error }) => {
      if (error) setError(error.message)
      else setVehicles(data as Vehicle[])
    })
  }, [userId])

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
      load()
    }
  }

  return (
    <>
      <h2 className="mt-4">My vehicles</h2>
      {error && <Alert variant="danger">{error}</Alert>}
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
    </>
  )
}
