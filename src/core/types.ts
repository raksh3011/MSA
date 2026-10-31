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

/** Where a vessel record came from: real AIS, the synthetic traffic generator, or a user-reported contact. */
export type VesselOrigin = 'ais' | 'synthetic' | 'reported';

export interface Vessel {
  mmsi: string;
  origin?: VesselOrigin;
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
  /** true for reports produced by the synthetic traffic generator */
  synthetic?: boolean;
}

export type Severity = 'low' | 'medium' | 'high' | 'critical';
export type AlertStatus = 'open' | 'acknowledged' | 'resolved';

/** Identity of a vessel from India's point of view. */
export type VesselClass = 'indian' | 'foreign' | 'unknown';

export type RuleId =
  | 'eez_approach'
  | 'eez_entry'
  | 'contiguous_entry'
  | 'indian_critical_zone'
  | 'indian_foreign_waters'
  | 'high_speed_in_eez'
  | 'ais_gap'
  | 'high_risk_zone'
  | 'territorial_sea'
  | 'loitering'
  | 'position_jump'
  | 'geofence'
  | 'user_report'
  | 'voyage_deviation'
  | 'voyage_exposure'
  | 'case_sla';

export interface Alert {
  id: string;
  ruleId: RuleId;
  severity: Severity;
  mmsi: string;
  vesselName: string;
  /** Indian / foreign / unknown vessel */
  vesselClass?: VesselClass;
  message: string;
  lat: number;
  lon: number;
  ts: number;
  status: AlertStatus;
  handledBy?: string;
  handledAt?: number;
  note?: string;
}

/** admin = platform owner; analyst = Coast Guard; operator / risk_officer / org_admin = shipping-company staff. */
export type Role = 'admin' | 'analyst' | 'operator' | 'risk_officer' | 'org_admin';

/** Roles that belong to a shipping-company tenant (their data is scoped to the organisation). */
export const COMPANY_ROLES: readonly Role[] = ['operator', 'risk_officer', 'org_admin'];
export const isCompanyRole = (r: Role): boolean => COMPANY_ROLES.includes(r);

export interface User {
  username: string;
  role: Role;
  displayName: string;
  /** Coast Guard station/controller this user works for (analysts only) */
  station?: string;
  /** company whose fleet this operator manages */
  fleetName?: string;
  /** organisation (tenant) this user belongs to */
  orgId?: string;
  /** PBKDF2 record: `iterations$saltB64$hashB64` */
  passwordHash: string;
}

export interface PublicUser {
  username: string;
  role: Role;
  displayName: string;
  station?: string;
  fleetName?: string;
  orgId?: string;
}

export type IncidentCategory = 'suspicious_behaviour' | 'unidentified_vessel' | 'ais_spoofing' | 'illegal_activity' | 'distress' | 'other';
export type IncidentStatus = 'open' | 'acknowledged' | 'investigating' | 'closed';

export interface Station {
  id: string;
  name: string;
  kind: 'Regional HQ' | 'District HQ' | 'Station';
  lat: number;
  lon: number;
}

export interface IncidentEvent {
  ts: number;
  actor: string;
  action: string;
  note?: string;
}

/** A user report about a suspicious / unidentified vessel, routed to the nearest Coast Guard controller. */
export interface Incident {
  id: string;
  ts: number;
  reporter: string;
  reporterRole: Role;
  mmsi: string;
  vesselName: string;
  lat: number;
  lon: number;
  category: IncidentCategory;
  note: string;
  status: IncidentStatus;
  /** nearest Coast Guard station at the time of the report */
  station: { id: string; name: string; distanceNm: number; desk: string };
  /** true when the contact was not on AIS and was added manually from a visual sighting */
  manual: boolean;
  history: IncidentEvent[];
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
  /** distance from the EEZ limit at which a closing foreign/unknown vessel raises an "approaching" alert */
  approachNm: number;
}

/** Where vessel positions come from. */
export type DataSource = 'simulated' | 'aisstream' | 'digitraffic';

/** Health of the upstream AIS feed, surfaced to the UI so a bad key or dropped connection is visible. */
export interface FeedInfo {
  connected: boolean;
  /** epoch ms of the last message received from the upstream feed */
  lastMessageAt?: number;
  error?: string;
  /** coverage preset, e.g. india | indian-ocean | world */
  region?: string;
  messages?: number;
  /** synthetic India traffic is being blended into the feed */
  synthetic?: boolean;
}

export interface Snapshot {
  vessels: Vessel[];
  alerts: Alert[];
  ts: number;
  source: DataSource;
  feed?: FeedInfo;
}
