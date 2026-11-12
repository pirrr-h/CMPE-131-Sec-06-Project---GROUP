// Identity verification page — the only screen an unverified user can
// reach. Poolr requires a verified ID (via Stripe Identity's hosted scan)
// before any service opens; App.tsx renders this page instead of the app
// until the profile's is_verified flag is true.
import { useEffect, useState } from 'react'
import { Alert, Button, Card, Spinner } from 'react-bootstrap'
import { getVerificationStatus, startVerification } from '../lib/identity'

type Phase = 'checking' | 'ready' | 'processing' | 'verified'

// Renders the verification gate screen: checks the caller's status, offers
// the Stripe Identity scan, polls while Stripe reviews, and hands off to
// the full app once verified.
export default function VerifyIdentity() {
  const [phase, setPhase] = useState<Phase>('checking')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [pollCount, setPollCount] = useState(0)

  // Check the verification state on arrival and on every poll tick. The
  // identity function syncs from Stripe first, so a finished scan flips
  // is_verified before it answers. This page is also where Stripe sends
  // the browser back after a scan, so arriving here may mean "just done".
  useEffect(() => {
    let cancelled = false
    getVerificationStatus()
      .then((result) => {
        if (cancelled) return
        if (result.verified) {
          setPhase('verified')
          // Full load so App.tsx re-reads the now-verified profile and opens.
          window.setTimeout(() => window.location.assign('/'), 900)
        } else if (result.status === 'processing') {
          setPhase('processing')
        } else {
          setPhase('ready')
        }
      })
      .catch((err: unknown) => {
        if (cancelled) return
        setError(err instanceof Error ? err.message : 'Could not check your verification status.')
        setPhase('ready')
      })
    return () => {
      cancelled = true
    }
  }, [pollCount])

  // While Stripe is still reviewing, schedule the next status check
  // instead of making the user refresh (gives up after ten tries).
  useEffect(() => {
    if (phase !== 'processing' || pollCount >= 10) return
    const timer = window.setTimeout(() => setPollCount((c) => c + 1), 3000)
    return () => window.clearTimeout(timer)
  }, [phase, pollCount])

  // Create a VerificationSession and send the browser to Stripe's hosted
  // scan, which returns the user to this same page when it ends.
  async function beginScan() {
    setError('')
    setBusy(true)
    try {
      const result = await startVerification(`${window.location.origin}/verify`)
      if (result.verified) {
        setPhase('verified')
        window.setTimeout(() => window.location.assign('/'), 900)
        return
      }
      if (result.url) {
        window.location.assign(result.url)
        return
      }
      throw new Error('Stripe did not return a verification link.')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not start verification.')
      setBusy(false)
    }
  }

  return (
    <Card className="mx-auto mt-5 p-4" style={{ maxWidth: 480 }}>
      <h2 className="mb-3">Verify your identity</h2>
      {phase === 'verified' ? (
        <Alert variant="success" className="mb-0">
          You're verified — opening Poolr…
        </Alert>
      ) : (
        <>
          <p>
            Poolr requires identity verification before you can find, publish, or
            request rides. You'll scan a government ID (driver's license,
            passport, or ID card) on Stripe's secure page — Stripe checks the
            document; Poolr only learns whether you passed.
          </p>
          {error && <Alert variant="danger">{error}</Alert>}
          {phase === 'checking' && (
            <p className="mb-0">
              <Spinner size="sm" className="me-2" />
              Checking your verification status…
            </p>
          )}
          {phase === 'processing' && (
            <Alert variant="info" className="mb-0">
              <Spinner size="sm" className="me-2" />
              Stripe is still reviewing your document — this page updates itself
              when the result lands. You can also log out and come back; your
              result is saved to your account.
            </Alert>
          )}
          {phase === 'ready' && (
            <Button className="w-100" onClick={() => void beginScan()} disabled={busy}>
              {busy ? 'Opening Stripe…' : 'Verify my ID'}
            </Button>
          )}
        </>
      )}
    </Card>
  )
}
