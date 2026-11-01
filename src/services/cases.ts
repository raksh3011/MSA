/** Case management service: open from a user report, assign, progress, enforce SLAs and escalate. */
import { isCompanyRole, type Alert, type IncidentCategory, type Role } from '../core/types';
import { deskOf } from '../core/stations';
import { evaluateSla, priorityFor, slaDeadlines } from '../domain/cases';
import type { CaseRecord, CaseStatus, ClosureCode } from '../domain/types';
import { emit, type Services } from './context';
import type { Result } from './org';

const bad = (error: string, status: 400 | 402 | 403 | 404 | 409 = 400): { ok: false; status: 400 | 402 | 403 | 404 | 409; error: string } => ({ ok: false, status, error });

export const CLOSURE_CODES: ClosureCode[] = ['confirmed_threat', 'false_alarm', 'resolved', 'referred'];

export interface CaseActor {
  username: string;
  role: Role;
  orgId: string;
}

export async function openCase(
  s: Services,
  actor: CaseActor,
  input: { category: IncidentCategory; note: string; mmsi?: string; lat?: number; lon?: number },
): Promise<Result<CaseRecord>> {
  const now = s.now();
  const flagged = s.hub.flagVessel({ reporter: actor.username, category: input.category, mmsi: input.mmsi, lat: input.lat, lon: input.lon }, now);
  if ('error' in flagged) return bad(flagged.error, 404);
  const priority = priorityFor(input.category);
  const { ackDueAt, resolveDueAt } = slaDeadlines(priority, now);
  const c: CaseRecord = {
    id: crypto.randomUUID(), orgId: actor.orgId, reporter: actor.username, reporterRole: actor.role, mmsi: flagged.vessel.mmsi, vesselName: flagged.vessel.name,
    lat: flagged.vessel.lat, lon: flagged.vessel.lon, category: input.category, note: input.note.slice(0, 500), status: 'open', priority,
    station: { id: flagged.nearest.station.id, name: flagged.nearest.station.name, distanceNm: flagged.nearest.distanceNm, desk: deskOf(flagged.nearest.station.id) },
    manual: flagged.manual, createdAt: now, ackDueAt, resolveDueAt, escalationLevel: 0, slaBreached: false,
    history: [{ ts: now, actor: actor.username, action: 'reported', note: input.note.slice(0, 500) || undefined }],
  };
  await s.repo.cases.insert(c);
  emit(s, c.orgId, 'case.created', { caseId: c.id, priority, mmsi: c.mmsi, vessel: c.vesselName, category: c.category, station: c.station.name });
  return { ok: true, value: c };
}

/** Reporters see their organisation's cases; Coast Guard / platform staff see everything. */
export async function visibleCases(s: Services, user: { role: Role; orgId?: string }, filter: { status?: CaseStatus; desk?: string } = {}): Promise<CaseRecord[]> {
  if (isCompanyRole(user.role)) return user.orgId ? s.repo.cases.list({ orgId: user.orgId, status: filter.status }) : [];
  return s.repo.cases.list(filter);
}

export async function assignCase(s: Services, actor: string, id: string, assignee: string): Promise<Result<CaseRecord>> {
  const c = await s.repo.cases.get(id);
  if (!c) return bad('Case not found', 404);
  if (c.status === 'closed') return bad('A closed case cannot be reassigned', 409);
  const u = s.hub.users.get(assignee);
  if (!u || u.role !== 'analyst') return bad('Assignee must be a Coast Guard controller', 400);
  c.assignee = assignee;
  c.history.push({ ts: s.now(), actor, action: 'assigned', note: assignee });
  await s.repo.cases.update(c);
  s.hub.log(actor, 'case.assigned', `${c.id} -> ${assignee}`);
  return { ok: true, value: c };
}

