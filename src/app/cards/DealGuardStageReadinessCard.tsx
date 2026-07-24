import React from 'react';
import { Alert, Button, Flex, Heading, StatusTag, Text, hubspot } from '@hubspot/ui-extensions';
import { CardLoading, CardUnavailable, useDealAssessment } from './deal-intelligence-shared';

hubspot.extend<'crm.record.tab'>(({ context }) => <DealGuardStageReadinessCard dealId={String(context.crm.objectId)} />);

const DealGuardStageReadinessCard = ({ dealId }: { dealId: string }) => {
  const { assessment, loading, working, error, notice, load } = useDealAssessment(dealId);
  if (loading) return <CardLoading label="Loading DealGuard stage readiness" />;
  if (!assessment) return <CardUnavailable error={error} />;
  const stage = assessment.intelligence?.stageReadiness;

  return <Flex direction="column" gap="medium">
    {error && <Alert title="Action failed" variant="danger">{error}</Alert>}
    {notice && <Alert title="Done" variant="success">{notice}</Alert>}
    <Flex direction="row" justify="between" align="center" gap="medium">
      <Flex direction="column" gap="extra-small">
        <Heading>{stage?.stageLabel ?? 'Current stage'}</Heading>
        <Text>{stage ? `${stage.satisfied}/${stage.total} configured requirements satisfied · ${stage.percent}% complete.` : 'Stage readiness is unavailable until the enriched assessment is loaded.'}</Text>
      </Flex>
      {stage && <StatusTag variant={stage.blockers.length === 0 ? 'success' : 'warning'}>{stage.blockers.length === 0 ? 'Ready' : `${stage.blockers.length} blocker${stage.blockers.length === 1 ? '' : 's'}`}</StatusTag>}
    </Flex>
    {stage && (stage.requirements.length === 0 ? <Text>No explicit requirements are configured for this stage.</Text> : <Flex direction="column" gap="extra-small">
      {stage.requirements.map((item) => <Text key={item.code}>{item.satisfied ? '✓' : '✕'} {item.label}{item.satisfied ? '' : ` · ${item.impact} pts`}</Text>)}
    </Flex>)}
    {stage && stage.blockers.length > 0 && <Alert title="Not ready to progress" variant="warning">Resolve the failed configured requirements before treating this stage as complete.</Alert>}
    <Button variant="secondary" onClick={() => void load(true)} disabled={working}>Refresh stage readiness</Button>
    <Text variant="microcopy">Based on assessment from {new Date(assessment.assessedAt).toLocaleString()}.</Text>
  </Flex>;
};
