// Notification pop-ups for the Poolr app.
//
// Kyaw's rule (2026-11-12): no separate notifications page. When a
// trip event creates a notification for the signed-in user while the
// app is open, it pops up in the top-right corner and disappears on
// its own after a few seconds (or sooner if the user closes it).
// Nothing is stored on screen — once a pop-up is gone, it is gone.

import { Toast } from 'react-bootstrap'
import { useNotificationPopups } from '../lib/notifications'

// How long each pop-up stays on screen before it removes itself.
const POPUP_DISPLAY_MS = 6000

// Renders the signed-in user's live notification pop-ups as a stack
// fixed to the top-right of the window, above the page content. Each
// pop-up auto-hides after POPUP_DISPLAY_MS; the close button and the
// auto-hide both end at the same dismiss call in the hook.
export default function NotificationPopups({ userId }: { userId: string }) {
  const { popups, dismissPopup } = useNotificationPopups(userId)

  if (popups.length === 0) return null

  return (
    <div
      aria-live="polite"
      style={{
        position: 'fixed',
        top: '4.5rem',
        right: '1rem',
        zIndex: 2000,
        display: 'flex',
        flexDirection: 'column',
        gap: '0.5rem',
      }}
    >
      {popups.map((popup) => (
        <Toast
          key={popup.notification_id}
          show
          autohide
          delay={POPUP_DISPLAY_MS}
          onClose={() => dismissPopup(popup.notification_id)}
        >
          <Toast.Header closeButton>
            <strong className="me-auto">{popup.title}</strong>
          </Toast.Header>
          {popup.body && <Toast.Body>{popup.body}</Toast.Body>}
        </Toast>
      ))}
    </div>
  )
}
