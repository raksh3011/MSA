import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import type { Geofence, Severity, Vessel, VesselCategory } from '../core/types';
import type { LatLon } from '../core/geo';
import {
  BOUNDARIES,
  CONTIGUOUS_POLYS,
  EEZ_POLYS,
  FOREIGN_WATERS,
  HIGH_RISK_ZONES,
  TERRITORIAL_POLYS,
} from '../core/zones';
import { h } from './dom';
import { VesselLayer } from './vesselLayer';

// Esri World Ocean Base: free to use with attribution, no API key, and bathymetry suits a maritime product.
const TILES = 'https://server.arcgisonline.com/ArcGIS/rest/services/Ocean/World_Ocean_Base/MapServer/tile/{z}/{y}/{x}';
const ATTRIBUTION = 'Tiles &copy; Esri &mdash; GEBCO, NOAA, National Geographic, DeLorme, HERE, Geonames.org and contributors';

export function addBaseLayer(map: L.Map): void {
  L.tileLayer(TILES, { attribution: ATTRIBUTION, maxZoom: 12, maxNativeZoom: 10 }).addTo(map);
}

export type ZoneKey = 'territorial' | 'contiguous' | 'eez' | 'foreign' | 'boundary' | 'highRisk' | 'geofence';

export const ZONE_LABEL: Record<ZoneKey, string> = {
  territorial: 'Territorial sea (12 nm)',
  contiguous: 'Contiguous zone (24 nm)',
  eez: 'Exclusive Economic Zone (200 nm)',
  foreign: 'Neighbouring waters (modelled)',
  boundary: 'Maritime boundary lines (modelled)',
  highRisk: 'High-risk areas (indicative)',
  geofence: 'Geofences',
};

export const ZONE_STYLE: Record<ZoneKey, { color: string; fill: number; dash?: string }> = {
  territorial: { color: '#2563eb', fill: 0.28 },
  contiguous: { color: '#3b82f6', fill: 0.16 },
  eez: { color: '#1d4ed8', fill: 0.06, dash: '7 6' },
  foreign: { color: '#64748b', fill: 0.14, dash: '2 4' },
  boundary: { color: '#ea580c', fill: 0 },
  highRisk: { color: '#dc2626', fill: 0.14 },
  geofence: { color: '#7c3aed', fill: 0.1 },
};

export type ZoneGroups = Record<ZoneKey, L.LayerGroup>;

/** Draw all modelled zones into toggleable groups. */
export function buildZoneGroups(): ZoneGroups {
  const groups = Object.fromEntries((Object.keys(ZONE_LABEL) as ZoneKey[]).map((k) => [k, L.layerGroup()])) as ZoneGroups;
  const poly = (rings: LatLon[][], key: ZoneKey, tip?: string, extra: L.PolylineOptions = {}): void => {
    const st = ZONE_STYLE[key];
    const p = L.polygon(rings, { color: st.color, weight: key === 'eez' ? 1.6 : 1, fillOpacity: st.fill, dashArray: st.dash, ...extra });
    if (tip) p.bindTooltip(tip, { sticky: true });
    p.addTo(groups[key]);
  };

  for (const p of EEZ_POLYS) poly(p, 'eez', 'India EEZ - modelled 200 nm limit (not the official gazetted limit)', { interactive: false });
  for (const p of CONTIGUOUS_POLYS) poly(p, 'contiguous', 'Contiguous zone (12-24 nm) - modelled');
  for (const p of TERRITORIAL_POLYS) poly(p, 'territorial', 'Territorial sea (0-12 nm) - modelled', { weight: 1.2 });
  for (const f of FOREIGN_WATERS) for (const p of f.polys) poly(p, 'foreign', `${f.name} waters - modelled equidistance, not official`);
  for (const z of HIGH_RISK_ZONES) {
    const st = ZONE_STYLE.highRisk;
    L.polygon(z.polygon, {
      color: z.level === 'high' ? '#dc2626' : '#d97706',
      weight: 1.5,
      dashArray: z.level === 'high' ? undefined : '6 5',
      fillColor: z.level === 'high' ? '#dc2626' : '#f59e0b',
      fillOpacity: st.fill,
    })
      .bindTooltip(`${z.name} - ${z.level === 'high' ? 'high' : 'elevated'} risk (indicative)`, { sticky: true })
      .addTo(groups.highRisk);
  }
  for (const b of BOUNDARIES) {
    for (const line of b.lines) {
      L.polyline(line, { color: ZONE_STYLE.boundary.color, weight: 3, dashArray: '9 6', opacity: 0.95 })
        .bindTooltip(`${b.name} - modelled equidistance line, not the official boundary`, { sticky: true })
        .addTo(groups.boundary);
    }
  }
  return groups;
}

