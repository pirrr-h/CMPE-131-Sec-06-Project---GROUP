// Driver payout setup: Stripe Connect Express onboarding is fully hosted
// by Stripe (identity + bank details never touch this app). This component
// only asks the Edge Function for a fresh onboarding link and reports the
// live status Stripe returns.
import { useEffect, useState } from 'react'
import { Alert, Button, Card, Spinner } from 'react-bootstrap'
import { getDriverStatus, startDriverSetup, type DriverStatus } from '../lib/stripeOnboarding'

export default function DriverPayoutSetup({ userId }: { userId: string }) {
  const [status, setStatus] = useState<DriverStatus | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // Coming back from Stripe's hosted pages, the URL says how it went:
  // ?driver=return (finished or bailed) or ?driver=refresh (link expired).
  const [notice] = useState<string | null>(() => {
    const back = new URLSearchParams(window.location.search).get('driver')
    if (back === 'return') return 'Welcome back — here is what Stripe has on file now:'
    if (back === 'refresh') return 'That onboarding link expired. Start again to get a fresh one.'
    return null
  })

  useEffect(() => {
    let cancelled = false
    getDriverStatus()
      .then((s) => {
        if (!cancelled) setStatus(s)
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : 'Could not load payout status.')
        }
      })
    return () => {
      cancelled = true
    }
  }, [userId])

  async function beginSetup() {
    setBusy(true)
    setError(null)
    try {
      const { url } = await startDriverSetup()
      // Leave for Stripe's hosted onboarding; Stripe returns the driver to
      // /payments?driver=return (see APP_ORIGIN in the Edge Function).
      window.location.href = url
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not start payout setup.')
      setBusy(false)
    }
  }

  return (
    <Card className="mb-4">
      <Card.Body>
        <Card.Title>Payouts (driver)</Card.Title>
        {notice && <Alert variant="info">{notice}</Alert>}
        {error && <Alert variant="danger">{error}</Alert>}
        {!status && !error && (
          <p className="mb-0">
            <Spinner animation="border" size="sm" /> Loading…
          </p>
        )}
        {status?.accountReady && (
          <p className="mb-0">
            ✅ Payout setup complete — Stripe can pay this account after a trip completes.
          </p>
        )}
        {status && !status.accountReady && (
          <>
            <p className="mb-2">
              {!status.accountId &&
                'No payout account yet. Set one up so riders can pay you.'}
              {status.accountId &&
                !status.detailsSubmitted &&
                'Payout account started but not finished — Stripe still needs details.'}
              {status.accountId &&
                status.detailsSubmitted &&
                'Details submitted — Stripe is still enabling charges/payouts. Check back shortly.'}
            </p>
            <Button onClick={beginSetup} disabled={busy}>
              {busy
                ? 'Opening Stripe…'
                : status.accountId
                  ? 'Continue payout setup'
                  : 'Set up payouts'}
            </Button>
          </>
        )}
      </Card.Body>
    </Card>
  )
}
