import React from 'react';
import { Alert, Button, Divider, Flex, Heading, StatusTag, Text, hubspot } from '@hubspot/ui-extensions';
import {
  CardLoading,
  CardUnavailable,
  engagementVariant,
  formatDate,
  useDealAssessment,
} from './deal-intelligence-shared';

hubspot.extend<'crm.record.tab'>(({ context }) => <DealGuardEngagementCard dealId={String(context.crm.objectId)} />);

const DealGuardEngagementCard = ({ dealId }: { dealId: string }) => {
  const { assessment, loading, working, error, notice, load } = useDealAssessment(dealId);
  if (loading) return <CardLoading label="Loading engagement evidence" />;
  if (!assessment) return <CardUnavailable error={error} />;
  const engagement = assessment.intelligence?.engagement;

  if (!engagement) {
    return <Flex direction="column" gap="medium">
      {error && <Alert title="Action failed" variant="danger">{error}</Alert>}
      <Alert title="Engagement metadata is not available" variant="warning">
        Refresh the deal to retrieve bounded email, call, and meeting metadata. Readiness remains available when optional activity evidence cannot be loaded.
      </Alert>
      <Button onClick={() => void load(true)} disabled={working}>Refresh engagement evidence</Button>
    </Flex>;
  }

  return <Flex direction="column" gap="medium">
    {error && <Alert title="Action failed" variant="danger">{error}</Alert>}
    {notice && <Alert title="Done" variant="success">{notice}</Alert>}
    <Flex direction="row" justify="between" align="center" gap="medium">
      <Flex direction="column" gap="extra-small">
        <Heading>Engagement evidence</Heading>
        <Text>{engagement.summary}</Text>
      </Flex>
      <StatusTag variant={engagementVariant(engagement.status)}>{engagement.status.replaceAll('_', ' ')}</StatusTag>
    </Flex>
    <Text>{engagement.score === null ? 'Score unavailable' : `${engagement.score}/100`} · {engagement.confidence} confidence · {engagement.coverage.percent}% metadata coverage.</Text>
    <Text>Last buyer-side activity: {formatDate(engagement.lastBuyerActivityAt)}.</Text>
    <Text>Email response gap: {engagement.emailResponseGapDays === null ? 'No unresolved outbound gap detected' : `${engagement.emailResponseGapDays} days`}.</Text>

    <Divider />
    <Heading>Email metadata</Heading>
    <Text>{engagement.counts.inboundEmails} inbound · {engagement.counts.outboundEmails} outbound · {engagement.counts.forwardedEmails} forwarded · {engagement.counts.failedOrBouncedEmails} failed or bounced.</Text>
    <Text>Reciprocity: {engagement.reciprocity.status.replaceAll('_', ' ')}{engagement.reciprocity.ratio === null ? '' : ` · inbound/outbound ratio ${engagement.reciprocity.ratio}`}.</Text>
    <Text variant="microcopy">Last inbound: {formatDate(engagement.lastInboundEmailAt)} · Last outbound: {formatDate(engagement.lastOutboundEmailAt)}</Text>

    <Divider />
    <Heading>Calls and meetings</Heading>
    <Text>{engagement.counts.completedCalls} completed calls ({engagement.counts.inboundCalls} inbound, {engagement.counts.outboundCalls} outbound).</Text>
    <Text>{engagement.counts.completedMeetings} completed meetings · {engagement.counts.scheduledMeetings} future scheduled · {engagement.counts.noShowMeetings} no-shows · {engagement.counts.canceledMeetings} canceled.</Text>
    <Text variant="microcopy">Last completed call: {formatDate(engagement.lastCompletedCallAt)} · Last completed meeting: {formatDate(engagement.lastCompletedMeetingAt)} · Next scheduled meeting: {formatDate(engagement.nextScheduledMeetingAt)}</Text>

    <Divider />
    <Heading>Activity cadence</Heading>
    <Text>{engagement.cadence.recent14Days} material activities in the latest 14 days versus {engagement.cadence.previous14Days} in the prior 14 days.</Text>
    <Text>{engagement.cadence.activeWeeks8} active week{engagement.cadence.activeWeeks8 === 1 ? '' : 's'} in the last eight weeks · trend {engagement.cadence.trend.replaceAll('_', ' ')}.</Text>

    <Divider />
    <Heading>Signals</Heading>
    {engagement.signals.length === 0
      ? <Text>No material engagement signal is available.</Text>
      : engagement.signals.map((item) => <Flex key={item.code} direction="row" justify="between" gap="small">
          <Text>{item.label}: {item.detail}</Text>
          <StatusTag variant={item.direction === 'positive' ? 'success' : item.direction === 'negative' ? (item.severity === 'critical' ? 'danger' : 'warning') : 'default'}>{item.direction}</StatusTag>
        </Flex>)}

    {engagement.coverage.truncated && <Alert title="Evidence is bounded" variant="warning">One or more activity types exceeded the on-demand record limit. The score and confidence disclose that limitation.</Alert>}
    {engagement.coverage.missingTypes.length > 0 && <Alert title="Partial activity coverage" variant="warning">Unavailable activity types: {engagement.coverage.missingTypes.join(', ')}. Missing metadata lowers confidence and is not proof that no interaction occurred.</Alert>}
    <Alert title="Metadata-only boundary" variant="info">DealGuard processes timestamps, direction, status, outcome, duration, and owner identifiers only. It does not request email subjects or bodies, headers, addresses, meeting descriptions or notes, call notes, phone numbers, recordings, transcripts, or sentiment.</Alert>
    {engagement.limitations.map((item, index) => <Text key={`engagement-limitation-${index}`} variant="microcopy">• {item}</Text>)}
    <Text variant="microcopy">Evidence fetched {formatDate(engagement.fetchedAt)}.</Text>
    <Button variant="secondary" onClick={() => void load(true)} disabled={working}>Refresh engagement evidence</Button>
  </Flex>;
};
