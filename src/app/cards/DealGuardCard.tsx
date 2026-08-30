import React from 'react';
import { Alert, Button, Divider, Flex, Heading, StatusTag, Text, hubspot } from '@hubspot/ui-extensions';
import {
  CardLoading,
  CardUnavailable,
  credibilityVariant,
  delta,
  formatDate,
  momentumVariant,
  relationshipVariant,
  roleCoverageVariant,
  statusVariant,
  useDealAssessment,
} from './deal-intelligence-shared';

hubspot.extend<'crm.record.tab'>(({ context }) => <DealGuardReadinessCard dealId={String(context.crm.objectId)} />);

const DealGuardReadinessCard = ({ dealId }: { dealId: string }) => {
  const { assessment, loading, working, error, notice, load, postAction } = useDealAssessment(dealId);
  if (loading) return <CardLoading label="Loading DealGuard readiness" />;
  if (!assessment) return <CardUnavailable error={error} />;
  const intelligence = assessment.intelligence;
  const change = intelligence?.change;
  const topRisks = intelligence?.risk.contributors.slice(0, 3) ?? [];
  const momentum = intelligence?.momentum;
  const closeDate = intelligence?.closeDateCredibility;
  const relationship = intelligence?.relationshipCoverage;
  const coreRoles = relationship?.roleCoverage.filter((item) => item.core) ?? [];

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
      <Text format={{ fontWeight: 'bold' }}>Top readiness risks</Text>
      {topRisks.map((item) => <Text key={item.code}>• −{item.impact} · {item.label}</Text>)}
    </Flex>}

    {momentum && <>
      <Divider />
      <Flex direction="row" justify="between" align="center" gap="medium">
        <Flex direction="column" gap="extra-small">
          <Heading>CRM process momentum</Heading>
          <Text>{momentum.summary}</Text>
        </Flex>
        <StatusTag variant={momentumVariant(momentum.band)}>{momentum.band.replaceAll('_', ' ')}</StatusTag>
      </Flex>
      <Text>{momentum.score === null ? 'Score unavailable' : `${momentum.score}/100`} · {momentum.evidenceCoveragePercent}% property-history coverage · last material change {formatDate(momentum.lastMaterialChangeAt)}.</Text>
      {momentum.signals.slice(0, 3).map((item) => <Text key={item.code}>• {item.label}: {item.detail}</Text>)}
    </>}

    {closeDate && <>
      <Divider />
      <Flex direction="row" justify="between" align="center" gap="medium">
        <Flex direction="column" gap="extra-small">
          <Heading>Close-date credibility</Heading>
          <Text>{closeDate.summary}</Text>
        </Flex>
        <StatusTag variant={credibilityVariant(closeDate.status)}>{closeDate.status}</StatusTag>
      </Flex>
      <Text>{closeDate.score === null ? 'Score unavailable' : `${closeDate.score}/100`} · confidence {closeDate.confidence} · {closeDate.closeDatePushes90d} pushes and {closeDate.closeDatePullIns90d} pull-ins in 90 days.</Text>
      {closeDate.reasons.slice(0, 3).map((item) => <Text key={item.code}>• {item.label}: {item.evidence}</Text>)}
    </>}

    {relationship && <>
      <Divider />
      <Flex direction="row" justify="between" align="center" gap="medium">
        <Flex direction="column" gap="extra-small">
          <Heading>Relationship coverage</Heading>
          <Text>{relationship.summary}</Text>
        </Flex>
        <StatusTag variant={relationshipVariant(relationship.status)}>{relationship.status}</StatusTag>
      </Flex>
      <Text>{relationship.score}/100 · confidence {relationship.confidence} · {relationship.contactCount} associated stakeholder{relationship.contactCount === 1 ? '' : 's'} · {relationship.explicitRoleCoveragePercent}% with explicit role evidence.</Text>
      <Text>Primary buying company: {relationship.primaryCompany?.name ?? 'Not identified'}.</Text>
      {coreRoles.map((item) => <Flex key={item.role} direction="row" justify="between" gap="small">
        <Text>{item.label}{item.people.length > 0 ? ` · ${item.people.join(', ')}` : ''}</Text>
        <StatusTag variant={roleCoverageVariant(item.status)}>{item.status === 'inferred_only' ? 'Inferred only' : item.status}</StatusTag>
      </Flex>)}
      {relationship.signals.filter((item) => item.direction !== 'positive').slice(0, 3).map((item) => <Text key={item.code}>• {item.label}: {item.detail}</Text>)}
    </>}

    {(momentum || closeDate || relationship) && <Alert title="How to read these signals" variant="info">DealGuard uses structured HubSpot CRM history, associations, buying-role fields, and explicitly marked job-title hints. These signals prioritise review; they do not measure buyer intent or predict win probability.</Alert>}

    {assessment.isWon && <Alert title="Sales-to-delivery handoff" variant={assessment.handoffStatus === 'confirmed' ? 'success' : 'warning'}>{assessment.handoffStatus === 'confirmed' ? 'The handoff has been confirmed.' : 'Resolve critical gaps, then confirm that delivery has enough information to begin.'}</Alert>}
    <Flex direction="row" gap="small" wrap="wrap">
      <Button onClick={() => void load(true)} disabled={working}>Refresh intelligence</Button>
      <Button variant="secondary" onClick={() => void postAction('review')} disabled={working}>Mark reviewed</Button>
      {assessment.isWon && assessment.handoffStatus !== 'confirmed' && <Button variant="primary" onClick={() => void postAction('handoff')} disabled={working || assessment.status === 'critical'}>Confirm handoff</Button>}
    </Flex>
    <Text variant="microcopy">Last assessed {new Date(assessment.assessedAt).toLocaleString()}.</Text>
  </Flex>;
};
