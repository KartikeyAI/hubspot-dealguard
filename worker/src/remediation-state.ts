import { AppError } from './errors.js';
import type { RemediationStatus } from './remediation.js';

export type RemediationAction = 'acknowledge' | 'start' | 'resolve' | 'waive' | 'close' | 'reopen' | 'assign';

const ALLOWED: Record<RemediationAction, RemediationStatus[]> = {
  acknowledge: ['open', 'overdue'],
  start: ['open', 'acknowledged', 'overdue'],
  resolve: ['open', 'acknowledged', 'in_progress', 'overdue'],
  waive: ['open', 'acknowledged', 'in_progress', 'overdue'],
  close: ['resolved', 'waived'],
  reopen: ['resolved', 'waived', 'closed'],
  assign: ['open', 'acknowledged', 'in_progress', 'overdue'],
};

export function assertRemediationTransition(status: RemediationStatus, action: RemediationAction): void {
  if (!ALLOWED[action].includes(status)) {
    throw new AppError(409, 'remediation_transition_invalid', `Cannot ${action} a remediation case in ${status.replace('_', ' ')} state.`);
  }
}

export function remediationTransitionAllowed(status: RemediationStatus, action: RemediationAction): boolean {
  return ALLOWED[action].includes(status);
}
