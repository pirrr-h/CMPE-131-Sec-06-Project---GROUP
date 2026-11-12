import { Badge, Button, Container, Nav, Navbar } from 'react-bootstrap'
import { BrowserRouter, Link, Navigate, Route, Routes } from 'react-router-dom'
import { supabase } from './lib/supabase'
import {
  unregisterPushNotifications,
  usePushRegistration,
  useUnreadNotificationCount,
} from './lib/notifications'
import { useProfile } from './lib/useProfile'
import Auth from './pages/Auth'
import FindTrips from './pages/FindTrips'
import Notifications from './pages/Notifications'
import PaymentSetup from './pages/PaymentSetup'
import PublishRoute from './pages/PublishRoute'
import TripRequests from './pages/TripRequests'
import Vehicles from './pages/Vehicles'
import VerifyIdentity from './pages/VerifyIdentity'

// Root component: shows the auth screen when signed out, only the
// identity verification page when signed in but unverified, and the full
// Poolr app (nav + service routes) once the profile is verified. Every
// signed-in session also registers this browser for push notifications
// and keeps the nav's unread-notification badge current.
export default function App() {
  const { session, profile, loading } = useProfile()
  const sessionUserId = session?.user.id ?? null
  usePushRegistration(sessionUserId)
  const unreadCount = useUnreadNotificationCount(sessionUserId)

  // Signs the user out after removing this browser's push token, so a
  // shared browser stops receiving the account's pushes at logout.
  async function handleLogout() {
    await unregisterPushNotifications()
    await supabase.auth.signOut()
  }

  if (loading) return <Container className="mt-5">Loading…</Container>
  if (!session) return <Container><Auth /></Container>

  const userId = session.user.id
  const canDrive = profile?.role === 'driver' || profile?.role === 'both' || profile?.role === 'admin'
  const canRide = profile?.role === 'rider' || profile?.role === 'both' || profile?.role === 'admin'

  // Verification gate: an unverified account reaches nothing but the
  // identity verification page — no nav links, no service routes — until
  // Stripe Identity flips profile.is_verified. The database enforces the
  // same rule behind this (verified_ok() with require_verified_users on).
  if (profile && !profile.is_verified) {
    return (
      <BrowserRouter>
        <Navbar bg="light" className="mb-3">
          <Container>
            <Navbar.Brand>Poolr</Navbar.Brand>
            <span className="me-3">{profile.full_name ?? session.user.email} ({profile.role})</span>
            <Button size="sm" variant="outline-secondary" onClick={() => void handleLogout()}>Log out</Button>
          </Container>
        </Navbar>
        <Container>
          <Routes>
            <Route path="*" element={<VerifyIdentity />} />
          </Routes>
        </Container>
      </BrowserRouter>
    )
  }

  return (
    <BrowserRouter>
      <Navbar bg="light" className="mb-3">
        <Container>
          <Navbar.Brand as={Link} to="/">Poolr</Navbar.Brand>
          <Nav className="me-auto">
            {canRide && <Nav.Link as={Link} to="/find">Find a trip</Nav.Link>}
            {canDrive && <Nav.Link as={Link} to="/vehicles">Vehicles</Nav.Link>}
            {canDrive && <Nav.Link as={Link} to="/publish">Publish route</Nav.Link>}
            {canDrive && <Nav.Link as={Link} to="/requests">Requests</Nav.Link>}
            <Nav.Link as={Link} to="/payments">Payments</Nav.Link>
            <Nav.Link as={Link} to="/notifications">
              Notifications{' '}
              {unreadCount > 0 && <Badge bg="danger">{unreadCount}</Badge>}
            </Nav.Link>
          </Nav>
          <span className="me-3">{profile?.full_name ?? session.user.email} ({profile?.role})</span>
          <Button size="sm" variant="outline-secondary" onClick={() => void handleLogout()}>Log out</Button>
        </Container>
      </Navbar>
      <Container>
        <Routes>
          <Route path="/verify" element={<Navigate to="/" replace />} />
          <Route path="/payments" element={<PaymentSetup userId={userId} />} />
          <Route path="/notifications" element={<Notifications userId={userId} />} />
          {canRide && <Route path="/find" element={<FindTrips userId={userId} />} />}
          {canDrive && <Route path="/" element={<Navigate to="/publish" replace />} />}
          {!canDrive && canRide && <Route path="/" element={<Navigate to="/find" replace />} />}
          {canDrive ? (
            <>
              <Route path="/vehicles" element={<Vehicles userId={userId} />} />
              <Route path="/publish" element={<PublishRoute userId={userId} />} />
              <Route path="/requests" element={<TripRequests userId={userId} />} />
            </>
          ) : (
            <Route path="*" element={<p>Rider pages are coming next. Only drivers can publish routes.</p>} />
          )}
        </Routes>
      </Container>
    </BrowserRouter>
  )
}