const DEFAULT_VISIBLE: Record<ZoneKey, boolean> = {
  territorial: true,
  contiguous: true,
  eez: true,
  foreign: true,
  boundary: true,
  highRisk: true,
  geofence: true,
};

/** Fisherman / simple maps: all zone groups on. */
export function addZoneLayers(map: L.Map): ZoneGroups {
  const g = buildZoneGroups();
  for (const k of Object.keys(g) as ZoneKey[]) if (DEFAULT_VISIBLE[k]) g[k].addTo(map);
  return g;
}

export interface MapHandlers {
  onSelect: (mmsi: string) => void;
  onMapClick: (lat: number, lon: number) => void;
  onCursor: (lat: number, lon: number) => void;
}

export class MapView {
  readonly map: L.Map;
  readonly zones: ZoneGroups;
  readonly vessels: VesselLayer;

  constructor(el: HTMLElement, handlers: MapHandlers, center: [number, number] = [14, 74], zoom = 4) {
    this.map = L.map(el, { center, zoom, minZoom: 2, worldCopyJump: true, zoomControl: false, attributionControl: true });
    L.control.zoom({ position: 'bottomright' }).addTo(this.map);
    L.control.scale({ position: 'bottomleft', imperial: false }).addTo(this.map);
    addBaseLayer(this.map);
    this.zones = buildZoneGroups();
    for (const k of Object.keys(this.zones) as ZoneKey[]) if (DEFAULT_VISIBLE[k]) this.zones[k].addTo(this.map);
    this.vessels = new VesselLayer({ onSelect: handlers.onSelect });
    this.vessels.addTo(this.map);
    this.map.on('click', (e: L.LeafletMouseEvent) => handlers.onMapClick(e.latlng.lat, e.latlng.lng));
    this.map.on('mousemove', (e: L.LeafletMouseEvent) => handlers.onCursor(e.latlng.lat, e.latlng.lng));
  }

  setZoneVisible(key: ZoneKey, on: boolean): void {
    const g = this.zones[key];
    if (on) g.addTo(this.map);
    else g.remove();
  }

  showVessels(vessels: readonly Vessel[], alertSeverity: ReadonlyMap<string, Severity>, selected: string | null, watched: ReadonlySet<string>, now: number): void {
    this.vessels.set({ vessels, alertSeverity, selected, watched, now });
  }

  setHidden(hidden: ReadonlySet<VesselCategory>): void {
    this.vessels.set({ hidden });
  }

  showGeofences(list: readonly Geofence[]): void {
    this.zones.geofence.clearLayers();
    for (const g of list) {
      L.circle([g.lat, g.lon], { radius: g.radiusNm * 1852, color: ZONE_STYLE.geofence.color, weight: 1.5, fillOpacity: ZONE_STYLE.geofence.fill })
        .bindTooltip(h('div', {}, h('strong', {}, g.name), h('br'), `${g.radiusNm} nm radius`), { sticky: true })
        .addTo(this.zones.geofence);
    }
  }

  focus(lat: number, lon: number, zoom?: number): void {
    this.map.setView([lat, lon], zoom ?? Math.max(this.map.getZoom(), 6), { animate: true });
  }

  invalidate(): void {
    setTimeout(() => this.map.invalidateSize(), 50);
  }
}
