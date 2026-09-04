import type { MomentumEvidence } from './deal-momentum-evidence.js';
import type { DealMomentumIntelligence } from './deal-momentum-types.js';

function clamp(value: number): number {
  return Math.max(0, Math.min(100, Math.round(value)));
}

export function evaluateMomentum(evidence: MomentumEvidence): DealMomentumIntelligence['momentum'] {
  const events = {
    stageAdvances: evidence.stageTransitions.filter((item) => item.direction === 'advance').length,
    stageRegressions: evidence.stageTransitions.filter((item) => item.direction === 'regression').length,
    pipelineChanges: evidence.stageTransitions.filter((item) => item.direction === 'pipeline_change').length,
    closeDatePushes: evidence.closeDateMoves.filter((item) => item.direction === 'push').length,
    closeDatePullIns: evidence.closeDateMoves.filter((item) => item.direction === 'pull_in').length,
    ownerChanges: evidence.ownerChanges.length,
    amountChanges: evidence.amountChanges.length,
    nextStepChanges: evidence.nextStepChanges.length,
  };

  if (evidence.evidenceCoveragePercent < 40) {
    return {
      methodology: 'crm_property_history_signal',
      windowDays: evidence.windowDays,
      score: null,
      band: 'insufficient_data',
      summary: 'More HubSpot property history is needed before DealGuard can assess CRM process momentum.',
      evidenceCoveragePercent: evidence.evidenceCoveragePercent,
      daysSinceMaterialChange: evidence.daysSinceMaterialChange,
      lastMaterialChangeAt: evidence.lastMaterialChangeAt,
      signals: evidence.signals,
      events,
      limitations: 'This signal uses structured CRM property history only. It does not measure buyer intent, message sentiment, or win probability.',
    };
  }

  let score = 65;
  score += Math.min(24, events.stageAdvances * 8);
  score += Math.min(8, events.closeDatePullIns * 4);
  score += evidence.hasNextStep && events.nextStepChanges > 0 ? 5 : 0;
  score -= Math.min(30, events.stageRegressions * 15);
  score -= Math.min(32, events.closeDatePushes * 8);
  score -= Math.min(15, Math.max(0, events.ownerChanges - 1) * 5);
  score -= events.pipelineChanges > 0 ? 8 : 0;
  if (evidence.currentStageAgeDays !== null && evidence.currentStageAgeDays > evidence.stageAgeLimitDays) score -= 18;
  if (evidence.currentActivityAgeDays !== null && evidence.currentActivityAgeDays > evidence.staleActivityLimitDays) score -= 15;
  if (evidence.daysSinceMaterialChange !== null && evidence.daysSinceMaterialChange > 30) score -= 12;
  const finalScore = clamp(score);
  const band: DealMomentumIntelligence['momentum']['band'] = finalScore >= 75
    ? 'strong'
    : finalScore >= 50 ? 'watch' : 'stalled';
  const summary = band === 'strong'
    ? 'CRM evidence shows sustained forward movement with limited process friction.'
    : band === 'watch'
      ? 'CRM evidence is mixed; review recent changes and confirm the next committed step.'
      : 'CRM evidence shows material stalling or regression that requires active review.';

  return {
    methodology: 'crm_property_history_signal',
    windowDays: evidence.windowDays,
    score: finalScore,
    band,
    summary,
    evidenceCoveragePercent: evidence.evidenceCoveragePercent,
    daysSinceMaterialChange: evidence.daysSinceMaterialChange,
    lastMaterialChangeAt: evidence.lastMaterialChangeAt,
    signals: evidence.signals,
    events,
    limitations: 'This signal uses structured CRM property history only. It does not measure buyer intent, message sentiment, or win probability.',
  };
}

