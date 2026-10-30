/** Shared domain types — used by the Worker, the in-browser demo engine and the UI. */

export type VesselCategory =
  | 'naval'
  | 'coast_guard'
  | 'cargo'
  | 'tanker'
  | 'passenger'
  | 'fishing'
  | 'highspeed'
  | 'other';

export interface Vessel {
  mmsi: string;
  name: string;
  lat: number;
  lon: number;
  /** speed over ground, knots */
  sog: number;
  /** course over ground, degrees 0-359 */
  cog: number;
  heading: number;
  category: VesselCategory;
  flag: string;
  /** epoch ms of the last position report */
  lastSeen: number;
  /** most recent positions, oldest first, [lat, lon] */
  trail: Array<[number, number]>;
}

export interface PositionReport {
  mmsi: string;
  name?: string;
  lat: number;
  lon: number;
  sog?: number;
  cog?: number;
  heading?: number;
  shipType?: number;
  /** epoch ms */
  ts?: number;
}

export type Severity = 'low' | 'medium' | 'high' | 'critical';
export type AlertStatus = 'open' | 'acknowledged' | 'resolved';

export type RuleId =
  | 'eez_entry'
  | 'high_speed_in_eez'
  | 'ais_gap'
  | 'high_risk_zone'
  | 'loitering'
  | 'position_jump'
  | 'fishing_boundary'
  | 'geofence';

export interface Alert {
  id: string;
  ruleId: RuleId;
  severity: Severity;
  mmsi: string;
  vesselName: string;
  message: string;
  lat: number;
  lon: number;
  ts: number;
  status: AlertStatus;
  handledBy?: string;
  handledAt?: number;
  note?: string;
}

export type Role = 'admin' | 'analyst' | 'operator';

export interface User {
  username: string;
  role: Role;
  displayName: string;
  /** PBKDF2 record: `iterations$saltB64$hashB64` */
  passwordHash: string;
}

export interface PublicUser {
  username: string;
  role: Role;
  displayName: string;
}

export interface Geofence {
  id: string;
  name: string;
  lat: number;
  lon: number;
  radiusNm: number;
  createdBy: string;
}

export interface AuditEntry {
  ts: number;
  actor: string;
  action: string;
  detail: string;
}

export interface Policy {
  /** flags that raise EEZ-entry severity; configurable by admins, empty by default */
  flagsOfInterest: string[];
  highSpeedKn: number;
  aisGapMinutes: number;
  loiterSogKn: number;
  /** distance to the fishing boundary at which a warning is raised */
  boundaryWarnNm: number;
}

export interface Snapshot {
  vessels: Vessel[];
  alerts: Alert[];
  ts: number;
  source: 'live' | 'demo';
}
