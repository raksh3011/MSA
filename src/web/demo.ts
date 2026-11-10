/** Static-demo chrome: control bar (clock, speed, role switch), guided tour and the "how it works" diagram. Only used with `--mode static`. */
import { clear, fmtDateTime, h } from './dom';
import type { Session } from './backend';
import { SPEEDS, type LocalBackend } from './local';
import { PERSONAS } from './personas';

interface Step {
  sel?: string;
  title: string;
  text: string;
  list?: string[];
}

const NS = 'http://www.w3.org/2000/svg';
function s<K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string | number> = {}, ...kids: Array<Node | string>): SVGElementTagNameMap[K] {
  const el = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v));
  for (const c of kids) el.append(typeof c === 'string' ? document.createTextNode(c) : c);
  return el;
}

/** The architecture in one picture: what runs in this tab and what runs in production. */
function architecture(): SVGSVGElement {
  const box = (x: number, y: number, w: number, hh: number, title: string, sub: string, cls: string): SVGGElement => {
    const g = s('g', { class: `ab ${cls}` });
    g.append(s('rect', { x, y, width: w, height: hh, rx: 10 }), s('text', { x: x + 12, y: y + 22, class: 't' }, title), s('text', { x: x + 12, y: y + 40, class: 's' }, sub));
    return g;
  };
  const arrow = (d: string): SVGPathElement => s('path', { d, class: 'ar', 'marker-end': 'url(#arw)' });
  const svg = s('svg', { viewBox: '0 0 780 380', role: 'img', 'aria-label': 'ORVMS architecture: the same API code runs in the browser tab or in a Cloudflare Worker', class: 'arch' });
  svg.append(
    s('defs', {}, s('marker', { id: 'arw', markerWidth: 8, markerHeight: 8, refX: 6, refY: 4, orient: 'auto' }, s('path', { d: 'M0 0L7 4L0 8Z', class: 'ah' }))),
    s('text', { x: 14, y: 18, class: 'cap' }, 'THIS PAGE (static demo)'),
    s('text', { x: 440, y: 18, class: 'cap' }, 'PRODUCTION (Cloudflare)'),
    box(14, 28, 200, 56, 'Single-page app', 'TypeScript · Leaflet · no innerHTML', 'tab'),
    box(14, 108, 200, 56, 'Backend interface', 'request() · startFeed()', 'tab'),
    box(240, 108, 170, 56, 'app.fetch()', 'in-page transport', 'tab'),
    box(440, 108, 170, 56, 'HTTPS + WebSocket', 'to the Worker', 'prod'),
    box(14, 196, 396, 56, 'Hono REST API', 'JWT · RBAC on every route · tenant scope · rate limits · validation', 'shared'),
    box(14, 270, 396, 56, 'Services + background jobs', 'voyages · shipments · cases · billing · webhooks · SLA sweeps', 'shared'),
    box(430, 196, 336, 56, 'Domain (pure functions)', 'risk engine · scoring · ETA · SLA · invoicing', 'shared'),
    box(430, 270, 160, 56, 'MemoryRepo', 'this tab', 'tab'),
    box(606, 270, 160, 56, 'D1 (SQL)', 'migrations · production', 'prod'),
    box(240, 28, 170, 56, 'Simulator + Hub', 'vessels · risk engine · alerts', 'tab'),
    box(440, 28, 326, 56, 'Durable Object hub', 'aisstream.io · Digitraffic · WebSocket fan-out', 'prod'),
    arrow('M114 84V108'),
    arrow('M214 136H240'),
    arrow('M114 164V196'),
    arrow('M114 252V270'),
    arrow('M410 224H430'),
    arrow('M510 252V270'),
    arrow('M526 252L686 270'),
    s('text', { x: 14, y: 352, class: 's' }, 'Teal = runs in this tab · dashed = production only · solid grey = identical code in both. The 226 automated tests run this same stack headless.'),
  );
  return svg;
}

export class Tour {
  private i = 0;
  private steps: Step[] = [];
  private layer: HTMLElement | null = null;
  private readonly onKey = (e: KeyboardEvent): void => {
    if (e.key === 'Escape') this.end();
    else if (e.key === 'ArrowRight') this.go(1);
    else if (e.key === 'ArrowLeft') this.go(-1);
  };
  private readonly onResize = (): void => this.show();
  constructor(private readonly onDone: () => void) {}

