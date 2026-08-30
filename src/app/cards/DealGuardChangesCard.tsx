import React from 'react';
import { Alert, Button, Divider, Flex, Heading, Text, hubspot } from '@hubspot/ui-extensions';
import { CardLoading, CardUnavailable, delta, formatDate, issueName, useDealAssessment } from './deal-intelligence-shared';

hubspot.extend<'crm.record.tab'>(({ context }) => <DealGuardChangesCard dealId={String(context.crm.objectId)} />);

const DealGuardChangesCard = ({ dealId }: { dealId: string }) => {
  const { assessment, loading, working, error, notice, load } = useDealAssessment(dealId);
  if (loading) return <CardLoading label="Loading DealGuard changes" />;
  if (!assessment) return <CardUnavailable error={error} />;
  const intelligence = assessment.intelligence;
  const change = intelligence?.change;
  const stageLabel = intelligence?.stageReadiness.stageLabel;
  const momentum = intelligence?.momentum;
  const closeDate = intelligence?.closeDateCredibility;

  return <Flex direction="column" gap="medium">
    {error && <Alert title="Action failed" variant="danger">{error}</Alert>}
    {notice && <Alert title="Done" variant="success">{notice}</Alert>}
    <Heading>What changed</Heading>
    {!change?.previousAssessedAt ? <Text>DealGuard needs at least two stored assessments before it can explain readiness changes.</Text> : <>
      <Text>Compared with {new Date(change.previousAssessedAt).toLocaleString()}.</Text>
      <Flex direction="column" gap="extra-small">
        {change.scoreDelta !== null && <Text><Text format={{ fontWeight: 'bold' }}>Readiness:</Text> {delta(change.scoreDelta)} points{change.statusChanged ? ' · status changed' : ''}{change.gradeChanged ? ' · grade changed' : ''}.</Text>}
        {change.newIssueCodes.length > 0 && <Text><Text format={{ fontWeight: 'bold' }}>New risks:</Text> {change.newIssueCodes.map((code) => issueName(assessment, code)).join(', ')}.</Text>}
        {change.resolvedIssueCodes.length > 0 && <Text><Text format={{ fontWeight: 'bold' }}>Resolved:</Text> {change.resolvedIssueCodes.map((code) => issueName(assessment, code)).join(', ')}.</Text>}
        {change.amountDelta !== null && change.amountDelta !== 0 && <Text><Text format={{ fontWeight: 'bold' }}>Deal amount:</Text> changed by {delta(change.amountDelta)}.</Text>}
        {change.stageChanged && <Text><Text format={{ fontWeight: 'bold' }}>Stage:</Text> moved to {stageLabel ?? 'the current stage'}.</Text>}
        {change.stageAgeDeltaDays !== null && change.stageAgeDeltaDays > 0 && <Text><Text format={{ fontWeight: 'bold' }}>Stage age:</Text> +{change.stageAgeDeltaDays} day{change.stageAgeDeltaDays === 1 ? '' : 's'}.</Text>}
      </Flex>
    </>}

    {momentum && <>
      <Divider />
      <Heading>90-day CRM movement</Heading>
      <Text>{momentum.events.stageAdvances} stage advances · {momentum.events.stageRegressions} regressions · {momentum.events.pipelineChanges} pipeline changes.</Text>
      <Text>{momentum.events.closeDatePushes} close-date pushes · {momentum.events.closeDatePullIns} pull-ins · {momentum.events.ownerChanges} owner changes.</Text>
      <Text>{momentum.events.amountChanges} amount changes · {momentum.events.nextStepChanges} next-step changes.</Text>
      <Text variant="microcopy">Last material change: {formatDate(momentum.lastMaterialChangeAt)} · evidence coverage {momentum.evidenceCoveragePercent}%.</Text>
    </>}

    {closeDate && <>
      <Divider />
      <Heading>Close-date evidence</Heading>
      <Text>{closeDate.summary}</Text>
      <Text>Current close date: {formatDate(closeDate.currentCloseDate)} · {closeDate.daysToClose === null ? 'days to close unavailable' : `${closeDate.daysToClose} days to close`}.</Text>
      <Text variant="microcopy">Last close-date change: {formatDate(closeDate.lastCloseDateChangeAt)} · last push: {formatDate(closeDate.lastPushAt)}.</Text>
    </>}

    <Button variant="secondary" onClick={() => void load(true)} disabled={working}>Refresh changes</Button>
    <Text variant="microcopy">Latest assessment {new Date(assessment.assessedAt).toLocaleString()}.</Text>
  </Flex>;
};
