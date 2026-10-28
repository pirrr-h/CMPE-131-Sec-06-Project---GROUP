// Loads Stripe.js once for the whole app, using the PUBLISHABLE key.
// Publishable keys (pk_...) are safe in frontend code — they can only
// collect card details through Elements, never move money. The secret key
// (sk_...) must never appear here; it lives only in Supabase secrets.
import { loadStripe, type Stripe } from '@stripe/stripe-js'

const publishableKey = import.meta.env.VITE_STRIPE_PUBLISHABLE_KEY as string | undefined

let stripePromise: Promise<Stripe | null> | null = null

export function getStripe(): Promise<Stripe | null> {
  if (!publishableKey) {
    throw new Error(
      'Missing VITE_STRIPE_PUBLISHABLE_KEY. Add your pk_test_... key to .env.local and restart npm run dev.',
    )
  }
  if (!stripePromise) stripePromise = loadStripe(publishableKey)
  return stripePromise
}
