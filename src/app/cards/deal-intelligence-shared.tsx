import React, { useCallback, useEffect, useState } from 'react';
import { Alert, LoadingSpinner, hubspot } from '@hubspot/ui-extensions';

export const API_BASE = 'https://dealguard-api.rokad.co/api/v1';
export type Severity = 'info' | 'warning' | 'critical';
export type Issue = { code: string; label: string; description: string; severity: Severity; weight: number; property?: string };
export type Requirement = { code: string; label: string; satisfied: boolean; severity: Severity; impact: number };
export type DecisionAction = { code: string; label: string; action: string; priority: 'high' | 'medium' | 'low'; rationale: string; owner: 'deal_owner' | 'manager'; dueAt: string | null; evidenceCodes: string[] };
export type MomentumSignal = { code: string; label: string; direction: 'positive' | 'negative' | 'neutral'; severity: Severity; observedAt: string | null; detail: string };
export type Momentum = {
  methodology: 'crm_property_history_signal'; windowDays: number; score: number | null; band: 'strong' | 'watch' | 'stalled' | 'insufficient_data'; summary: string;
  evidenceCoveragePercent: number; daysSinceMaterialChange: number | null; lastMaterialChangeAt: string | null; signals: MomentumSignal[];
  events: { stageAdvances: number; stageRegressions: number; pipelineChanges: number; closeDatePushes: number; closeDatePullIns: number; ownerChanges: number; amountChanges: number; nextStepChanges: number };
  limitations: string;
};
export type CloseDateCredibility = {
  methodology: 'deterministic_close_date_credibility'; score: number | null; status: 'credible' | 'watch' | 'weak' | 'unavailable'; confidence: 'high' | 'medium' | 'low'; summary: string;
  currentCloseDate: string | null; daysToClose: number | null; closeDatePushes90d: number; closeDatePullIns90d: number; lastCloseDateChangeAt: string | null; lastPushAt: string | null;
  reasons: Array<{ code: string; label: string; impact: number; evidence: string }>; notWinProbability: true;
};
export type BuyerRole = 'decision_maker' | 'budget_holder' | 'champion' | 'executive_sponsor' | 'technical_evaluator' | 'procurement' | 'legal_compliance' | 'end_user' | 'influencer' | 'implementer' | 'blocker';
export type BuyerRoleCoverage = { role: BuyerRole; label: string; core: boolean; status: 'explicit' | 'inferred_only' | 'missing'; people: string[]; sources: string[] };
export type BuyerCommitteeContact = { id: string; displayName: string; jobTitle: string | null; associationLabels: string[]; explicitRoles: BuyerRole[]; inferredRoles: BuyerRole[]; updatedAt: string | null };
export type BuyerCommitteeCompany = { id: string; name: string; domain: string | null; industry: string | null; associationLabels: string[]; primary: boolean; primaryEvidence: string | null; updatedAt: string | null };
export type RelationshipCoverage = {
  methodology: 'hubspot_association_and_contact_role_evidence'; score: number; status: 'strong' | 'partial' | 'weak'; confidence: 'high' | 'medium' | 'low'; summary: string;
  contactCount: number; companyCount: number; singleThreaded: boolean; explicitRoleCoveragePercent: number; labeledAssociationCoveragePercent: number;
  contacts: BuyerCommitteeContact[]; companies: BuyerCommitteeCompany[]; primaryCompany: BuyerCommitteeCompany | null; roleCoverage: BuyerRoleCoverage[];
  missingCoreRoles: BuyerRole[]; explicitRoles: BuyerRole[]; inferredOnlyRoles: BuyerRole[];
  signals: Array<{ code: string; label: string; direction: 'positive' | 'negative' | 'neutral'; severity: Severity; detail: string; evidenceCodes: string[] }>;
  relationshipActions: DecisionAction[]; fetchedAt: string; contactsTruncated: boolean; companiesTruncated: boolean; limitations: string[]; notBuyerIntent: true; notWinProbability: true;
};
export type EngagementSignal = { code: string; label: string; direction: 'positive' | 'negative' | 'neutral'; severity: Severity; detail: string; observedAt: string | null; evidenceCodes: string[] };
export type Engagement = {
  methodology: 'hubspot_activity_metadata'; windowDays: 90; score: number | null; status: 'active' | 'watch' | 'disengaged' | 'insufficient_data'; confidence: 'high' | 'medium' | 'low'; summary: string;
  lastBuyerActivityAt: string | null; lastInboundEmailAt: string | null; lastOutboundEmailAt: string | null; unansweredOutboundSince: string | null; emailResponseGapDays: number | null;
  lastCompletedCallAt: string | null; lastCompletedMeetingAt: string | null; nextScheduledMeetingAt: string | null;
  counts: { inboundEmails: number; outboundEmails: number; forwardedEmails: number; failedOrBouncedEmails: number; inboundCalls: number; outboundCalls: number; completedCalls: number; completedMeetings: number; scheduledMeetings: number; noShowMeetings: number; canceledMeetings: number; totalMaterialActivities: number };
  cadence: { recent14Days: number; previous14Days: number; activeWeeks8: number; trend: 'accelerating' | 'steady' | 'declining' | 'inactive' | 'insufficient_data' };
  reciprocity: { inboundEmailCount: number; outboundEmailCount: number; ratio: number | null; status: 'balanced' | 'outbound_heavy' | 'inbound_led' | 'unavailable' };
  coverage: { emails: boolean; calls: boolean; meetings: boolean; percent: number; truncated: boolean; missingTypes: Array<'email' | 'call' | 'meeting'> };
  signals: EngagementSignal[]; fetchedAt: string; limitations: string[]; contentProcessed: false; notBuyerIntent: true; notWinProbability: true; notSentimentAnalysis: true;
};
export type DealBriefItem = {
  code: string; label: string; dimension: 'readiness' | 'momentum' | 'close_date' | 'relationship' | 'engagement' | 'change'; direction: 'positive' | 'negative';
  severity: Severity; detail: string; observedAt: string | null; evidenceCodes: string[];
};
export type DealBriefChange = { code: string; label: string; detail: string; observedAt: string | null };
export type DealBrief = {
  methodology: 'deterministic_evidence_synthesis'; generatedAt: string; status: 'on_track' | 'watch' | 'intervention_required' | 'insufficient_evidence';
  attentionScore: number; confidence: 'high' | 'medium' | 'low'; summary: string; risks: DealBriefItem[]; positiveSignals: DealBriefItem[]; changes: DealBriefChange[];
  nextAction: DecisionAction | null;
  coverage: { readiness: true; momentum: boolean; closeDate: boolean; relationship: boolean; engagement?: boolean; percent: number; missingDimensions: Array<'momentum' | 'close_date' | 'relationship' | 'engagement'>; truncated: boolean };
  freshness: { assessedAt: string; ageHours: number | null; status: 'fresh' | 'aging' | 'stale' | 'unavailable' };
  limitations: string[]; notWinProbability: true; notBuyerIntent: true; notForecastCategory: true;
};
export type Intelligence = {
  risk: { lostPoints: number; potentialScore: number; afterCriticalFixes: number; contributors: Array<Issue & { impact: number }> };
  nextBestActions: Array<{ code: string; label: string; action: string; impact: number; severity: Severity; property?: string }>;
  stageReadiness: { stageId: string | null; stageLabel: string; satisfied: number; total: number; percent: number; blockers: Array<{ code: string; label: string; severity: Severity; impact: number }>; requirements: Requirement[] };
  change: { previousAssessedAt: string | null; scoreDelta: number | null; gradeChanged: boolean; statusChanged: boolean; newIssueCodes: string[]; resolvedIssueCodes: string[]; amountDelta: number | null; stageAgeDeltaDays: number | null; stageChanged: boolean };
  decisionActions?: DecisionAction[];
  momentum?: Momentum;
  closeDateCredibility?: CloseDateCredibility;
  relationshipCoverage?: RelationshipCoverage;
  relationshipActions?: DecisionAction[];
  engagement?: Engagement;
  engagementActions?: DecisionAction[];
  dealBrief?: DealBrief;
};
export type Assessment = {
  dealId: string; score: number; grade: string; status: 'ready' | 'at_risk' | 'critical'; issues: Issue[]; readinessSummary: string;
  isWon: boolean; assessedAt: string; reviewedAt: string | null; handoffStatus: string | null; intelligence?: Intelligence;
};

