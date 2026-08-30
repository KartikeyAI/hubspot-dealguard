import React, { useCallback, useEffect, useState } from 'react';
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
const WINDOW_OPTIONS = [30, 90, 180] as const;
type OutcomeWindow = typeof WINDOW_OPTIONS[number];
type RecommendationStatus = 'presented' | 'accepted' | 'completed' | 'dismissed' | 'expired' | 'superseded';
type ObservedProgress = 'improved' | 'mixed' | 'unchanged' | 'worsened' | 'insufficient_evidence';

type RecommendationOutcome = {
  evaluationStatus: 'pending' | 'observed' | 'insufficient_evidence';
  observedProgress: ObservedProgress | null;
  observationAssessmentAt: string | null;
  readinessDelta: number | null;
  attentionDelta: number | null;
  stageChanged: boolean | null;
  closeDateDeltaDays: number | null;
  explanation: string | null;
  causalAttribution: false;
};

type Recommendation = {
  id: string;
  dealId: string;
  recommendationCode: string;
  label: string;
  action: string;
  dimension: string;
  priority: 'high' | 'medium' | 'low';
  owner: 'deal_owner' | 'manager';
  dueAt: string | null;
  rationale: string;
  status: RecommendationStatus;
  terminalReason: string | null;
  presentedAt: string;
  acceptedAt: string | null;
  completedAt: string | null;
  dismissedAt: string | null;
  expiredAt: string | null;
  supersededAt: string | null;
  dismissalReason: string | null;
  overdue: boolean;
  current: boolean;
  outcome: RecommendationOutcome | null;
};

type RecommendationAnalytics = {
  generatedAt: string;
  window: { days: number; start: string; end: string };
  summary: {
    presented: number;
    accepted: number;
    completed: number;
    dismissed: number;
    expired: number;
    superseded: number;
    overdueAccepted: number;
    acceptanceRatePercent: number;
    completionRatePercent: number;
    medianHoursToAccept: number | null;
    medianHoursToComplete: number | null;
  };
  observedOutcomes: {
    total: number;
    improved: number;
    mixed: number;
    unchanged: number;
    worsened: number;
    insufficientEvidence: number;
    improvedSharePercent: number;
  };
  byRecommendation: Array<{
    code: string;
    label: string;
    presented: number;
    accepted: number;
    completed: number;
    dismissed: number;
    expired: number;
    observed: number;
    improved: number;
  }>;
  recent: Recommendation[];
  semantics: {
    observationalOnly: true;
    causalAttribution: false;
    completionDoesNotProveImpact: true;
    missingEvidenceDoesNotMeanFailure: true;
  };
};

function statusVariant(status: RecommendationStatus): 'success' | 'warning' | 'danger' | 'default' {
  if (status === 'completed') return 'success';
  if (status === 'accepted') return 'warning';
  if (status === 'expired') return 'danger';
  return 'default';
}

function progressVariant(progress: ObservedProgress): 'success' | 'warning' | 'danger' | 'default' {
  if (progress === 'improved') return 'success';
  if (progress === 'mixed') return 'warning';
  if (progress === 'worsened') return 'danger';
  return 'default';
}

function formatDate(value: string | null | undefined): string {
  return value ? new Date(value).toLocaleString() : 'Not available';
}

function formatHours(value: number | null): string {
  if (value === null) return 'Not observed';
  if (value < 1) return 'Under 1 hour';
  if (value < 24) return `${Math.round(value * 10) / 10} hours`;
  const days = value / 24;
  return `${Math.round(days * 10) / 10} days`;
}

function signed(value: number | null): string {
  if (value === null) return 'not comparable';
  return `${value > 0 ? '+' : ''}${value}`;
}

function percentage(numerator: number, denominator: number): number {
  return denominator > 0 ? Math.round(numerator / denominator * 100) : 0;
}

function label(value: string): string {
  return value.replaceAll('_', ' ');
}

