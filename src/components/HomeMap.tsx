import { useEffect, useRef, useState } from 'react'
import mapboxgl from 'mapbox-gl'
import 'mapbox-gl/dist/mapbox-gl.css'

export interface HomeMapMarker {
  id: string
  longitude: number
  latitude: number
  title: string
  details?: string
  color?: string
}

interface HomeMapProps {
  markers: HomeMapMarker[]
  emptyMessage?: string
  onMarkerClick?: (marker: HomeMapMarker) => void
}

const token = import.meta.env.VITE_MAPBOX_TOKEN as string | undefined

export default function HomeMap({
  markers,
  emptyMessage = 'No matches found yet.',
  onMarkerClick,
}: HomeMapProps) {
  const container = useRef<HTMLDivElement | null>(null)
  const map = useRef<mapboxgl.Map | null>(null)
  const mapMarkers = useRef<mapboxgl.Marker[]>([])
  const [ready, setReady] = useState(false)

  useEffect(() => {
    if (!token || !container.current || map.current) return

    mapboxgl.accessToken = token

    map.current = new mapboxgl.Map({
      container: container.current,
      style: 'mapbox://styles/mapbox/streets-v12',
      center: [-122.4194, 37.7749],
      zoom: 9,
    })

    map.current.addControl(new mapboxgl.NavigationControl(), 'top-right')

    map.current.on('load', () => setReady(true))

    return () => {
      mapMarkers.current.forEach((marker) => marker.remove())
      map.current?.remove()
      map.current = null
    }
  }, [])

  useEffect(() => {
    if (!ready || !map.current) return

    const currentMap = map.current

    mapMarkers.current.forEach((marker) => marker.remove())
    mapMarkers.current = []

    const bounds = new mapboxgl.LngLatBounds()

    markers.forEach((markerInfo) => {
      const marker = new mapboxgl.Marker({
        color: markerInfo.color ?? '#2563eb',
      })
        .setLngLat([markerInfo.longitude, markerInfo.latitude])
        .setPopup(
          new mapboxgl.Popup({ offset: 25 }).setHTML(
            `<strong>${markerInfo.title}</strong><br />${
              markerInfo.details ?? ''
            }`,
          ),
        )
        .addTo(currentMap)

      marker.getElement().addEventListener('click', () => {
        onMarkerClick?.(markerInfo)
      })

      mapMarkers.current.push(marker)
      bounds.extend([markerInfo.longitude, markerInfo.latitude])
    })

    if (markers.length > 0) {
      currentMap.fitBounds(bounds, {
        padding: 80,
        maxZoom: 12,
        duration: 700,
      })
    }
  }, [markers, ready, onMarkerClick])

  if (!token) {
    return (
      <div className="alert alert-warning">
        Missing <code>VITE_MAPBOX_TOKEN</code>.
      </div>
    )
  }

  return (
    <div className="position-relative">
      {markers.length === 0 && (
        <div
          className="position-absolute top-0 start-0 m-3 alert alert-info"
          style={{ zIndex: 2 }}
        >
          {emptyMessage}
        </div>
      )}

      <div
        ref={container}
        style={{
          width: '100%',
          height: '520px',
          borderRadius: '8px',
          overflow: 'hidden',
        }}
      />
    </div>
  )
}