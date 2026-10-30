import './style.css';
import type { Alert, Geofence, Policy, Severity, Vessel } from '../core/types';
import { Backend, DEMO_PASSWORD, type FeedData, type Session } from './backend';
import { $, clear, fmtDateTime, fmtTime, h } from './dom';
import { mountFisher } from './fisher';
import { CATEGORY_COLOR, CATEGORY_LABEL, MapView, SEVERITY_COLOR } from './map';

const root = $('#root');
let backend: Backend;

type Tab = 'map' | 'fleet' | 'analytics' | 'zones' | 'admin';
const SEV_RANK: Record<Severity, number> = { critical: 3, high: 2, medium: 1, low: 0 };
const RULE_LABEL: Record<string, string> = {
  eez_entry: 'EEZ entry',
  high_speed_in_eez: 'High speed in EEZ',
  ais_gap: 'AIS gap (dark)',
  high_risk_zone: 'High-risk zone',
  loitering: 'Loitering',
  position_jump: 'Position jump',
  fishing_boundary: 'Fishing boundary',
  geofence: 'Geofence',
};

// ── boot ──────────────────────────────────────────────────────────────────────
async function boot(): Promise<void> {
  root.replaceChildren(h('div', { class: 'boot' }, 'Connecting...'));
  const forceDemo = new URLSearchParams(location.search).has('demo');
  backend = await Backend.connect(forceDemo);
  const saved = readSession();
  if (saved) {
    const check = await backend.request('GET', '/api/me', saved.token);
    if (check.status === 200) return startApp(saved);
    sessionStorage.removeItem('ns_session');
  }
  showLanding();
}

function readSession(): Session | null {
  try {
    const raw = sessionStorage.getItem('ns_session');
    return raw ? (JSON.parse(raw) as Session) : null;
  } catch {
    return null;
  }
}

// ── landing ───────────────────────────────────────────────────────────────────
function modeBanner(): HTMLElement {
  return backend.mode === 'live'
    ? h('div', { class: 'banner live' }, 'LIVE - connected to the NavSight server')
    : h('div', { class: 'banner demo' }, 'DEMO MODE - simulated vessels running in your browser (no server). All features work; data is not real.');
}

function showLanding(): void {
  root.className = '';
  const card = (title: string, who: string, text: string, action: HTMLElement): HTMLElement =>
    h('article', { class: 'persona' }, h('h2', {}, title), h('p', { class: 'who' }, who), h('p', {}, text), action);

  clear(root);
  root.append(
    modeBanner(),
    h(
      'main',
      { class: 'landing' },
      h('div', { class: 'brand-big' }, h('span', { class: 'logo' }, '◈'), h('h1', {}, 'NavSight')),
      h('p', { class: 'tagline' }, 'Maritime situational awareness - one picture of the sea for those who guard it, work it and fish it.'),
      h(
        'div',
        { class: 'personas' },
        card(
          'Coast Guard & Maritime Security',
          'Analysts, watch officers',
          'Live vessel picture, risk alerts (EEZ entry, dark vessels, spoofing, loitering), alert triage with audit trail, geofences.',
          h('button', { class: 'btn primary', onclick: () => showLogin('analyst') }, 'Sign in as analyst'),
        ),
        card(
          'Fleet Operators',
          'Shipping, tanker and cargo companies',
          'Watch your own vessels, get alerts for high-risk zones and AIS gaps, export incident reports for insurers and charterers.',
          h('button', { class: 'btn primary', onclick: () => showLogin('operator') }, 'Sign in as operator'),
        ),
        card(
          'Fishermen & Small Boats',
          'No login. Works offline. Hindi / Gujarati / English',
          'Use your phone GPS to see how far you are from the maritime boundary - no AIS transponder needed.',
          h('button', { class: 'btn accent', onclick: () => { clear(root); mountFisher(root, showLanding); } }, 'Open Boundary Safety'),
        ),
      ),
      h(
        'p',
        { class: 'limits' },
        'Data limits: public AIS shows only vessels that transmit it. Small fishing boats and vessels that switch AIS off are often invisible, and AIS positions can be wrong or spoofed. NavSight is decision support, not a navigation or legal-boundary tool.',
      ),
    ),
  );
}

