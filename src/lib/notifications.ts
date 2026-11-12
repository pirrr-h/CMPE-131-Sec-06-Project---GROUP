// Push notification plumbing for the Poolr app.
//
// The flow, end to end:
//   1. After login, usePushRegistration asks the browser for
//      notification permission and gets this browser's FCM token from
//      Firebase (Firebase registers public/firebase-messaging-sw.js as
//      the service worker that receives pushes while no tab is open).
//   2. The token is saved with the register_push_token database RPC,
//      which assigns the token to the signed-in user — signing in as a
//      different account in the same browser moves the token, so pushes
//      never go to the previous account.
//   3. The database writes notification rows for trip events; the
//      notification-drainer Edge Function reads push_tokens and sends
//      the FCM pushes; the Notifications page reads the same rows as an
//      in-app inbox (RLS: each user sees only their own).

import { useEffect, useRef, useState } from 'react'
import { deleteToken, getToken } from 'firebase/messaging'
import { FIREBASE_VAPID_KEY, getFirebaseMessaging } from './firebase'
import { supabase } from './supabase'

// One row of the notifications table, as the inbox page displays it.
export interface PoolrNotification {
  notification_id: string
  user_id: string
  type: string
  title: string
  body: string | null
  trip_id: string | null
  request_id: string | null
  read_at: string | null
  created_at: string
}

// Where the current browser's FCM token is remembered locally, so the
// logout path can unregister exactly the token this browser registered.
const TOKEN_STORAGE_KEY = 'poolr-fcm-token'

// Asks the browser for notification permission, gets this browser's
// FCM token, and saves it to push_tokens for the signed-in user.
// Returns a short status string; every failure is a quiet status, not
// an exception — push is an enhancement, the inbox works without it.
export async function registerPushNotifications(): Promise<string> {
  try {
    const messaging = await getFirebaseMessaging()
    if (!messaging) return 'unsupported'
    if (!('Notification' in window)) return 'unsupported'

    const permission = await Notification.requestPermission()
    if (permission !== 'granted') return 'denied'

    const token = await getToken(messaging, { vapidKey: FIREBASE_VAPID_KEY })
    if (!token) return 'no-token'

    const { error } = await supabase.rpc('register_push_token', {
      p_token: token,
      p_user_agent: navigator.userAgent,
    })
    if (error) return 'save-failed'

    localStorage.setItem(TOKEN_STORAGE_KEY, token)
    return 'registered'
  } catch {
    return 'error'
  }
}

// Removes this browser's token registration for the signed-in user and
// deletes the FCM token itself. Called on logout, so a shared browser
// stops receiving the previous account's pushes.
export async function unregisterPushNotifications(): Promise<void> {
  try {
    const token = localStorage.getItem(TOKEN_STORAGE_KEY)
    if (token) {
      await supabase.rpc('unregister_push_token', { p_token: token })
      localStorage.removeItem(TOKEN_STORAGE_KEY)
    }
    const messaging = await getFirebaseMessaging()
    if (messaging) await deleteToken(messaging)
  } catch {
    // Logout must never fail because push cleanup did.
  }
}

// Registers this browser for push once per signed-in user. Rendered by
// App for every signed-in session; the ref guard keeps React's double
// effect invocation (and re-renders) from registering twice.
export function usePushRegistration(userId: string | null) {
  const registeredFor = useRef<string | null>(null)

  useEffect(() => {
    if (!userId || registeredFor.current === userId) return
    registeredFor.current = userId
    void registerPushNotifications()
  }, [userId])
}

// Tracks the signed-in user's unread notification count for the nav
// badge: an initial count query, then a Realtime subscription that
// recounts whenever the user's notification rows change. The count is
// stored together with the user it belongs to, so a signed-out or
// switched account never shows the previous user's number.
export function useUnreadNotificationCount(userId: string | null) {
  const [badge, setBadge] = useState<{ userId: string | null; count: number }>({
    userId: null,
    count: 0,
  })

  useEffect(() => {
    if (!userId) return
    let cancelled = false

    // Counts this user's unread rows (head request: no rows returned).
    function refresh() {
      supabase
        .from('notifications')
        .select('notification_id', { count: 'exact', head: true })
        .eq('user_id', userId)
        .is('read_at', null)
        .then(({ count, error }) => {
          if (!cancelled && !error) setBadge({ userId, count: count ?? 0 })
        })
    }

    refresh()
    const channel = supabase
      .channel(`notifications-badge-${userId}`)
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'notifications',
          filter: `user_id=eq.${userId}`,
        },
        () => refresh(),
      )
      .subscribe()

    return () => {
      cancelled = true
      void supabase.removeChannel(channel)
    }
  }, [userId])

  return badge.userId === userId ? badge.count : 0
}

// Loads the user's newest notifications for the inbox page.
export async function fetchNotifications(userId: string): Promise<PoolrNotification[]> {
  const { data, error } = await supabase
    .from('notifications')
    .select('notification_id, user_id, type, title, body, trip_id, request_id, read_at, created_at')
    .eq('user_id', userId)
    .order('created_at', { ascending: false })
    .limit(100)
  if (error) throw new Error(error.message)
  return (data ?? []) as PoolrNotification[]
}

// Marks one notification read (the RLS update policy allows a user to
// update only their own rows).
export async function markNotificationRead(notificationId: string): Promise<void> {
  const { error } = await supabase
    .from('notifications')
    .update({ read_at: new Date().toISOString() })
    .eq('notification_id', notificationId)
    .is('read_at', null)
  if (error) throw new Error(error.message)
}

// Marks every unread notification of the user read in one update.
export async function markAllNotificationsRead(userId: string): Promise<void> {
  const { error } = await supabase
    .from('notifications')
    .update({ read_at: new Date().toISOString() })
    .eq('user_id', userId)
    .is('read_at', null)
  if (error) throw new Error(error.message)
}
