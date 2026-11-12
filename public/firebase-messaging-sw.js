// Poolr push service worker.
//
// Firebase Cloud Messaging requires this file at the site root: it is
// the service worker Firebase registers when the app asks for a push
// token, and it is what receives pushes while no Poolr tab is open (or
// the tab is in the background). It is plain JavaScript on purpose —
// service workers are served as-is from public/ and never pass through
// the Vite build, so the Firebase config below is written out in full.
// These are the project's PUBLIC web config values, not secrets.

/* global importScripts, firebase, self, clients */

importScripts('https://www.gstatic.com/firebasejs/10.13.2/firebase-app-compat.js')
importScripts('https://www.gstatic.com/firebasejs/10.13.2/firebase-messaging-compat.js')

firebase.initializeApp({
  apiKey: 'AIzaSyBJkuWI1XOZp7uXmZNrKC9mWres4JBDdII',
  authDomain: 'poolr-74494.firebaseapp.com',
  projectId: 'poolr-74494',
  storageBucket: 'poolr-74494.firebasestorage.app',
  messagingSenderId: '567447161229',
  appId: '1:567447161229:web:53225c8faf7d74a52cd5c4',
  measurementId: 'G-KHE87497DS',
})

const messaging = firebase.messaging()

// Handles a background push. Poolr's sender includes a notification
// payload, which the Firebase SDK displays on its own — in that case
// there is nothing to do here. A data-only payload (no notification
// object) is displayed manually from its data fields.
messaging.onBackgroundMessage((payload) => {
  if (payload.notification) return
  const title = (payload.data && payload.data.title) || 'Poolr'
  const body = (payload.data && payload.data.body) || ''
  return self.registration.showNotification(title, { body })
})

// Opens the inbox when a push is clicked: focuses an already-open
// Poolr tab and navigates it to /notifications, or opens a new tab.
self.addEventListener('notificationclick', (event) => {
  event.notification.close()
  const target = '/notifications'
  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then((windowClients) => {
      for (const client of windowClients) {
        if ('focus' in client) {
          client.navigate(target)
          return client.focus()
        }
      }
      return clients.openWindow(target)
    }),
  )
})