export function statusVariant(status: Assessment['status']): 'success' | 'warning' | 'danger' {
  if (status === 'ready') return 'success';
  if (status === 'at_risk') return 'warning';
  return 'danger';
}
export function momentumVariant(band: NonNullable<Intelligence['momentum']>['band']): 'success' | 'warning' | 'danger' | 'default' {
  if (band === 'strong') return 'success';
  if (band === 'watch') return 'warning';
  if (band === 'stalled') return 'danger';
  return 'default';
}
export function credibilityVariant(status: NonNullable<Intelligence['closeDateCredibility']>['status']): 'success' | 'warning' | 'danger' | 'default' {
  if (status === 'credible') return 'success';
  if (status === 'watch') return 'warning';
  if (status === 'weak') return 'danger';
  return 'default';
}
export function relationshipVariant(status: NonNullable<Intelligence['relationshipCoverage']>['status']): 'success' | 'warning' | 'danger' {
  if (status === 'strong') return 'success';
  if (status === 'partial') return 'warning';
  return 'danger';
}
export function engagementVariant(status: NonNullable<Intelligence['engagement']>['status']): 'success' | 'warning' | 'danger' | 'default' {
  if (status === 'active') return 'success';
  if (status === 'watch') return 'warning';
  if (status === 'disengaged') return 'danger';
  return 'default';
}
export function briefVariant(status: NonNullable<Intelligence['dealBrief']>['status']): 'success' | 'warning' | 'danger' | 'default' {
  if (status === 'on_track') return 'success';
  if (status === 'watch') return 'warning';
  if (status === 'intervention_required') return 'danger';
  return 'default';
}
export function attentionVariant(score: number): 'success' | 'warning' | 'danger' {
  if (score >= 70) return 'danger';
  if (score >= 35) return 'warning';
  return 'success';
}
export function freshnessVariant(status: NonNullable<Intelligence['dealBrief']>['freshness']['status']): 'success' | 'warning' | 'danger' | 'default' {
  if (status === 'fresh') return 'success';
  if (status === 'aging') return 'warning';
  if (status === 'stale') return 'danger';
  return 'default';
}
export function roleCoverageVariant(status: BuyerRoleCoverage['status']): 'success' | 'warning' | 'danger' {
  if (status === 'explicit') return 'success';
  if (status === 'inferred_only') return 'warning';
  return 'danger';
}
export function buyerRoleLabel(role: BuyerRole): string {
  return role.split('_').map((part) => part.charAt(0).toUpperCase() + part.slice(1)).join(' ');
}
export function issueName(assessment: Assessment, code: string): string {
  return assessment.issues.find((item) => item.code === code)?.label ?? code.replace(/^custom_/, '').replace(/_/g, ' ');
}
export function delta(value: number): string { return `${value > 0 ? '+' : ''}${value}`; }
export function formatDate(value: string | null | undefined): string { return value ? new Date(value).toLocaleString() : 'Not available'; }
export function formatAgeHours(value: number | null): string {
  if (value === null) return 'Unknown age';
  if (value < 1) return 'Less than one hour old';
  if (value < 24) return `${Math.floor(value)} hour${Math.floor(value) === 1 ? '' : 's'} old`;
  const days = Math.floor(value / 24);
  return `${days} day${days === 1 ? '' : 's'} old`;
}