export function evaluateCloseDateCredibility(
  evidence: MomentumEvidence,
): DealMomentumIntelligence['closeDateCredibility'] {
  const pushes = evidence.closeDateMoves.filter((item) => item.direction === 'push');
  const pullIns = evidence.closeDateMoves.filter((item) => item.direction === 'pull_in');
  const regressions = evidence.stageTransitions.filter((item) => item.direction === 'regression');
  const reasons: DealMomentumIntelligence['closeDateCredibility']['reasons'] = [];

  if (!evidence.currentCloseDate || evidence.daysToClose === null) {
    return {
      methodology: 'deterministic_close_date_credibility',
      score: null,
      status: 'unavailable',
      confidence: 'low',
      summary: 'A valid current close date is required before credibility can be assessed.',
      currentCloseDate: evidence.currentCloseDate,
      daysToClose: null,
      closeDatePushes90d: pushes.length,
      closeDatePullIns90d: pullIns.length,
      lastCloseDateChangeAt: evidence.closeDateMoves.at(-1)?.timestamp ?? null,
      lastPushAt: pushes.at(-1)?.timestamp ?? null,
      reasons,
      notWinProbability: true,
    };
  }

  let score = 100;
  if (evidence.daysToClose < 0) {
    score -= 40;
    reasons.push({ code: 'close_date_overdue', label: 'Close date is overdue', impact: -40, evidence: `The current close date passed ${Math.abs(evidence.daysToClose)} day${Math.abs(evidence.daysToClose) === 1 ? '' : 's'} ago.` });
  }
  if (pushes.length > 0) {
    const impact = -Math.min(36, pushes.length * 12);
    score += impact;
    reasons.push({ code: 'close_date_pushes', label: 'Close date has moved later', impact, evidence: `${pushes.length} later close-date change${pushes.length === 1 ? '' : 's'} occurred in the last 90 days.` });
  }
  if (regressions.length > 0) {
    score -= 15;
    reasons.push({ code: 'stage_regression', label: 'Deal regressed in stage', impact: -15, evidence: `${regressions.length} stage regression${regressions.length === 1 ? '' : 's'} occurred in the evidence window.` });
  }
  if (evidence.currentStageAgeDays !== null && evidence.currentStageAgeDays > evidence.stageAgeLimitDays) {
    score -= 15;
    reasons.push({ code: 'stage_age_above_policy', label: 'Stage age exceeds policy', impact: -15, evidence: `The deal has been in its current stage for ${evidence.currentStageAgeDays} days; policy allows ${evidence.stageAgeLimitDays}.` });
  }
  if (evidence.daysToClose <= 14 && !evidence.hasNextStep) {
    score -= 15;
    reasons.push({ code: 'next_step_missing_near_close', label: 'No next step near close', impact: -15, evidence: 'The close date is within 14 days and no committed next step is recorded.' });
  }
  if (evidence.daysToClose <= 14 && evidence.currentActivityAgeDays !== null && evidence.currentActivityAgeDays > evidence.staleActivityLimitDays) {
    score -= 15;
    reasons.push({ code: 'activity_stale_near_close', label: 'Recorded activity is stale near close', impact: -15, evidence: `The last recorded sales activity was ${evidence.currentActivityAgeDays} days ago.` });
  }

  const finalScore = clamp(score);
  const status: DealMomentumIntelligence['closeDateCredibility']['status'] = finalScore >= 75
    ? 'credible'
    : finalScore >= 50 ? 'watch' : 'weak';
  const confidence: DealMomentumIntelligence['closeDateCredibility']['confidence'] = evidence.evidenceCoveragePercent >= 80
    ? 'high'
    : evidence.evidenceCoveragePercent >= 40 ? 'medium' : 'low';
  const summary = status === 'credible'
    ? 'The current close date is supported by the available structured CRM evidence.'
    : status === 'watch'
      ? 'The current close date has evidence gaps or process friction that should be confirmed.'
      : 'The current close date has multiple credibility concerns and should be revalidated.';

  return {
    methodology: 'deterministic_close_date_credibility',
    score: finalScore,
    status,
    confidence,
    summary,
    currentCloseDate: evidence.currentCloseDate,
    daysToClose: evidence.daysToClose,
    closeDatePushes90d: pushes.length,
    closeDatePullIns90d: pullIns.length,
    lastCloseDateChangeAt: evidence.closeDateMoves.at(-1)?.timestamp ?? null,
    lastPushAt: pushes.at(-1)?.timestamp ?? null,
    reasons: reasons.sort((left, right) => left.impact - right.impact),
    notWinProbability: true,
  };
}
