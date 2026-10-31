/** Business (enterprise) domain model: organisations, registry, voyages, cases, integrations. */
import type { LatLon } from '../core/geo';
import type { IncidentCategory, Role } from '../core/types';

// ── tenancy and commercial ───────────────────────────────────────────────────
export type OrgKind = 'shipping_company' | 'coast_guard' | 'platform';
export type PlanId = 'starter' | 'professional' | 'enterprise';

export interface PlanLimits {
  vessels: number;
  users: number;
  voyagesPerMonth: number;
  apiCallsPerMonth: number;
  apiKeysAndWebhooks: boolean;
}

export interface Plan {
  id: PlanId;
  name: string;
  /** monthly subscription fee in INR (illustrative pricing) */
  monthlyFeeInr: number;
  /** charge per voyage above the monthly allowance, INR */
  overagePerVoyageInr: number;
  limits: PlanLimits;
}

export interface Organization {
  id: string;
  name: string;
  kind: OrgKind;
  planId: PlanId;
  status: 'active' | 'suspended';
  createdAt: number;
}

// ── master data ──────────────────────────────────────────────────────────────
export interface RegistryVessel {
  orgId: string;
  mmsi: string;
  imo?: string;
  name: string;
  /** AIS ship-type family: cargo | tanker | passenger | ... */
  vesselType: string;
  flag: string;
  grossTonnage?: number;
  owner?: string;
  status: 'active' | 'retired';
  createdAt: number;
}

export interface Port {
  id: string;
  name: string;
  country: string;
  lat: number;
  lon: number;
}

export interface RouteTemplate {
  id: string;
  name: string;
  from: string;
  to: string;
  waypoints: LatLon[];
}

// ── voyage risk management ───────────────────────────────────────────────────
export type CargoType = 'general' | 'containers' | 'bulk' | 'crude_oil' | 'refined_products' | 'chemicals' | 'lng_lpg' | 'passengers';
export type VoyageStatus = 'draft' | 'submitted' | 'changes_requested' | 'approved' | 'rejected' | 'active' | 'completed' | 'cancelled';
export type RiskLevel = 'low' | 'medium' | 'high' | 'critical';
export type ApprovalRole = 'risk_officer' | 'org_admin';

export interface RiskFactor {
  code: string;
  label: string;
  points: number;
  detail: string;
}

export interface RiskAssessment {
  score: number;
  level: RiskLevel;
  factors: RiskFactor[];
  /** recommended controls — advisory text, to be verified against current guidance */
  controls: string[];
  exposure: { totalNm: number; highRiskNm: number; elevatedRiskNm: number; foreignWatersNm: number; zones: string[] };
  assessedAt: number;
}

export interface Approval {
  role: ApprovalRole;
  userId: string;
  decision: 'approved' | 'rejected' | 'changes_requested';
  note: string;
  ts: number;
}

export interface VoyageEvent {
  ts: number;
  actor: string;
  action: string;
  note?: string;
}

export interface Voyage {
  id: string;
  orgId: string;
  reference: string;
  mmsi: string;
  vesselName: string;
  originPort: string;
  destinationPort: string;
  routeId?: string;
  waypoints: LatLon[];
  /** epoch ms */
  etd: number;
  eta: number;
  cargo: CargoType;
  status: VoyageStatus;
  assessment?: RiskAssessment;
  approvalsRequired: ApprovalRole[];
  approvals: Approval[];
  conditions?: string;
  history: VoyageEvent[];
  createdBy: string;
  createdAt: number;
  updatedAt: number;
}

// ── supply chain: shipments (consignments) carried by voyages ────────────────
export type ShipmentStatus = 'booked' | 'in_transit' | 'delivered' | 'cancelled';
/** Will the consignment reach the customer by the committed date? */
export type DeliveryRisk = 'on_track' | 'at_risk' | 'late' | 'unplanned';

export interface Shipment {
  id: string;
  orgId: string;
  /** purchase-order / booking / bill-of-lading reference from the customer's ERP */
  reference: string;
  customer: string;
  commodity: string;
  cargo: CargoType;
  quantity: number;
  unit: string;
  /** cargo value, INR */
  valueInr: number;
  incoterm: string;
  originPort: string;
  destinationPort: string;
  /** delivery commitment to the customer, epoch ms */
  requiredBy: number;
  /** the voyage carrying this shipment (set when the shipment is allocated to a vessel) */
  voyageId?: string;
  status: ShipmentStatus;
  /** last evaluated delivery risk (kept so a change can raise an event) */
  deliveryRisk: DeliveryRisk;
  createdBy: string;
  createdAt: number;
  updatedAt: number;
  history: VoyageEvent[];
}

// ── case management ──────────────────────────────────────────────────────────
export type CaseStatus = 'open' | 'acknowledged' | 'investigating' | 'closed';
export type CasePriority = 'P1' | 'P2' | 'P3' | 'P4';
export type ClosureCode = 'confirmed_threat' | 'false_alarm' | 'resolved' | 'referred';

export interface CaseEvent {
  ts: number;
  actor: string;
  action: string;
  note?: string;
}

/** A user report about a suspicious / unidentified vessel, worked by a Coast Guard controller against an SLA. */
export interface CaseRecord {
  id: string;
  /** organisation of the reporter (visibility scope for company users) */
  orgId: string;
  reporter: string;
  reporterRole: Role;
  mmsi: string;
  vesselName: string;
  lat: number;
  lon: number;
  category: IncidentCategory;
  note: string;
  status: CaseStatus;
  priority: CasePriority;
  station: { id: string; name: string; distanceNm: number; desk: string };
  manual: boolean;
  assignee?: string;
  createdAt: number;
  ackDueAt: number;
  resolveDueAt: number;
  ackedAt?: number;
  closedAt?: number;
  closureCode?: ClosureCode;
  /** 0 = none, 1 = desk lead notified (acknowledgement overdue), 2 = regional controller (resolution overdue) */
  escalationLevel: 0 | 1 | 2;
  slaBreached: boolean;
  history: CaseEvent[];
}

// ── integration ──────────────────────────────────────────────────────────────
export type ApiScope = 'read:fleet' | 'read:alerts' | 'read:voyages' | 'write:voyages' | 'read:shipments';
export type WebhookEvent = 'alert.created' | 'voyage.status_changed' | 'voyage.deviation' | 'case.created' | 'case.escalated' | 'case.closed' | 'shipment.at_risk';

export interface ApiKey {
  id: string;
  orgId: string;
  name: string;
  /** first characters shown in lists; the secret itself is only shown once at creation */
  prefix: string;
  hash: string;
  scopes: ApiScope[];
  createdBy: string;
  createdAt: number;
  lastUsedAt?: number;
  revokedAt?: number;
}

export interface Webhook {
  id: string;
  orgId: string;
  url: string;
  secret: string;
  events: WebhookEvent[];
  active: boolean;
  createdAt: number;
}

export interface Delivery {
  id: string;
  orgId: string;
  webhookId: string;
  event: WebhookEvent;
  payload: string;
  status: 'pending' | 'delivered' | 'failed';
  attempts: number;
  responseStatus?: number;
  error?: string;
  createdAt: number;
  deliveredAt?: number;
}

export type UsageMetric = 'voyages' | 'api_calls';
