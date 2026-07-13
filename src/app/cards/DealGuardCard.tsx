import React, { useCallback, useEffect, useState } from 'react';
import {
  Alert,
  Button,
  Divider,
  Flex,
  Heading,
  LoadingSpinner,
  StatusTag,
  Text,
  hubspot,
} from '@hubspot/ui-extensions';

const API_BASE = 'https://dealguard-api.rokad.co/api/v1';

type Issue = {
  code: string;
  label: string;
  description: string;
  severity: 'info' | 'warning' | 'critical';
};

type Assessment = {
  dealId: string;
  score: number;
  grade: string;
  status: 'ready' | 'at_risk' | 'critical';
  issues: Issue[];
  readinessSummary: string;
  isWon: boolean;
  assessedAt: string;
  reviewedAt: string | null;
  handoffStatus: string | null;
};

hubspot.extend<'crm.record.tab'>(({ context }) => (
  <DealGuardCard dealId={String(context.crm.objectId)} />
));

function statusVariant(status: Assessment['status']): 'success' | 'warning' | 'danger' {
  if (status === 'ready') return 'success';
  if (status === 'at_risk') return 'warning';
  return 'danger';
}

const DealGuardCard = ({ dealId }: { dealId: string }) => {
  const [assessment, setAssessment] = useState<Assessment | null>(null);
  const [loading, setLoading] = useState(true);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async (refresh = false) => {
    setError(null);
    setNotice(null);
    if (refresh) setWorking(true); else setLoading(true);
    try {
      const response = await hubspot.fetch(`${API_BASE}/deals/${dealId}/assessment`, {
        method: refresh ? 'POST' : 'GET',
        timeout: 15000,
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data?.error?.message ?? 'DealGuard could not assess this deal.');
      setAssessment(data as Assessment);
      if (refresh) setNotice('Readiness assessment refreshed.');
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'DealGuard could not assess this deal.');
    } finally {
      setLoading(false);
      setWorking(false);
    }
  }, [dealId]);

  useEffect(() => { void load(false); }, [load]);

  const postAction = async (action: 'review' | 'handoff') => {
    setWorking(true);
    setError(null);
    setNotice(null);
    try {
      const response = await hubspot.fetch(`${API_BASE}/deals/${dealId}/${action}`, {
        method: 'POST',
        timeout: 15000,
        body: {},
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data?.error?.message ?? 'The action could not be completed.');
      setNotice(action === 'review' ? 'Deal marked as reviewed.' : 'Closed-won handoff confirmed.');
      await load(false);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'The action could not be completed.');
    } finally {
      setWorking(false);
    }
  };

  if (loading) return <LoadingSpinner label="Loading DealGuard assessment" />;
  if (!assessment) return <Alert title="DealGuard unavailable" variant="danger">{error ?? 'No assessment is available.'}</Alert>;

  const criticalIssues = assessment.issues.filter((item) => item.severity === 'critical');
  const otherIssues = assessment.issues.filter((item) => item.severity !== 'critical');

  return (
    <Flex direction="column" gap="medium">
      {error && <Alert title="Action failed" variant="danger">{error}</Alert>}
      {notice && <Alert title="Done" variant="success">{notice}</Alert>}
      <Flex direction="row" justify="between" align="center" gap="medium">
        <Flex direction="column" gap="extra-small">
          <Heading>Readiness {assessment.score}/100 · Grade {assessment.grade}</Heading>
          <Text>{assessment.readinessSummary}</Text>
        </Flex>
        <StatusTag variant={statusVariant(assessment.status)}>
          {assessment.status === 'at_risk' ? 'At risk' : assessment.status.charAt(0).toUpperCase() + assessment.status.slice(1)}
        </StatusTag>
      </Flex>
      <Divider />
      {assessment.issues.length === 0 ? (
        <Alert title="Ready to progress" variant="success">No configured readiness gaps were detected.</Alert>
      ) : (
        <Flex direction="column" gap="small">
          {criticalIssues.length > 0 && <Heading>Critical gaps</Heading>}
          {criticalIssues.length > 0 && (
            <Flex direction="column" gap="extra-small">
              {criticalIssues.map((item) => <Text key={item.code}>• <Text format={{ fontWeight: 'bold' }}>{item.label}:</Text> {item.description}</Text>)}
            </Flex>
          )}
          {otherIssues.length > 0 && <Heading>Other gaps</Heading>}
          {otherIssues.length > 0 && (
            <Flex direction="column" gap="extra-small">
              {otherIssues.map((item) => <Text key={item.code}>• <Text format={{ fontWeight: 'bold' }}>{item.label}:</Text> {item.description}</Text>)}
            </Flex>
          )}
        </Flex>
      )}
      {assessment.isWon && (
        <Alert title="Sales-to-delivery handoff" variant={assessment.handoffStatus === 'confirmed' ? 'success' : 'warning'}>
          {assessment.handoffStatus === 'confirmed'
            ? 'The handoff has been confirmed.'
            : 'Resolve critical gaps, then confirm that delivery has enough information to begin.'}
        </Alert>
      )}
      <Flex direction="row" gap="small" wrap="wrap">
        <Button onClick={() => void load(true)} disabled={working}>Refresh assessment</Button>
        <Button variant="secondary" onClick={() => void postAction('review')} disabled={working}>Mark reviewed</Button>
        {assessment.isWon && assessment.handoffStatus !== 'confirmed' && (
          <Button variant="primary" onClick={() => void postAction('handoff')} disabled={working || assessment.status === 'critical'}>
            Confirm handoff
          </Button>
        )}
      </Flex>
      <Text variant="microcopy">Last assessed {new Date(assessment.assessedAt).toLocaleString()}.</Text>
    </Flex>
  );
};
