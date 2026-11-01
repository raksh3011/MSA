export const NAME = 'Ocean Risk and Vessel Monitoring System';
export const SHORT = 'ORVMS';
export const TAGLINE = 'A multi-tenant platform that links live maritime risk to voyages, shipments and customer commitments - for shipping companies and the Coast Guard.';

const SVG_NS = 'http://www.w3.org/2000/svg';

function svg(tag: string, attrs: Record<string, string>): SVGElement {
  const el = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  return el;
}

/** Logo mark: radar ring, heading arrow and a wave line. Built with DOM APIs (no innerHTML). */
export function logoMark(): SVGElement {
  const root = svg('svg', { viewBox: '0 0 48 48', class: 'logo-mark', role: 'img', 'aria-label': `${SHORT} logo` });
  root.append(
    svg('circle', { cx: '24', cy: '24', r: '21', fill: 'none', stroke: 'var(--accent)', 'stroke-width': '2.5' }),
    svg('circle', { cx: '24', cy: '24', r: '13', fill: 'none', stroke: 'var(--accent)', 'stroke-width': '1.2', 'stroke-dasharray': '3 3', opacity: '.6' }),
    svg('path', { d: 'M24 9 L31 31 L24 26.5 L17 31 Z', fill: 'var(--accent)' }),
    svg('path', { d: 'M9 38 q4 -4 8 0 t8 0 t8 0 t6 0', fill: 'none', stroke: 'var(--accent)', 'stroke-width': '2', 'stroke-linecap': 'round' }),
  );
  return root;
}
