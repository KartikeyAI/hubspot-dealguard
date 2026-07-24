import React from 'react';
import { Alert, Button, Flex, Heading, StatusTag, Text, hubspot } from '@hubspot/ui-extensions';
import { CardLoading, CardUnavailable, delta, statusVariant, useDealAssessment } from './deal-intelligence-shared';

hubspot.extend<'crm.record.tab'>(({ context }) => <DealGuardReadinessCard dealId={String(context.crm.objectId)} />);

const DealGuardReadinessCard = ({ dealId }: { dealId: string }) => {
  const { assessment, loading, working, error, notice, load, postAction } = useDealAssessment(dealId);
  if (loading) return <CardLoading label="Loading DealGuard readiness" />;
  if (!assessment) return <CardUnavailable error={error} />;
  const intelligence = assessment.intelligence;
  const change = intelligence?.change;
  const topRisks = intelligence?.risk.contributors.slice(0, 3) ?? [];

  return <Flex direction="column" gap="medium">
    {error && <Alert title="Action failed" variant="danger">{error}</Alert>}
    {notice && <Alert title="Done" variant="success">{notice}</Alert>}
    <Flex direction="row" justify="between" align="center" gap="medium">
      <Flex direction="column" gap="extra-small">
        <Heading>{assessment.score}/100 · Grade {assessment.grade}</Heading>
        <Text>{assessment.readinessSummary}</Text>
        {change?.scoreDelta !== null && change?.scoreDelta !== undefined && <Text variant="microcopy">Since last assessment: {delta(change.scoreDelta)} points.</Text>}
      </Flex>
      <StatusTag variant={statusVariant(assessment.status)}>{assessment.status === 'at_risk' ? 'At risk' : assessment.status.charAt(0).toUpperCase() + assessment.status.slice(1)}</StatusTag>
    </Flex>
    {intelligence && <Text>{intelligence.risk.lostPoints} readiness points blocked · critical fixes can raise readiness to {intelligence.risk.afterCriticalFixes} · full detected potential {intelligence.risk.potentialScore}.</Text>}
    {topRisks.length > 0 && <Flex direction="column" gap="extra-small">
      <Text format={{ fontWeight: 'bold' }}>Top risks</Text>
      {topRisks.map((item) => <Text key={item.code}>• −{item.impact} · {item.label}</Text>)}
    </Flex>}
    {assessment.isWon && <Alert title="Sales-to-delivery handoff" variant={assessment.handoffStatus === 'confirmed' ? 'success' : 'warning'}>{assessment.handoffStatus === 'confirmed' ? 'The handoff has been confirmed.' : 'Resolve critical gaps, then confirm that delivery has enough information to begin.'}</Alert>}
    <Flex direction="row" gap="small" wrap="wrap">
      <Button onClick={() => void load(true)} disabled={working}>Refresh readiness</Button>
      <Button variant="secondary" onClick={() => void postAction('review')} disabled={working}>Mark reviewed</Button>
      {assessment.isWon && assessment.handoffStatus !== 'confirmed' && <Button variant="primary" onClick={() => void postAction('handoff')} disabled={working || assessment.status === 'critical'}>Confirm handoff</Button>}
    </Flex>
    <Text variant="microcopy">Last assessed {new Date(assessment.assessedAt).toLocaleString()}.</Text>
  </Flex>;
};
