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
export type RoleEvidenceSource = 'deal_association_label' | 'contact_buying_role' | 'job_title_hint';
export type RelationshipContact = {
  id: string; displayName: string; jobTitle: string | null; associationLabels: string[];
  roleEvidence: Array<{ role: BuyerRole; source: RoleEvidenceSource; sourceLabel: string; confidence: 'confirmed' | 'contextual' | 'inferred' }>;
  explicitRoles: BuyerRole[]; inferredRoles: BuyerRole[]; updatedAt: string | null;
};
export type RelationshipCompany = {
  id: string; name: string; domain: string | null; industry: string | null; associationLabels: string[]; primary: boolean; primaryEvidence: 'association_label' | 'only_associated_company' | null; updatedAt: string | null;
};
export type BuyerRoleCoverage = {
  role: BuyerRole; label: string; core: boolean; status: 'explicit' | 'inferred_only' | 'missing'; people: string[]; sources: RoleEvidenceSource[];
};
export type RelationshipSignal = {
  code: string; label: string; direction: 'positive' | 'negative' | 'neutral'; severity: Severity; detail: string; evidenceCodes: string[];
};
export type RelationshipCoverage = {
  methodology: 'hubspot_association_and_contact_role_evidence'; score: number; status: 'strong' | 'partial' | 'weak'; confidence: 'high' | 'medium' | 'low'; summary: string;
  contactCount: number; companyCount: number; singleThreaded: boolean; explicitRoleCoveragePercent: number; labeledAssociationCoveragePercent: number;
  contacts: RelationshipContact[]; companies: RelationshipCompany[]; primaryCompany: RelationshipCompany | null; roleCoverage: BuyerRoleCoverage[];
  missingCoreRoles: BuyerRole[]; explicitRoles: BuyerRole[]; inferredOnlyRoles: BuyerRole[]; signals: RelationshipSignal[]; relationshipActions: DecisionAction[];
  fetchedAt: string; contactsTruncated: boolean; companiesTruncated: boolean; limitations: string[]; notBuyerIntent: true; notWinProbability: true;
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
};
export type Assessment = {
  dealId: string; score: number; grade: string; status: 'ready' | 'at_risk' | 'critical'; issues: Issue[]; readinessSummary: string;
  isWon: boolean; assessedAt: string; reviewedAt: string | null; handoffStatus: string | null; intelligence?: Intelligence;
};

const BUYER_ROLE_LABELS: Record<BuyerRole, string> = {
  decision_maker: 'Decision maker', budget_holder: 'Budget holder', champion: 'Champion', executive_sponsor: 'Executive sponsor',
  technical_evaluator: 'Technical evaluator', procurement: 'Procurement', legal_compliance: 'Legal or compliance', end_user: 'End user',
  influencer: 'Influencer', implementer: 'Implementer', blocker: 'Blocker',
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
export function roleCoverageVariant(status: BuyerRoleCoverage['status']): 'success' | 'warning' | 'danger' {
  if (status === 'explicit') return 'success';
  if (status === 'inferred_only') return 'warning';
  return 'danger';
}
export function buyerRoleLabel(role: BuyerRole): string { return BUYER_ROLE_LABELS[role]; }
export function issueName(assessment: Assessment, code: string): string {
  return assessment.issues.find((item) => item.code === code)?.label ?? code.replace(/^custom_/, '').replace(/_/g, ' ');
}
export function delta(value: number): string { return `${value > 0 ? '+' : ''}${value}`; }
export function formatDate(value: string | null | undefined): string { return value ? new Date(value).toLocaleString() : 'Not available'; }

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
