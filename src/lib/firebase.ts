// Firebase client setup for Poolr push notifications.
//
// These values are the PUBLIC web config of Kyaw's Firebase project
// (poolr-74494) — the same block the Firebase console shows under
// Project settings -> General. They identify the project to Firebase;
// they are not secrets and are safe in client code. The secret service
// account key never appears here: sending pushes is the
// notification-drainer Edge Function's job, server-side.

import { initializeApp } from 'firebase/app'
import type { FirebaseApp } from 'firebase/app'
import { getMessaging, isSupported } from 'firebase/messaging'
import type { Messaging } from 'firebase/messaging'

// The web app's Firebase configuration (project poolr-74494).
export const firebaseConfig = {
  apiKey: 'AIzaSyBJkuWI1XOZp7uXmZNrKC9mWres4JBDdII',
  authDomain: 'poolr-74494.firebaseapp.com',
  projectId: 'poolr-74494',
  storageBucket: 'poolr-74494.firebasestorage.app',
  messagingSenderId: '567447161229',
  appId: '1:567447161229:web:53225c8faf7d74a52cd5c4',
  measurementId: 'G-KHE87497DS',
}

// The Web Push (VAPID) public key from Project settings -> Cloud
// Messaging -> Web Push certificates. The browser presents it when
// asking Firebase for this device's push token.
export const FIREBASE_VAPID_KEY =
  'BIgskXGtKRVANhYw1xez-fE5-xlWqpzwVVqrF3-_dhWZQcu07JtHTeMCWT--rCxUc6ZpVDV0xUXtXRZaX1InozA'

let app: FirebaseApp | null = null
let messaging: Messaging | null = null
let messagingChecked = false

// Returns the shared Firebase app instance, creating it on first use.
export function getFirebaseApp(): FirebaseApp {
  if (!app) app = initializeApp(firebaseConfig)
  return app
}

// Returns the Firebase Messaging instance, or null when this browser
// cannot do web push at all (unsupported browser or insecure context).
// The check runs once and the answer is cached.
export async function getFirebaseMessaging(): Promise<Messaging | null> {
  if (messagingChecked) return messaging
  messagingChecked = true
  if (!(await isSupported())) return null
  messaging = getMessaging(getFirebaseApp())
  return messaging
}
