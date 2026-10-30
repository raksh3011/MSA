/** The authenticated workspace: header, KPI + alert queue, map with overlays, vessel detail, pages. */
import { classifyZone, nearestBoundaryNm } from '../core/boundary';
import { highRiskZoneOf } from '../core/engine';
import type { Alert, DataSource, Geofence, Severity, VesselCategory } from '../core/types';
import { Backend, type FeedData, type FeedStatus, type Session } from './backend';
import { logoMark, SHORT, NAME } from './brand';
import type { Ctx } from './ctx';
import { clear, fmtDateTime, fmtTime, h } from './dom';
import { MapView, ZONE_LABEL, ZONE_STYLE, type ZoneKey } from './map';
import { adminPage, analyticsPage, fleetPage, zonesPage } from './pages';
import { CATEGORY_COLOR, CATEGORY_LABEL, RULE_LABEL, SEVERITY_RANK } from './style-tokens';
import { getTheme, toggleTheme } from './theme';

type Tab = 'map' | 'fleet' | 'analytics' | 'zones' | 'admin';

const SOURCE_LABEL: Record<DataSource, string> = {
  simulated: 'Simulated · Indian Ocean scenarios',
  digitraffic: 'Live AIS · Baltic Sea (Digitraffic)',
  aisstream: 'Live AIS · aisstream.io',
};
const SOURCE_VIEW: Record<DataSource, { center: [number, number]; zoom: number }> = {
  simulated: { center: [14, 74], zoom: 4 },
  digitraffic: { center: [60.0, 23.5], zoom: 6 },
  aisstream: { center: [14, 74], zoom: 4 },
};

const ZONE_ORDER: ZoneKey[] = ['territorial', 'contiguous', 'eez', 'foreign', 'boundary', 'highRisk', 'geofence'];

function loadJson<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? ({ ...fallback, ...(JSON.parse(raw) as object) } as T) : fallback;
  } catch {
    return fallback;
  }
}
function saveJson(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* storage unavailable */
  }
}

