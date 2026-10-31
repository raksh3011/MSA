/** Case management: priority, SLA deadlines and escalation rules. Pure functions. */
import type { IncidentCategory } from '../core/types';
import type { CasePriority, CaseRecord } from './types';

export const SLA_MINUTES: Record<CasePriority, { ack: number; resolve: number }> = {
  P1: { ack: 5, resolve: 60 },
  P2: { ack: 15, resolve: 240 },
  P3: { ack: 60, resolve: 1440 },
  P4: { ack: 240, resolve: 4320 },
};

export function priorityFor(category: IncidentCategory): CasePriority {
  switch (category) {
    case 'distress':
      return 'P1';
    case 'illegal_activity':
    case 'unidentified_vessel':
      return 'P2';
    case 'suspicious_behaviour':
    case 'ais_spoofing':
      return 'P3';
    default:
      return 'P4';
  }
}

export function slaDeadlines(priority: CasePriority, createdAt: number): { ackDueAt: number; resolveDueAt: number } {
  const s = SLA_MINUTES[priority];
  return { ackDueAt: createdAt + s.ack * 60_000, resolveDueAt: createdAt + s.resolve * 60_000 };
}

export interface Escalation {
  level: 1 | 2;
  reason: 'ack_overdue' | 'resolve_overdue';
  message: string;
}

/**
 * Decide whether a case needs escalating at `now`.
 *  level 1 — not acknowledged by its deadline  → the desk lead is notified;
 *  level 2 — acknowledgement badly overdue (2×) or resolution deadline passed → the regional controller is notified.
 */
export function evaluateSla(c: CaseRecord, now: number): Escalation | null {
  if (c.status === 'closed') return null;
  if (now > c.resolveDueAt && c.escalationLevel < 2) {
    return { level: 2, reason: 'resolve_overdue', message: `${c.priority} case on ${c.vesselName} passed its resolution deadline` };
  }
  if (c.status === 'open') {
    const ackWindow = c.ackDueAt - c.createdAt;
    if (now > c.createdAt + ackWindow * 2 && c.escalationLevel < 2) {
      return { level: 2, reason: 'ack_overdue', message: `${c.priority} case on ${c.vesselName} is still unacknowledged at twice its SLA` };
    }
    if (now > c.ackDueAt && c.escalationLevel < 1) {
      return { level: 1, reason: 'ack_overdue', message: `${c.priority} case on ${c.vesselName} was not acknowledged within its SLA` };
    }
  }
  return null;
}

/** Minutes until the next SLA deadline (negative when overdue), for display. */
export function slaRemainingMinutes(c: CaseRecord, now: number): number | null {
  if (c.status === 'closed') return null;
  const due = c.status === 'open' ? c.ackDueAt : c.resolveDueAt;
  return Math.round((due - now) / 60_000);
}
