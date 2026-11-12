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
//      the FCM pushes for when the app is closed. While the app IS
//      open, useNotificationPopups watches the same rows over Realtime
//      and shows each new one as a pop-up that disappears on its own.
//      There is no notifications page (Kyaw's call, 2026-11-12):
//      pop-ups only.

import { useEffect, useRef, useState } from 'react'
import { deleteToken, getToken } from 'firebase/messaging'
import { FIREBASE_VAPID_KEY, getFirebaseMessaging } from './firebase'
import { supabase } from './supabase'

// One row of the notifications table, as the pop-ups display it.
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
// an exception — push is an enhancement, never a blocker.
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

// Collects the signed-in user's new notifications as pop-ups while the
// app is open: a Realtime subscription appends each inserted row, and
// dismissPopup removes one (the pop-up component also calls it when a
// pop-up's display time runs out, so pop-ups disappear on their own).
// Only rows created after the subscription starts appear — nothing is
// loaded from history, because there is no inbox to catch up on.
export function useNotificationPopups(userId: string | null) {
  const [popups, setPopups] = useState<PoolrNotification[]>([])

  // Removes one pop-up from the stack by its notification id.
  function dismissPopup(notificationId: string) {
    setPopups((current) => current.filter((popup) => popup.notification_id !== notificationId))
  }

  useEffect(() => {
    if (!userId) return

    const channel = supabase
      .channel(`notification-popups-${userId}`)
      .on(
        'postgres_changes',
        {
          event: 'INSERT',
          schema: 'public',
          table: 'notifications',
          filter: `user_id=eq.${userId}`,
        },
        (payload) => {
          const row = payload.new as PoolrNotification
          setPopups((current) => [...current.slice(-3), row])
        },
      )
      .subscribe()

    return () => {
      void supabase.removeChannel(channel)
    }
  }, [userId])

  return { popups, dismissPopup }
}
