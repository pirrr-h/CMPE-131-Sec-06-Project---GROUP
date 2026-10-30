import { useEffect, useRef } from 'react';
import mapboxgl from 'mapbox-gl';
import 'mapbox-gl/dist/mapbox-gl.css';
import polyline from '@mapbox/polyline';

mapboxgl.accessToken = import.meta.env.VITE_MAPBOX_TOKEN as string;

export interface MapPin {
  lat: number;
  lng: number;
  label: string;
  color?: string;
}

interface Props {
  pins: MapPin[];
  routePolyline?: string | null;
  height?: number;
}

const DEFAULT_CENTER: [number, number] = [-121.881, 37.335];

export default function MapView({ pins, routePolyline, height = 360 }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<mapboxgl.Map | null>(null);

  useEffect(() => {
    if (!containerRef.current) return;
    const map = new mapboxgl.Map({
      container: containerRef.current,
      style: 'mapbox://styles/mapbox/streets-v12',
      center: DEFAULT_CENTER,
      zoom: 11,
    });
    mapRef.current = map;
    return () => map.remove();
  }, []);

  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;

    const markers = pins.map((p) =>
      new mapboxgl.Marker({ color: p.color ?? '#2563eb' })
        .setLngLat([p.lng, p.lat])
        .setPopup(new mapboxgl.Popup().setText(p.label))
        .addTo(map),
    );

    const line: [number, number][] = routePolyline
      ? polyline.decode(routePolyline).map(([lat, lng]) => [lng, lat])
      : [];

    const draw = () => {
      if (map.getLayer('route')) map.removeLayer('route');
      if (map.getSource('route')) map.removeSource('route');
      if (line.length > 0) {
        map.addSource('route', {
          type: 'geojson',
          data: { type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: line } },
        });
        map.addLayer({
          id: 'route',
          type: 'line',
          source: 'route',
          paint: { 'line-color': '#2563eb', 'line-width': 4 },
        });
      }

      const points: [number, number][] = [...pins.map((p) => [p.lng, p.lat] as [number, number]), ...line];
      if (points.length === 1) {
        map.setCenter(points[0]);
      } else if (points.length > 1) {
        const bounds = new mapboxgl.LngLatBounds(points[0], points[0]);
        points.forEach((pt) => bounds.extend(pt));
        map.fitBounds(bounds, { padding: 40, maxZoom: 14 });
      }
    };

    if (map.isStyleLoaded()) draw();
    else map.once('load', draw);

    return () => markers.forEach((m) => m.remove());
  }, [pins, routePolyline]);

  return <div ref={containerRef} style={{ height, width: '100%', borderRadius: 8 }} />;
}