/**
 * Supply-chain risk: connects a shipment (customer order / consignment) to the voyage that carries it, projects a live ETA
 * from the vessel's position, and tells the business whether the delivery commitment is at risk and how much cargo value is exposed.
 */
import { distanceNm, distanceToLineNm, type LatLon } from '../core/geo';
import type { DeliveryRisk, Shipment, Voyage } from './types';

export const HOUR = 3_600_000;
const AT_RISK_SLACK_H = 24;
const HIGH_RISK_VOYAGE_SLACK_H = 72;

/** Nautical miles still to sail along `route` from the point on it nearest to `pos`. */
export function remainingRouteNm(route: readonly LatLon[], pos: { lat: number; lon: number }): number {
  if (route.length < 2) return 0;
  const k = Math.cos((pos.lat * Math.PI) / 180);
  let best = Infinity;
  let bestIdx = 0;
  let bestT = 0;
  for (let i = 0; i < route.length - 1; i++) {
    const a = route[i] as LatLon;
    const b = route[i + 1] as LatLon;
    const ax = (a[1] - pos.lon) * k * 60;
    const ay = (a[0] - pos.lat) * 60;
    const bx = (b[1] - pos.lon) * k * 60;
    const by = (b[0] - pos.lat) * 60;
    const dx = bx - ax;
    const dy = by - ay;
    const len2 = dx * dx + dy * dy;
    const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, (-ax * dx + -ay * dy) / len2));
    const d = Math.hypot(ax + t * dx, ay + t * dy);
    if (d < best) {
      best = d;
      bestIdx = i;
      bestT = t;
    }
  }
  let rest = (1 - bestT) * distanceNm(route[bestIdx] as LatLon, route[bestIdx + 1] as LatLon);
  for (let i = bestIdx + 1; i < route.length - 1; i++) rest += distanceNm(route[i] as LatLon, route[i + 1] as LatLon);
  return rest;
}

export interface EtaProjection {
  eta: number;
  basis: 'live' | 'planned';
  remainingNm?: number;
}

/** ETA from the live position and speed of an active voyage (including the detour back to the route); otherwise the plan. */
export function projectEta(voyage: Voyage, live: { lat: number; lon: number; sog: number } | undefined, now: number): EtaProjection {
  if (voyage.status !== 'active' || !live) return { eta: voyage.eta, basis: 'planned' };
  const offRoute = distanceToLineNm(live.lat, live.lon, voyage.waypoints);
  const remaining = remainingRouteNm(voyage.waypoints, live) + (offRoute > 30 ? offRoute : 0);
  const speed = Math.max(5, Math.min(25, live.sog || 10));
  return { eta: now + (remaining / speed) * HOUR, basis: 'live', remainingNm: Math.round(remaining) };
}

export function deliveryRiskOf(shipment: Shipment, voyage: Voyage | undefined, eta: number | undefined, now: number): DeliveryRisk {
  if (!voyage || eta === undefined) return 'unplanned';
  if (voyage.status === 'rejected' || voyage.status === 'cancelled') return 'at_risk';
  const slackH = (shipment.requiredBy - eta) / HOUR;
  if (slackH < 0) return 'late';
  if (slackH < AT_RISK_SLACK_H) return 'at_risk';
  const lvl = voyage.assessment?.level;
  if ((lvl === 'high' || lvl === 'critical') && slackH < HIGH_RISK_VOYAGE_SLACK_H) return 'at_risk';
  if ((voyage.status === 'submitted' || voyage.status === 'changes_requested') && voyage.etd - now < 24 * HOUR) return 'at_risk';
  return 'on_track';
}

/** Cargo value sailing through a high- or elevated-risk area on its planned route. */
export function valueAtRisk(shipment: Shipment, voyage: Voyage | undefined): number {
  const e = voyage?.assessment?.exposure;
  return e && e.highRiskNm + e.elevatedRiskNm > 0 ? shipment.valueInr : 0;
}

