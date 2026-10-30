/** "Report suspicious vessel" dialog: routes the report to the nearest Coast Guard controller. */
import { nearestStation } from '../core/stations';
import type { Incident, IncidentCategory } from '../core/types';
import type { Ctx } from './ctx';
import { h } from './dom';

export const CATEGORY_TEXT: Record<IncidentCategory, string> = {
  suspicious_behaviour: 'Suspicious behaviour (loitering, erratic movement)',
  unidentified_vessel: 'Unidentified vessel / no AIS',
  ais_spoofing: 'Suspected AIS spoofing or false identity',
  illegal_activity: 'Possible illegal activity (smuggling, illegal fishing)',
  distress: 'Vessel in distress',
  other: 'Other concern',
};

export interface ReportTarget {
  /** existing track; omit for an unidentified boat at a position */
  mmsi?: string;
  name?: string;
  lat: number;
  lon: number;
}

export function openReportDialog(ctx: Ctx, target: ReportTarget): void {
  const near = nearestStation(target.lat, target.lon);
  const category = h('select', { id: 'rp-cat' }, ...(Object.keys(CATEGORY_TEXT) as IncidentCategory[]).map((k) => h('option', { value: k }, CATEGORY_TEXT[k]))) as HTMLSelectElement;
  if (!target.mmsi) category.value = 'unidentified_vessel';
  const note = h('textarea', { id: 'rp-note', rows: '4', maxlength: '500', placeholder: 'What did you see? Heading, size, colour, number of people, time observed…' }) as HTMLTextAreaElement;
  const err = h('p', { class: 'error', role: 'alert' });
  const submit = h('button', { class: 'btn primary', type: 'submit' }, '⚑ Send report');

  const close = (): void => {
    overlay.remove();
    document.removeEventListener('keydown', onKey);
  };
  const onKey = (e: KeyboardEvent): void => {
    if (e.key === 'Escape') close();
  };

  const form = h(
    'form',
    {
      class: 'dialog',
      role: 'dialog',
      'aria-modal': 'true',
      'aria-labelledby': 'rp-title',
      onsubmit: async (e: Event) => {
        e.preventDefault();
        err.textContent = '';
        (submit as HTMLButtonElement).disabled = true;
        const body = target.mmsi
          ? { mmsi: target.mmsi, category: category.value, note: note.value }
          : { lat: Number(target.lat.toFixed(4)), lon: Number(target.lon.toFixed(4)), category: category.value, note: note.value };
        const res = await ctx.api<Incident & { error?: string }>('POST', '/api/incidents', body);
        (submit as HTMLButtonElement).disabled = false;
        if (res.status === 201) {
          close();
          ctx.toast(`Reported - routed to ${res.data.station.name}`);
          await ctx.refreshIncidents();
          ctx.openOnMap(res.data.mmsi);
        } else {
          err.textContent = res.data.error ?? 'Could not send the report';
        }
      },
    },
    h('h2', { id: 'rp-title' }, target.mmsi ? `Report: ${target.name ?? target.mmsi}` : 'Report an unidentified boat'),
    h('p', { class: 'muted' }, target.mmsi ? 'Flags this vessel to the nearest Coast Guard controller and adds it to your set.' : `Adds a contact at ${target.lat.toFixed(3)}°, ${target.lon.toFixed(3)}° to the map, flags it to the nearest controller and adds it to your set.`),
    h('div', { class: 'route-box' }, h('span', { class: 'muted' }, 'Will be routed to'), h('strong', {}, near.station.name), h('span', { class: 'muted' }, `${near.distanceNm} nm away · ${near.station.kind}`), near.distanceNm > 500 ? h('span', { class: 'warn-text' }, 'This position is far outside Indian waters. The report goes to the nearest Indian controller for information only - contact the local maritime authority as well.') : null),
    h('label', { for: 'rp-cat' }, 'What is the concern?'),
    category,
    h('label', { for: 'rp-note' }, 'Details'),
    note,
    h('p', { class: 'muted small-print' }, 'Station locations are approximate. For an emergency at sea use official distress channels - this form is not a distress system.'),
    err,
    h('div', { class: 'row' }, h('button', { class: 'btn', type: 'button', onclick: close }, 'Cancel'), submit),
  );
  const overlay = h('div', { class: 'modal', onclick: (e: Event) => { if (e.target === overlay) close(); } }, form);
  document.body.append(overlay);
  document.addEventListener('keydown', onKey);
  category.focus();
}
