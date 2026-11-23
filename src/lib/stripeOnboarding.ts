// Client helpers for the stripe-onboarding Edge Function.
// Every call goes through supabase.functions.invoke, which attaches the
// signed-in user's JWT automatically — the function trusts only that token.
import { supabase } from './supabase'

export interface CardSummary {
  brand: string
  last4: string
  expMonth: number
  expYear: number
}

export interface RiderStatus {
  customerReady: boolean
  // Pass this value to payment-service's "hold" action as paymentMethodId.
  paymentMethodId: string | null
  card: CardSummary | null
}

export interface DriverStatus {
  accountId?: string
  accountReady: boolean
  detailsSubmitted: boolean
  chargesEnabled: boolean
  payoutsEnabled: boolean
}

interface RiderSetup {
  customerId: string
  setupIntentId: string
  clientSecret: string
}

async function callOnboarding<T>(body: Record<string, unknown>): Promise<T> {
  const { data, error } = await supabase.functions.invoke('stripe-onboarding', { body })
  if (error) {
    // Edge Function errors arrive as a generic invoke error; the function's
    // own message is in the response body when we can read it.
    let message = error.message
    const ctx = (error as { context?: Response }).context
    if (ctx && typeof ctx.clone === 'function') {
      try {
        const parsed = (await ctx.clone().json()) as { error?: string }
        if (parsed?.error) message = parsed.error
      } catch {
        // keep the generic message
      }
    }
    throw new Error(message)
  }
  return data as T
}

/** Create/reuse the rider's Stripe Customer and open a card SetupIntent. */
export function startRiderSetup() {
  return callOnboarding<RiderSetup>({ action: 'rider_setup' })
}

/** Finalize a confirmed SetupIntent: sets the card as the default method. */
export function completeRiderSetup(setupIntentId: string) {
  return callOnboarding<RiderStatus>({ action: 'rider_complete', setupIntentId })
}

/** Current rider card state (and the paymentMethodId a hold needs). */
export function getRiderStatus() {
  return callOnboarding<RiderStatus>({ action: 'rider_status' })
}

/** Create/reuse the driver's Connect account; returns the onboarding URL. */
export function startDriverSetup() {
  return callOnboarding<{ accountId: string; url: string }>({ action: 'driver_start' })
}

/** Live Connect status from Stripe (submitted / charges / payouts). */
export function getDriverStatus() {
  return callOnboarding<DriverStatus>({ action: 'driver_status' })
}
