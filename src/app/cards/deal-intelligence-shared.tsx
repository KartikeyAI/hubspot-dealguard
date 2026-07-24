import React, { useCallback, useEffect, useState } from 'react';
import { Alert, LoadingSpinner, hubspot } from '@hubspot/ui-extensions';

export const API_BASE = 'https://dealguard-api.rokad.co/api/v1';
export type Severity = 'info' | 'warning' | 'critical';
export type Issue = { code: string; label: string; description: string; severity: Severity; weight: number; property?: string };
export type Requirement = { code: string; label: string; satisfied: boolean; severity: Severity; impact: number };
export type Intelligence = {
  risk: { lostPoints: number; potentialScore: number; afterCriticalFixes: number; contributors: Array<Issue & { impact: number }> };
  nextBestActions: Array<{ code: string; label: string; action: string; impact: number; severity: Severity; property?: string }>;
  stageReadiness: { stageId: string | null; stageLabel: string; satisfied: number; total: number; percent: number; blockers: Array<{ code: string; label: string; severity: Severity; impact: number }>; requirements: Requirement[] };
  change: { previousAssessedAt: string | null; scoreDelta: number | null; gradeChanged: boolean; statusChanged: boolean; newIssueCodes: string[]; resolvedIssueCodes: string[]; amountDelta: number | null; stageAgeDeltaDays: number | null; stageChanged: boolean };
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
export function issueName(assessment: Assessment, code: string): string {
  return assessment.issues.find((item) => item.code === code)?.label ?? code.replace(/^custom_/, '').replace(/_/g, ' ');
}
export function delta(value: number): string { return `${value > 0 ? '+' : ''}${value}`; }

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
