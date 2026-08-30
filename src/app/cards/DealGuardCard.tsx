import React from 'react';
import { Alert, Button, Divider, Flex, Heading, StatusTag, Text, hubspot } from '@hubspot/ui-extensions';
import {
  CardLoading,
  CardUnavailable,
  attentionVariant,
  briefVariant,
  credibilityVariant,
  formatAgeHours,
  formatDate,
  freshnessVariant,
  momentumVariant,
  relationshipVariant,
  statusVariant,
  useDealAssessment,
} from './deal-intelligence-shared';

hubspot.extend<'crm.record.tab'>(({ context }) => <DealGuardBriefCard dealId={String(context.crm.objectId)} />);

const DealGuardBriefCard = ({ dealId }: { dealId: string }) => {
  const { assessment, loading, working, error, notice, load, postAction } = useDealAssessment(dealId);
  if (loading) return <CardLoading label="Loading DealGuard deal brief" />;
  if (!assessment) return <CardUnavailable error={error} />;

  const intelligence = assessment.intelligence;
  const brief = intelligence?.dealBrief;
  const momentum = intelligence?.momentum;
  const closeDate = intelligence?.closeDateCredibility;
  const relationship = intelligence?.relationshipCoverage;
  const nextAction = brief?.nextAction;

  return <Flex direction="column" gap="medium">
    {error && <Alert title="Action failed" variant="danger">{error}</Alert>}
    {notice && <Alert title="Done" variant="success">{notice}</Alert>}

    <Flex direction="row" justify="between" align="center" gap="medium">
      <Flex direction="column" gap="extra-small">
        <Heading>Deal brief</Heading>
        <Text>{brief?.summary ?? assessment.readinessSummary}</Text>
      </Flex>
      <StatusTag variant={brief ? briefVariant(brief.status) : statusVariant(assessment.status)}>
        {brief ? brief.status.replaceAll('_', ' ') : assessment.status.replaceAll('_', ' ')}
      </StatusTag>
    </Flex>

    {brief ? <>
      <Flex direction="row" gap="medium" wrap="wrap">
        <Flex direction="column" gap="extra-small">
          <Text variant="microcopy">ATTENTION PRIORITY</Text>
          <Heading>{brief.attentionScore}/100</Heading>
          <StatusTag variant={attentionVariant(brief.attentionScore)}>{brief.attentionScore >= 70 ? 'Act now' : brief.attentionScore >= 35 ? 'Review' : 'Low'}</StatusTag>
        </Flex>
        <Flex direction="column" gap="extra-small">
          <Text variant="microcopy">EVIDENCE COVERAGE</Text>
          <Heading>{brief.coverage.percent}%</Heading>
          <StatusTag variant={brief.confidence === 'high' ? 'success' : brief.confidence === 'medium' ? 'warning' : 'default'}>{brief.confidence} confidence</StatusTag>
        </Flex>
        <Flex direction="column" gap="extra-small">
          <Text variant="microcopy">EVIDENCE FRESHNESS</Text>
          <Heading>{brief.freshness.status}</Heading>
          <StatusTag variant={freshnessVariant(brief.freshness.status)}>{formatAgeHours(brief.freshness.ageHours)}</StatusTag>
        </Flex>
        <Flex direction="column" gap="extra-small">
          <Text variant="microcopy">READINESS</Text>
          <Heading>{assessment.score}/100</Heading>
          <StatusTag variant={statusVariant(assessment.status)}>{assessment.status.replaceAll('_', ' ')}</StatusTag>
        </Flex>
      </Flex>

      {nextAction && <Alert title="Recommended next action" variant={nextAction.priority === 'high' ? 'danger' : nextAction.priority === 'medium' ? 'warning' : 'info'}>
        {nextAction.action} Owner: {nextAction.owner === 'deal_owner' ? 'Deal owner' : 'Sales manager'}. Due: {formatDate(nextAction.dueAt)}. Why: {nextAction.rationale}
      </Alert>}

      <Flex direction="row" gap="large" wrap="wrap">
        <Flex direction="column" gap="extra-small">
          <Text format={{ fontWeight: 'bold' }}>Top risks</Text>
          {brief.risks.length === 0
            ? <Text>No material deterministic risk is currently detected.</Text>
            : brief.risks.slice(0, 3).map((item) => <Text key={item.code}>• {item.label}: {item.detail}</Text>)}
        </Flex>
        <Flex direction="column" gap="extra-small">
          <Text format={{ fontWeight: 'bold' }}>Positive signals</Text>
          {brief.positiveSignals.length === 0
            ? <Text>No positive evidence is currently strong enough to highlight.</Text>
            : brief.positiveSignals.slice(0, 3).map((item) => <Text key={item.code}>• {item.label}: {item.detail}</Text>)}
        </Flex>
      </Flex>

      <Divider />
      <Flex direction="column" gap="extra-small">
        <Text format={{ fontWeight: 'bold' }}>What changed</Text>
        {brief.changes.length === 0
          ? <Text>No material deterministic change is available since the previous assessment.</Text>
          : brief.changes.slice(0, 5).map((item) => <Text key={item.code}>• {item.label}: {item.detail}</Text>)}
      </Flex>

      <Divider />
      <Heading>Evidence by dimension</Heading>
      <Flex direction="row" gap="medium" wrap="wrap">
        <Flex direction="column" gap="extra-small">
          <Text variant="microcopy">CRM PROCESS MOMENTUM</Text>
          <Heading>{momentum?.score === null || momentum?.score === undefined ? '—' : `${momentum.score}/100`}</Heading>
          <StatusTag variant={momentum ? momentumVariant(momentum.band) : 'default'}>{momentum?.band.replaceAll('_', ' ') ?? 'Unavailable'}</StatusTag>
        </Flex>
        <Flex direction="column" gap="extra-small">
          <Text variant="microcopy">CLOSE-DATE CREDIBILITY</Text>
          <Heading>{closeDate?.score === null || closeDate?.score === undefined ? '—' : `${closeDate.score}/100`}</Heading>
          <StatusTag variant={closeDate ? credibilityVariant(closeDate.status) : 'default'}>{closeDate?.status ?? 'Unavailable'}</StatusTag>
        </Flex>
        <Flex direction="column" gap="extra-small">
          <Text variant="microcopy">RELATIONSHIP COVERAGE</Text>
          <Heading>{relationship ? `${relationship.score}/100` : '—'}</Heading>
          <StatusTag variant={relationship ? relationshipVariant(relationship.status) : 'default'}>{relationship?.status ?? 'Unavailable'}</StatusTag>
        </Flex>
        <Flex direction="column" gap="extra-small">
          <Text variant="microcopy">STAGE READINESS</Text>
          <Heading>{intelligence?.stageReadiness.percent ?? assessment.score}%</Heading>
          <Text>{intelligence?.stageReadiness.satisfied ?? 0} of {intelligence?.stageReadiness.total ?? 0} configured requirements</Text>
        </Flex>
      </Flex>

      {brief.coverage.percent < 100 && <Alert title="Evidence is incomplete" variant="warning">
        Available dimensions: readiness{brief.coverage.momentum ? ', momentum' : ''}{brief.coverage.closeDate ? ', close date' : ''}{brief.coverage.relationship ? ', relationship coverage' : ''}. Missing or bounded evidence lowers confidence; it does not imply the deal will be lost.
      </Alert>}
      <Alert title="How to read this brief" variant="info">
        The Deal Brief synthesises deterministic readiness, CRM movement, close-date, and structured relationship evidence. Attention priority is not buyer intent, a forecast category, a win probability, or an expected-loss estimate.
      </Alert>
    </> : <Alert title="Refresh to build the full Deal Brief" variant="info">
      The stored readiness assessment is available, but the unified evidence synthesis has not yet been generated for this record.
    </Alert>}

    {assessment.isWon && <Alert title="Sales-to-delivery handoff" variant={assessment.handoffStatus === 'confirmed' ? 'success' : 'warning'}>
      {assessment.handoffStatus === 'confirmed' ? 'The handoff has been confirmed.' : 'Resolve critical gaps, then confirm that delivery has enough information to begin.'}
    </Alert>}

    <Flex direction="row" gap="small" wrap="wrap">
      <Button onClick={() => void load(true)} disabled={working}>Refresh Deal Brief</Button>
      <Button variant="secondary" onClick={() => void postAction('review')} disabled={working}>Mark reviewed</Button>
      {assessment.isWon && assessment.handoffStatus !== 'confirmed' && <Button variant="primary" onClick={() => void postAction('handoff')} disabled={working || assessment.status === 'critical'}>Confirm handoff</Button>}
    </Flex>
    <Text variant="microcopy">Assessment: {formatDate(assessment.assessedAt)} · Deal Brief generated: {formatDate(brief?.generatedAt)}</Text>
  </Flex>;
};
