import type { DealHistoryContext } from './deal-history.js';
import { buildDecisionActions } from './deal-momentum-actions.js';
import { collectMomentumEvidence } from './deal-momentum-evidence.js';
import { evaluateCloseDateCredibility, evaluateMomentum } from './deal-momentum-evaluation.js';
import type { DealMomentumIntelligence } from './deal-momentum-types.js';
import type { DealAssessment, NormalizedDeal, RuleSettings } from './types.js';

export function buildDealMomentum(
  deal: NormalizedDeal,
  settings: RuleSettings,
  _assessment: DealAssessment,
  history: DealHistoryContext,
  now = Date.now(),
): DealMomentumIntelligence {
  const evidence = collectMomentumEvidence(deal, settings, history, now);
  const momentum = evaluateMomentum(evidence);
  const closeDateCredibility = evaluateCloseDateCredibility(evidence);
  return {
    decisionActions: buildDecisionActions(evidence, momentum, closeDateCredibility, now),
    momentum,
    closeDateCredibility,
  };
}

export type { DealMomentumIntelligence } from './deal-momentum-types.js';
