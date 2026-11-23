import { Button, Container, Nav, Navbar } from 'react-bootstrap'
import { BrowserRouter, Link, Route, Routes } from 'react-router-dom'
import { supabase } from './lib/supabase'
import { useProfile } from './lib/useProfile'
import Auth from './pages/Auth'
import Home from './pages/Home'
import LetsGo from './pages/LetsGo'
import PaymentSetup from './pages/PaymentSetup'
import PublishRoute from './pages/PublishRoute'
import TripRequests from './pages/TripRequests'
import Vehicles from './pages/Vehicles'

export default function App() {
  const { session, profile, loading } = useProfile()

  if (loading) {
    return <Container className="mt-5">Loading…</Container>
  }

  if (!session) {
    return (
      <Container>
        <Auth />
      </Container>
    )
  }

  const userId = session.user.id

  const canRide =
    profile?.role === 'rider' ||
    profile?.role === 'both' ||
    profile?.role === 'admin'

  const canDrive =
    profile?.role === 'driver' ||
    profile?.role === 'both' ||
    profile?.role === 'admin'

  return (
    <BrowserRouter>
      <Navbar bg="light" className="mb-3">
        <Container>
          <Navbar.Brand as={Link} to="/">
            Poolr
          </Navbar.Brand>

          <Nav className="me-auto">
            <Nav.Link as={Link} to="/">
              Home
            </Nav.Link>

            {canRide && (
              <Nav.Link as={Link} to="/lets-go">
                Let&apos;s Go!
              </Nav.Link>
            )}

            {canDrive && (
              <Nav.Link as={Link} to="/vehicles">
                Vehicles
              </Nav.Link>
            )}

            {canDrive && (
              <Nav.Link as={Link} to="/publish">
                Publish route
              </Nav.Link>
            )}

            {canDrive && (
              <Nav.Link as={Link} to="/requests">
                Requests
              </Nav.Link>
            )}

            <Nav.Link as={Link} to="/payments">
              Payments
            </Nav.Link>
          </Nav>

          <span className="me-3">
            {profile?.full_name ?? session.user.email} ({profile?.role})
          </span>

          <Button
            size="sm"
            variant="outline-secondary"
            onClick={() => supabase.auth.signOut()}
          >
            Log out
          </Button>
        </Container>
      </Navbar>

      <Container>
        <Routes>
          <Route
            path="/"
            element={<Home userId={userId} profile={profile} />}
          />

          {canRide && (
            <Route
              path="/lets-go"
              element={<LetsGo userId={userId} />}
            />
          )}

          <Route
            path="/payments"
            element={<PaymentSetup userId={userId} />}
          />

          {canDrive ? (
            <>
              <Route
                path="/vehicles"
                element={<Vehicles userId={userId} />}
              />

              <Route
                path="/publish"
                element={<PublishRoute userId={userId} />}
              />

              <Route
                path="/requests"
                element={<TripRequests userId={userId} />}
              />
            </>
          ) : (
            <Route
              path="*"
              element={<p>Use Home to find a ride.</p>}
            />
          )}
        </Routes>
      </Container>
    </BrowserRouter>
  )
}