function showLogin(preset: 'analyst' | 'operator' | 'admin'): void {
  root.className = '';
  const user = h('input', { id: 'u', autocomplete: 'username', value: backend.mode === 'demo' ? preset : '', required: true });
  const pass = h('input', { id: 'p', type: 'password', autocomplete: 'current-password', value: backend.mode === 'demo' ? DEMO_PASSWORD : '', required: true });
  const err = h('p', { class: 'error', role: 'alert' });
  const form = h(
    'form',
    {
      class: 'login',
      onsubmit: async (e: Event) => {
        e.preventDefault();
        err.textContent = '';
        const res = await backend.request<{ token?: string; user?: Session['user']; error?: string }>('POST', '/api/auth/login', undefined, {
          username: (user as HTMLInputElement).value.trim(),
          password: (pass as HTMLInputElement).value,
        });
        if (res.status === 200 && res.data.token && res.data.user) {
          const session = { token: res.data.token, user: res.data.user };
          try {
            sessionStorage.setItem('ns_session', JSON.stringify(session));
          } catch {
            /* private mode: session lasts for this page only */
          }
          startApp(session);
        } else {
          err.textContent = res.data.error ?? 'Sign-in failed';
        }
      },
    },
    h('h2', {}, 'Sign in'),
    backend.mode === 'demo'
      ? h('p', { class: 'muted' }, `Demo accounts: analyst, operator, admin - password "${DEMO_PASSWORD}" (demo mode only).`)
      : null,
    h('label', { for: 'u' }, 'Username'),
    user,
    h('label', { for: 'p' }, 'Password'),
    pass,
    err,
    h('div', { class: 'row' }, h('button', { class: 'btn', type: 'button', onclick: showLanding }, 'Back'), h('button', { class: 'btn primary', type: 'submit' }, 'Sign in')),
  );
  clear(root);
  root.append(modeBanner(), h('main', { class: 'login-wrap' }, form));
  user.focus();
}

