import React, { useCallback, useState } from 'react';
import {
  Alert,
  Button,
  Card,
  Divider,
  Flex,
  Heading,
  LoadingSpinner,
  StatusTag,
  Text,
  hubspot,
} from '@hubspot/ui-extensions';
import { safeProductError } from './product-ui';

const API_BASE = 'https://dealguard-api.rokad.co/api/v1';
const WINDOWS = [7, 30, 90, 180] as const;
type WindowDays = typeof WINDOWS[number];
type Health = 'healthy' | 'watch' | 'degraded' | 'unavailable';
type ChannelType = 'slack_webhook' | 'teams_workflow' | 'email' | 'webhook';

type AnalyticsResponse = {
  generatedAt: string;
  window: { days: number; start: string; end: string };
  summary: {
    batches: number;
    manualBatches: number;
    policyBatches: number;
    attemptedItems: number;
    deliveredItems: number;
    partiallyFailedItems: number;
    failedItems: number;
    deliverySuccessPercent: number;
    medianCompletionMinutes: number | null;
    p95CompletionMinutes: number | null;
    primaryQueued: number;
    repeatQueued: number;
    escalationQueued: number;
    escalationSlaEligible: number;
    escalationSlaCompliant: number;
    escalationSlaBreached: number;
    escalationSlaCompliancePercent: number;
    quietHourDeferrals: number;
    cooldownSuppressions: number;
    notificationLimitSuppressions: number;
    routeUnavailable: number;
    resolvedDispatches: number;
  };
  policies: Array<{
    policyId: string;
    policyName: string;
    trigger: 'due_soon' | 'overdue';
    matched: number;
    primaryQueued: number;
    repeatQueued: number;
    escalationQueued: number;
    attemptedItems: number;
    deliveredItems: number;
    failedItems: number;
    deliverySuccessPercent: number;
    quietHourDeferrals: number;
    cooldownSuppressions: number;
    notificationLimitSuppressions: number;
    routeUnavailable: number;
    escalationSlaEligible: number;
    escalationSlaCompliant: number;
    escalationSlaBreached: number;
    escalationSlaCompliancePercent: number;
    medianFirstQueueMinutes: number | null;
    health: Health;
  }>;
  routes: Array<{
    routeId: string;
    routeName: string;
    attemptedChannels: number;
    deliveredChannels: number;
    failedChannels: number;
    deliverySuccessPercent: number;
    quietHourDeferrals: number;
    routeUnavailable: number;
    lastDeliveryAt: string | null;
    health: Health;
  }>;
  channels: Array<{
    channelId: string;
    channelName: string;
    channelType: ChannelType;
    attempted: number;
    delivered: number;
    failed: number;
    deliverySuccessPercent: number;
    lastDeliveryAt: string | null;
    health: Health;
  }>;
  timeline: Array<{
    date: string;
    attemptedItems: number;
    deliveredItems: number;
    failedItems: number;
    escalationsQueued: number;
    quietHourDeferrals: number;
    cooldownSuppressions: number;
  }>;
  recentFailures: Array<{
    batchId: string;
    recommendationId: string;
    dealId: string;
    channelId: string | null;
    channelName: string;
    channelType: ChannelType | null;
    policyId: string | null;
    policyName: string | null;
    occurredAt: string;
    error: string;
  }>;
  coverage: {
    loadedAttempts: number;
    loadedEvents: number;
    loadedDispatches: number;
    completedAttemptPercent: number;
    channelEvidencePercent: number;
    truncated: boolean;
  };
  limitations: string[];
  semantics: {
    operationalDeliveryOnly: true;
    notDealOutcome: true;
    noCausalAttribution: true;
    noCrmMutation: true;
    escalationSlaUsesConfiguredThreshold: true;
    schedulerGraceMinutes: number;
    suppressionCountsAreDeduplicatedOperationalEvents: true;
  };
};

function formatDate(value: string | null | undefined): string {
  return value ? new Date(value).toLocaleString() : 'Not yet';
}

function formatMinutes(value: number | null): string {
  if (value === null) return 'Unavailable';
  if (value < 60) return `${value} min`;
  return `${Math.round(value / 6) / 10} hr`;
}

function healthVariant(health: Health): 'success' | 'warning' | 'danger' | 'default' {
  if (health === 'healthy') return 'success';
  if (health === 'watch') return 'warning';
  if (health === 'degraded') return 'danger';
  return 'default';
}

function channelLabel(type: ChannelType | null): string {
  if (type === 'slack_webhook') return 'Slack';
  if (type === 'teams_workflow') return 'Microsoft Teams';
  if (type === 'email') return 'Email';
  if (type === 'webhook') return 'Signed webhook';
  return 'Unknown channel';
}

