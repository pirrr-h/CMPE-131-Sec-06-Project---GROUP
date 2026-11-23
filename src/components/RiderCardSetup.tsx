// Rider card setup: shows the saved card, or collects one with Stripe
// Elements. Card numbers are typed into Stripe's own iframe and go straight
// to Stripe — this app only ever sees the brand and last 4 digits.
import { useCallback, useEffect, useState } from 'react'
import { Alert, Button, Card, Spinner } from 'react-bootstrap'
import { Elements, PaymentElement, useElements, useStripe } from '@stripe/react-stripe-js'
import { getStripe } from '../lib/stripe'
import {
  completeRiderSetup,
  getRiderStatus,
  startRiderSetup,
  type RiderStatus,
} from '../lib/stripeOnboarding'

// The form rendered INSIDE <Elements> (hooks need the Elements context).
function CardForm({
  setupIntentId,
  onSaved,
}: {
  setupIntentId: string
  onSaved: () => void
}) {
  const stripe = useStripe()
  const elements = useElements()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!stripe || !elements) return
    setBusy(true)
    setError(null)
    try {
      // redirect: "if_required" + the SetupIntent's allow_redirects=never
      // means card confirmations complete right here, with no page change.
      const result = await stripe.confirmSetup({
        elements,
        redirect: 'if_required',
      })
      if (result.error) {
        setError(result.error.message ?? 'Stripe could not save that card.')
        return
      }
      if (result.setupIntent?.status !== 'succeeded') {
        setError(`Card setup did not finish (status: ${result.setupIntent?.status ?? 'unknown'}).`)
        return
      }
      // Server-side: verify the SetupIntent and mark the card as default.
      await completeRiderSetup(setupIntentId)
      onSaved()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save the card.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <form onSubmit={handleSubmit}>
      <PaymentElement />
      {error && (
        <Alert variant="danger" className="mt-3 mb-0">
          {error}
        </Alert>
      )}
      <Button type="submit" className="mt-3" disabled={!stripe || busy}>
        {busy ? 'Saving…' : 'Save card'}
      </Button>
    </form>
  )
}

export default function RiderCardSetup({ userId }: { userId: string }) {
  const [status, setStatus] = useState<RiderStatus | null>(null)
  const [clientSecret, setClientSecret] = useState<string | null>(null)
  const [setupIntentId, setSetupIntentId] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    try {
      setStatus(await getRiderStatus())
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load card status.')
    }
  }, [])

  useEffect(() => {
    let cancelled = false
    getRiderStatus()
      .then((s) => {
        if (!cancelled) setStatus(s)
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : 'Could not load card status.')
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
      const setup = await startRiderSetup()
      setSetupIntentId(setup.setupIntentId)
      setClientSecret(setup.clientSecret)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not start card setup.')
    } finally {
      setBusy(false)
    }
  }

  function handleSaved() {
    setClientSecret(null)
    setSetupIntentId(null)
    void refresh()
  }

  return (
    <Card className="mb-4">
      <Card.Body>
        <Card.Title>Payment method (rider)</Card.Title>
        {error && <Alert variant="danger">{error}</Alert>}
        {!status && !error && (
          <p className="mb-0">
            <Spinner animation="border" size="sm" /> Loading…
          </p>
        )}
        {status?.card && !clientSecret && (
          <>
            <p className="mb-2">
              💳 {status.card.brand} •••• {status.card.last4} — expires{' '}
              {status.card.expMonth}/{status.card.expYear}
            </p>
            <Button variant="outline-primary" onClick={beginSetup} disabled={busy}>
              Replace card
            </Button>
          </>
        )}
        {status && !status.card && !clientSecret && (
          <>
            <p className="mb-2">No card saved yet. Add one to book rides.</p>
            <Button onClick={beginSetup} disabled={busy}>
              {busy ? 'Starting…' : 'Add a card'}
            </Button>
          </>
        )}
        {clientSecret && setupIntentId && (
          <Elements stripe={getStripe()} options={{ clientSecret }}>
            <CardForm setupIntentId={setupIntentId} onSaved={handleSaved} />
          </Elements>
        )}
      </Card.Body>
    </Card>
  )
}
