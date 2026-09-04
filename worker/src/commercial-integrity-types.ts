import type { DecisionAction } from './deal-momentum-types.js';
import type { IssueSeverity } from './types.js';

export const COMMERCIAL_LINE_ITEM_SCOPE = 'crm.objects.line_items.read' as const;
export const COMMERCIAL_QUOTE_SCOPE = 'crm.objects.quotes.read' as const;

export type CommercialScope =
  | typeof COMMERCIAL_LINE_ITEM_SCOPE
  | typeof COMMERCIAL_QUOTE_SCOPE;

export interface CommercialAuthorization {
  status: 'full' | 'partial' | 'required';
  requestedScopes: CommercialScope[];
  grantedScopes: CommercialScope[];
  missingScopes: CommercialScope[];
}

export interface CommercialDealContext {
  amount: number | null;
  amountInCompanyCurrency: number | null;
  currencyCode: string | null;
  closeDate: string | null;
  stageId: string | null;
}

export interface CommercialLineItemMetadata {
  id: string;
  name: string | null;
  sku: string | null;
  quantity: number | null;
  unitPrice: number | null;
  amount: number | null;
  discountAmount: number | null;
  discountPercent: number | null;
  recurringFrequency: string | null;
  updatedAt: string | null;
}

export type CommercialQuoteState =
  | 'draft'
  | 'pending'
  | 'issued'
  | 'accepted'
  | 'expired'
  | 'rejected'
  | 'unknown';

export interface CommercialQuoteMetadata {
  id: string;
  title: string | null;
  number: string | null;
  status: string | null;
  state: CommercialQuoteState;
  amount: number | null;
  currencyCode: string | null;
  expirationDate: string | null;
  createdAt: string | null;
  updatedAt: string | null;
}

export interface CommercialIntegrityData {
  authorization: CommercialAuthorization;
  deal: CommercialDealContext;
  lineItems: CommercialLineItemMetadata[];
  quotes: CommercialQuoteMetadata[];
  availability: {
    lineItems: boolean;
    quotes: boolean;
  };
  truncated: {
    lineItems: boolean;
    quotes: boolean;
  };
  fetchedAt: string;
  limitations: string[];
}

export interface CommercialSignal {
  code: string;
  label: string;
  direction: 'positive' | 'negative' | 'neutral';
  severity: IssueSeverity;
  detail: string;
  observedAt: string | null;
  evidenceCodes: string[];
}

export interface CommercialIntegritySummary {
  methodology: 'hubspot_quote_and_line_item_metadata';
  status: 'ready' | 'watch' | 'weak' | 'insufficient_data' | 'authorization_required' | 'unavailable';
  score: number | null;
  confidence: 'high' | 'medium' | 'low';
  summary: string;
  authorization: CommercialAuthorization;
  deal: CommercialDealContext;
  coverage: {
    lineItems: boolean;
    quotes: boolean;
    percent: number;
    truncated: boolean;
    missingSources: Array<'line_items' | 'quotes'>;
  };
  lineItems: {
    count: number;
    completeCount: number;
    incompleteCount: number;
    amountCoveragePercent: number;
    subtotal: number | null;
    subtotalCurrencyCode: string | null;
    dealAmountDifferencePercent: number | null;
    discountedCount: number;
    maximumDiscountPercent: number | null;
    weightedDiscountPercent: number | null;
    recurringCount: number;
  };
  quotes: {
    count: number;
    currentCount: number;
    draftCount: number;
    pendingCount: number;
    issuedCount: number;
    acceptedCount: number;
    expiredCount: number;
    rejectedCount: number;
    latestQuoteAt: string | null;
    nextExpirationAt: string | null;
    nearestExpirationDays: number | null;
    latestCurrentQuoteAmount: number | null;
    latestCurrentQuoteCurrencyCode: string | null;
    dealAmountDifferencePercent: number | null;
  };
  daysToClose: number | null;
  signals: CommercialSignal[];
  fetchedAt: string;
  limitations: string[];
  contentProcessed: false;
  notForecastCategory: true;
  notWinProbability: true;
  notExpectedLoss: true;
}

export interface CommercialIntegrityIntelligence {
  commercialIntegrity: CommercialIntegritySummary;
  commercialActions: DecisionAction[];
}
