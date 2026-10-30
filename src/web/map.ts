import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import type { Geofence, Severity, Vessel, VesselCategory } from '../core/types';
import type { LatLon } from '../core/geo';
import { EEZ_ZONES, FISHING_BOUNDARY, HIGH_RISK_ZONES } from '../core/zones';
import { h } from './dom';

export const CATEGORY_COLOR: Record<VesselCategory, string> = {
  naval: '#4895ef',
  coast_guard: '#00b4d8',
  cargo: '#06d6a0',
  tanker: '#ffd60a',
  passenger: '#ff9f1c',
  fishing: '#c8d0d8',
  highspeed: '#f72585',
  other: '#90caf9',
};
export const CATEGORY_LABEL: Record<VesselCategory, string> = {
  naval: 'Naval',
  coast_guard: 'Coast Guard',
  cargo: 'Cargo',
  tanker: 'Tanker',
  passenger: 'Passenger',
  fishing: 'Fishing',
  highspeed: 'High-speed craft',
  other: 'Other / unknown',
};
export const SEVERITY_COLOR: Record<Severity, string> = {
  low: '#7aa2f7',
  medium: '#e0af68',
  high: '#ff7a59',
  critical: '#f7768e',
};

// Esri World Ocean Base: free to use with attribution, no API key, and bathymetry suits a maritime product.
const TILES = 'https://server.arcgisonline.com/ArcGIS/rest/services/Ocean/World_Ocean_Base/MapServer/tile/{z}/{y}/{x}';
const ATTRIBUTION = 'Tiles &copy; Esri &mdash; Sources: GEBCO, NOAA, National Geographic, DeLorme, HERE, Geonames.org, and other contributors';

export function addBaseLayer(map: L.Map): void {
  L.tileLayer(TILES, { attribution: ATTRIBUTION, maxZoom: 12, maxNativeZoom: 10 }).addTo(map);
}

export function addZoneLayers(map: L.Map): void {
  for (const z of EEZ_ZONES) {
    L.polygon(z.polygon, { color: '#1d4ed8', weight: 1.5, dashArray: '6 6', fillOpacity: 0.05, interactive: false }).addTo(map);
  }
  for (const z of HIGH_RISK_ZONES) {
    L.polygon(z.polygon, { color: '#d6293e', weight: 1.5, fillOpacity: 0.12, interactive: false })
      .bindTooltip(z.name, { sticky: true })
      .addTo(map);
  }
  L.polyline(FISHING_BOUNDARY as LatLon[], { color: '#e85d04', weight: 3, dashArray: '2 8' })
    .bindTooltip('Illustrative maritime boundary', { sticky: true })
    .addTo(map);
}

export class MapView {
  readonly map: L.Map;
  private readonly renderer = L.canvas({ padding: 0.5 });
  private readonly markers = new Map<string, L.CircleMarker>();
  private readonly geofences = L.layerGroup();
  private trail: L.Polyline | undefined;

  constructor(
    el: HTMLElement,
    private readonly onSelect: (mmsi: string) => void,
    onMapClick: (lat: number, lon: number) => void,
  ) {
    this.map = L.map(el, { center: [14, 72], zoom: 4, minZoom: 2, worldCopyJump: true, preferCanvas: true });
    addBaseLayer(this.map);
    addZoneLayers(this.map);
    this.geofences.addTo(this.map);
    this.map.on('click', (e: L.LeafletMouseEvent) => onMapClick(e.latlng.lat, e.latlng.lng));
  }

  update(vessels: readonly Vessel[], alertSeverity: ReadonlyMap<string, Severity>, selected: string | null, watched: ReadonlySet<string>): void {
    const seen = new Set<string>();
    for (const v of vessels) {
      seen.add(v.mmsi);
      const sev = alertSeverity.get(v.mmsi);
      const isSel = v.mmsi === selected;
      const style: L.CircleMarkerOptions = {
        radius: isSel ? 9 : sev ? 7 : watched.has(v.mmsi) ? 7 : 5,
        color: isSel ? '#000000' : sev ? SEVERITY_COLOR[sev] : watched.has(v.mmsi) ? '#000000' : '#0b1623',
        weight: isSel || sev || watched.has(v.mmsi) ? 2.5 : 1,
        fillColor: CATEGORY_COLOR[v.category],
        fillOpacity: 0.95,
      };
      let m = this.markers.get(v.mmsi);
      if (!m) {
        m = L.circleMarker([v.lat, v.lon], { ...style, renderer: this.renderer });
        m.on('click', (e) => {
          L.DomEvent.stopPropagation(e);
          this.onSelect(v.mmsi);
        });
        m.bindTooltip(() => h('div', {}, h('strong', {}, v.name), h('br'), `${CATEGORY_LABEL[v.category]} - ${v.flag}`), { direction: 'top' });
        m.addTo(this.map);
        this.markers.set(v.mmsi, m);
      } else {
        m.setLatLng([v.lat, v.lon]);
        m.setStyle(style);
      }
    }
    for (const [mmsi, m] of this.markers) {
      if (!seen.has(mmsi)) {
        m.remove();
        this.markers.delete(mmsi);
      }
    }
  }

  showTrail(points: ReadonlyArray<[number, number]> | null): void {
    this.trail?.remove();
    this.trail = undefined;
    if (points && points.length > 1) {
      this.trail = L.polyline(points as LatLon[], { color: '#0b1623', weight: 2, opacity: 0.8, dashArray: '4 4' }).addTo(this.map);
    }
  }

  showGeofences(list: readonly Geofence[]): void {
    this.geofences.clearLayers();
    for (const g of list) {
      L.circle([g.lat, g.lon], { radius: g.radiusNm * 1852, color: '#bb9af7', weight: 1.5, fillOpacity: 0.08 })
        .bindTooltip(g.name, { sticky: true })
        .addTo(this.geofences);
    }
  }

  focus(lat: number, lon: number): void {
    this.map.setView([lat, lon], Math.max(this.map.getZoom(), 6), { animate: true });
  }

  invalidate(): void {
    setTimeout(() => this.map.invalidateSize(), 50);
  }
}
