import type { Alert, Incident, IncidentStatus, Policy, Vessel } from '../core/types';
import { classifyZone } from '../core/boundary';
import { highRiskZoneOf } from '../core/engine';
import type { Ctx } from './ctx';
import { clear, fmtDateTime, h } from './dom';
import { CATEGORY_TEXT } from './report';
import { CATEGORY_COLOR, CATEGORY_LABEL, RULE_LABEL, SEVERITY_COLOR } from './style-tokens';

function zoneText(v: Vessel): string {
  const risk = highRiskZoneOf(v);
  if (risk) return `${risk.level === 'high' ? 'High-risk' : 'Elevated-risk'}: ${risk.name}`;
  const z = classifyZone(v.lat, v.lon);
  switch (z.zone) {
    case 'territorial': return 'Indian territorial sea';
    case 'contiguous': return 'Indian contiguous zone';
    case 'eez': return 'Indian EEZ';
    case 'foreign': return `${z.country ?? 'Foreign'} waters`;
    default: return 'Open sea';
  }
}

function vesselTable(ctx: Ctx, list: Vessel[], empty: string): HTMLElement {
  if (list.length === 0) return h('p', { class: 'empty' }, empty);
  const sev = ctx.alertSeverity();
  return h(
    'table',
    { class: 'tbl' },
    h('thead', {}, h('tr', {}, ...['Vessel', 'MMSI', 'Type', 'Flag', 'Speed', 'Zone', 'Status', ''].map((c) => h('th', {}, c)))),
    h(
      'tbody',
      {},
      ...list.slice(0, 200).map((v) => {
        const s = sev.get(v.mmsi);
        return h(
          'tr',
          {},
          h('td', {}, h('button', { class: 'link', onclick: () => ctx.openOnMap(v.mmsi) }, v.name), v.origin === 'synthetic' ? h('span', { class: 'origin-tag synthetic', style: 'margin-left:6px' }, 'SYN') : null),
          h('td', {}, v.mmsi),
          h('td', {}, CATEGORY_LABEL[v.category]),
          h('td', {}, v.flag),
          h('td', {}, `${v.sog.toFixed(1)} kn`),
          h('td', {}, zoneText(v)),
          h('td', {}, s ? h('span', { class: `badge sev-${s}` }, s) : h('span', { class: 'muted' }, 'normal')),
          h('td', {}, h('button', { class: 'btn small', onclick: () => void ctx.toggleWatch(v.mmsi) }, ctx.watch().has(v.mmsi) ? 'Remove' : 'Add to set')),
        );
      }),
    ),
  );
}

export function fleetPage(ctx: Ctx, onExport: () => void): HTMLElement {
  const vessels = ctx.data()?.vessels ?? [];
  const byMmsi = new Map(vessels.map((v) => [v.mmsi, v]));
  const watched = [...ctx.watch()];
  const mine = watched.map((m) => byMmsi.get(m)).filter((v): v is Vessel => v !== undefined);
  const missing = watched.filter((m) => !byMmsi.has(m));
  const sev = ctx.alertSeverity();
  const inRisk = mine.filter((v) => highRiskZoneOf(v)).length;
  const atRisk = mine.filter((v) => sev.has(v.mmsi)).length;
  const avg = mine.length ? mine.reduce((n, v) => n + v.sog, 0) / mine.length : 0;
  const fleetName = ctx.session.user.fleetName;

  const q = h('input', { type: 'search', placeholder: 'Search by vessel name or MMSI to add to your set...', 'aria-label': 'Search vessels' });
  const results = h('div', {});
  q.addEventListener('input', () => {
    const s = (q as HTMLInputElement).value.trim().toLowerCase();
    clear(results);
    if (s.length < 2) return;
    results.append(vesselTable(ctx, vessels.filter((v) => v.name.toLowerCase().includes(s) || v.mmsi.includes(s)).slice(0, 15), 'No matching vessels'));
  });
  const stat = (n: string | number, label: string): HTMLElement => h('div', { class: 'stat' }, h('strong', {}, String(n)), label);
  return h(
    'div',
    { class: 'page-inner' },
    h('div', { class: 'page-head' }, h('h2', {}, fleetName ? `${fleetName} - fleet` : ctx.isOperator ? 'My fleet' : 'My set'), h('button', { class: 'btn', onclick: onExport }, '⬇ Export alerts (CSV)')),
    h('p', { class: 'muted' }, ctx.isOperator ? 'Your fleet and the alerts raised for it (high-risk areas, foreign waters, AIS gaps, spoofing). Export them for insurer and charterer incident reports.' : 'Vessels you have flagged for attention.'),
    h('div', { class: 'stats' }, stat(watched.length, 'vessels in fleet'), stat(mine.length, 'tracked now'), stat(inRisk, 'in risk areas'), stat(atRisk, 'with open alerts'), stat(avg.toFixed(1), 'avg speed (kn)')),
    vesselTable(ctx, mine, 'No fleet vessel is currently tracked. Add vessels below, or switch on the live/synthetic feed.'),
    missing.length ? h('p', { class: 'muted' }, `Not currently reporting AIS (${missing.length}): ${missing.slice(0, 8).join(', ')}${missing.length > 8 ? '…' : ''}`) : null,
    h('h3', {}, 'Add vessels'),
    q,
    results,
  );
}

