/**
 * High-performance canvas layer drawing every vessel as a heading-oriented arrow.
 * Supports thousands of vessels, alert rings, watchlist/selection highlights, hover tooltips and hit-testing.
 */
import L from 'leaflet';
import type { Severity, Vessel, VesselCategory } from '../core/types';
import { CATEGORY_COLOR, CATEGORY_LABEL, SEVERITY_COLOR } from './style-tokens';

interface Projected {
  v: Vessel;
  x: number;
  y: number;
}

export interface VesselLayerOptions {
  onSelect: (mmsi: string) => void;
}

export class VesselLayer extends L.Layer {
  private canvas: HTMLCanvasElement | undefined;
  private tip: HTMLDivElement | undefined;
  private vessels: readonly Vessel[] = [];
  private projected: Projected[] = [];
  private alertSeverity: ReadonlyMap<string, Severity> = new Map();
  private watched: ReadonlySet<string> = new Set();
  private selected: string | null = null;
  private hidden: ReadonlySet<VesselCategory> = new Set();
  private trails: ReadonlyMap<string, ReadonlyArray<[number, number]>> = new Map();
  private showTrails = false;
  private showLabels = true;
  private raf = 0;
  private now = Date.now();

  constructor(private readonly opts: VesselLayerOptions) {
    super();
  }

  override onAdd(map: L.Map): this {
    const canvas = L.DomUtil.create('canvas', 'orvms-vessels') as HTMLCanvasElement;
    canvas.style.position = 'absolute';
    canvas.style.pointerEvents = 'none';
    canvas.style.zIndex = '450';
    map.getContainer().appendChild(canvas);
    this.canvas = canvas;
    const tip = L.DomUtil.create('div', 'map-tip') as HTMLDivElement;
    tip.hidden = true;
    map.getContainer().appendChild(tip);
    this.tip = tip;
    map.on('move zoom resize viewreset', this.schedule, this);
    map.on('click', this.onClick, this);
    map.on('mousemove', this.onHover, this);
    map.on('mouseout', this.hideTip, this);
    this.resize();
    this.schedule();
    return this;
  }

  override onRemove(map: L.Map): this {
    map.off('move zoom resize viewreset', this.schedule, this);
    map.off('click', this.onClick, this);
    map.off('mousemove', this.onHover, this);
    map.off('mouseout', this.hideTip, this);
    this.canvas?.remove();
    this.tip?.remove();
    cancelAnimationFrame(this.raf);
    return this;
  }

  set(data: {
    vessels?: readonly Vessel[];
    alertSeverity?: ReadonlyMap<string, Severity>;
    watched?: ReadonlySet<string>;
    selected?: string | null;
    hidden?: ReadonlySet<VesselCategory>;
    trails?: ReadonlyMap<string, ReadonlyArray<[number, number]>>;
    showTrails?: boolean;
    showLabels?: boolean;
    now?: number;
  }): void {
    if (data.vessels) this.vessels = data.vessels;
    if (data.alertSeverity) this.alertSeverity = data.alertSeverity;
    if (data.watched) this.watched = data.watched;
    if (data.selected !== undefined) this.selected = data.selected;
    if (data.hidden) this.hidden = data.hidden;
    if (data.trails) this.trails = data.trails;
    if (data.showTrails !== undefined) this.showTrails = data.showTrails;
    if (data.showLabels !== undefined) this.showLabels = data.showLabels;
    if (data.now !== undefined) this.now = data.now;
    this.schedule();
  }

  private schedule(): void {
    if (this.raf) return;
    this.raf = requestAnimationFrame(() => {
      this.raf = 0;
      this.draw();
    });
  }

  private resize(): void {
    const map = this._map;
    if (!map || !this.canvas) return;
    const size = map.getSize();
    const dpr = window.devicePixelRatio || 1;
    this.canvas.width = size.x * dpr;
    this.canvas.height = size.y * dpr;
    this.canvas.style.width = `${size.x}px`;
    this.canvas.style.height = `${size.y}px`;
    this.canvas.style.left = '0px';
    this.canvas.style.top = '0px';
  }

  private draw(): void {
    const map = this._map;
    const canvas = this.canvas;
    if (!map || !canvas) return;
    const size = map.getSize();
    const dpr = window.devicePixelRatio || 1;
    if (canvas.width !== size.x * dpr || canvas.height !== size.y * dpr) this.resize();
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, size.x, size.y);

    const zoom = map.getZoom();
    const scale = zoom >= 9 ? 1.5 : zoom >= 6 ? 1.2 : zoom >= 4 ? 1 : 0.8;
    this.projected = [];

    // trails
    if (this.showTrails || this.selected) {
      ctx.lineWidth = 1.5;
      for (const [mmsi, pts] of this.trails) {
        const isSel = mmsi === this.selected;
        if (!isSel && !this.showTrails) continue;
        if (pts.length < 2) continue;
        ctx.strokeStyle = isSel ? 'rgba(255,255,255,0.9)' : 'rgba(120,170,230,0.35)';
        ctx.setLineDash(isSel ? [5, 4] : []);
        ctx.beginPath();
        pts.forEach((p, i) => {
          const pt = map.latLngToContainerPoint(p);
          if (i === 0) ctx.moveTo(pt.x, pt.y);
          else ctx.lineTo(pt.x, pt.y);
        });
        ctx.stroke();
      }
      ctx.setLineDash([]);
    }

