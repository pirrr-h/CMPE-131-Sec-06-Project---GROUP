// Turns an address into coordinates, and gets driving distance/time, using Mapbox.
const token = import.meta.env.VITE_MAPBOX_TOKEN as string | undefined

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

export async function geocode(query: string): Promise<Place> {
  if (!token) {
    throw new Error('Missing VITE_MAPBOX_TOKEN in .env.local, so addresses cannot be looked up.')
  }
  const res = await fetch(
    `https://api.mapbox.com/geocoding/v5/mapbox.places/${encodeURIComponent(query)}.json?limit=1&access_token=${token}`,
  )
  if (!res.ok) throw new Error('Address lookup failed. Check your Mapbox token.')
  const data = await res.json()
  const feature = data.features?.[0]
  if (!feature) throw new Error(`Could not find the address "${query}".`)
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