function bars(title: string, entries: Array<[string, number, string?]>): HTMLElement {
  const max = Math.max(1, ...entries.map((e) => e[1]));
  return h(
    'section',
    { class: 'card' },
    h('h3', {}, title),
    entries.length === 0 ? h('p', { class: 'empty' }, 'No data') : null,
    ...entries.map(([label, n, color]) =>
      h(
        'div',
        { class: 'bar-row' },
        h('span', {}, label),
        h('span', { class: 'bar' }, h('span', { class: 'bar-fill', style: `width:${(n / max) * 100}%;${color ? `background:${color}` : ''}` })),
        h('span', { class: 'bar-n' }, String(n)),
      ),
    ),
  );
}

function tally<T>(items: T[], key: (x: T) => string): Array<[string, number]> {
  const m = new Map<string, number>();
  for (const i of items) m.set(key(i), (m.get(key(i)) ?? 0) + 1);
  return [...m].sort((a, b) => b[1] - a[1]);
}

export function analyticsPage(ctx: Ctx): HTMLElement {
  const vessels = ctx.data()?.vessels ?? [];
  const alerts = ctx.data()?.alerts ?? [];
  const open = alerts.filter((a) => a.status === 'open').length;
  const urgent = alerts.filter((a) => a.severity === 'critical' || a.severity === 'high').length;
  return h(
    'div',
    { class: 'page-inner' },
    h('div', { class: 'page-head' }, h('h2', {}, 'Analytics')),
    h(
      'div',
      { class: 'stats' },
      h('div', { class: 'stat' }, h('strong', {}, String(vessels.length)), 'vessels tracked'),
      h('div', { class: 'stat' }, h('strong', {}, String(open)), 'open alerts'),
      h('div', { class: 'stat' }, h('strong', {}, String(urgent)), 'high / critical'),
      h('div', { class: 'stat' }, h('strong', {}, String(ctx.watch().size)), 'on watchlist'),
    ),
    h(
      'div',
      { class: 'grid2' },
      bars('Vessels by type', tally(vessels, (v) => v.category).map(([k, n]) => [CATEGORY_LABEL[k as Vessel['category']], n, CATEGORY_COLOR[k as Vessel['category']]])),
      bars('Alerts by severity', (['critical', 'high', 'medium', 'low'] as const).map((s) => [s, alerts.filter((a) => a.severity === s).length, SEVERITY_COLOR[s]])),
      bars('Alerts by rule', tally(alerts, (a: Alert) => RULE_LABEL[a.ruleId] ?? a.ruleId)),
      bars('Top flags', tally(vessels, (v) => v.flag).slice(0, 8)),
    ),
  );
}