  start(steps: Step[]): void {
    this.end();
    this.steps = steps;
    this.i = 0;
    this.layer = h('div', { class: 'tour-layer', role: 'dialog', 'aria-label': 'Guided tour' });
    document.body.append(this.layer);
    window.addEventListener('keydown', this.onKey, true);
    window.addEventListener('resize', this.onResize);
    this.show();
  }
  end(): void {
    if (!this.layer) return;
    this.layer.remove();
    this.layer = null;
    window.removeEventListener('keydown', this.onKey, true);
    window.removeEventListener('resize', this.onResize);
    this.onDone();
  }
  private go(d: number): void {
    const n = this.i + d;
    if (n >= this.steps.length) return this.end();
    if (n >= 0) {
      this.i = n;
      this.show();
    }
  }
  private show(): void {
    const layer = this.layer;
    const st = this.steps[this.i];
    if (!layer || !st) return;
    clear(layer);
    const target = st.sel ? document.querySelector<HTMLElement>(st.sel) : null;
    const r = target?.getBoundingClientRect();
    const ok = r && r.width > 4 && r.height > 4 ? r : null;
    const spot = h('div', { class: 'tour-spot' });
    if (ok) Object.assign(spot.style, { left: `${ok.left - 6}px`, top: `${ok.top - 6}px`, width: `${ok.width + 12}px`, height: `${ok.height + 12}px` });
    else Object.assign(spot.style, { left: '50%', top: '40%', width: '0px', height: '0px', borderColor: 'transparent' });
    const last = this.i + 1 >= this.steps.length;
    const tip = h(
      'div',
      { class: 'tour-tip' },
      h('h4', {}, st.title),
      h('p', {}, st.text),
      st.list ? h('ul', {}, ...st.list.map((x) => h('li', {}, x))) : null,
      h(
        'div',
        { class: 'tour-nav' },
        h('span', { class: 'muted' }, `${this.i + 1} / ${this.steps.length}`),
        h('button', { class: 'btn small ghost', onclick: () => this.end() }, last ? 'Close' : 'Skip'),
        this.i > 0 ? h('button', { class: 'btn small', onclick: () => this.go(-1) }, 'Back') : null,
        h('button', { class: 'btn small primary', onclick: () => this.go(1) }, last ? 'Done' : 'Next'),
      ),
    );
    layer.append(spot, tip);
    const tw = Math.min(360, window.innerWidth - 20);
    const th = tip.offsetHeight || 200;
    let x = (window.innerWidth - tw) / 2;
    let y = Math.max(60, (window.innerHeight - th) / 2.4);
    if (ok) {
      if (ok.right + tw + 24 < window.innerWidth) { x = ok.right + 18; y = Math.min(Math.max(ok.top, 56), window.innerHeight - th - 12); }
      else if (ok.bottom + th + 24 < window.innerHeight) { x = Math.min(Math.max(ok.left, 10), window.innerWidth - tw - 10); y = ok.bottom + 14; }
      else if (ok.left - tw - 24 > 0) { x = ok.left - tw - 18; y = Math.min(Math.max(ok.top, 56), window.innerHeight - th - 12); }
      else y = Math.max(56, ok.top - th - 14);
    }
    Object.assign(tip.style, { left: `${x}px`, top: `${y}px`, width: `${tw}px` });
    tip.querySelector<HTMLButtonElement>('.btn.primary')?.focus();
  }
}

export interface DemoHooks {
  session: () => Session | null;
  switchTo: (username: string) => Promise<void>;
}

