// Notifications — the in-app inbox for Poolr's notification rows.
//
// What this page does:
//   Lists the signed-in user's notifications newest first (the database
//   writes a row for every trip event: new request, accepted / declined
//   / cancelled, arrival, trip start and completion, reconfirm
//   reminders, no-match alerts). The same rows are what the
//   notification-drainer turns into FCM pushes — the inbox is the
//   permanent record, the push is just the tap on the shoulder.
//   - Unread rows are highlighted; clicking one marks it read.
//   - "Mark all read" clears the whole list in one update.
//   - A Supabase Realtime subscription prepends new rows live while
//     the page is open (notifications is in the realtime publication).
//   RLS guarantees a user only ever receives their own rows.

import { useEffect, useState } from 'react'
import { Alert, Badge, Button, ListGroup, Spinner } from 'react-bootstrap'
import {
  fetchNotifications,
  markAllNotificationsRead,
  markNotificationRead,
} from '../lib/notifications'
import type { PoolrNotification } from '../lib/notifications'
import { supabase } from '../lib/supabase'

// Formats a notification timestamp for the list: time today, date and
// time for anything older.
function formatWhen(iso: string): string {
  const date = new Date(iso)
  const today = new Date()
  const sameDay = date.toDateString() === today.toDateString()
  return sameDay
    ? date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
    : date.toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
}

// Notifications inbox page: loads the user's rows, keeps them live via
// Realtime, and handles mark-read for a single row and for all rows.
export default function Notifications({ userId }: { userId: string }) {
  const [items, setItems] = useState<PoolrNotification[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  useEffect(() => {
    let cancelled = false
    fetchNotifications(userId)
      .then((rows) => {
        if (cancelled) return
        setItems(rows)
        setError('')
      })
      .catch((err: unknown) => {
        if (cancelled) return
        setError(err instanceof Error ? err.message : 'Could not load notifications.')
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })

    const channel = supabase
      .channel(`notifications-inbox-${userId}`)
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
          setItems((current) => [row, ...current.filter((n) => n.notification_id !== row.notification_id)])
        },
      )
      .subscribe()
    return () => {
      cancelled = true
      void supabase.removeChannel(channel)
    }
  }, [userId])

  // Marks one row read when it is clicked, updating the list in place.
  async function handleOpen(item: PoolrNotification) {
    if (item.read_at) return
    try {
      await markNotificationRead(item.notification_id)
      setItems((current) =>
        current.map((n) =>
          n.notification_id === item.notification_id
            ? { ...n, read_at: new Date().toISOString() }
            : n,
        ),
      )
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not mark that notification read.')
    }
  }

  // Marks every unread row read and clears the highlighting.
  async function handleMarkAllRead() {
    try {
      await markAllNotificationsRead(userId)
      const now = new Date().toISOString()
      setItems((current) => current.map((n) => (n.read_at ? n : { ...n, read_at: now })))
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not mark notifications read.')
    }
  }

  const unreadCount = items.filter((n) => !n.read_at).length

  if (loading) return <Spinner animation="border" />

  return (
    <div>
      <div className="d-flex justify-content-between align-items-center mb-3">
        <h2 className="mb-0">
          Notifications{' '}
          {unreadCount > 0 && <Badge bg="danger">{unreadCount}</Badge>}
        </h2>
        {unreadCount > 0 && (
          <Button size="sm" variant="outline-secondary" onClick={handleMarkAllRead}>
            Mark all read
          </Button>
        )}
      </div>

      {error && <Alert variant="danger">{error}</Alert>}

      {items.length === 0 ? (
        <p className="text-muted">
          No notifications yet. Trip requests, acceptances, cancellations, and
          departure reminders will appear here.
        </p>
      ) : (
        <ListGroup>
          {items.map((item) => (
            <ListGroup.Item
              key={item.notification_id}
              action
              onClick={() => void handleOpen(item)}
              className={item.read_at ? '' : 'fw-semibold'}
              variant={item.read_at ? undefined : 'light'}
            >
              <div className="d-flex justify-content-between align-items-start">
                <div>
                  <div>{item.title}</div>
                  {item.body && <div className="text-muted fw-normal">{item.body}</div>}
                </div>
                <small className="text-muted ms-3 text-nowrap">{formatWhen(item.created_at)}</small>
              </div>
            </ListGroup.Item>
          ))}
        </ListGroup>
      )}
    </div>
  )
}
