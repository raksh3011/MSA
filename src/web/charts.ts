/** Small, dependency-free SVG/CSS visual components: icons, rings, donuts, bars. All text goes through textContent. */
import { h } from './dom';

const NS = 'http://www.w3.org/2000/svg';

export function svg(tag: string, attrs: Record<string, string | number> = {}, ...children: Array<SVGElement | string>): SVGElement {
  const el = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v));
  for (const c of children) el.append(typeof c === 'string' ? document.createTextNode(c) : c);
  return el;
}

export const rupees = (n: number): string => (n >= 1e7 ? `₹${(n / 1e7).toFixed(2)} Cr` : n >= 1e5 ? `₹${(n / 1e5).toFixed(2)} L` : `₹${Math.round(n).toLocaleString('en-IN')}`);
export const rupeesFull = (n: number): string => `₹${n.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
export const dateOnly = (ts: number): string => new Date(ts).toISOString().slice(0, 10);
export const monthName = (period: string): string => {
  const [y, m] = period.split('-').map(Number) as [number, number];
  return new Date(Date.UTC(y, m - 1, 1)).toLocaleString('en-GB', { month: 'short', year: 'numeric', timeZone: 'UTC' });
};
export const pretty = (s: string): string => s.replace(/_/g, ' ');

// ── icons (24x24 stroke paths) ───────────────────────────────────────────────
const ICONS: Record<string, string[]> = {
  overview: ['M3 3h7v9H3z', 'M14 3h7v5h-7z', 'M14 12h7v9h-7z', 'M3 16h7v5H3z'],
  map: ['M3 6l6-3 6 3 6-3v15l-6 3-6-3-6 3z', 'M9 3v15', 'M15 6v15'],
  supply: ['M21 8l-9-5-9 5v8l9 5 9-5z', 'M3.3 7.5L12 12.5l8.7-5', 'M12 22V12'],
  voyages: ['M3 11l19-9-9 19-2-8z'],
  fleet: ['M3 17l2 4h14l2-4z', 'M5 17v-7l7-4 7 4v7', 'M12 6V3'],
  reports: ['M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z', 'M14 2v6h6', 'M8 13h8', 'M8 17h8'],
  billing: ['M3 5h18a1 1 0 0 1 1 1v12a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1z', 'M2 10h20', 'M6 15h4'],
  org: ['M3 21h18', 'M5 21V7l7-4 7 4v14', 'M9 10h2', 'M13 10h2', 'M9 14h2', 'M13 14h2'],
  analytics: ['M3 3v18h18', 'M7 14v4', 'M12 9v9', 'M17 5v13'],
  zones: ['M12 2l9 4v6c0 5-4 9-9 10-5-1-9-5-9-10V6z'],
  incidents: ['M12 9v4', 'M12 17h.01', 'M10.3 3.9L1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z'],
  service: ['M22 12h-4l-3 9L9 3l-3 9H2'],
  revenue: ['M22 7l-8.5 8.5-5-5L2 17', 'M16 7h6v6'],
  ops: ['M4 3h16a2 2 0 0 1 2 2v4a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z', 'M4 13h16a2 2 0 0 1 2 2v4a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2v-4a2 2 0 0 1 2-2z', 'M6 7h.01', 'M6 17h.01'],
  orgs: ['M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2', 'M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8z', 'M23 21v-2a4 4 0 0 0-3-3.9', 'M16 3.1a4 4 0 0 1 0 7.8'],
  admin: ['M4 21v-7', 'M4 10V3', 'M12 21v-9', 'M12 8V3', 'M20 21v-5', 'M20 12V3', 'M1 14h6', 'M9 8h6', 'M17 16h6'],
  watch: ['M2 12s4-8 10-8 10 8 10 8-4 8-10 8S2 12 2 12z', 'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z'],
  menu: ['M3 6h18', 'M3 12h18', 'M3 18h18'],
  check: ['M20 6L9 17l-5-5'],
  cross: ['M18 6L6 18', 'M6 6l12 12'],
  download: ['M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4', 'M7 10l5 5 5-5', 'M12 15V3'],
  print: ['M6 9V2h12v7', 'M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2', 'M6 14h12v8H6z'],
  shield: ['M12 2l9 4v6c0 5-4 9-9 10-5-1-9-5-9-10V6z', 'M9 12l2 2 4-4'],
  money: ['M12 1v22', 'M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6'],
  clock: ['M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20z', 'M12 6v6l4 2'],
  ship: ['M3 17l2 4h14l2-4z', 'M5 17v-7l7-4 7 4v7'],
};

export function icon(name: string, size = 18): SVGElement {
  const el = svg('svg', { viewBox: '0 0 24 24', width: size, height: size, fill: 'none', 'stroke-width': 1.8, 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true', class: 'ico-svg' });
  el.style.stroke = 'currentColor';
  for (const d of ICONS[name] ?? ICONS.overview ?? []) el.append(svg('path', { d }));
  return el;
}

// ── ring gauge ───────────────────────────────────────────────────────────────
export function ring(pct: number | null, opts: { size?: number; color?: string; label?: string; text?: string } = {}): HTMLElement {
  const size = opts.size ?? 84;
  const r = size / 2 - 7;
  const c = 2 * Math.PI * r;
  const v = pct === null ? 0 : Math.max(0, Math.min(100, pct));
  const track = svg('circle', { cx: size / 2, cy: size / 2, r, fill: 'none', 'stroke-width': 7 });
  track.style.stroke = 'var(--surface-3)';
  const arc = svg('circle', { cx: size / 2, cy: size / 2, r, fill: 'none', 'stroke-width': 7, 'stroke-linecap': 'round', 'stroke-dasharray': `${(c * v) / 100} ${c}`, transform: `rotate(-90 ${size / 2} ${size / 2})` });
  arc.style.stroke = opts.color ?? (v >= 90 ? 'var(--ok)' : v >= 70 ? 'var(--warn)' : 'var(--bad)');
  arc.style.transition = 'stroke-dasharray .8s ease';
  const label = svg('text', { x: size / 2, y: size / 2 + 5, 'text-anchor': 'middle', 'font-size': size / 4.2, 'font-weight': 700 }, opts.text ?? (pct === null ? 'n/a' : `${Math.round(v)}`));
  label.style.fill = 'var(--text)';
  return h('div', { class: 'ring' }, svg('svg', { viewBox: `0 0 ${size} ${size}`, width: size, height: size, role: 'img', 'aria-label': `${opts.label ?? 'value'} ${pct === null ? 'not available' : Math.round(v)}` }, track, arc, label), opts.label ? h('small', {}, opts.label) : null);
}

// ── donut with legend ────────────────────────────────────────────────────────
export interface Slice {
  label: string;
  value: number;
  color: string;
}

export function donut(slices: Slice[], centre: { big: string; small?: string }, size = 150): HTMLElement {
  const total = slices.reduce((a, s) => a + s.value, 0);
  const r = size / 2 - 12;
  const c = 2 * Math.PI * r;
  const root = svg('svg', { viewBox: `0 0 ${size} ${size}`, width: size, height: size, role: 'img', 'aria-label': slices.map((s) => `${s.label} ${s.value}`).join(', ') });
  const base = svg('circle', { cx: size / 2, cy: size / 2, r, fill: 'none', 'stroke-width': 16 });
  base.style.stroke = 'var(--surface-3)';
  root.append(base);
  let offset = 0;
  if (total > 0) {
    for (const s of slices.filter((x) => x.value > 0)) {
      const len = (s.value / total) * c;
      const arc = svg('circle', { cx: size / 2, cy: size / 2, r, fill: 'none', 'stroke-width': 16, 'stroke-dasharray': `${Math.max(0, len - 2)} ${c}`, 'stroke-dashoffset': -offset, transform: `rotate(-90 ${size / 2} ${size / 2})` });
      arc.style.stroke = s.color;
      root.append(arc);
      offset += len;
    }
  }
  const big = svg('text', { x: size / 2, y: size / 2 + 2, 'text-anchor': 'middle', 'font-size': 22, 'font-weight': 750 }, centre.big);
  big.style.fill = 'var(--text)';
  root.append(big);
  if (centre.small) {
    const sm = svg('text', { x: size / 2, y: size / 2 + 18, 'text-anchor': 'middle', 'font-size': 10 }, centre.small);
    sm.style.fill = 'var(--muted)';
    root.append(sm);
  }
  return h('div', { class: 'donut' }, root, h('ul', { class: 'legend-list' }, ...slices.map((s) => h('li', {}, h('span', { class: 'swatch', style: `background:${s.color}` }), s.label, h('strong', {}, String(s.value))))));
}

// ── horizontal bars ──────────────────────────────────────────────────────────
export function hbars(rows: Array<{ label: string; value: number; color?: string; note?: string }>, opts: { max?: number; format?: (n: number) => string } = {}): HTMLElement {
  const max = opts.max ?? Math.max(1, ...rows.map((r) => r.value));
  const fmt = opts.format ?? ((n: number) => String(n));
  return h(
    'div',
    { class: 'hbars' },
    ...rows.map((r) =>
      h(
        'div',
        { class: 'hb' },
        h('span', { class: 'hb-l' }, r.label),
        h('span', { class: 'hb-t' }, h('span', { class: 'hb-f', style: `width:${Math.max(r.value > 0 ? 2 : 0, (r.value / max) * 100)}%;background:${r.color ?? 'var(--accent)'}` })),
        h('span', { class: 'hb-v' }, fmt(r.value)),
        r.note ? h('small', { class: 'hb-n muted' }, r.note) : null,
      ),
    ),
  );
}

// ── grouped columns (billed vs collected) ────────────────────────────────────
export function columns(data: Array<{ label: string; a: number; b: number }>, legend: [string, string], format: (n: number) => string): HTMLElement {
  const W = 420;
  const H = 170;
  const pad = 26;
  const max = Math.max(1, ...data.map((d) => Math.max(d.a, d.b)));
  const slot = (W - pad) / Math.max(1, data.length);
  const root = svg('svg', { viewBox: `0 0 ${W} ${H}`, width: '100%', role: 'img', 'aria-label': `${legend[0]} versus ${legend[1]} by month` });
  const axis = svg('line', { x1: pad, x2: W, y1: H - 22, y2: H - 22 });
  axis.style.stroke = 'var(--border)';
  root.append(axis);
  data.forEach((d, i) => {
    const x = pad + i * slot + slot * 0.14;
    const bw = slot * 0.3;
    for (const [k, v, colour] of [[0, d.a, 'var(--accent)'], [1, d.b, 'var(--ok)']] as const) {
      const hgt = (v / max) * (H - 48);
      const bar = svg('rect', { x: x + k * (bw + 3), y: H - 22 - hgt, width: bw, height: Math.max(v > 0 ? 2 : 0, hgt), rx: 3 });
      bar.style.fill = colour;
      const tip = svg('title', {}, `${d.label} ${k === 0 ? legend[0] : legend[1]}: ${format(v)}`);
      bar.append(tip);
      root.append(bar);
    }
    const t = svg('text', { x: x + bw, y: H - 6, 'text-anchor': 'middle', 'font-size': 10 }, d.label);
    t.style.fill = 'var(--muted)';
    root.append(t);
  });
  return h('div', { class: 'columns' }, root, h('div', { class: 'legend-inline' }, h('span', {}, h('i', { class: 'sw', style: 'background:var(--accent)' }), legend[0]), h('span', {}, h('i', { class: 'sw', style: 'background:var(--ok)' }), legend[1])));
}
