// Turns an address into coordinates, and gets driving distance/time, using Mapbox.
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

// Looks up one address and returns the matched place, rejecting weak partial matches.
export async function geocode(query: string): Promise<Place> {
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

// Best effort: if this fails the trip is still published, just without distance/time.
export async function getRoute(from: Place, to: Place): Promise<RouteInfo | null> {
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
