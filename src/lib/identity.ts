// Client helpers for the identity-verification Edge Function.
// Every call goes through supabase.functions.invoke, which attaches the
// signed-in user's JWT automatically — the function trusts only that token.
import { supabase } from './supabase'

export interface IdentityStart {
  verified?: boolean
  sessionId?: string
  url?: string
}

export interface IdentityStatus {
  verified: boolean
  // Stripe session status: not_started | requires_input | processing |
  // verified | canceled. Meaningless once verified is true.
  status: string
}

// Send one action to the identity-verification function and unwrap its
// reply, surfacing the function's own error message when it sends one.
async function callIdentity<T>(body: Record<string, unknown>): Promise<T> {
  const { data, error } = await supabase.functions.invoke('identity-verification', { body })
  if (error) {
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

/** Start a Stripe Identity scan; the caller redirects the browser to the returned url. */
export function startVerification(returnUrl: string) {
  return callIdentity<IdentityStart>({ action: 'start', returnUrl })
}

/** Current verification state; the function flips is_verified itself once Stripe confirms. */
export function getVerificationStatus() {
  return callIdentity<IdentityStatus>({ action: 'status' })
}