export function advisoriesFor(risk: DeliveryRisk, shipment: Shipment, voyage: Voyage | undefined): string[] {
  const out: string[] = [];
  if (risk === 'unplanned') out.push('No vessel allocated yet: allocate this shipment to a voyage to get an ETA.');
  if (risk === 'late') out.push('Projected arrival is after the delivery commitment: notify the customer now and agree a revised date.');
  if (risk === 'at_risk') out.push('Little or no buffer to the delivery commitment: alert the customer and prepare a contingency (priority berth, expedited customs, transshipment).');
  if (voyage?.status === 'rejected' || voyage?.status === 'cancelled') out.push('The carrying voyage was not approved: re-allocate the shipment to another voyage.');
  if (voyage?.assessment && (voyage.assessment.exposure.highRiskNm > 0 || voyage.assessment.exposure.elevatedRiskNm > 0)) {
    out.push(`Cargo of ₹${Math.round(shipment.valueInr / 1e5) / 10} million transits a risk area: confirm cargo insurance cover and war-risk terms with the insurer.`);
  }
  if (voyage?.assessment?.level === 'critical') out.push('Voyage risk is critical: consider an alternative route or timing before departure.');
  return out;
}

export interface ShipmentView extends Shipment {
  voyageReference?: string;
  voyageStatus?: Voyage['status'];
  vesselName?: string;
  riskLevel?: Voyage['assessment'] extends infer A ? (A extends { level: infer L } ? L : never) : never;
  projectedEta?: number;
  etaBasis?: EtaProjection['basis'];
  slackHours?: number;
  valueAtRiskInr: number;
  advisories: string[];
}

export interface SupplyChainSummary {
  shipments: number;
  inTransit: number;
  valueInTransitInr: number;
  valueAtRiskInr: number;
  atRisk: number;
  late: number;
  unplanned: number;
  onTrack: number;
}

export function buildView(shipment: Shipment, voyage: Voyage | undefined, live: { lat: number; lon: number; sog: number } | undefined, now: number): ShipmentView {
  const proj = voyage ? projectEta(voyage, live, now) : undefined;
  const risk = shipment.status === 'delivered' || shipment.status === 'cancelled' ? shipment.deliveryRisk : deliveryRiskOf(shipment, voyage, proj?.eta, now);
  return {
    ...shipment,
    deliveryRisk: risk,
    voyageReference: voyage?.reference,
    voyageStatus: voyage?.status,
    vesselName: voyage?.vesselName,
    riskLevel: voyage?.assessment?.level,
    projectedEta: proj?.eta,
    etaBasis: proj?.basis,
    slackHours: proj ? Math.round(((shipment.requiredBy - proj.eta) / HOUR) * 10) / 10 : undefined,
    valueAtRiskInr: shipment.status === 'delivered' || shipment.status === 'cancelled' ? 0 : valueAtRisk(shipment, voyage),
    advisories: shipment.status === 'delivered' || shipment.status === 'cancelled' ? [] : advisoriesFor(risk, shipment, voyage),
  };
}

export function summarize(views: readonly ShipmentView[]): SupplyChainSummary {
  const open = views.filter((v) => v.status === 'booked' || v.status === 'in_transit');
  return {
    shipments: views.length,
    inTransit: views.filter((v) => v.status === 'in_transit').length,
    valueInTransitInr: Math.round(views.filter((v) => v.status === 'in_transit').reduce((n, v) => n + v.valueInr, 0)),
    valueAtRiskInr: Math.round(open.reduce((n, v) => n + v.valueAtRiskInr, 0)),
    atRisk: open.filter((v) => v.deliveryRisk === 'at_risk').length,
    late: open.filter((v) => v.deliveryRisk === 'late').length,
    unplanned: open.filter((v) => v.deliveryRisk === 'unplanned').length,
    onTrack: open.filter((v) => v.deliveryRisk === 'on_track').length,
  };
}