export function zonesPage(ctx: Ctx): HTMLElement {
  const g = ctx.pendingGeo;
  const name = h('input', { id: 'gn', placeholder: 'e.g. Mumbai approach', maxlength: '60', required: true });
  const lat = h('input', { id: 'gla', type: 'number', step: 'any', required: true, value: g ? g.lat.toFixed(3) : '' });
  const lon = h('input', { id: 'glo', type: 'number', step: 'any', required: true, value: g ? g.lon.toFixed(3) : '' });
  const rad = h('input', { id: 'gr', type: 'number', min: '1', max: '500', value: '25', required: true });
  const err = h('p', { class: 'error', role: 'alert' });
  const geofences = ctx.geofences();
  return h(
    'div',
    { class: 'page-inner side' },
    h('div', { class: 'page-head' }, h('h2', {}, 'Geofences')),
    h('p', { class: 'muted' }, ctx.canManage ? 'Click the map to pick a centre, then name it. An alert fires when a vessel enters the circle.' : 'Geofences are managed by analysts. They are shown on the map.'),
    ctx.canManage
      ? h(
          'form',
          {
            class: 'stack',
            onsubmit: async (e: Event) => {
              e.preventDefault();
              const r = await ctx.api<{ error?: string }>('POST', '/api/geofences', {
                name: (name as HTMLInputElement).value,
                lat: parseFloat((lat as HTMLInputElement).value),
                lon: parseFloat((lon as HTMLInputElement).value),
                radiusNm: parseFloat((rad as HTMLInputElement).value),
              });
              if (r.status === 201) {
                ctx.pendingGeo = null;
                await ctx.reloadGeofences();
                ctx.toast('Geofence created');
                ctx.rerenderPage();
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
    h('h3', {}, 'Active geofences'),
    h(
      'ul',
      { class: 'mini' },
      ...geofences.map((gf) =>
        h(
          'li',
          { class: 'kv' },
          h('span', {}, `${gf.name} · ${gf.radiusNm} nm`),
          ctx.canManage
            ? h('button', { class: 'btn small danger', onclick: async () => { await ctx.api('DELETE', `/api/geofences/${gf.id}`); await ctx.reloadGeofences(); ctx.rerenderPage(); } }, 'Delete')
            : null,
        ),
      ),
      geofences.length === 0 ? h('li', { class: 'empty' }, 'No geofences yet') : null,
    ),
  );
}

export async function adminPage(ctx: Ctx): Promise<HTMLElement> {
  const [pol, aud] = await Promise.all([
    ctx.api<Policy>('GET', '/api/policy'),
    ctx.api<{ audit: Array<{ ts: number; actor: string; action: string; detail: string }> }>('GET', '/api/audit'),
  ]);
  const p = pol.data;
  const field = (id: keyof Omit<Policy, 'flagsOfInterest'>, label: string): [HTMLElement, HTMLInputElement] => {
    const inp = h('input', { id: `p-${id}`, type: 'number', step: 'any', value: p[id] });
    return [h('label', { for: `p-${id}` }, label), inp];
  };
  const f1 = field('highSpeedKn', 'High-speed threshold (kn)');
  const f2 = field('aisGapMinutes', 'AIS gap (minutes)');
  const f3 = field('loiterSogKn', 'Loitering speed (kn)');
  const f4 = field('approachNm', 'EEZ approach alert distance (nm)');
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
          const r = await ctx.api<{ error?: string }>('PUT', '/api/policy', {
            highSpeedKn: parseFloat(f1[1].value),
            aisGapMinutes: parseFloat(f2[1].value),
            loiterSogKn: parseFloat(f3[1].value),
            approachNm: parseFloat(f4[1].value),
            flagsOfInterest: (flags as HTMLInputElement).value.split(',').map((s) => s.trim()).filter(Boolean),
          });
          msg.textContent = r.status === 200 ? 'Policy saved.' : (r.data.error ?? 'Failed');
        },
      },
      h('h3', {}, 'Risk policy'),
      h('p', { class: 'muted' }, 'Flags of interest raise EEZ-entry severity. This is a configurable policy decision, not hard-coded.'),
      ...f1, ...f2, ...f3, ...f4,
      h('label', { for: 'p-flags' }, 'Flags of interest (comma-separated)'),
      flags,
      h('div', { class: 'row' }, h('span', {}), h('button', { class: 'btn primary', type: 'submit' }, 'Save policy')),
      msg,
    ),
    h(
      'section',
      { class: 'card' },
      h('h3', {}, 'Audit log'),
      h(
        'table',
        { class: 'tbl' },
        h('thead', {}, h('tr', {}, ...['Time', 'Actor', 'Action', 'Detail'].map((c) => h('th', {}, c)))),
        h('tbody', {}, ...aud.data.audit.slice(0, 60).map((a) => h('tr', {}, h('td', {}, fmtDateTime(a.ts)), h('td', {}, a.actor), h('td', {}, a.action), h('td', {}, a.detail)))),
      ),
    ),
  );
}

