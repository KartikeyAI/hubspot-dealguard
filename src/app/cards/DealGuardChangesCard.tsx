import React from 'react';
import { Alert, Button, Flex, Heading, Text, hubspot } from '@hubspot/ui-extensions';
import { CardLoading, CardUnavailable, delta, issueName, useDealAssessment } from './deal-intelligence-shared';

hubspot.extend<'crm.record.tab'>(({ context }) => <DealGuardChangesCard dealId={String(context.crm.objectId)} />);

const DealGuardChangesCard = ({ dealId }: { dealId: string }) => {
  const { assessment, loading, working, error, notice, load } = useDealAssessment(dealId);
  if (loading) return <CardLoading label="Loading DealGuard changes" />;
  if (!assessment) return <CardUnavailable error={error} />;
  const change = assessment.intelligence?.change;
  const stageLabel = assessment.intelligence?.stageReadiness.stageLabel;

  return <Flex direction="column" gap="medium">
    {error && <Alert title="Action failed" variant="danger">{error}</Alert>}
    {notice && <Alert title="Done" variant="success">{notice}</Alert>}
    <Heading>What changed</Heading>
    {!change?.previousAssessedAt ? <Text>DealGuard needs at least two historical assessments before it can explain changes.</Text> : <>
      <Text>Compared with {new Date(change.previousAssessedAt).toLocaleString()}.</Text>
      <Flex direction="column" gap="extra-small">
        {change.scoreDelta !== null && <Text><Text format={{ fontWeight: 'bold' }}>Readiness:</Text> {delta(change.scoreDelta)} points{change.statusChanged ? ' · status changed' : ''}{change.gradeChanged ? ' · grade changed' : ''}.</Text>}
        {change.newIssueCodes.length > 0 && <Text><Text format={{ fontWeight: 'bold' }}>New risks:</Text> {change.newIssueCodes.map((code) => issueName(assessment, code)).join(', ')}.</Text>}
        {change.resolvedIssueCodes.length > 0 && <Text><Text format={{ fontWeight: 'bold' }}>Resolved:</Text> {change.resolvedIssueCodes.map((code) => issueName(assessment, code)).join(', ')}.</Text>}
        {change.amountDelta !== null && change.amountDelta !== 0 && <Text><Text format={{ fontWeight: 'bold' }}>Deal amount:</Text> changed by {delta(change.amountDelta)}.</Text>}
        {change.stageChanged && <Text><Text format={{ fontWeight: 'bold' }}>Stage:</Text> moved to {stageLabel ?? 'the current stage'}.</Text>}
        {change.stageAgeDeltaDays !== null && change.stageAgeDeltaDays > 0 && <Text><Text format={{ fontWeight: 'bold' }}>Stage age:</Text> +{change.stageAgeDeltaDays} day{change.stageAgeDeltaDays === 1 ? '' : 's'}.</Text>}
        {change.scoreDelta === 0 && change.newIssueCodes.length === 0 && change.resolvedIssueCodes.length === 0 && !change.stageChanged && (change.amountDelta === null || change.amountDelta === 0) && <Text>No material readiness changes were detected.</Text>}
      </Flex>
    </>}
    <Button variant="secondary" onClick={() => void load(true)} disabled={working}>Refresh changes</Button>
    <Text variant="microcopy">Latest assessment {new Date(assessment.assessedAt).toLocaleString()}.</Text>
  </Flex>;
};
