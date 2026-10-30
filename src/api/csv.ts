import type { Alert } from '../core/types';

/** Escape a CSV cell, neutralising spreadsheet formula injection (=, +, -, @). */
export function csvCell(value: unknown): string {
  let s = value === undefined || value === null ? '' : String(value);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function alertsToCsv(alerts: readonly Alert[]): string {
  const header = ['time_utc', 'severity', 'rule', 'status', 'mmsi', 'vessel', 'lat', 'lon', 'message', 'handled_by', 'note'];
  const rows = alerts.map((a) =>
    [new Date(a.ts).toISOString(), a.severity, a.ruleId, a.status, a.mmsi, a.vesselName, a.lat.toFixed(4), a.lon.toFixed(4), a.message, a.handledBy, a.note]
      .map(csvCell)
      .join(','),
  );
  return [header.join(','), ...rows].join('\n') + '\n';
}