const INCIDENT_FLOW: Array<{ status: Exclude<IncidentStatus, 'open'>; label: string }> = [
  { status: 'acknowledged', label: 'Acknowledge' },
  { status: 'investigating', label: 'Investigating' },
  { status: 'closed', label: 'Close' },
];

export function incidentsPage(ctx: Ctx, myStation: string | undefined): HTMLElement {
  const all = ctx.incidents() as Incident[];
  let onlyMine = false;
  const body = h('div', {});
  const render = (): void => {
    clear(body);
    const list = onlyMine && myStation ? all.filter((i) => (i.station.desk ?? i.station.id) === myStation) : all;
    if (list.length === 0) {
      body.append(h('p', { class: 'empty' }, ctx.isOperator ? 'You have not reported anything yet. Select a vessel on the map and press "Report suspicious", or use "Report unidentified boat".' : 'No incidents.'));
      return;
    }
    for (const i of list) {
      body.append(
        h(
          'article',
          { class: `incident st-${i.status}` },
          h(
            'div',
            { class: 'inc-head' },
            h('span', { class: `badge st-${i.status}` }, i.status),
            h('button', { class: 'link', onclick: () => ctx.openOnMap(i.mmsi) }, i.vesselName),
            h('span', { class: 'muted' }, `${fmtDateTime(i.ts)} · by ${i.reporter}`),
          ),
          h('div', { class: 'inc-route' }, '⚑ ', h('strong', {}, i.station.name), h('span', { class: 'muted' }, ` · ${i.station.distanceNm} nm from contact · desk: ${i.station.desk ?? i.station.id}`)),
          h('p', { class: 'inc-note' }, h('strong', {}, `${CATEGORY_TEXT[i.category]}. `), i.note || ''),
          h('ul', { class: 'timeline' }, ...i.history.map((e) => h('li', {}, h('span', { class: 'muted' }, `${fmtDateTime(e.ts)} `), `${e.actor}: ${e.action}${e.note ? ` - ${e.note}` : ''}`))),
          ctx.isOperator || i.status === 'closed'
            ? null
            : h(
                'div',
                { class: 'inc-actions' },
                ...INCIDENT_FLOW.filter((f) => f.status !== i.status).map((f) =>
                  h('button', {
                    class: 'btn small',
                    onclick: async () => {
                      const note = f.status === 'closed' ? (prompt('Closing note (optional):') ?? undefined) : undefined;
                      await ctx.api('POST', `/api/incidents/${i.id}/status`, { status: f.status, ...(note ? { note } : {}) });
                      await ctx.refreshIncidents();
                      ctx.toast(`Incident ${f.status}`);
                      ctx.rerenderPage();
                    },
                  }, f.label),
                ),
              ),
        ),
      );
    }
  };
  render();
  return h(
    'div',
    { class: 'page-inner' },
    h(
      'div',
      { class: 'page-head' },
      h('h2', {}, ctx.isOperator ? 'My reports' : 'Incident reports'),
      myStation && !ctx.isOperator
        ? h('label', { class: 'chk', style: 'margin:0' }, h('input', { type: 'checkbox', onchange: (e: Event) => { onlyMine = (e.target as HTMLInputElement).checked; render(); } }), 'only my station')
        : null,
    ),
    h('p', { class: 'muted' }, ctx.isOperator ? 'Reports you filed and the controller response.' : 'Reports from users, routed to the nearest Coast Guard controller. Acknowledge, investigate and close them here.'),
    body,
  );
}
