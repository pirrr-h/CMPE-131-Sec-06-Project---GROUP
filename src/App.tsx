import { Button, Container, Nav, Navbar } from 'react-bootstrap'
import { BrowserRouter, Link, Navigate, Route, Routes } from 'react-router-dom'
import { supabase } from './lib/supabase'
import { useProfile } from './lib/useProfile'
import Auth from './pages/Auth'
import PublishRoute from './pages/PublishRoute'
import Vehicles from './pages/Vehicles'

export default function App() {
  const { session, profile, loading } = useProfile()

  if (loading) return <Container className="mt-5">Loading…</Container>
  if (!session) return <Container><Auth /></Container>

  const userId = session.user.id
  const canDrive = profile?.role === 'driver' || profile?.role === 'both' || profile?.role === 'admin'

  return (
    <BrowserRouter>
      <Navbar bg="light" className="mb-3">
        <Container>
          <Navbar.Brand as={Link} to="/">Poolr</Navbar.Brand>
          <Nav className="me-auto">
            {canDrive && <Nav.Link as={Link} to="/vehicles">Vehicles</Nav.Link>}
            {canDrive && <Nav.Link as={Link} to="/publish">Publish route</Nav.Link>}
          </Nav>
          <span className="me-3">{profile?.full_name ?? session.user.email} ({profile?.role})</span>
          <Button size="sm" variant="outline-secondary" onClick={() => supabase.auth.signOut()}>Log out</Button>
        </Container>
      </Navbar>
      <Container>
        <Routes>
          {canDrive && <Route path="/" element={<Navigate to="/publish" replace />} />}
          {canDrive ? (
            <>
              <Route path="/vehicles" element={<Vehicles userId={userId} />} />
              <Route path="/publish" element={<PublishRoute userId={userId} />} />
            </>
          ) : (
            <Route path="*" element={<p>Rider pages are coming next. Only drivers can publish routes.</p>} />
          )}
        </Routes>
      </Container>
    </BrowserRouter>
  )
}