export async function progressCase(s: Services, actor: string, id: string, status: Exclude<CaseStatus, 'open'>, note: string, closureCode?: string): Promise<Result<CaseRecord>> {
  const c = await s.repo.cases.get(id);
  if (!c) return bad('Case not found', 404);
  if (c.status === 'closed') return bad('Case is already closed', 409);
  const now = s.now();
  if (status === 'closed') {
    if (!closureCode || !(CLOSURE_CODES as string[]).includes(closureCode)) return bad(`closureCode is required: ${CLOSURE_CODES.join(', ')}`);
    c.closedAt = now;
    c.closureCode = closureCode as ClosureCode;
    if (c.manual) s.hub.removeContact(c.mmsi);
  }
  if (!c.ackedAt) {
    c.ackedAt = now;
    if (now > c.ackDueAt) c.slaBreached = true;
  }
  if (status === 'closed' && now > c.resolveDueAt) c.slaBreached = true;
  c.status = status;
  c.assignee ??= actor;
  c.history.push({ ts: now, actor, action: status, note: note || undefined });
  await s.repo.cases.update(c);
  s.hub.log(actor, `case.${status}`, `${c.id} ${c.station.id}${closureCode ? ` ${closureCode}` : ''}`);
  if (status === 'closed') emit(s, c.orgId, 'case.closed', { caseId: c.id, mmsi: c.mmsi, closureCode, slaBreached: c.slaBreached });
  return { ok: true, value: c };
}

/** SLA sweeper: escalate overdue cases, raise an alert for the controllers and notify the owning organisation. */
export async function sweepCases(s: Services): Promise<number> {
  const now = s.now();
  let n = 0;
  for (const c of await s.repo.cases.listOpen()) {
    const esc = evaluateSla(c, now);
    if (!esc) continue;
    c.escalationLevel = esc.level;
    c.slaBreached = true;
    c.history.push({ ts: now, actor: 'system', action: `escalated_L${esc.level}`, note: esc.message });
    await s.repo.cases.update(c);
    const alert: Alert = {
      id: crypto.randomUUID(), ruleId: 'case_sla', severity: esc.level === 2 ? 'critical' : 'high', mmsi: c.mmsi, vesselName: c.vesselName, message: `SLA escalation L${esc.level}: ${esc.message} (${c.station.name})`,
      lat: c.lat, lon: c.lon, ts: now, status: 'open',
    };
    s.hub.pushAlert(alert);
    s.hub.log('system', 'case.escalated', `${c.id} L${esc.level} ${esc.reason}`);
    emit(s, c.orgId, 'case.escalated', { caseId: c.id, level: esc.level, reason: esc.reason, priority: c.priority, mmsi: c.mmsi, station: c.station.name });
    n++;
  }
  return n;
}

/** Controller files a short post-incident report once a case is closed (findings, actions, lessons). */
export async function filePostIncident(s: Services, actor: string, id: string, input: { summary?: unknown; findings?: unknown; actionsTaken?: unknown; lessonsLearned?: unknown }): Promise<Result<CaseRecord>> {
  const c = await s.repo.cases.get(id);
  if (!c) return bad('Case not found', 404);
  if (c.status !== 'closed') return bad('A post-incident report can only be filed after the case is closed', 409);
  const text = (v: unknown, name: string, min: number, max: number): string | { error: string } => {
    const t = typeof v === 'string' ? v.trim() : '';
    return t.length >= min && t.length <= max ? t : { error: `${name} must be ${min}-${max} characters` };
  };
  const summary = text(input.summary, 'summary', 20, 1500);
  const findings = text(input.findings, 'findings', 10, 1500);
  const actionsTaken = text(input.actionsTaken, 'actionsTaken', 10, 1500);
  const lessons = typeof input.lessonsLearned === 'string' ? input.lessonsLearned.trim().slice(0, 1500) : '';
  for (const x of [summary, findings, actionsTaken]) if (typeof x !== 'string') return bad(x.error);
  const now = s.now();
  c.postIncident = { summary: summary as string, findings: findings as string, actionsTaken: actionsTaken as string, lessonsLearned: lessons, filedBy: actor, filedAt: now };
  c.history.push({ ts: now, actor, action: 'post_incident_report_filed' });
  await s.repo.cases.update(c);
  s.hub.log(actor, 'case.post_incident', c.id);
  return { ok: true, value: c };
}
