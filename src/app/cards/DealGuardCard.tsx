import React, { useCallback, useEffect, useState } from 'react';
import { Alert, Button, Divider, Flex, Heading, LoadingSpinner, StatusTag, Text, hubspot } from '@hubspot/ui-extensions';

const API_BASE = 'https://dealguard-api.rokad.co/api/v1';
type Severity = 'info' | 'warning' | 'critical';
type Issue = { code: string; label: string; description: string; severity: Severity; weight: number; property?: string };
type Requirement = { code: string; label: string; satisfied: boolean; severity: Severity; impact: number };
type Intelligence = {
  risk: { lostPoints: number; potentialScore: number; afterCriticalFixes: number; contributors: Array<Issue & { impact: number }> };
  nextBestActions: Array<{ code: string; label: string; action: string; impact: number; severity: Severity; property?: string }>;
  stageReadiness: { stageId: string | null; stageLabel: string; satisfied: number; total: number; percent: number; blockers: Array<{ code: string; label: string; severity: Severity; impact: number }>; requirements: Requirement[] };
  change: { previousAssessedAt: string | null; scoreDelta: number | null; gradeChanged: boolean; statusChanged: boolean; newIssueCodes: string[]; resolvedIssueCodes: string[]; amountDelta: number | null; stageAgeDeltaDays: number | null; stageChanged: boolean };
};
type Assessment = {
  dealId: string; score: number; grade: string; status: 'ready' | 'at_risk' | 'critical'; issues: Issue[]; readinessSummary: string;
  isWon: boolean; assessedAt: string; reviewedAt: string | null; handoffStatus: string | null; intelligence?: Intelligence;
};

hubspot.extend<'crm.record.tab'>(({ context }) => <DealGuardCard dealId={String(context.crm.objectId)} />);

function statusVariant(status: Assessment['status']): 'success' | 'warning' | 'danger' {
  if (status === 'ready') return 'success';
  if (status === 'at_risk') return 'warning';
  return 'danger';
}
function issueName(assessment: Assessment, code: string): string {
  return assessment.issues.find((item) => item.code === code)?.label ?? code.replace(/^custom_/, '').replace(/_/g, ' ');
}
function delta(value: number): string { return `${value > 0 ? '+' : ''}${value}`; }

