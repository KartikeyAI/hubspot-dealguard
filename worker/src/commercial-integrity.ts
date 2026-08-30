import { buildCommercialActions } from './commercial-integrity-actions.js';
import { analyzeCommercialIntegrity } from './commercial-integrity-analysis.js';
import type {
  CommercialIntegrityData,
  CommercialIntegrityIntelligence,
} from './commercial-integrity-types.js';

export function buildCommercialIntegrity(
  data: CommercialIntegrityData,
  now = Date.now(),
): CommercialIntegrityIntelligence {
  const commercialIntegrity = analyzeCommercialIntegrity(data, now);
  return {
    commercialIntegrity,
    commercialActions: buildCommercialActions(commercialIntegrity, now),
  };
}

export type {
  CommercialAuthorization,
  CommercialIntegrityData,
  CommercialIntegrityIntelligence,
  CommercialIntegritySummary,
} from './commercial-integrity-types.js';