    const bounds = map.getBounds().pad(0.05);
    for (const v of this.vessels) {
      if (this.hidden.has(v.category) || !bounds.contains([v.lat, v.lon])) continue;
      const pt = map.latLngToContainerPoint([v.lat, v.lon]);
      this.projected.push({ v, x: pt.x, y: pt.y });
      const sev = this.alertSeverity.get(v.mmsi);
      const isSel = v.mmsi === this.selected;
      const isWatched = this.watched.has(v.mmsi);
      const color = CATEGORY_COLOR[v.category];
      const r = (isSel ? 7 : 5.5) * scale;
      // Fade vessels that have not reported recently (sparse coverage): <30 min full, <6 h dimmed, older faint.
      const age = this.now - v.lastSeen;
      ctx.globalAlpha = isSel || sev ? 1 : age < 30 * 60_000 ? 1 : age < 6 * 3600_000 ? 0.6 : 0.35;

      if (sev) {
        ctx.beginPath();
        ctx.arc(pt.x, pt.y, r + 5, 0, Math.PI * 2);
        ctx.strokeStyle = SEVERITY_COLOR[sev];
        ctx.lineWidth = 2.5;
        ctx.stroke();
      }
      if (isWatched) {
        ctx.beginPath();
        ctx.arc(pt.x, pt.y, r + 9, 0, Math.PI * 2);
        ctx.setLineDash([3, 3]);
        ctx.strokeStyle = '#ffffff';
        ctx.lineWidth = 1.5;
        ctx.stroke();
        ctx.setLineDash([]);
      }
      if (isSel) {
        ctx.beginPath();
        ctx.arc(pt.x, pt.y, r + 12, 0, Math.PI * 2);
        ctx.strokeStyle = '#ffd166';
        ctx.lineWidth = 2;
        ctx.stroke();
      }

      ctx.fillStyle = color;
      ctx.strokeStyle = 'rgba(8,16,28,0.9)';
      ctx.lineWidth = 1.2;
      if (v.sog < 0.5) {
        ctx.beginPath();
        ctx.arc(pt.x, pt.y, r * 0.8, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
      } else {
        const a = ((v.heading || v.cog) * Math.PI) / 180;
        ctx.save();
        ctx.translate(pt.x, pt.y);
        ctx.rotate(a);
        ctx.beginPath();
        ctx.moveTo(0, -r * 1.5);
        ctx.lineTo(r * 0.95, r * 1.1);
        ctx.lineTo(0, r * 0.5);
        ctx.lineTo(-r * 0.95, r * 1.1);
        ctx.closePath();
        ctx.fill();
        ctx.stroke();
        ctx.restore();
      }

      if (this.showLabels && (zoom >= 8 || isSel || (sev && zoom >= 5))) {
        ctx.font = '600 11px system-ui, sans-serif';
        ctx.lineWidth = 3;
        ctx.strokeStyle = 'rgba(8,16,28,0.85)';
        ctx.fillStyle = '#e8eef6';
        ctx.strokeText(v.name, pt.x + r + 6, pt.y + 4);
        ctx.fillText(v.name, pt.x + r + 6, pt.y + 4);
      }
      ctx.globalAlpha = 1;
    }
  }

  private nearest(e: L.LeafletMouseEvent): Projected | null {
    const { x, y } = e.containerPoint;
    let best: Projected | null = null;
    let bestD = 14 * 14;
    for (const p of this.projected) {
      const d = (p.x - x) ** 2 + (p.y - y) ** 2;
      if (d < bestD) {
        bestD = d;
        best = p;
      }
    }
    return best;
  }

  private onClick(e: L.LeafletMouseEvent): void {
    const hit = this.nearest(e);
    if (hit) this.opts.onSelect(hit.v.mmsi);
  }

  private onHover(e: L.LeafletMouseEvent): void {
    const tip = this.tip;
    const map = this._map;
    if (!tip || !map) return;
    const hit = this.nearest(e);
    map.getContainer().style.cursor = hit ? 'pointer' : '';
    if (!hit) return this.hideTip();
    tip.replaceChildren();
    const title = document.createElement('strong');
    title.textContent = hit.v.name;
    const sub = document.createElement('span');
    sub.textContent = `${CATEGORY_LABEL[hit.v.category]} · ${hit.v.flag} · ${hit.v.sog.toFixed(1)} kn`;
    tip.append(title, document.createElement('br'), sub);
    tip.style.left = `${hit.x + 14}px`;
    tip.style.top = `${hit.y - 10}px`;
    tip.hidden = false;
  }

  private hideTip(): void {
    if (this.tip) this.tip.hidden = true;
  }
}