/** Mount the control bar. Returns tour controls so the app can start the guide after sign-in. */
export function mountDemoBar(backend: LocalBackend, hooks: DemoHooks): { tour: () => void; refresh: () => void } {
  const srv = backend.server;
  document.body.classList.add('has-demo');
  const clock = h('span', { class: 'demo-clock', title: 'Simulated time (the traffic simulator runs in time-lapse)' });
  const play = h('button', { class: 'btn small', 'aria-label': 'Pause or resume the simulation', onclick: () => { srv.setPaused(!srv.paused); sync(); } }, '❚❚');
  const speeds = SPEEDS.map((v) => h('button', { class: 'seg-b', 'aria-pressed': 'false', onclick: () => { srv.setSpeed(v); sync(); } }, `${v}×`));
  const who = h('select', { class: 'demo-who', 'aria-label': 'Switch role', onchange: (e: Event) => void hooks.switchTo((e.target as HTMLSelectElement).value) });
  const tourBtn = h('button', { class: 'btn small', onclick: () => startTour() }, '? Guide');
  const howBtn = h('button', { class: 'btn small how', onclick: () => openHow() }, 'How it works');
  const bar = h(
    'div',
    { class: 'demo-bar', role: 'region', 'aria-label': 'Demo controls' },
    h('span', { class: 'demo-tag' }, 'BROWSER DEMO'),
    h('span', { class: 'demo-note' }, 'The real API runs in this tab. Nothing is sent to a server; data resets on reload.'),
    h('span', { class: 'spacer' }),
    clock,
    h('span', { class: 'demo-ctl' }, play, h('span', { class: 'speed seg', role: 'group', 'aria-label': 'Simulation speed' }, ...speeds)),
    who,
    tourBtn,
    howBtn,
  );
  document.body.prepend(bar);

  const tour = new Tour(() => {
    try { sessionStorage.setItem('orvms_tour_seen', '1'); } catch { /* ignore */ }
  });

  function sync(): void {
    clock.textContent = fmtDateTime(srv.simTime);
    play.textContent = srv.paused ? '▶' : '❚❚';
    play.title = srv.paused ? 'Resume' : 'Pause';
    speeds.forEach((b, i) => b.setAttribute('aria-pressed', String(SPEEDS[i] === srv.speed)));
    const me = hooks.session();
    who.hidden = tourBtn.hidden = !me;
    if (me && who.value !== me.user.username && !who.matches(':focus')) who.value = PERSONAS.some((p) => p.username === me.user.username) ? me.user.username : '';
  }
  who.append(...PERSONAS.map((p) => h('option', { value: p.username }, `View as: ${p.label}`)));
  srv.onChange(sync);
  sync();

  function startTour(): void {
    const me = hooks.session();
    const persona = PERSONAS.find((p) => p.username === me?.user.username);
    const steps: Step[] = [
      { title: 'Welcome to ORVMS', text: `You are signed in as ${me?.user.displayName ?? 'a demo user'}. A simulated fleet sails the Indian Ocean in time-lapse; zone entries, AIS gaps, spoofing and distress scenarios fire over time. Everything you see is computed live by the real server code, running in this page.` },
      { sel: '.sidebar', title: 'Sections', text: 'Navigation is grouped by job: Operate, Monitor, Respond, Govern, Account. You only see what your role is allowed to use.' },
      { sel: '.search', title: 'Find a vessel', text: 'Search by vessel name or MMSI. Press / from anywhere to jump here.' },
      { sel: '.demo-ctl', title: 'Time-lapse', text: 'Pause, or run the clock at 1x, 4x or 16x. Faster time makes voyages progress, SLA timers expire and cases escalate within a minute.' },
      { sel: '.demo-who', title: 'Switch role', text: 'Same data, different persona. Try the operator, then the risk officer: tenant isolation, role checks and the four-eyes approval all happen on the server routes.' },
      ...(persona ? [{ title: `Try this as ${persona.label}`, text: persona.blurb, list: persona.tryThis }] : []),
      { sel: '.demo-bar .how', title: 'System design', text: 'The architecture diagram shows which code is identical to production and what is swapped for the browser.' },
    ];
    tour.start(steps);
  }

  function openHow(): void {
    const prev = document.activeElement as HTMLElement | null;
    const close = (): void => { overlay.remove(); document.removeEventListener('keydown', onEsc); prev?.focus(); };
    const onEsc = (e: KeyboardEvent): void => { if (e.key === 'Escape') close(); };
    const overlay = h(
      'div',
      { class: 'modal', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'How the demo works', onclick: (e: Event) => { if (e.target === overlay) close(); } },
      h(
        'div',
        { class: 'dialog wide' },
        h('h2', {}, 'How this demo works'),
        h('p', { class: 'muted' }, 'ORVMS is a four-layer design: UI, REST API, services, and a domain of pure functions. The production build runs the API inside a Cloudflare Durable Object with D1. This static page loads the same modules and swaps only the transport and storage, so there is no separate "mock".'),
        architecture(),
        h(
          'ul',
          { class: 'how-list' },
          h('li', {}, h('strong', {}, 'One codebase, two runtimes. '), 'Hono routes are called with app.fetch(): over HTTP in production, as a function call here.'),
          h('li', {}, h('strong', {}, 'Rules stay pure. '), 'Risk scoring, ETA, SLA and invoicing take data in and return data out, so they are unit-tested without a server.'),
          h('li', {}, h('strong', {}, 'Tenant isolation by construction. '), 'The organisation id is a parameter of every repository call; the same business API is tested against memory and SQL.'),
          h('li', {}, h('strong', {}, 'Cost-aware. '), 'The upstream AIS socket stays open only while someone is watching, so the free tier is enough.'),
          h('li', {}, h('strong', {}, 'Honest data. '), 'India traffic here is synthetic and labelled; real feeds are aisstream.io and Digitraffic. Zones are modelled, not official limits.'),
        ),
        h('div', { class: 'row' }, h('a', { class: 'btn', href: 'https://github.com/raksh3011/MSA', target: '_blank', rel: 'noopener' }, 'Source on GitHub'), h('button', { class: 'btn primary', onclick: close }, 'Close')),
      ),
    );
    document.body.append(overlay);
    document.addEventListener('keydown', onEsc);
    overlay.querySelector<HTMLButtonElement>('.btn.primary')?.focus();
  }

  return {
    tour: startTour,
    refresh: sync,
  };
}
