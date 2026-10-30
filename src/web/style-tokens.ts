import type { Severity, VesselCategory } from '../core/types';

export const CATEGORY_COLOR: Record<VesselCategory, string> = {
  naval: '#3b82f6',
  coast_guard: '#06b6d4',
  cargo: '#10b981',
  tanker: '#f5c518',
  passenger: '#fb923c',
  fishing: '#e5e7eb',
  highspeed: '#ec4899',
  other: '#94a3b8',
};

export const CATEGORY_LABEL: Record<VesselCategory, string> = {
  naval: 'Naval',
  coast_guard: 'Coast Guard',
  cargo: 'Cargo',
  tanker: 'Tanker',
  passenger: 'Passenger',
  fishing: 'Fishing',
  highspeed: 'High-speed craft',
  other: 'Other / unknown',
};

export const SEVERITY_COLOR: Record<Severity, string> = {
  low: '#60a5fa',
  medium: '#fbbf24',
  high: '#fb7185',
  critical: '#ff2d55',
};

export const SEVERITY_RANK: Record<Severity, number> = { critical: 3, high: 2, medium: 1, low: 0 };

export const RULE_LABEL: Record<string, string> = {
  eez_entry: 'EEZ entry',
  territorial_sea: 'Territorial sea',
  high_speed_in_eez: 'High speed in EEZ',
  ais_gap: 'AIS gap (dark)',
  high_risk_zone: 'High-risk area',
  loitering: 'Loitering',
  position_jump: 'Position jump',
  geofence: 'Geofence',
  user_report: 'User report',
};
