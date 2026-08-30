import type { MomentumEvidence } from './deal-momentum-evidence.js';
import type { DecisionAction, DealMomentumIntelligence } from './deal-momentum-types.js';

const DAY_MS = 86_400_000;

function dueInDays(now: number, days: number): string {
  return new Date(now + days * DAY_MS).toISOString();
}

function action(value: DecisionAction): DecisionAction {
  return value;
}

export function buildDecisionActions(
  evidence: MomentumEvidence,
  momentum: DealMomentumIntelligence['momentum'],
  closeDate: DealMomentumIntelligence['closeDateCredibility'],
  now = Date.now(),
): DecisionAction[] {
  const output: DecisionAction[] = [];
  const pushes = evidence.closeDateMoves.filter((item) => item.direction === 'push').length;
  const regressions = evidence.stageTransitions.filter((item) => item.direction === 'regression').length;

  if (pushes >= 2 || closeDate.status === 'weak') {
    output.push(action({
      code: 'reconfirm_close_date',
      label: 'Reconfirm the close plan',
      action: 'Confirm the buyer-backed close milestone, then update the close date or reclassify the deal if the milestone is not committed.',
      priority: 'high',
      rationale: pushes >= 2 ? `The close date moved later ${pushes} times in 90 days.` : 'The close date has multiple credibility concerns.',
      owner: 'deal_owner',
      dueAt: dueInDays(now, 2),
      evidenceCodes: ['close_date_pushes'],
    }));
  }

  if (regressions > 0) {
    output.push(action({
      code: 'review_stage_regression',
      label: 'Review the stage regression',
      action: 'Review the reason for the backward stage movement with the deal owner and document the qualification decision.',
      priority: 'high',
      rationale: `${regressions} stage regression${regressions === 1 ? '' : 's'} occurred in the evidence window.`,
      owner: 'manager',
      dueAt: dueInDays(now, 1),
      evidenceCodes: ['stage_regression'],
    }));
  }

  if (evidence.daysToClose !== null && evidence.daysToClose <= 14 && !evidence.hasNextStep) {
    output.push(action({
      code: 'record_committed_next_step',
      label: 'Record the committed next step',
      action: 'Record the next buyer-committed action, its owner, and target date before relying on the current close date.',
      priority: 'high',
      rationale: 'The deal is near its close date without a recorded next step.',
      owner: 'deal_owner',
      dueAt: dueInDays(now, 1),
      evidenceCodes: ['next_step_missing_near_close'],
    }));
  }

  if (evidence.currentStageAgeDays !== null && evidence.currentStageAgeDays > evidence.stageAgeLimitDays) {
    output.push(action({
      code: 'resolve_stage_age_exception',
      label: 'Resolve the stage-age exception',
      action: 'Progress, requalify, or close the opportunity and document why it remains in the current stage.',
      priority: momentum.band === 'stalled' ? 'high' : 'medium',
      rationale: `Current stage age is ${evidence.currentStageAgeDays} days against a ${evidence.stageAgeLimitDays}-day policy.`,
      owner: 'deal_owner',
      dueAt: dueInDays(now, 3),
      evidenceCodes: ['stage_age_above_policy'],
    }));
  }

  if (evidence.currentActivityAgeDays !== null && evidence.currentActivityAgeDays > evidence.staleActivityLimitDays) {
    output.push(action({
      code: 'refresh_recorded_activity',
      label: 'Refresh the sales activity evidence',
      action: 'Re-engage the opportunity or record the latest completed sales activity and agreed follow-up.',
      priority: evidence.currentActivityAgeDays > evidence.staleActivityLimitDays * 2 ? 'high' : 'medium',
      rationale: `The last recorded sales activity is ${evidence.currentActivityAgeDays} days old.`,
      owner: 'deal_owner',
      dueAt: dueInDays(now, 2),
      evidenceCodes: ['recorded_activity_stale'],
    }));
  }

  if (evidence.ownerChanges.length > 1) {
    output.push(action({
      code: 'stabilize_ownership',
      label: 'Stabilize deal ownership',
      action: 'Confirm the accountable deal owner and document the internal handoff of context and next actions.',
      priority: 'medium',
      rationale: `${evidence.ownerChanges.length} owner changes occurred in 90 days.`,
      owner: 'manager',
      dueAt: dueInDays(now, 3),
      evidenceCodes: ['owner_churn'],
    }));
  }

  return output.slice(0, 5);
}