export function RecommendationOutcomePanel({ enabled }: { enabled: boolean }) {
  const [windowDays, setWindowDays] = useState<OutcomeWindow>(90);
  const [analytics, setAnalytics] = useState<RecommendationAnalytics | null>(null);
  const [loading, setLoading] = useState(enabled);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (manual = false) => {
    if (!enabled) return;
    if (manual) setRefreshing(true);
    else setLoading(true);
    setError(null);
    try {
      const response = await hubspot.fetch(`${API_BASE}/enterprise/recommendation-outcomes?days=${windowDays}`, {
        method: 'GET',
        timeout: 15_000,
      });
      const data = await response.json();
      if (!response.ok) {
        throw new Error(safeProductError(
          data?.error?.message,
          'Recommendation outcome analytics could not be loaded.',
        ));
      }
      setAnalytics(data as RecommendationAnalytics);
    } catch (caught) {
      setError(safeProductError(
        caught instanceof Error ? caught.message : null,
        'Recommendation outcome analytics could not be loaded. Please try again.',
      ));
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [enabled, windowDays]);

  useEffect(() => {
    if (!enabled) {
      setAnalytics(null);
      setLoading(false);
      return;
    }
    void load(false);
  }, [enabled, load]);

  if (!enabled) {
    return <Card>
      <Flex direction="column" gap="small">
        <Flex direction="row" justify="between" align="center">
          <Heading>Recommendation adoption & outcomes</Heading>
          <StatusTag variant="default">Enterprise</StatusTag>
        </Flex>
        <Text>Measure which evidence-backed recommendations are accepted, completed, dismissed, overdue, or followed by later deterministic evidence.</Text>
        <Text variant="microcopy">The product remains useful without this analytics surface; Enterprise adds governed lifecycle measurement and portfolio review.</Text>
      </Flex>
    </Card>;
  }

  const summary = analytics?.summary;
  const observed = analytics?.observedOutcomes;
  const recent = analytics?.recent.slice(0, 6) ?? [];

  return <Flex direction="column" gap="medium">
    <Flex direction="row" justify="between" align="center" gap="medium">
      <Flex direction="column" gap="extra-small">
        <Heading>Recommendation adoption & outcomes</Heading>
        <Text>See whether teams act on DealGuard recommendations and what later deterministic evidence was observed after completion.</Text>
      </Flex>
      <Flex direction="row" gap="small" align="center">
        <StatusTag variant="default">Observed, not causal</StatusTag>
        <Button variant="secondary" disabled={loading || refreshing} onClick={() => void load(true)}>
          {refreshing ? 'Refreshing…' : 'Refresh outcomes'}
        </Button>
      </Flex>
    </Flex>

    <Flex direction="column" gap="extra-small">
      <Text variant="microcopy">ANALYSIS WINDOW</Text>
      <Flex direction="row" gap="small" wrap="wrap">
        {WINDOW_OPTIONS.map((days) => <Button
          key={days}
          variant={windowDays === days ? 'primary' : 'secondary'}
          disabled={loading || refreshing}
          onClick={() => setWindowDays(days)}
        >{days} days</Button>)}
      </Flex>
    </Flex>

    {error && <Alert title="Recommendation outcome analytics unavailable" variant="danger">{error}</Alert>}
    {loading && <LoadingSpinner label="Loading recommendation outcome analytics" />}

    {!loading && analytics && summary && observed && <>
      <Flex direction="row" gap="medium" wrap="wrap">
        <Card>
          <Text variant="microcopy">ACCEPTANCE RATE</Text>
          <Heading>{summary.acceptanceRatePercent}%</Heading>
          <Text>{summary.accepted} of {summary.presented} presented</Text>
          <Text variant="microcopy">Median time to accept: {formatHours(summary.medianHoursToAccept)}</Text>
        </Card>
        <Card>
          <Text variant="microcopy">COMPLETION RATE</Text>
          <Heading>{summary.completionRatePercent}%</Heading>
          <Text>{summary.completed} of {summary.presented} presented</Text>
          <Text variant="microcopy">Median time to complete: {formatHours(summary.medianHoursToComplete)}</Text>
        </Card>
        <Card>
          <Text variant="microcopy">OVERDUE ACCEPTED</Text>
          <Heading>{summary.overdueAccepted}</Heading>
          <StatusTag variant={summary.overdueAccepted > 0 ? 'danger' : 'success'}>{summary.overdueAccepted > 0 ? 'Follow up' : 'On time'}</StatusTag>
        </Card>
        <Card>
          <Text variant="microcopy">OBSERVED OUTCOMES</Text>
          <Heading>{observed.total}</Heading>
          <Text>{observed.improvedSharePercent}% with later improved evidence</Text>
          <Text variant="microcopy">This share is observational and does not establish causation.</Text>
        </Card>
      </Flex>

      {summary.presented === 0
        ? <Alert title="No tracked recommendation history yet" variant="info">
            DealGuard begins tracking after a final enriched Deal Brief presents a next action. Refresh selected deal records after the recommendation-outcome migration and Worker release are deployed.
          </Alert>
        : <Flex direction="row" gap="small" wrap="wrap">
            <StatusTag variant="success">{summary.completed} completed</StatusTag>
            <StatusTag variant="warning">{summary.dismissed} dismissed</StatusTag>
            <StatusTag variant="danger">{summary.expired} expired</StatusTag>
            <StatusTag variant="default">{summary.superseded} superseded</StatusTag>
          </Flex>}

      {observed.total > 0 && <Flex direction="column" gap="small">
        <Heading>Later observed evidence</Heading>
        <Flex direction="row" gap="medium" wrap="wrap">
          <Card>
            <Text variant="microcopy">IMPROVED EVIDENCE</Text>
            <Heading>{observed.improved}</Heading>
            <StatusTag variant="success">Observed association</StatusTag>
          </Card>
          <Card>
            <Text variant="microcopy">MIXED EVIDENCE</Text>
            <Heading>{observed.mixed}</Heading>
            <StatusTag variant="warning">Two-sided evidence</StatusTag>
          </Card>
          <Card>
            <Text variant="microcopy">UNCHANGED</Text>
            <Heading>{observed.unchanged}</Heading>
            <StatusTag variant="default">No material direction</StatusTag>
          </Card>
          <Card>
            <Text variant="microcopy">WORSENED EVIDENCE</Text>
            <Heading>{observed.worsened}</Heading>
            <StatusTag variant={observed.worsened > 0 ? 'danger' : 'success'}>{observed.worsened > 0 ? 'Review context' : 'None observed'}</StatusTag>
          </Card>
          <Card>
            <Text variant="microcopy">INSUFFICIENT EVIDENCE</Text>
            <Heading>{observed.insufficientEvidence}</Heading>
            <StatusTag variant="default">No conclusion</StatusTag>
          </Card>
        </Flex>
      </Flex>}

      {analytics.byRecommendation.length > 0 && <Flex direction="column" gap="small">
        <Heading>Recommendation adoption</Heading>
        <Text>Compare action rates by deterministic recommendation type; dismissal and low adoption require customer-context review rather than an automatic quality verdict.</Text>
        {analytics.byRecommendation.slice(0, 6).map((item) => <Card key={item.code}>
          <Flex direction="column" gap="extra-small">
            <Flex direction="row" justify="between" align="center" gap="small">
              <Text format={{ fontWeight: 'bold' }}>{item.label}</Text>
              <StatusTag variant={percentage(item.accepted, item.presented) >= 60 ? 'success' : 'warning'}>
                {percentage(item.accepted, item.presented)}% accepted
              </StatusTag>
            </Flex>
            <Text>{item.presented} presented · {item.accepted} accepted · {item.completed} completed</Text>
            <Text variant="microcopy">{item.dismissed} dismissed · {item.expired} expired · {item.observed} later observations · {item.improved} with improved evidence</Text>
          </Flex>
        </Card>)}
      </Flex>}

      {recent.length > 0 && <Flex direction="column" gap="small">
        <Divider />
        <Heading>Recent recommendation evidence</Heading>
        {recent.map((item) => <Card key={item.id}>
          <Flex direction="column" gap="extra-small">
            <Flex direction="row" justify="between" align="center" gap="small">
              <Flex direction="column" gap="extra-small">
                <Text variant="microcopy">DEAL {item.dealId} · {item.dimension.replaceAll('_', ' ')}</Text>
                <Text format={{ fontWeight: 'bold' }}>{item.label}</Text>
              </Flex>
              <Flex direction="row" gap="extra-small" wrap="wrap">
                <StatusTag variant={statusVariant(item.status)}>{label(item.status)}</StatusTag>
                {item.overdue && <StatusTag variant="danger">Overdue</StatusTag>}
                {item.current && <StatusTag variant="success">Current</StatusTag>}
              </Flex>
            </Flex>
            <Text>{item.action}</Text>
            <Text variant="microcopy">Presented {formatDate(item.presentedAt)}{item.completedAt ? ` · Completed ${formatDate(item.completedAt)}` : ''}</Text>
            {item.dismissalReason && <Text variant="microcopy">Dismissal reason: {item.dismissalReason}</Text>}
            {item.outcome?.evaluationStatus === 'pending' && <Alert title="Awaiting later evidence" variant="info">
              Completion is recorded, but DealGuard will not infer impact until a later Deal Brief provides comparable evidence.
            </Alert>}
            {item.outcome?.observedProgress && <Alert
              title={`Observed ${label(item.outcome.observedProgress)}`}
              variant={progressVariant(item.outcome.observedProgress)}
            >
              {item.outcome.explanation ?? 'Later deterministic evidence was observed.'} Readiness delta: {signed(item.outcome.readinessDelta)}. Attention delta: {signed(item.outcome.attentionDelta)}. Stage identifier changed: {item.outcome.stageChanged === null ? 'not comparable' : item.outcome.stageChanged ? 'yes' : 'no'}.
            </Alert>}
          </Flex>
        </Card>)}
      </Flex>}

      <Alert title="Observed association only" variant="info">
        Recommendation completion does not prove impact, and missing evidence does not mean success or failure. DealGuard does not convert these observations into buyer intent, win probability, forecast category, expected revenue, or expected loss.
      </Alert>
      <Text variant="microcopy">Generated {formatDate(analytics.generatedAt)} for {analytics.window.days} days.</Text>
    </>}
  </Flex>;
}
