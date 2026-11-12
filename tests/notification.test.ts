// Contract tests for the Poolr notifications package.
//
// These guard the values that must agree across files for push to
// work at all: the Firebase project config in src/lib/firebase.ts and
// in the service worker (which is served outside the Vite build, so
// its copy is typed separately and can silently drift), the VAPID key
// shape, the database RPC names the client calls, and the pop-up
// wiring (Kyaw's rule: no notifications page — pop-ups that appear
// and disappear on their own).

// The repo's Jest tsconfig loads only the jest types, so the two Node
// built-ins used here are declared locally instead of imported.
declare const __dirname: string
declare function require(name: string): unknown

const { readFileSync, existsSync } = require('fs') as {
  readFileSync: (path: string, encoding: string) => string
  existsSync: (path: string) => boolean
}
const { join } = require('path') as {
  join: (...parts: string[]) => string
}

const root = join(__dirname, '..')

// Reads one delivered file as text for contract assertions.
function read(relativePath: string): string {
  return readFileSync(join(root, relativePath), 'utf8')
}

// Reports whether one delivered file exists in the package.
function exists(relativePath: string): boolean {
  return existsSync(join(root, relativePath))
}

describe('firebase client config', () => {
  const firebaseTs = read('src/lib/firebase.ts')

  test('points at the poolr-74494 project', () => {
    expect(firebaseTs).toContain("projectId: 'poolr-74494'")
    expect(firebaseTs).toContain("messagingSenderId: '567447161229'")
    expect(firebaseTs).toContain("authDomain: 'poolr-74494.firebaseapp.com'")
    expect(firebaseTs).toContain("appId: '1:567447161229:web:53225c8faf7d74a52cd5c4'")
  })

  test('has a well-formed VAPID public key', () => {
    const match = firebaseTs.match(/FIREBASE_VAPID_KEY =\s*'([^']+)'/)
    expect(match).not.toBeNull()
    const key = match![1]
    expect(key.startsWith('B')).toBe(true)
    expect(key.length).toBeGreaterThanOrEqual(80)
    expect(key).toMatch(/^[A-Za-z0-9_-]+$/)
  })
})

describe('service worker', () => {
  const sw = read('public/firebase-messaging-sw.js')

  test('carries the same project config as the client', () => {
    expect(sw).toContain("projectId: 'poolr-74494'")
    expect(sw).toContain("messagingSenderId: '567447161229'")
    expect(sw).toContain("appId: '1:567447161229:web:53225c8faf7d74a52cd5c4'")
    expect(sw).toContain("apiKey: 'AIzaSyBJkuWI1XOZp7uXmZNrKC9mWres4JBDdII'")
  })

  test('handles background messages and clicks open the app home', () => {
    expect(sw).toContain('onBackgroundMessage')
    expect(sw).toContain('notificationclick')
    expect(sw).toContain("const target = '/'")
    expect(sw).not.toContain('/notifications')
  })
})

describe('client database calls', () => {
  const notificationsTs = read('src/lib/notifications.ts')

  test('registers and unregisters through the SQL patch RPCs', () => {
    expect(notificationsTs).toContain("rpc('register_push_token'")
    expect(notificationsTs).toContain("rpc('unregister_push_token'")
  })

  test('feeds the pop-ups from a Realtime insert subscription', () => {
    expect(notificationsTs).toContain('useNotificationPopups')
    expect(notificationsTs).toContain("'postgres_changes'")
    expect(notificationsTs).toContain("event: 'INSERT'")
    expect(notificationsTs).toContain("table: 'notifications'")
  })
})

describe('app wiring', () => {
  const appTsx = read('src/App.tsx')
  const popupsTsx = read('src/components/NotificationPopups.tsx')

  test('renders the pop-ups and registers for push', () => {
    expect(appTsx).toContain('NotificationPopups')
    expect(appTsx).toContain('usePushRegistration')
    expect(popupsTsx).toContain('useNotificationPopups')
  })

  test('pop-ups disappear on their own', () => {
    expect(popupsTsx).toContain('autohide')
    expect(popupsTsx).toContain('POPUP_DISPLAY_MS')
  })

  test('there is no notifications page or route', () => {
    expect(appTsx).not.toContain('path="/notifications"')
    expect(appTsx).not.toContain('to="/notifications"')
    expect(appTsx).not.toContain('pages/Notifications')
    expect(exists('src/pages/Notifications.tsx')).toBe(false)
  })
})
