// Turns an address into coordinates, and gets driving distance/time, using Mapbox.
//
// Both lookups are memoized for the life of the page session: the first
// call for an address (or a coordinate pair) goes to Mapbox, and every
// later call with the same address (or pair) reuses the stored result
// instead of asking Mapbox again. That matters because the publish flow
// computes the geocode and the route once for the preview and again when
// the route is actually published — with this cache the second pass is
// free and sends no duplicate Mapbox requests, so the publish step
// cannot burn rate limit re-asking questions the preview already
// answered. Failures are never cached: a lookup that throws, and a route
// lookup that comes back empty, are forgotten so a later call can retry.
const token = import.meta.env.VITE_MAPBOX_TOKEN as string | undefined

// The lowest Mapbox match score a lookup may have and still count as the place the user typed.
const MIN_RELEVANCE = 0.8

export interface Place {
  address: string
  latitude: number
  longitude: number
}

export interface RouteInfo {
  distanceMiles: number
  durationMinutes: number
  polyline: string
}

// Session cache of geocode lookups, keyed by normalized address text.
// Promises are stored (not just finished results) so two calls for the
// same address made at the same time share one Mapbox request.
const geocodeCache = new Map<string, Promise<Place>>()

// Session cache of route lookups, keyed by the two endpoints'
// coordinates rounded to five decimal places (about a metre), so the
// same trip previewed and then published hits the cache exactly.
const routeCache = new Map<string, Promise<RouteInfo | null>>()

// Normalizes an address into its cache key: trimmed, with runs of
// whitespace collapsed and case folded, so "1 Washington Sq " and
// "1  washington sq" are the same lookup.
function geocodeKey(query: string): string {
  return query.trim().replace(/\s+/g, ' ').toLowerCase()
}

// Builds the cache key for a route between two places from their
// coordinates, so the key depends on where the places are, not on how
// their addresses happened to be typed.
function routeKey(from: Place, to: Place): string {
  const a = `${from.latitude.toFixed(5)},${from.longitude.toFixed(5)}`
  const b = `${to.latitude.toFixed(5)},${to.longitude.toFixed(5)}`
  return `${a}->${b}`
}

// Asks Mapbox for one address and returns its display name and
// coordinates, rejecting weak partial matches whose relevance score is
// below the minimum. This is the uncached network call; geocode()
// below is the cached entry point the rest of the app uses.
async function fetchGeocode(query: string): Promise<Place> {
  if (!token) {
    throw new Error('Missing VITE_MAPBOX_TOKEN in .env.local, so addresses cannot be looked up.')
  }
  const res = await fetch(
    `https://api.mapbox.com/geocoding/v5/mapbox.places/${encodeURIComponent(query)}.json?limit=1&types=address,poi,place,locality,neighborhood,district&access_token=${token}`,
  )
  if (!res.ok) throw new Error('Address lookup failed. Check your Mapbox token.')
  const data = await res.json()
  const feature = data.features?.[0]
  if (!feature) throw new Error(`Could not find the address "${query}".`)
  const relevance = (feature.relevance as number | undefined) ?? 0
  if (relevance < MIN_RELEVANCE) {
    throw new Error(`Could not find the address "${query}". Check the spelling, or add the city and ZIP code.`)
  }
  const [longitude, latitude] = feature.center as [number, number]
  return { address: feature.place_name as string, latitude, longitude }
}

// Looks up one address, reusing the session cache: the first call for an
// address goes to Mapbox, later calls with the same address (however it
// was capitalized or spaced) return the stored result with no request.
export function geocode(query: string): Promise<Place> {
  const key = geocodeKey(query)
  const cached = geocodeCache.get(key)
  if (cached) return cached
  const pending = fetchGeocode(query)
  geocodeCache.set(key, pending)
  // A failed lookup must not poison the cache: forget it once it
  // rejects, so the next call for this address tries Mapbox again.
  pending.catch(() => {
    if (geocodeCache.get(key) === pending) geocodeCache.delete(key)
  })
  return pending
}

// Asks Mapbox for the driving route between two places; best effort —
// returns null when unavailable, so a trip can still be published
// without distance/time. This is the uncached network call; getRoute()
// below is the cached entry point the rest of the app uses.
async function fetchRoute(from: Place, to: Place): Promise<RouteInfo | null> {
  if (!token) return null
  try {
    const coords = `${from.longitude},${from.latitude};${to.longitude},${to.latitude}`
    const res = await fetch(
      `https://api.mapbox.com/directions/v5/mapbox/driving/${coords}?geometries=polyline&overview=full&access_token=${token}`,
    )
    if (!res.ok) return null
    const route = (await res.json()).routes?.[0]
    if (!route) return null
    return {
      distanceMiles: Math.round((route.distance / 1609.344) * 100) / 100,
      durationMinutes: Math.round(route.duration / 60),
      polyline: route.geometry as string,
    }
  } catch {
    return null
  }
}

// Gets the driving distance, duration and route line between two
// places, reusing the session cache: a route already computed for a
// preview is returned with no new Mapbox request when the same two
// places are routed again (for example at publish time). An empty
// result is not kept, so a later call can retry after a transient
// Mapbox failure.
export function getRoute(from: Place, to: Place): Promise<RouteInfo | null> {
  const key = routeKey(from, to)
  const cached = routeCache.get(key)
  if (cached) return cached
  const pending = fetchRoute(from, to)
  routeCache.set(key, pending)
  pending.then((route) => {
    if (route === null && routeCache.get(key) === pending) routeCache.delete(key)
  })
  return pending
}

// Empties both session caches, so the next lookup for any address or
// route asks Mapbox again. Not needed in normal use; it exists for
// tests and for a future sign-out hook that wants a clean slate.
export function clearGeocodeCache(): void {
  geocodeCache.clear()
  routeCache.clear()
}
