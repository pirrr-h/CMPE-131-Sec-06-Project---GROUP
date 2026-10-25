import { useEffect, useState } from 'react';
import type { Session } from '@supabase/supabase-js';
import { Button, Container } from 'react-bootstrap';
import { supabase } from './supabaseClient';
import AuthPage from './AuthPage';

export default function App() {
  const [session, setSession] = useState<Session | null>(null);

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => setSession(data.session));
    const { data } = supabase.auth.onAuthStateChange((_event, newSession) => setSession(newSession));
    return () => data.subscription.unsubscribe();
  }, []);

  if (!session) return <AuthPage />;

  return (
    <Container className="mt-5">
      <h2>Welcome to Poolr</h2>
      <p>Logged in as {session.user.user_metadata.full_name ?? session.user.email}</p>
      <Button variant="outline-secondary" onClick={() => supabase.auth.signOut()}>
        Log out
      </Button>
    </Container>
  );
}