export function RecommendationDeliveryAnalyticsPanel({ enabled }: { enabled: boolean }) {
  const [days, setDays] = useState<WindowDays>(30);
  const [data, setData] = useState<AnalyticsResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (selectedDays = days) => {
    if (!enabled) return;
    setLoading(true);
    setError(null);
    try {
      const response = await hubspot.fetch(
        `${API_BASE}/enterprise/recommendation-delivery-analytics?days=${selectedDays}`,
        { method: 'GET', timeout: 15_000 },
      );
      const payload = await response.json();
      if (!response.ok) {
        throw new Error(safeProductError(payload?.error?.message, 'Recommendation delivery analytics could not be loaded.'));
      }
      setData(payload as AnalyticsResponse);
    } catch (caught) {
      setError(safeProductError(
        caught instanceof Error ? caught.message : null,
        'Recommendation delivery analytics could not be loaded.',
      ));
    } finally {
      setLoading(false);
    }
  }, [days, enabled]);

  if (!enabled) {
    return <Card>
      <Flex direction="column" gap="small">
        <Flex direction="row" justify="between" align="center">
          <Heading>Recommendation delivery & SLA analytics</Heading>
          <StatusTag variant="default">Enterprise</StatusTag>
        </Flex>
        <Text>Measure notification reliability, quiet-hour deferrals, cooldown controls and escalation timeliness without changing CRM data.</Text>
      </Flex>
    </Card>;
  }

  if (!data && !loading) {
    return <Card>
      <Flex direction="column" gap="small">
        <Flex direction="row" justify="between" align="center" gap="small">
          <Flex direction="column" gap="extra-small">
            <Heading>Recommendation delivery & SLA analytics</Heading>
            <Text>Load operational evidence for notification delivery, route health, configured-policy controls and escalation SLA compliance.</Text>
          </Flex>
          <StatusTag variant="default">On demand</StatusTag>
        </Flex>
        {error && <Alert title="Delivery analytics unavailable" variant="danger">{error}</Alert>}
        <Alert title="Operational evidence only" variant="info">
          Delivery success does not mean a deal progressed or that DealGuard caused an outcome. No HubSpot CRM request or mutation is performed by this report.
        </Alert>
        <Button onClick={() => void load(days)}>Load delivery analytics</Button>
      </Flex>
    </Card>;
  }

  if (loading && !data) return <LoadingSpinner label="Loading recommendation delivery analytics" />;
  if (!data) return null;

  const summaryCards = [
    {
      label: 'DELIVERY SUCCESS',
      value: `${data.summary.deliverySuccessPercent}%`,
      detail: `${data.summary.deliveredItems} delivered · ${data.summary.partiallyFailedItems} partial · ${data.summary.failedItems} failed`,
      variant: data.summary.deliverySuccessPercent >= 95 ? 'success' : data.summary.deliverySuccessPercent >= 80 ? 'warning' : 'danger',
    },
    {
      label: 'ESCALATION SLA',
      value: data.summary.escalationSlaEligible > 0 ? `${data.summary.escalationSlaCompliancePercent}%` : 'No due SLAs',
      detail: `${data.summary.escalationSlaCompliant} compliant · ${data.summary.escalationSlaBreached} breached`,
      variant: data.summary.escalationSlaBreached > 0 ? 'danger' : data.summary.escalationSlaEligible > 0 ? 'success' : 'default',
    },
    {
      label: 'QUIET-HOUR DEFERRALS',
      value: String(data.summary.quietHourDeferrals),
      detail: 'Deduplicated recommendation-route days deferred by business calendars',
      variant: data.summary.quietHourDeferrals > 0 ? 'warning' : 'success',
    },
    {
      label: 'COOLDOWN CONTROLS',
      value: String(data.summary.cooldownSuppressions),
      detail: `${data.summary.notificationLimitSuppressions} additional notification-cap suppressions`,
      variant: 'default',
    },
    {
      label: 'COMPLETION LATENCY',
      value: formatMinutes(data.summary.medianCompletionMinutes),
      detail: `95th percentile: ${formatMinutes(data.summary.p95CompletionMinutes)}`,
      variant: data.summary.p95CompletionMinutes !== null && data.summary.p95CompletionMinutes > 60 ? 'warning' : 'success',
    },
    {
      label: 'ROUTE AVAILABILITY',
      value: data.summary.routeUnavailable === 0 ? 'Available' : String(data.summary.routeUnavailable),
      detail: data.summary.routeUnavailable === 0 ? 'No deduplicated route-unavailable observations' : 'Route, event opt-in or channel evidence was unavailable',
      variant: data.summary.routeUnavailable > 0 ? 'danger' : 'success',
    },
  ] as const;

  return <Flex direction="column" gap="medium">
    <Flex direction="row" justify="between" align="center" gap="medium" wrap="wrap">
      <Flex direction="column" gap="extra-small">
        <Heading>Recommendation delivery & SLA analytics</Heading>
        <Text>Operational delivery evidence from {formatDate(data.window.start)} to {formatDate(data.window.end)}.</Text>
        <Text variant="microcopy">Generated {formatDate(data.generatedAt)} · no CRM read or mutation</Text>
      </Flex>
      <Flex direction="row" gap="small" wrap="wrap">
        {WINDOWS.map((windowDays) => <Button
          key={windowDays}
          variant={days === windowDays ? 'primary' : 'secondary'}
          disabled={loading}
          onClick={() => {
            setDays(windowDays);
            void load(windowDays);
          }}
        >{windowDays} days</Button>)}
        <Button variant="secondary" disabled={loading} onClick={() => void load(days)}>
          {loading ? 'Refreshing…' : 'Refresh evidence'}
        </Button>
      </Flex>
    </Flex>

    {error && <Alert title="Delivery analytics refresh failed" variant="danger">{error}</Alert>}
    {data.coverage.truncated && <Alert title="Bounded evidence limit reached" variant="warning">
      The report reached a configured row limit. Older evidence inside the selected window may be omitted.
    </Alert>}

    <Flex direction="row" gap="small" wrap="wrap">
      {summaryCards.map((item) => <Card key={item.label}>
        <Flex direction="column" gap="extra-small">
          <Text variant="microcopy">{item.label}</Text>
          <Heading>{item.value}</Heading>
          <StatusTag variant={item.variant}>{item.variant === 'default' ? 'Context' : item.variant}</StatusTag>
          <Text>{item.detail}</Text>
        </Flex>
      </Card>)}
    </Flex>

    <Card>
      <Flex direction="column" gap="small">
        <Flex direction="row" justify="between" align="center" gap="small">
          <Heading>Delivery funnel</Heading>
          <StatusTag variant="default">Deterministic</StatusTag>
        </Flex>
        <Text>{data.summary.batches} batches · {data.summary.manualBatches} human-confirmed · {data.summary.policyBatches} configured-policy</Text>
        <Text>{data.summary.primaryQueued} primary items · {data.summary.repeatQueued} repeat items · {data.summary.escalationQueued} escalated items</Text>
        <Text>{data.summary.attemptedItems} completed delivery attempts · {data.summary.resolvedDispatches} resolved dispatches</Text>
        <Text variant="microcopy">
          Escalation compliance uses each policy’s configured threshold plus a {data.semantics.schedulerGraceMinutes}-minute allowance for the 15-minute maintenance cadence.
        </Text>
      </Flex>
    </Card>

    <Flex direction="column" gap="small">
      <Flex direction="row" justify="between" align="center">
        <Heading>Policy delivery performance</Heading>
        <Text variant="microcopy">{data.policies.length} policies with evidence</Text>
      </Flex>
      {data.policies.length === 0
        ? <Alert title="No policy delivery evidence" variant="info">No configured-policy evidence exists in this window.</Alert>
        : data.policies.slice(0, 8).map((policy) => <Card key={policy.policyId}>
            <Flex direction="column" gap="extra-small">
              <Flex direction="row" justify="between" align="center" gap="small">
                <Flex direction="column" gap="extra-small">
                  <Text format={{ fontWeight: 'bold' }}>{policy.policyName}</Text>
                  <Text variant="microcopy">{policy.trigger.replaceAll('_', ' ')} · policy {policy.policyId}</Text>
                </Flex>
                <StatusTag variant={healthVariant(policy.health)}>{policy.health}</StatusTag>
              </Flex>
              <Text>{policy.deliverySuccessPercent}% delivery success · {policy.deliveredItems} delivered · {policy.failedItems} failed</Text>
              <Text>{policy.primaryQueued} primary · {policy.repeatQueued} repeat · {policy.escalationQueued} escalation notifications</Text>
              <Text>{policy.quietHourDeferrals} quiet deferrals · {policy.cooldownSuppressions} cooldown suppressions · {policy.notificationLimitSuppressions} cap suppressions</Text>
              <Text>{policy.routeUnavailable} route-unavailable observations · first queue median {formatMinutes(policy.medianFirstQueueMinutes)}</Text>
              <Text variant="microcopy">
                Escalation SLA: {policy.escalationSlaEligible > 0 ? `${policy.escalationSlaCompliancePercent}% (${policy.escalationSlaCompliant}/${policy.escalationSlaEligible})` : 'not yet measurable'}
              </Text>
            </Flex>
          </Card>)}
    </Flex>

    <Divider />
    <Flex direction="column" gap="small">
      <Flex direction="row" justify="between" align="center">
        <Heading>Route health</Heading>
        <Text variant="microcopy">Shared-channel observations are attributed to each matching route</Text>
      </Flex>
      {data.routes.length === 0
        ? <Alert title="No route evidence" variant="info">No route delivery or deferral evidence exists in this window.</Alert>
        : data.routes.slice(0, 8).map((route) => <Card key={route.routeId}>
            <Flex direction="column" gap="extra-small">
              <Flex direction="row" justify="between" align="center">
                <Text format={{ fontWeight: 'bold' }}>{route.routeName}</Text>
                <StatusTag variant={healthVariant(route.health)}>{route.health}</StatusTag>
              </Flex>
              <Text>{route.deliverySuccessPercent}% channel delivery success · {route.deliveredChannels} delivered · {route.failedChannels} failed</Text>
              <Text>{route.quietHourDeferrals} quiet-hour deferrals · {route.routeUnavailable} unavailable observations</Text>
              <Text variant="microcopy">Last delivery evidence: {formatDate(route.lastDeliveryAt)}</Text>
            </Flex>
          </Card>)}
    </Flex>

    <Flex direction="column" gap="small">
      <Heading>Channel health</Heading>
      {data.channels.length === 0
        ? <Alert title="No channel evidence" variant="info">No completed channel delivery evidence exists in this window.</Alert>
        : data.channels.slice(0, 8).map((channel) => <Card key={channel.channelId}>
            <Flex direction="column" gap="extra-small">
              <Flex direction="row" justify="between" align="center">
                <Flex direction="column" gap="extra-small">
                  <Text format={{ fontWeight: 'bold' }}>{channel.channelName}</Text>
                  <Text variant="microcopy">{channelLabel(channel.channelType)}</Text>
                </Flex>
                <StatusTag variant={healthVariant(channel.health)}>{channel.health}</StatusTag>
              </Flex>
              <Text>{channel.deliverySuccessPercent}% success · {channel.delivered} delivered · {channel.failed} failed of {channel.attempted}</Text>
              <Text variant="microcopy">Last delivery evidence: {formatDate(channel.lastDeliveryAt)}</Text>
            </Flex>
          </Card>)}
    </Flex>

    {data.recentFailures.length > 0 && <Flex direction="column" gap="small">
      <Divider />
      <Heading>Recent delivery failures</Heading>
      {data.recentFailures.slice(0, 8).map((failure) => <Card key={`${failure.batchId}:${failure.recommendationId}:${failure.channelId ?? 'unknown'}`}>
        <Flex direction="column" gap="extra-small">
          <Flex direction="row" justify="between" align="center">
            <Text format={{ fontWeight: 'bold' }}>{failure.channelName}</Text>
            <StatusTag variant="danger">Failed</StatusTag>
          </Flex>
          <Text>Deal {failure.dealId} · recommendation {failure.recommendationId}</Text>
          <Text>{failure.error}</Text>
          <Text variant="microcopy">{channelLabel(failure.channelType)} · {failure.policyName ?? 'Manual follow-up'} · {formatDate(failure.occurredAt)}</Text>
        </Flex>
      </Card>)}
    </Flex>}

    <Card>
      <Flex direction="column" gap="extra-small">
        <Heading>Evidence coverage</Heading>
        <Text>{data.coverage.loadedAttempts} item rows · {data.coverage.loadedEvents} control events · {data.coverage.loadedDispatches} policy dispatches</Text>
        <Text>{data.coverage.completedAttemptPercent}% completed-attempt coverage · {data.coverage.channelEvidencePercent}% channel-result coverage</Text>
        {data.timeline.slice(-7).map((item) => <Text key={item.date} variant="microcopy">
          {item.date}: {item.deliveredItems}/{item.attemptedItems} delivered · {item.failedItems} failed · {item.escalationsQueued} escalated · {item.quietHourDeferrals} quiet deferrals
        </Text>)}
      </Flex>
    </Card>

    <Alert title="Interpretation boundary" variant="info">
      Notification transport success is not a deal outcome, recommendation quality score, buyer-intent signal or causal effect. Suppression counts are deduplicated operational observations. DealGuard does not modify CRM records through this report.
    </Alert>
  </Flex>;
}