// ── main application ──────────────────────────────────────────────────────────
function startApp(session: Session): void {
  root.className = 'app';
  const isOperator = session.user.role === 'operator';
  const canManage = session.user.role !== 'operator';
  let tab: Tab = isOperator ? 'fleet' : 'map';
  let data: FeedData | null = null;
  let selected: string | null = null;
  let online = true;
  let watch = new Set<string>();
  let geofences: Geofence[] = [];
  let sevFilter: Severity | 'all' = 'all';
  let showClosed = false;
  const trails = new Map<string, Array<[number, number]>>();
  let pendingGeo: { lat: number; lon: number } | null = null;

  const mapEl = h('div', { id: 'map', class: 'map', style: 'position:absolute;inset:0', 'aria-label': 'Vessel map' });
  const alertsEl = h('aside', { class: 'panel alerts', 'aria-label': 'Alerts' });
  const detailEl = h('aside', { class: 'panel detail', 'aria-label': 'Vessel details' });
  const pageEl = h('section', { class: 'page hidden' });
  const statusEl = h('span', { class: 'pill' });
  const tabsEl = h('nav', { class: 'tabs', 'aria-label': 'Sections' });

  const mapView = new MapView(
    mapEl,
    (mmsi) => select(mmsi),
    (lat, lon) => {
      if (tab === 'zones') {
        pendingGeo = { lat, lon };
        renderTab();
      }
    },
  );

  const api = <T>(method: string, path: string, body?: unknown) => backend.request<T>(method, path, session.token, body);

  const tabs: Array<{ id: Tab; label: string; show: boolean }> = [
    { id: 'map', label: 'Live map', show: true },
    { id: 'fleet', label: isOperator ? 'My fleet' : 'Watchlist', show: true },
    { id: 'analytics', label: 'Analytics', show: true },
    { id: 'zones', label: 'Geofences', show: true },
    { id: 'admin', label: 'Admin', show: session.user.role === 'admin' },
  ];

  const logout = (): void => {
    stopFeed();
    mapView.map.remove();
    sessionStorage.removeItem('ns_session');
    showLanding();
  };

  root.replaceChildren(
    modeBanner(),
    h(
      'header',
      { class: 'topbar' },
      h('div', { class: 'brand' }, h('span', { class: 'logo' }, '◈'), 'NavSight'),
      tabsEl,
      h('div', { class: 'spacer' }),
      statusEl,
      h('span', { class: 'who-badge' }, `${session.user.displayName} · ${session.user.role}`),
      h('button', { class: 'btn small', onclick: logout }, 'Sign out'),
    ),
    h('div', { class: 'workspace' }, alertsEl, h('div', { class: 'center' }, mapEl, pageEl), detailEl),
  );

  function select(mmsi: string | null): void {
    selected = mmsi;
    renderAll();
    const v = mmsi ? data?.vessels.find((x) => x.mmsi === mmsi) : undefined;
    if (v) mapView.focus(v.lat, v.lon);
  }

  function alertSeverityMap(): Map<string, Severity> {
    const m = new Map<string, Severity>();
    for (const a of data?.alerts ?? []) {
      if (a.status === 'resolved') continue;
      const cur = m.get(a.mmsi);
      if (!cur || SEV_RANK[a.severity] > SEV_RANK[cur]) m.set(a.mmsi, a.severity);
    }
    return m;
  }

  function renderTabs(): void {
    clear(tabsEl);
    for (const t of tabs.filter((x) => x.show)) {
      tabsEl.append(
        h('button', { class: `tab ${t.id === tab ? 'active' : ''}`, 'aria-current': t.id === tab ? 'page' : undefined, onclick: () => { tab = t.id; renderAll(); } }, t.label),
      );
    }
  }

  function renderStatus(): void {
    statusEl.className = `pill ${online ? 'ok' : 'bad'}`;
    statusEl.textContent = online ? `${data?.vessels.length ?? 0} vessels · ${data ? fmtTime(data.ts) : '...'}` : 'Reconnecting...';
  }

  // alerts panel
  function renderAlerts(): void {
    clear(alertsEl);
    const all = data?.alerts ?? [];
    const open = all.filter((a) => (showClosed ? true : a.status !== 'resolved')).filter((a) => sevFilter === 'all' || a.severity === sevFilter);
    alertsEl.append(
      h('div', { class: 'panel-head' }, h('h2', {}, isOperator ? 'Fleet alerts' : 'Alert queue'), h('span', { class: 'count' }, String(open.length))),
      h(
        'div',
        { class: 'filters' },
        ...(['all', 'critical', 'high', 'medium', 'low'] as const).map((s) =>
          h('button', { class: `chip ${sevFilter === s ? 'active' : ''}`, 'aria-pressed': String(sevFilter === s), onclick: () => { sevFilter = s; renderAlerts(); } }, s),
        ),
        h('label', { class: 'chk' }, h('input', { type: 'checkbox', checked: showClosed, onchange: (e: Event) => { showClosed = (e.target as HTMLInputElement).checked; renderAlerts(); } }), 'resolved'),
      ),
    );
    const list = h('ul', { class: 'alert-list' });
    for (const a of open.slice(0, 80)) list.append(alertItem(a));
    if (open.length === 0) {
      list.append(h('li', { class: 'empty' }, isOperator ? 'No alerts for your vessels. Add vessels to your watchlist from the Fleet tab.' : 'No alerts. All quiet.'));
    }
    alertsEl.append(list);
  }

  function alertItem(a: Alert): HTMLElement {
    return h(
      'li',
      { class: `alert sev-${a.severity} st-${a.status}`, style: `--sev:${SEVERITY_COLOR[a.severity]}` },
      h(
        'button',
        { class: 'alert-main', onclick: () => { select(a.mmsi); } },
        h('div', { class: 'alert-top' }, h('span', { class: 'sev' }, a.severity.toUpperCase()), h('span', { class: 'rule' }, RULE_LABEL[a.ruleId] ?? a.ruleId), h('span', { class: 'time' }, fmtTime(a.ts))),
        h('div', { class: 'alert-msg' }, a.message),
      ),
      a.status === 'resolved'
        ? h('div', { class: 'alert-foot muted' }, `Resolved by ${a.handledBy ?? '-'}`)
        : h(
            'div',
            { class: 'alert-foot' },
            a.status === 'acknowledged' ? h('span', { class: 'muted' }, `Ack: ${a.handledBy ?? ''}`) : h('button', { class: 'btn small', onclick: () => act(a, 'ack') }, 'Acknowledge'),
            h('button', { class: 'btn small', onclick: () => act(a, 'resolve') }, 'Resolve'),
          ),
    );
  }

  async function act(a: Alert, kind: 'ack' | 'resolve'): Promise<void> {
    const note = kind === 'resolve' ? (prompt('Resolution note (optional):') ?? undefined) : undefined;
    await api('POST', `/api/alerts/${a.id}/${kind}`, note ? { note } : {});
    await refreshNow();
  }

  // vessel detail panel
  function renderDetail(): void {
    clear(detailEl);
    const v = selected ? data?.vessels.find((x) => x.mmsi === selected) : undefined;
    if (!v) {
      detailEl.append(h('div', { class: 'panel-head' }, h('h2', {}, 'Vessel')), h('p', { class: 'empty' }, 'Select a vessel on the map or an alert to see details.'));
      mapView.showTrail(null);
      return;
    }
    const mine = (data?.alerts ?? []).filter((a) => a.mmsi === v.mmsi).slice(0, 6);
    const row = (k: string, val: string): HTMLElement => h('div', { class: 'kv' }, h('span', {}, k), h('strong', {}, val));
    detailEl.append(
      h('div', { class: 'panel-head' }, h('h2', {}, v.name), h('button', { class: 'btn small', 'aria-label': 'Close details', onclick: () => select(null) }, '✕')),
      h('div', { class: 'swatch-row' }, h('span', { class: 'swatch', style: `background:${CATEGORY_COLOR[v.category]}` }), CATEGORY_LABEL[v.category]),
      row('MMSI', v.mmsi),
      row('Flag', v.flag),
      row('Position', `${v.lat.toFixed(3)}, ${v.lon.toFixed(3)}`),
      row('Speed', `${v.sog.toFixed(1)} kn`),
      row('Course', `${Math.round(v.cog)}°`),
      row('Last report', fmtDateTime(v.lastSeen)),
      h(
        'button',
        { class: 'btn', onclick: () => toggleWatch(v.mmsi) },
        watch.has(v.mmsi) ? '★ On watchlist - remove' : '☆ Add to watchlist',
      ),
      h('h3', {}, 'Recent alerts'),
      mine.length ? h('ul', { class: 'mini' }, ...mine.map((a) => h('li', {}, h('span', { class: `dot sev-${a.severity}` }), `${fmtTime(a.ts)} ${a.message}`))) : h('p', { class: 'empty' }, 'None'),
    );
    mapView.showTrail(trails.get(v.mmsi) ?? null);
  }

  async function toggleWatch(mmsi: string): Promise<void> {
    if (watch.has(mmsi)) await api('DELETE', `/api/watchlist/${mmsi}`);
    else await api('POST', '/api/watchlist', { mmsi });
    await loadWatch();
    await refreshNow();
  }

  // tab pages
  function renderTab(): void {
    const isMap = tab === 'map';
    mapEl.classList.toggle('hidden', !isMap && tab !== 'zones');
    pageEl.classList.toggle('hidden', isMap);
    pageEl.classList.toggle('overlay', tab === 'zones');
    clear(pageEl);
    if (isMap) {
      mapView.invalidate();
      return;
    }
    if (tab === 'fleet') pageEl.append(fleetPage());
    else if (tab === 'analytics') pageEl.append(analyticsPage());
    else if (tab === 'zones') {
      pageEl.append(zonesPage());
      mapView.invalidate();
    } else if (tab === 'admin') void adminPage().then((el) => { clear(pageEl); pageEl.append(el); });
  }

  function vesselTable(list: Vessel[], empty: string): HTMLElement {
    if (list.length === 0) return h('p', { class: 'empty' }, empty);
    const sev = alertSeverityMap();
    return h(
      'table',
      { class: 'tbl' },
      h('thead', {}, h('tr', {}, ...['Vessel', 'MMSI', 'Type', 'Flag', 'Speed', 'Status', ''].map((c) => h('th', {}, c)))),
      h(
        'tbody',
        {},
        ...list.slice(0, 200).map((v) =>
          h(
            'tr',
            {},
            h('td', {}, h('button', { class: 'link', onclick: () => { tab = 'map'; select(v.mmsi); } }, v.name)),
            h('td', {}, v.mmsi),
            h('td', {}, CATEGORY_LABEL[v.category]),
            h('td', {}, v.flag),
            h('td', {}, `${v.sog.toFixed(1)} kn`),
            h('td', {}, sev.get(v.mmsi) ? h('span', { class: `badge sev-${sev.get(v.mmsi)}` }, sev.get(v.mmsi)) : h('span', { class: 'muted' }, 'normal')),
            h('td', {}, h('button', { class: 'btn small', onclick: () => toggleWatch(v.mmsi) }, watch.has(v.mmsi) ? 'Unwatch' : 'Watch')),
          ),
        ),
      ),
    );
  }

  function fleetPage(): HTMLElement {
    const vessels = data?.vessels ?? [];
    const mine = vessels.filter((v) => watch.has(v.mmsi));
    const q = h('input', { type: 'search', placeholder: 'Search by vessel name or MMSI to add...', 'aria-label': 'Search vessels' });
    const results = h('div', {});
    q.addEventListener('input', () => {
      const s = (q as HTMLInputElement).value.trim().toLowerCase();
      clear(results);
      if (s.length < 2) return;
      results.append(vesselTable(vessels.filter((v) => v.name.toLowerCase().includes(s) || v.mmsi.includes(s)).slice(0, 15), 'No matching vessels'));
    });
    return h(
      'div',
      { class: 'page-inner' },
      h('div', { class: 'page-head' }, h('h2', {}, isOperator ? 'My fleet' : 'My watchlist'), h('button', { class: 'btn', onclick: () => void downloadCsv() }, '⬇ Export alerts (CSV)')),
      h('p', { class: 'muted' }, isOperator ? 'Alerts are limited to the vessels on your watchlist. Use the export for insurer / charterer incident reports.' : 'Vessels you flagged for attention.'),
      vesselTable(mine, 'Your watchlist is empty. Search below to add vessels.'),
      h('h3', {}, 'Find vessels'),
      q,
      results,
    );
  }

  async function downloadCsv(): Promise<void> {
    const res = await api<string>('GET', '/api/reports/alerts.csv');
    const url = URL.createObjectURL(new Blob([res.data], { type: 'text/csv' }));
    const a = h('a', { href: url, download: 'navsight-alerts.csv' });
    document.body.append(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }

  function bars(title: string, entries: Array<[string, number, string?]>): HTMLElement {
    const max = Math.max(1, ...entries.map((e) => e[1]));
    return h(
      'section',
      { class: 'card' },
      h('h3', {}, title),
      ...entries.map(([label, n, color]) =>
        h('div', { class: 'bar-row' }, h('span', { class: 'bar-label' }, label), h('span', { class: 'bar' }, h('span', { class: 'bar-fill', style: `width:${(n / max) * 100}%;${color ? `background:${color}` : ''}` })), h('span', { class: 'bar-n' }, String(n))),
      ),
    );
  }

  function analyticsPage(): HTMLElement {
    const vessels = data?.vessels ?? [];
    const alerts = data?.alerts ?? [];
    const count = <T>(items: T[], key: (x: T) => string): Array<[string, number]> => {
      const m = new Map<string, number>();
      for (const i of items) m.set(key(i), (m.get(key(i)) ?? 0) + 1);
      return [...m].sort((a, b) => b[1] - a[1]);
    };
    const open = alerts.filter((a) => a.status === 'open').length;
    return h(
      'div',
      { class: 'page-inner' },
      h('div', { class: 'page-head' }, h('h2', {}, 'Analytics')),
      h('div', { class: 'stats' },
        h('div', { class: 'stat' }, h('strong', {}, String(vessels.length)), 'vessels tracked'),
        h('div', { class: 'stat' }, h('strong', {}, String(open)), 'open alerts'),
        h('div', { class: 'stat' }, h('strong', {}, String(alerts.filter((a) => a.severity === 'critical' || a.severity === 'high').length)), 'high / critical'),
        h('div', { class: 'stat' }, h('strong', {}, String(watch.size)), 'on watchlist'),
      ),
      h(
        'div',
        { class: 'grid2' },
        bars('Vessels by type', count(vessels, (v) => v.category).map(([k, n]) => [CATEGORY_LABEL[k as Vessel['category']], n, CATEGORY_COLOR[k as Vessel['category']]])),
        bars('Alerts by severity', (['critical', 'high', 'medium', 'low'] as const).map((s) => [s, alerts.filter((a) => a.severity === s).length, SEVERITY_COLOR[s]])),
        bars('Alerts by rule', count(alerts, (a) => RULE_LABEL[a.ruleId] ?? a.ruleId)),
        bars('Top flags', count(vessels, (v) => v.flag).slice(0, 8)),
      ),
    );
  }

  function zonesPage(): HTMLElement {
    const name = h('input', { id: 'gn', placeholder: 'e.g. Mumbai approach', maxlength: '60', required: true });
    const lat = h('input', { id: 'gla', type: 'number', step: 'any', required: true, value: pendingGeo ? pendingGeo.lat.toFixed(3) : '' });
    const lon = h('input', { id: 'glo', type: 'number', step: 'any', required: true, value: pendingGeo ? pendingGeo.lon.toFixed(3) : '' });
    const rad = h('input', { id: 'gr', type: 'number', min: '1', max: '500', value: '25', required: true });
    const err = h('p', { class: 'error', role: 'alert' });
    return h(
      'div',
      { class: 'page-inner side' },
      h('div', { class: 'page-head' }, h('h2', {}, 'Geofences')),
      h('p', { class: 'muted' }, canManage ? 'Click the map to pick a centre, then name it. Alerts fire when a vessel enters the circle.' : 'Geofences are managed by analysts. You can view them on the map.'),
      canManage
        ? h(
            'form',
            {
              class: 'stack',
              onsubmit: async (e: Event) => {
                e.preventDefault();
                const r = await api<{ error?: string }>('POST', '/api/geofences', {
                  name: (name as HTMLInputElement).value,
                  lat: parseFloat((lat as HTMLInputElement).value),
                  lon: parseFloat((lon as HTMLInputElement).value),
                  radiusNm: parseFloat((rad as HTMLInputElement).value),
                });
                if (r.status === 201) {
                  pendingGeo = null;
                  await loadGeofences();
                  renderTab();
                } else err.textContent = r.data.error ?? 'Failed';
              },
            },
            h('label', { for: 'gn' }, 'Name'), name,
            h('label', { for: 'gla' }, 'Latitude'), lat,
            h('label', { for: 'glo' }, 'Longitude'), lon,
            h('label', { for: 'gr' }, 'Radius (nm)'), rad,
            err,
            h('button', { class: 'btn primary', type: 'submit' }, 'Create geofence'),
          )
        : null,
      h(
        'ul',
        { class: 'mini' },
        ...geofences.map((g) =>
          h('li', {}, `${g.name} - ${g.radiusNm} nm `, canManage ? h('button', { class: 'btn small', onclick: async () => { await api('DELETE', `/api/geofences/${g.id}`); await loadGeofences(); renderTab(); } }, 'Delete') : null),
        ),
        geofences.length === 0 ? h('li', { class: 'empty' }, 'No geofences yet') : null,
      ),
    );
  }

  async function adminPage(): Promise<HTMLElement> {
    const [pol, aud] = await Promise.all([api<Policy>('GET', '/api/policy'), api<{ audit: Array<{ ts: number; actor: string; action: string; detail: string }> }>('GET', '/api/audit')]);
    const p = pol.data;
    const field = (id: keyof Omit<Policy, 'flagsOfInterest'>, label: string): [HTMLElement, HTMLInputElement] => {
      const inp = h('input', { id: `p-${id}`, type: 'number', step: 'any', value: p[id] });
      return [h('label', { for: `p-${id}` }, label), inp];
    };
    const f1 = field('highSpeedKn', 'High-speed threshold (kn)');
    const f2 = field('aisGapMinutes', 'AIS gap (minutes)');
    const f3 = field('loiterSogKn', 'Loitering speed (kn)');
    const f4 = field('boundaryWarnNm', 'Boundary warning (nm)');
    const flags = h('input', { id: 'p-flags', value: p.flagsOfInterest.join(', '), placeholder: 'e.g. Somalia, Yemen' });
    const msg = h('p', { class: 'muted', role: 'status' });
    return h(
      'div',
      { class: 'page-inner' },
      h('div', { class: 'page-head' }, h('h2', {}, 'Administration')),
      h(
        'form',
        {
          class: 'stack card',
          onsubmit: async (e: Event) => {
            e.preventDefault();
            const r = await api<{ error?: string }>('PUT', '/api/policy', {
              highSpeedKn: parseFloat(f1[1].value),
              aisGapMinutes: parseFloat(f2[1].value),
              loiterSogKn: parseFloat(f3[1].value),
              boundaryWarnNm: parseFloat(f4[1].value),
              flagsOfInterest: (flags as HTMLInputElement).value.split(',').map((s) => s.trim()).filter(Boolean),
            });
            msg.textContent = r.status === 200 ? 'Policy saved.' : (r.data.error ?? 'Failed');
          },
        },
        h('h3', {}, 'Risk policy'),
        h('p', { class: 'muted' }, 'Flags of interest raise EEZ-entry severity. This is a configurable policy decision, not hard-coded.'),
        ...f1, ...f2, ...f3, ...f4,
        h('label', { for: 'p-flags' }, 'Flags of interest (comma-separated)'), flags,
        h('button', { class: 'btn primary', type: 'submit' }, 'Save policy'),
        msg,
      ),
      h(
        'section',
        { class: 'card' },
        h('h3', {}, 'Audit log'),
        h('table', { class: 'tbl' },
          h('thead', {}, h('tr', {}, ...['Time', 'Actor', 'Action', 'Detail'].map((c) => h('th', {}, c)))),
          h('tbody', {}, ...aud.data.audit.slice(0, 60).map((a) => h('tr', {}, h('td', {}, fmtDateTime(a.ts)), h('td', {}, a.actor), h('td', {}, a.action), h('td', {}, a.detail)))),
        ),
      ),
    );
  }

  // data plumbing
  function renderAll(): void {
    renderTabs();
    renderStatus();
    renderAlerts();
    renderDetail();
    renderTab();
    if (data) mapView.update(data.vessels, alertSeverityMap(), selected, watch);
    mapView.showGeofences(geofences);
  }

  function onData(d: FeedData): void {
    data = d;
    for (const v of d.vessels) {
      const t = trails.get(v.mmsi) ?? [];
      const last = t[t.length - 1];
      if (!last || last[0] !== v.lat || last[1] !== v.lon) t.push([v.lat, v.lon]);
      if (t.length > 40) t.shift();
      trails.set(v.mmsi, t);
    }
    if (tab === 'analytics' || tab === 'fleet') renderTab();
    renderStatus();
    renderAlerts();
    if (selected) renderDetail();
    mapView.update(d.vessels, alertSeverityMap(), selected, watch);
  }

  async function loadWatch(): Promise<void> {
    const r = await api<{ mmsi: string[] }>('GET', '/api/watchlist');
    watch = new Set(r.data.mmsi ?? []);
  }
  async function loadGeofences(): Promise<void> {
    const r = await api<{ geofences: Geofence[] }>('GET', '/api/geofences');
    geofences = r.data.geofences ?? [];
    mapView.showGeofences(geofences);
  }

  let stopFeed: () => void = () => undefined;
  async function refreshNow(): Promise<void> {
    const d = await backend.fetchOnce(session);
    if (d) {
      onData(d);
      renderAll();
    }
  }

  void (async () => {
    await Promise.all([loadWatch(), loadGeofences()]);
    renderAll();
    stopFeed = backend.startFeed(session, onData, (o) => { online = o; renderStatus(); });
  })();
}

void boot();