function ago(ts: number, ref: number): string {
  const s = Math.max(0, Math.round((ref - ts) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  return `${Math.round(s / 3600)} h ago`;
}

export function startApp(root: HTMLElement, backend: Backend, session: Session, onLogout: () => void): void {
  root.className = 'app';
  const isOperator = session.user.role === 'operator';
  const canManage = !isOperator;
  let tab: Tab = isOperator ? 'fleet' : 'map';
  let data: FeedData | null = null;
  let selected: string | null = null;
  let status: FeedStatus = { online: true };
  let watch = new Set<string>();
  let geofences: Geofence[] = [];
  let sevFilter: Severity | 'all' = 'all';
  let showClosed = false;
  const hidden = new Set<VesselCategory>();
  let lastSource: DataSource | null = null;
  const trails = new Map<string, Array<[number, number]>>();
  const layerPrefs = loadJson<Record<ZoneKey | 'trails' | 'labels', boolean>>('orvms_layers', {
    territorial: true, contiguous: true, eez: true, foreign: true, boundary: true, highRisk: true, geofence: true, trails: false, labels: true,
  });

  // ── DOM skeleton ────────────────────────────────────────────────────────────
  const mapEl = h('div', { id: 'map', class: 'map', style: 'position:absolute;inset:0', 'aria-label': 'Vessel map' });
  const alertsEl = h('aside', { class: 'panel', 'aria-label': 'Alerts' });
  const detailEl = h('aside', { class: 'panel detail', 'aria-label': 'Vessel details' });
  const pageEl = h('section', { class: 'page hidden' });
  const tabsEl = h('nav', { class: 'tabs', 'aria-label': 'Sections' });
  const statusEl = h('span', { class: 'pill' });
  const clockEl = h('span', { class: 'clock' });
  const sourceEl = h('span', {});
  const searchInput = h('input', { type: 'search', placeholder: 'Search vessel name or MMSI', 'aria-label': 'Search vessels', autocomplete: 'off' });
  const resultsEl = h('div', { class: 'results', hidden: true });
  const layersEl = h('details', { class: 'map-overlay layers', open: true });
  const legendEl = h('details', { class: 'map-overlay legend', open: true });
  const coordsEl = h('div', { class: 'map-overlay coords' }, '—');
  const toastsEl = h('div', { class: 'toasts', 'aria-live': 'polite' });

  const mapView = new MapView(
    mapEl,
    {
      onSelect: (mmsi) => select(mmsi),
      onMapClick: (lat, lon) => {
        if (tab === 'zones') {
          ctx.pendingGeo = { lat, lon };
          renderPage();
        }
      },
      onCursor: (lat, lon) => {
        coordsEl.textContent = `${Math.abs(lat).toFixed(3)}°${lat >= 0 ? 'N' : 'S'}  ${Math.abs(lon).toFixed(3)}°${lon >= 0 ? 'E' : 'W'}`;
      },
    },
    SOURCE_VIEW.simulated.center,
    SOURCE_VIEW.simulated.zoom,
  );

  // ── context for pages ───────────────────────────────────────────────────────
  const ctx: Ctx = {
    backend,
    session,
    isOperator,
    canManage,
    data: () => data,
    watch: () => watch,
    geofences: () => geofences,
    pendingGeo: null,
    api: (method, path, body) => backend.request(method, path, session.token, body),
    alertSeverity: () => alertSeverityMap(),
    openOnMap: (mmsi) => {
      tab = 'map';
      select(mmsi);
    },
    toggleWatch: async (mmsi) => {
      if (watch.has(mmsi)) await ctx.api('DELETE', `/api/watchlist/${mmsi}`);
      else await ctx.api('POST', '/api/watchlist', { mmsi });
      await loadWatch();
      await refreshNow();
      ctx.toast(watch.has(mmsi) ? 'Added to watchlist' : 'Removed from watchlist');
    },
    reloadGeofences: loadGeofences,
    rerenderPage: () => renderPage(),
    toast: (message) => {
      const t = h('div', { class: 'toast', role: 'status' }, message);
      toastsEl.append(t);
      setTimeout(() => t.remove(), 2800);
    },
    alertsFor: (mmsi) => (data?.alerts ?? []).filter((a) => a.mmsi === mmsi),
  };

  const tabs: Array<{ id: Tab; label: string; show: boolean }> = [
    { id: 'map', label: 'Live map', show: true },
    { id: 'fleet', label: isOperator ? 'My fleet' : 'Watchlist', show: true },
    { id: 'analytics', label: 'Analytics', show: true },
    { id: 'zones', label: 'Geofences', show: true },
    { id: 'admin', label: 'Administration', show: session.user.role === 'admin' },
  ];

  const header = h(
    'header',
    { class: 'hdr' },
    h('div', { class: 'brand-lockup', title: NAME }, logoMark(), h('div', {}, h('div', { class: 'brand-name' }, SHORT), h('div', { class: 'brand-sub' }, 'Ocean Risk & Vessel Monitoring'))),
    h('div', { class: 'search' }, h('span', { class: 's-ico', 'aria-hidden': 'true' }, '⌕'), searchInput, h('span', { class: 'kbd' }, '/'), resultsEl),
    tabsEl,
    h('div', { class: 'spacer' }),
    h(
      'div',
      { class: 'hdr-right' },
      sourceEl,
      statusEl,
      clockEl,
      h('button', { class: 'btn small ghost', title: 'Toggle light / dark theme', 'aria-label': 'Toggle theme', onclick: () => { toggleTheme(); ctx.toast(`${getTheme()} theme`); } }, '◐'),
      h(
        'div',
        { class: 'user-chip' },
        h('span', { class: 'avatar', 'aria-hidden': 'true' }, session.user.displayName.slice(0, 1).toUpperCase()),
        h('div', { class: 'user-meta' }, h('div', {}, session.user.displayName), h('small', {}, session.user.role)),
      ),
      h('button', { class: 'btn small', onclick: () => { stopFeed(); clearInterval(clockTimer); mapView.map.remove(); document.removeEventListener('keydown', onKey); onLogout(); } }, 'Sign out'),
    ),
  );

  clear(root);
  root.append(
    header,
    h('div', { class: 'workspace' }, alertsEl, h('div', { class: 'center' }, mapEl, layersEl, legendEl, coordsEl, pageEl), detailEl),
    toastsEl,
  );

  // ── search ──────────────────────────────────────────────────────────────────
  searchInput.addEventListener('input', () => {
    const q = (searchInput as HTMLInputElement).value.trim().toLowerCase();
    clear(resultsEl);
    if (q.length < 2) {
      resultsEl.hidden = true;
      return;
    }
    const hits = (data?.vessels ?? []).filter((v) => v.name.toLowerCase().includes(q) || v.mmsi.includes(q)).slice(0, 12);
    if (hits.length === 0) resultsEl.append(h('div', { class: 'empty' }, 'No matching vessels'));
    for (const v of hits) {
      resultsEl.append(
        h(
          'button',
          {
            onclick: () => {
              resultsEl.hidden = true;
              (searchInput as HTMLInputElement).value = '';
              ctx.openOnMap(v.mmsi);
            },
          },
          h('span', { class: 'swatch', style: `background:${CATEGORY_COLOR[v.category]}` }),
          v.name,
          h('small', {}, `${v.mmsi} · ${v.flag}`),
        ),
      );
    }
    resultsEl.hidden = false;
  });
  const onKey = (e: KeyboardEvent): void => {
    const typing = (e.target as HTMLElement | null)?.matches('input, textarea, select');
    if (e.key === '/' && !typing) {
      e.preventDefault();
      searchInput.focus();
    } else if (e.key === 'Escape') {
      resultsEl.hidden = true;
      if (typing) (e.target as HTMLElement).blur();
      else if (selected) select(null);
    }
  };
  document.addEventListener('keydown', onKey);

  // ── derived data ────────────────────────────────────────────────────────────
  function alertSeverityMap(): Map<string, Severity> {
    const m = new Map<string, Severity>();
    for (const a of data?.alerts ?? []) {
      if (a.status === 'resolved') continue;
      const cur = m.get(a.mmsi);
      if (!cur || SEVERITY_RANK[a.severity] > SEVERITY_RANK[cur]) m.set(a.mmsi, a.severity);
    }
    return m;
  }

  function select(mmsi: string | null): void {
    selected = mmsi;
    renderAll();
    const v = mmsi ? data?.vessels.find((x) => x.mmsi === mmsi) : undefined;
    if (v) mapView.focus(v.lat, v.lon);
  }

  // ── renderers ───────────────────────────────────────────────────────────────
  function renderTabs(): void {
    clear(tabsEl);
    for (const t of tabs.filter((x) => x.show)) {
      tabsEl.append(h('button', { class: `tab ${t.id === tab ? 'active' : ''}`, 'aria-current': t.id === tab ? 'page' : undefined, onclick: () => { tab = t.id; renderAll(); } }, t.label));
    }
  }

  function renderSource(): void {
    clear(sourceEl);
    const src = data?.source ?? backend.demoSource ?? 'simulated';
    if (backend.mode === 'demo') {
      const sel = h(
        'select',
        { class: 'source-select', 'aria-label': 'Data source', onchange: async (e: Event) => {
          const next = (e.target as HTMLSelectElement).value as DataSource;
          await backend.setDemoSource(next);
          data = null;
          trails.clear();
          selected = null;
          const v = SOURCE_VIEW[next];
          mapView.map.setView(v.center, v.zoom);
          await refreshNow();
          ctx.toast(next === 'simulated' ? 'Switched to simulated scenarios' : 'Connecting to live AIS…');
        } },
        h('option', { value: 'simulated' }, 'Simulated · Indian Ocean'),
        h('option', { value: 'digitraffic' }, 'Live AIS · Baltic (real-time)'),
      ) as HTMLSelectElement;
      sel.value = src;
      sourceEl.append(sel);
    } else {
      sourceEl.append(h('span', { class: 'pill' }, SOURCE_LABEL[src]));
    }
  }

  function renderStatus(): void {
    const live = (data?.source ?? 'simulated') !== 'simulated';
    statusEl.className = `pill ${!status.online ? 'bad' : live ? 'ok' : 'sim'}`;
    clear(statusEl);
    const label = !status.online
      ? 'Reconnecting…'
      : status.error
        ? `Feed problem: ${status.error}`
        : `${live ? 'LIVE' : 'SIM'} · ${data?.vessels.length ?? 0} vessels${data && live ? ` · ${ago(data.ts, Date.now())}` : ''}`;
    statusEl.append(h('span', { class: 'dot' }), label);
  }

  function renderClock(): void {
    clockEl.textContent = new Date().toISOString().slice(11, 19) + ' UTC';
    renderStatus();
  }

  function renderAlerts(): void {
    clear(alertsEl);
    const all = data?.alerts ?? [];
    const list = all.filter((a) => showClosed || a.status !== 'resolved').filter((a) => sevFilter === 'all' || a.severity === sevFilter);
    const live = all.filter((a) => a.status !== 'resolved');
    const kpi = (value: number, label: string, cls = ''): HTMLElement => h('div', { class: `kpi ${cls}` }, h('strong', {}, String(value)), h('span', {}, label));
    alertsEl.append(
      h(
        'div',
        { class: 'kpis' },
        kpi(data?.vessels.length ?? 0, 'Vessels'),
        kpi(live.length, 'Open alerts'),
        kpi(live.filter((a) => a.severity === 'critical').length, 'Critical', 'crit'),
        kpi(live.filter((a) => a.severity === 'high').length, 'High', 'high'),
      ),
      h('div', { class: 'panel-head' }, h('h2', {}, isOperator ? 'Fleet alerts' : 'Alert queue'), h('span', { class: 'count' }, String(list.length))),
      h(
        'div',
        { class: 'filters' },
        ...(['all', 'critical', 'high', 'medium', 'low'] as const).map((s) =>
          h('button', { class: `chip ${sevFilter === s ? 'active' : ''}`, 'aria-pressed': String(sevFilter === s), onclick: () => { sevFilter = s; renderAlerts(); } }, s),
        ),
        h('label', { class: 'chk' }, h('input', { type: 'checkbox', checked: showClosed, onchange: (e: Event) => { showClosed = (e.target as HTMLInputElement).checked; renderAlerts(); } }), 'show resolved'),
      ),
    );
    const ul = h('ul', { class: 'alert-list' });
    for (const a of list.slice(0, 100)) ul.append(alertItem(a));
    if (list.length === 0) ul.append(h('li', { class: 'empty' }, isOperator ? 'No alerts for your vessels. Add vessels from the My fleet tab.' : 'No alerts match. All quiet.'));
    alertsEl.append(ul);
  }

  function alertItem(a: Alert): HTMLElement {
    const ref = data?.ts ?? Date.now();
    return h(
      'li',
      { class: `alert sev-${a.severity} st-${a.status} ${a.mmsi === selected ? 'sel' : ''}` },
      h(
        'button',
        { class: 'alert-main', onclick: () => ctx.openOnMap(a.mmsi) },
        h('div', { class: 'alert-top' }, h('span', { class: 'sevtag' }, a.severity.toUpperCase()), h('span', { class: 'rule' }, RULE_LABEL[a.ruleId] ?? a.ruleId), h('span', { class: 'time' }, `${fmtTime(a.ts)} · ${ago(a.ts, ref)}`)),
        h('div', { class: 'alert-msg' }, a.message),
      ),
      a.status === 'resolved'
        ? h('div', { class: 'alert-foot muted' }, `Resolved by ${a.handledBy ?? '-'}${a.note ? ` - ${a.note}` : ''}`)
        : h(
            'div',
            { class: 'alert-foot' },
            a.status === 'acknowledged' ? h('span', { class: 'muted' }, `Acknowledged by ${a.handledBy ?? ''}`) : h('button', { class: 'btn small', onclick: () => void act(a, 'ack') }, 'Acknowledge'),
            h('button', { class: 'btn small', onclick: () => void act(a, 'resolve') }, 'Resolve'),
          ),
    );
  }

  async function act(a: Alert, kind: 'ack' | 'resolve'): Promise<void> {
    const note = kind === 'resolve' ? (prompt('Resolution note (optional):') ?? undefined) : undefined;
    await ctx.api('POST', `/api/alerts/${a.id}/${kind}`, note ? { note } : {});
    await refreshNow();
    ctx.toast(kind === 'ack' ? 'Alert acknowledged' : 'Alert resolved');
  }

  function renderDetail(): void {
    clear(detailEl);
    detailEl.classList.toggle('open', selected !== null);
    const v = selected ? data?.vessels.find((x) => x.mmsi === selected) : undefined;
    if (!v) {
      detailEl.append(h('div', { class: 'panel-head' }, h('h2', {}, 'Vessel details')), h('p', { class: 'empty' }, 'Select a vessel on the map, from search or from an alert.'));
      mapView.vessels.set({ selected: null });
      return;
    }
    const ref = data?.ts ?? Date.now();
    const zone = classifyZone(v.lat, v.lon);
    const risk = highRiskZoneOf(v);
    const zoneText: Record<string, string> = {
      territorial: 'Indian territorial sea (12 nm)',
      contiguous: 'Indian contiguous zone',
      eez: 'Indian EEZ',
      foreign: `${zone.country ?? 'Foreign'} waters (modelled)`,
      high_seas: 'Outside modelled Indian waters',
    };
    const row = (k: string, val: string): HTMLElement => h('div', { class: 'kv' }, h('span', {}, k), h('strong', {}, val));
    const mine = (data?.alerts ?? []).filter((a) => a.mmsi === v.mmsi).slice(0, 6);
    detailEl.append(
      h('div', { class: 'panel-head' }, h('h2', {}, v.name), h('button', { class: 'btn small', 'aria-label': 'Close details', onclick: () => select(null) }, '✕')),
      h('div', { class: 'swatch-row' }, h('span', { class: 'swatch', style: `background:${CATEGORY_COLOR[v.category]}` }), CATEGORY_LABEL[v.category]),
      h('div', {}, h('span', { class: `zone-tag ${zone.zone}` }, zoneText[zone.zone] ?? zone.zone), risk ? h('span', { class: 'zone-tag', style: 'margin-left:6px' }, `${risk.name} (${risk.level})`) : null),
      row('MMSI', v.mmsi),
      row('Flag', v.flag),
      row('Position', `${v.lat.toFixed(3)}°, ${v.lon.toFixed(3)}°`),
      row('Speed', `${v.sog.toFixed(1)} kn`),
      row('Course / heading', `${Math.round(v.cog)}° / ${Math.round(v.heading)}°`),
      ...(v.category === 'fishing' ? [row('Nearest boundary', `${nearestBoundaryNm(v.lat, v.lon).toFixed(1)} nm`)] : []),
      row('Last report', `${fmtDateTime(v.lastSeen)} (${ago(v.lastSeen, ref)})`),
      h(
        'div',
        { class: 'detail-actions' },
        h('button', { class: 'btn', onclick: () => mapView.focus(v.lat, v.lon, 8) }, 'Centre'),
        h('button', { class: 'btn', onclick: () => void ctx.toggleWatch(v.mmsi) }, watch.has(v.mmsi) ? '★ Watching' : '☆ Watch'),
      ),
      h('h3', {}, 'Recent alerts'),
      mine.length
        ? h('ul', { class: 'mini' }, ...mine.map((a) => h('li', { class: `kv sev-${a.severity}` }, h('span', {}, h('span', { class: 'dot' }), ` ${fmtTime(a.ts)} `), h('strong', {}, a.message))))
        : h('p', { class: 'empty' }, 'None'),
    );
    mapView.vessels.set({ selected: v.mmsi, trails });
  }

  function renderOverlays(): void {
    // layers
    clear(layersEl);
    const body = h('div', { class: 'body' });
    body.append(h('h3', { style: 'margin-top:6px' }, 'Maritime zones'));
    for (const k of ZONE_ORDER) {
      const st = ZONE_STYLE[k];
      body.append(
        h(
          'label',
          { class: `lyr ${layerPrefs[k] ? '' : 'off'}` },
          h('input', { type: 'checkbox', checked: layerPrefs[k], onchange: (e: Event) => { layerPrefs[k] = (e.target as HTMLInputElement).checked; saveJson('orvms_layers', layerPrefs); mapView.setZoneVisible(k, layerPrefs[k]); renderOverlays(); } }),
          h('span', { class: 'sw', style: `border-color:${st.color};background:${st.color}${Math.round(Math.max(st.fill, 0.15) * 255).toString(16).padStart(2, '0')}` }),
          ZONE_LABEL[k],
        ),
      );
    }
    body.append(h('h3', {}, 'Vessels'));
    for (const [k, label] of [['trails', 'Show all trails'], ['labels', 'Show names']] as const) {
      body.append(
        h('label', { class: 'lyr' }, h('input', { type: 'checkbox', checked: layerPrefs[k], onchange: (e: Event) => { layerPrefs[k] = (e.target as HTMLInputElement).checked; saveJson('orvms_layers', layerPrefs); applyVesselPrefs(); } }), label),
      );
    }
    body.append(h('p', { class: 'muted', style: 'margin:8px 0 0;font-size:.7rem' }, 'Zones are modelled from coastlines (UNCLOS distances), not official limits.'));
    layersEl.append(h('summary', {}, 'Layers', h('span', { class: 'muted' }, '▾')), body);

    // legend
    clear(legendEl);
    const counts = new Map<VesselCategory, number>();
    for (const v of data?.vessels ?? []) counts.set(v.category, (counts.get(v.category) ?? 0) + 1);
    const lb = h('div', { class: 'body' });
    for (const cat of Object.keys(CATEGORY_LABEL) as VesselCategory[]) {
      const n = counts.get(cat) ?? 0;
      if (n === 0 && !hidden.has(cat)) continue;
      lb.append(
        h(
          'label',
          { class: `lyr ${hidden.has(cat) ? 'off' : ''}` },
          h('input', { type: 'checkbox', checked: !hidden.has(cat), onchange: (e: Event) => { if ((e.target as HTMLInputElement).checked) hidden.delete(cat); else hidden.add(cat); mapView.setHidden(new Set(hidden)); renderOverlays(); } }),
          h('span', { class: 'swatch', style: `background:${CATEGORY_COLOR[cat]}` }),
          CATEGORY_LABEL[cat],
          h('span', { class: 'n' }, String(n)),
        ),
      );
    }
    lb.append(h('p', { class: 'muted', style: 'margin:8px 0 0;font-size:.7rem' }, 'Coloured ring = open alert · dashed ring = on watchlist'));
    legendEl.append(h('summary', {}, 'Vessel types', h('span', { class: 'muted' }, '▾')), lb);
  }

  function applyVesselPrefs(): void {
    mapView.vessels.set({ showTrails: layerPrefs.trails, showLabels: layerPrefs.labels });
  }

  async function renderPage(): Promise<void> {
    const isMap = tab === 'map';
    const overlayTab = tab === 'zones';
    mapEl.classList.toggle('hidden', !isMap && !overlayTab);
    layersEl.classList.toggle('hidden', !isMap && !overlayTab);
    legendEl.classList.toggle('hidden', !isMap);
    coordsEl.classList.toggle('hidden', !isMap && !overlayTab);
    pageEl.classList.toggle('hidden', isMap);
    pageEl.classList.toggle('overlay', overlayTab);
    clear(pageEl);
    if (isMap) return mapView.invalidate();
    if (tab === 'fleet') pageEl.append(fleetPage(ctx, () => void downloadCsv()));
    else if (tab === 'analytics') pageEl.append(analyticsPage(ctx));
    else if (tab === 'zones') {
      pageEl.append(zonesPage(ctx));
      mapView.invalidate();
    } else if (tab === 'admin') {
      const el = await adminPage(ctx);
      clear(pageEl);
      pageEl.append(el);
    }
  }

  async function downloadCsv(): Promise<void> {
    const res = await ctx.api<string>('GET', '/api/reports/alerts.csv');
    const url = URL.createObjectURL(new Blob([res.data], { type: 'text/csv' }));
    const a = h('a', { href: url, download: 'orvms-alerts.csv' });
    document.body.append(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
    ctx.toast('Alerts exported');
  }

  function renderAll(): void {
    renderTabs();
    renderSource();
    renderStatus();
    renderAlerts();
    renderDetail();
    renderOverlays();
    void renderPage();
    pushToMap();
  }

  function pushToMap(): void {
    if (data) mapView.showVessels(data.vessels, alertSeverityMap(), selected, watch);
    mapView.showGeofences(geofences);
  }

  // ── data plumbing ───────────────────────────────────────────────────────────
  function onData(d: FeedData): void {
    const firstOfSource = lastSource !== d.source;
    if (firstOfSource) {
      lastSource = d.source;
      const v = SOURCE_VIEW[d.source];
      mapView.map.setView(v.center, v.zoom);
      renderSource();
    }
    data = d;
    for (const v of d.vessels) {
      const t = trails.get(v.mmsi) ?? [];
      const last = t[t.length - 1];
      if (!last || last[0] !== v.lat || last[1] !== v.lon) t.push([v.lat, v.lon]);
      if (t.length > 40) t.shift();
      trails.set(v.mmsi, t);
    }
    if (trails.size > 12_000) trails.clear();
    if (tab === 'analytics' || tab === 'fleet') void renderPage();
    renderStatus();
    renderAlerts();
    renderOverlays();
    if (selected) renderDetail();
    mapView.vessels.set({ trails });
    pushToMap();
  }

  async function loadWatch(): Promise<void> {
    const r = await ctx.api<{ mmsi: string[] }>('GET', '/api/watchlist');
    watch = new Set(r.data.mmsi ?? []);
  }
  async function loadGeofences(): Promise<void> {
    const r = await ctx.api<{ geofences: Geofence[] }>('GET', '/api/geofences');
    geofences = r.data.geofences ?? [];
    mapView.showGeofences(geofences);
  }
  async function refreshNow(): Promise<void> {
    const d = await backend.fetchOnce(session);
    if (d) {
      onData(d);
      renderAll();
    }
  }

  let stopFeed: () => void = () => undefined;
  const clockTimer = setInterval(renderClock, 1000);
  void (async () => {
    for (const k of ZONE_ORDER) mapView.setZoneVisible(k, layerPrefs[k]);
    applyVesselPrefs();
    await Promise.all([loadWatch(), loadGeofences()]);
    renderAll();
    renderClock();
    stopFeed = backend.startFeed(session, onData, (s) => { status = s; renderStatus(); });
  })();
}