export function useDealAssessment(dealId: string) {
  const [assessment, setAssessment] = useState<Assessment | null>(null);
  const [loading, setLoading] = useState(true);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async (refresh = false) => {
    setError(null); setNotice(null); if (refresh) setWorking(true); else setLoading(true);
    try {
      const response = await hubspot.fetch(`${API_BASE}/deals/${dealId}/assessment`, { method: refresh ? 'POST' : 'GET', timeout: 15000 });
      const data = await response.json();
      if (!response.ok) throw new Error(data?.error?.message ?? 'DealGuard could not assess this deal.');
      setAssessment(data as Assessment);
      if (refresh) setNotice('Deal intelligence refreshed.');
    } catch (caught) { setError(caught instanceof Error ? caught.message : 'DealGuard could not assess this deal.'); }
    finally { setLoading(false); setWorking(false); }
  }, [dealId]);

  useEffect(() => { void load(false); }, [load]);

  const postAction = useCallback(async (action: 'review' | 'handoff') => {
    setWorking(true); setError(null); setNotice(null);
    try {
      const response = await hubspot.fetch(`${API_BASE}/deals/${dealId}/${action}`, { method: 'POST', timeout: 15000, body: {} });
      const data = await response.json();
      if (!response.ok) throw new Error(data?.error?.message ?? 'The action could not be completed.');
      setNotice(action === 'review' ? 'Deal marked as reviewed.' : 'Closed-won handoff confirmed.');
      await load(false);
    } catch (caught) { setError(caught instanceof Error ? caught.message : 'The action could not be completed.'); }
    finally { setWorking(false); }
  }, [dealId, load]);

  return { assessment, loading, working, error, notice, load, postAction };
}

export function CardLoading({ label }: { label: string }) { return <LoadingSpinner label={label} />; }
export function CardUnavailable({ error }: { error: string | null }) { return <Alert title="DealGuard unavailable" variant="danger">{error ?? 'No assessment is available.'}</Alert>; }