const DealGuardCard = ({ dealId }: { dealId: string }) => {
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

  const postAction = async (action: 'review' | 'handoff') => {
    setWorking(true); setError(null); setNotice(null);
    try {
      const response = await hubspot.fetch(`${API_BASE}/deals/${dealId}/${action}`, { method: 'POST', timeout: 15000, body: {} });
      const data = await response.json();
      if (!response.ok) throw new Error(data?.error?.message ?? 'The action could not be completed.');
      setNotice(action === 'review' ? 'Deal marked as reviewed.' : 'Closed-won handoff confirmed.'); await load(false);
    } catch (caught) { setError(caught instanceof Error ? caught.message : 'The action could not be completed.'); }
    finally { setWorking(false); }
  };

  if (loading) return <LoadingSpinner label="Loading DealGuard intelligence" />;
  if (!assessment) return <Alert title="DealGuard unavailable" variant="danger">{error ?? 'No assessment is available.'}</Alert>;
  const intelligence = assessment.intelligence;
  const change = intelligence?.change;

  return (
    <Flex direction="column" gap="medium">
      {error && <Alert title="Action failed" variant="danger">{error}</Alert>}
      {notice && <Alert title="Done" variant="success">{notice}</Alert>}

      <Flex direction="row" justify="between" align="center" gap="medium">
        <Flex direction="column" gap="extra-small">
          <Heading>DealGuard · {assessment.score}/100 · Grade {assessment.grade}</Heading>
          <Text>{assessment.readinessSummary}</Text>
          {change?.scoreDelta !== null && change?.scoreDelta !== undefined && <Text variant="microcopy">Since last assessment: {delta(change.scoreDelta)} points.</Text>}
        </Flex>
        <StatusTag variant={statusVariant(assessment.status)}>{assessment.status === 'at_risk' ? 'At risk' : assessment.status.charAt(0).toUpperCase() + assessment.status.slice(1)}</StatusTag>
      </Flex>

      {intelligence && intelligence.risk.contributors.length > 0 && <>
        <Divider />
        <Heading>Why this deal is at risk</Heading>
        <Text>{intelligence.risk.lostPoints} readiness points are currently blocked. Fixing critical issues would raise the score to {intelligence.risk.afterCriticalFixes}; resolving all detected gaps can raise it to {intelligence.risk.potentialScore}.</Text>
        <Flex direction="column" gap="extra-small">
          {intelligence.risk.contributors.slice(0, 5).map((item) => <Text key={item.code}>• <Text format={{ fontWeight: 'bold' }}>−{item.impact} · {item.label}:</Text> {item.description}</Text>)}
        </Flex>
      </>}

      {intelligence && <>
        <Divider />
        <Heading>Stage readiness · {intelligence.stageReadiness.stageLabel}</Heading>
        <Text>{intelligence.stageReadiness.satisfied}/{intelligence.stageReadiness.total} configured requirements satisfied · {intelligence.stageReadiness.percent}% complete.</Text>
        {intelligence.stageReadiness.requirements.length === 0 ? <Text>No explicit stage requirements are configured.</Text> : <Flex direction="column" gap="extra-small">
          {intelligence.stageReadiness.requirements.map((item) => <Text key={item.code}>{item.satisfied ? '✓' : '✕'} {item.label}{item.satisfied ? '' : ` · ${item.impact} pts`}</Text>)}
        </Flex>}
      </>}

      {intelligence && intelligence.nextBestActions.length > 0 && <>
        <Divider />
        <Heading>Next best actions</Heading>
        <Flex direction="column" gap="extra-small">
          {intelligence.nextBestActions.map((item, index) => <Text key={item.code}>{index + 1}. <Text format={{ fontWeight: 'bold' }}>{item.action}</Text> Potential impact: +{item.impact}.</Text>)}
        </Flex>
      </>}

      {change?.previousAssessedAt && <>
        <Divider />
        <Heading>What changed</Heading>
        <Text>Compared with {new Date(change.previousAssessedAt).toLocaleString()}.</Text>
        {change.scoreDelta !== null && <Text>Readiness: {delta(change.scoreDelta)} points{change.statusChanged ? ' · status changed' : ''}{change.gradeChanged ? ' · grade changed' : ''}.</Text>}
        {change.newIssueCodes.length > 0 && <Text>New risks: {change.newIssueCodes.map((code) => issueName(assessment, code)).join(', ')}.</Text>}
        {change.resolvedIssueCodes.length > 0 && <Text>Resolved: {change.resolvedIssueCodes.map((code) => issueName(assessment, code)).join(', ')}.</Text>}
        {change.amountDelta !== null && change.amountDelta !== 0 && <Text>Deal amount changed by {delta(change.amountDelta)}.</Text>}
        {change.stageChanged && <Text>The deal moved to {intelligence?.stageReadiness.stageLabel}.</Text>}
        {change.stageAgeDeltaDays !== null && change.stageAgeDeltaDays > 0 && <Text>Time in stage increased by {change.stageAgeDeltaDays} day{change.stageAgeDeltaDays === 1 ? '' : 's'}.</Text>}
      </>}

      {!intelligence && assessment.issues.length === 0 && <Alert title="Ready to progress" variant="success">No configured readiness gaps were detected.</Alert>}
      {assessment.isWon && <Alert title="Sales-to-delivery handoff" variant={assessment.handoffStatus === 'confirmed' ? 'success' : 'warning'}>{assessment.handoffStatus === 'confirmed' ? 'The handoff has been confirmed.' : 'Resolve critical gaps, then confirm that delivery has enough information to begin.'}</Alert>}
      <Flex direction="row" gap="small" wrap="wrap">
        <Button onClick={() => void load(true)} disabled={working}>Refresh intelligence</Button>
        <Button variant="secondary" onClick={() => void postAction('review')} disabled={working}>Mark reviewed</Button>
        {assessment.isWon && assessment.handoffStatus !== 'confirmed' && <Button variant="primary" onClick={() => void postAction('handoff')} disabled={working || assessment.status === 'critical'}>Confirm handoff</Button>}
      </Flex>
      <Text variant="microcopy">Last assessed {new Date(assessment.assessedAt).toLocaleString()}.</Text>
    </Flex>
  );
};
