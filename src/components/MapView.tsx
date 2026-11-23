import { useEffect, useRef, useState } from 'react'
import mapboxgl from 'mapbox-gl'
import 'mapbox-gl/dist/mapbox-gl.css'

interface MapViewProps {
  origin: string
  destination: string
}

interface Coordinates {
  longitude: number
  latitude: number
}

const token = import.meta.env.VITE_MAPBOX_TOKEN as string | undefined

export default function MapView({ origin, destination }: MapViewProps) {
  const mapContainer = useRef<HTMLDivElement | null>(null)
  const map = useRef<mapboxgl.Map | null>(null)
  const markers = useRef<mapboxgl.Marker[]>([])
  const [mapReady, setMapReady] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    if (!token || !mapContainer.current || map.current) return

    mapboxgl.accessToken = token

    map.current = new mapboxgl.Map({
      container: mapContainer.current,
      style: 'mapbox://styles/mapbox/streets-v12',
      center: [-122.4194, 37.7749],
      zoom: 9,
    })

    map.current.addControl(new mapboxgl.NavigationControl(), 'top-right')

    map.current.on('load', () => {
      setMapReady(true)
    })

    return () => {
      map.current?.remove()
      map.current = null
    }
  }, [])

  async function geocodeAddress(address: string): Promise<Coordinates> {
    const response = await fetch(
      `https://api.mapbox.com/geocoding/v5/mapbox.places/${encodeURIComponent(
        address,
      )}.json?limit=1&access_token=${token}`,
    )

    if (!response.ok) {
      throw new Error('Could not look up the address.')
    }

    const data = await response.json()
    const coordinates = data.features?.[0]?.center

    if (!coordinates) {
      throw new Error(`Address not found: ${address}`)
    }

    return {
      longitude: coordinates[0],
      latitude: coordinates[1],
    }
  }

  async function showRoute() {
    if (!token || !map.current || !mapReady) return

    if (!origin || !destination) {
      setError('Enter both an origin and destination.')
      return
    }

    setLoading(true)
    setError('')

    try {
      const from = await geocodeAddress(origin)
      const to = await geocodeAddress(destination)

      const routeResponse = await fetch(
        `https://api.mapbox.com/directions/v5/mapbox/driving/` +
          `${from.longitude},${from.latitude};` +
          `${to.longitude},${to.latitude}` +
          `?geometries=geojson&overview=full&access_token=${token}`,
      )

      if (!routeResponse.ok) {
        throw new Error('Could not calculate the route.')
      }

      const routeData = await routeResponse.json()
      const route = routeData.routes?.[0]

      if (!route) {
        throw new Error('No driving route was found.')
      }

      const coordinates = route.geometry.coordinates as [number, number][]

      const geoJson: GeoJSON.Feature<GeoJSON.LineString> = {
        type: 'Feature',
        properties: {},
        geometry: {
          type: 'LineString',
          coordinates,
        },
      }

      const currentMap = map.current

      if (currentMap.getSource('route')) {
        ;(currentMap.getSource('route') as mapboxgl.GeoJSONSource).setData(
          geoJson,
        )
      } else {
        currentMap.addSource('route', {
          type: 'geojson',
          data: geoJson,
        })

        currentMap.addLayer({
          id: 'route',
          type: 'line',
          source: 'route',
          paint: {
            'line-color': '#2563eb',
            'line-width': 5,
            'line-opacity': 0.85,
          },
        })
      }

      markers.current.forEach((marker) => marker.remove())
      markers.current = [
        new mapboxgl.Marker({ color: '#16a34a' })
          .setLngLat([from.longitude, from.latitude])
          .setPopup(new mapboxgl.Popup().setText('Origin'))
          .addTo(currentMap),

        new mapboxgl.Marker({ color: '#dc2626' })
          .setLngLat([to.longitude, to.latitude])
          .setPopup(new mapboxgl.Popup().setText('Destination'))
          .addTo(currentMap),
      ]

      const bounds = new mapboxgl.LngLatBounds()

      coordinates.forEach((coordinate) => {
        bounds.extend(coordinate)
      })

      currentMap.fitBounds(bounds, {
        padding: 60,
        duration: 800,
      })
    } catch (routeError) {
      setError(
        routeError instanceof Error
          ? routeError.message
          : 'Something went wrong.',
      )
    } finally {
      setLoading(false)
    }
  }

  if (!token) {
    return (
      <div className="alert alert-warning">
        Missing <code>VITE_MAPBOX_TOKEN</code> in your environment file.
      </div>
    )
  }

  return (
    <div className="mt-4">
      <button
        type="button"
        className="btn btn-outline-primary mb-3"
        onClick={showRoute}
        disabled={loading || !origin || !destination}
      >
        {loading ? 'Loading route...' : 'Preview route'}
      </button>

      {error && <div className="alert alert-danger">{error}</div>}

      <div
        ref={mapContainer}
        style={{
          width: '100%',
          height: '420px',
          borderRadius: '8px',
          overflow: 'hidden',
        }}
      />
    </div>
  )
}