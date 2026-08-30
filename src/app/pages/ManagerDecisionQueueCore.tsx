import React, { useCallback, useEffect, useState } from 'react';
import {
  Alert,
  Button,
  Card,
  Divider,
  Flex,
  Heading,
  Link,
  LoadingSpinner,
  StatusTag,
  Text,
  hubspot,
} from '@hubspot/ui-extensions';
import { safeProductError } from './product-ui';

const API_BASE = 'https://dealguard-api.rokad.co/api/v1';
const QUEUE_LIMIT = 25;

type ManagerDecisionBand = 'act_now' | 'review' | 'monitor';
type DecisionEvidenceMode =
  | 'full_deal_brief'
  | 'aging_deal_brief'
  | 'stale_deal_brief'
  | 'readiness_only';
type QueueBandFilter = ManagerDecisionBand | 'all';
type QueueEvidenceFilter = DecisionEvidenceMode | 'all';

type DecisionQueueReason = {
  code: string;
  label: string;
  severity: 'critical' | 'warning' | 'info';
  dimension: string;
};

type DecisionQueueAction = {
  code: string;
  label: string;
  action: string;
  priority: 'high' | 'medium' | 'low';
  owner: 'deal_owner' | 'manager';
  dueAt: string | null;
  rationale: string;
  evidenceCodes: string[];
  source: 'deal_brief' | 'remediation' | 'readiness';
  overdue: boolean;
};

type DecisionQueueItem = {
  dealId: string;
  dealName: string;
  recordUrl: string;
  pipelineLabel: string | null;
  stageLabel: string | null;
  ownerId: string | null;
  teamId: string | null;
  regionCode: string | null;
  readinessScore: number;
  readinessStatus: 'ready' | 'at_risk' | 'critical';
  issueCount: number;
  stageAgeDays: number | null;
  assessedAt: string;
  priorityScore: number;
  band: ManagerDecisionBand;
  deterministicAttentionScore: number;
  actionUrgencyScore: number;
  commercialImportanceScore: number;
  evidenceReviewScore: number;
  evidenceMode: DecisionEvidenceMode;
  evidenceCoveragePercent: number;
  evidenceConfidence: 'high' | 'medium' | 'low';
  snapshotGeneratedAt: string | null;
  dealBriefStatus: 'on_track' | 'watch' | 'intervention_required' | 'insufficient_evidence' | null;
  amount: {
    value: number | null;
    basis: 'company_currency' | 'deal_currency' | 'unavailable';
    currencyCode: string | null;
    label: string;
    cohortPercentile: number | null;
    comparable: boolean;
  };
  nextAction: DecisionQueueAction | null;
  openRemediationCount: number;
  overdueRemediationCount: number;
  reasons: DecisionQueueReason[];
};

type ManagerDecisionQueue = {
  generatedAt: string;
  summary: {
    totalOpenDeals: number;
    returnedDeals: number;
    actNow: number;
    review: number;
    monitor: number;
    overdueActions: number;
    fullDealBriefDeals: number;
    readinessOnlyDeals: number;
    staleDealBriefDeals: number;
    fullDealBriefCoveragePercent: number;
    amountComparableDeals: number;
  };
  amountCohorts: Array<{
    basis: 'company_currency' | 'deal_currency';
    currencyCode: string | null;
    label: string;
    deals: number;
    totalAmount: number;
  }>;
  items: DecisionQueueItem[];
};

const BAND_OPTIONS: Array<{ value: QueueBandFilter; label: string }> = [
  { value: 'all', label: 'All priorities' },
  { value: 'act_now', label: 'Act now' },
  { value: 'review', label: 'Review' },
  { value: 'monitor', label: 'Monitor' },
];

const EVIDENCE_OPTIONS: Array<{ value: QueueEvidenceFilter; label: string }> = [
  { value: 'all', label: 'All evidence' },
  { value: 'full_deal_brief', label: 'Fresh Deal Brief' },
  { value: 'aging_deal_brief', label: 'Aging Deal Brief' },
  { value: 'stale_deal_brief', label: 'Stale Deal Brief' },
  { value: 'readiness_only', label: 'Readiness only' },
];

function bandVariant(band: ManagerDecisionBand): 'danger' | 'warning' | 'success' {
  if (band === 'act_now') return 'danger';
  if (band === 'review') return 'warning';
  return 'success';
}

function evidenceVariant(mode: DecisionEvidenceMode): 'success' | 'warning' | 'danger' | 'default' {
  if (mode === 'full_deal_brief') return 'success';
  if (mode === 'aging_deal_brief') return 'warning';
  if (mode === 'stale_deal_brief') return 'danger';
  return 'default';
}

function readinessVariant(status: DecisionQueueItem['readinessStatus']): 'success' | 'warning' | 'danger' {
  if (status === 'ready') return 'success';
  if (status === 'at_risk') return 'warning';
  return 'danger';
}

function actionVariant(priority: DecisionQueueAction['priority']): 'danger' | 'warning' | 'info' {
  if (priority === 'high') return 'danger';
  if (priority === 'medium') return 'warning';
  return 'info';
}

function reasonVariant(severity: DecisionQueueReason['severity']): 'danger' | 'warning' | 'default' {
  if (severity === 'critical') return 'danger';
  if (severity === 'warning') return 'warning';
  return 'default';
}

function evidenceLabel(mode: DecisionEvidenceMode): string {
  if (mode === 'full_deal_brief') return 'Fresh Deal Brief';
  if (mode === 'aging_deal_brief') return 'Aging Deal Brief';
  if (mode === 'stale_deal_brief') return 'Stale Deal Brief';
  return 'Readiness only';
}

function actionSourceLabel(source: DecisionQueueAction['source']): string {
  if (source === 'deal_brief') return 'Deal Brief';
  if (source === 'remediation') return 'Remediation';
  return 'Readiness';
}

function formatDate(value: string | null): string {
  return value ? new Date(value).toLocaleString() : 'No deadline recorded';
}

function compactNumber(value: number): string {
  return new Intl.NumberFormat('en', {
    maximumFractionDigits: Math.abs(value) >= 1_000 ? 0 : 1,
    notation: Math.abs(value) >= 1_000_000 ? 'compact' : 'standard',
  }).format(value);
}

function formatAmount(item: DecisionQueueItem): string {
  const value = item.amount.value;
  if (value === null) return 'Amount unavailable';
  if (item.amount.currencyCode && /^[A-Z]{3}$/.test(item.amount.currencyCode)) {
    try {
      return new Intl.NumberFormat('en', {
        style: 'currency',
        currency: item.amount.currencyCode,
        maximumFractionDigits: 0,
        notation: Math.abs(value) >= 1_000_000 ? 'compact' : 'standard',
      }).format(value);
    } catch {
      return `${item.amount.currencyCode} ${compactNumber(value)}`;
    }
  }
  return `${compactNumber(value)} ${item.amount.label}`;
}

function buildQueuePath(band: QueueBandFilter, evidence: QueueEvidenceFilter): string {
  const params = new URLSearchParams({ limit: String(QUEUE_LIMIT) });
  if (band !== 'all') params.set('band', band);
  if (evidence !== 'all') params.set('evidenceMode', evidence);
  return `/enterprise/decision-queue?${params.toString()}`;
}

export function ManagerDecisionQueuePanel({ enabled }: { enabled: boolean }) {
  const [queue, setQueue] = useState<ManagerDecisionQueue | null>(null);
  const [band, setBand] = useState<QueueBandFilter>('all');
  const [evidence, setEvidence] = useState<QueueEvidenceFilter>('all');
  const [loading, setLoading] = useState(enabled);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (manual = false) => {
    if (!enabled) return;
    if (manual) setRefreshing(true);
    else setLoading(true);
    setError(null);
    try {
      const response = await hubspot.fetch(`${API_BASE}${buildQueuePath(band, evidence)}`, {
        method: 'GET',
        timeout: 20_000,
      });
      const data = await response.json();
      if (!response.ok) {
        throw new Error(safeProductError(data?.error?.message, 'The Manager Decision Queue could not be loaded.'));
      }
      setQueue(data as ManagerDecisionQueue);
    } catch (caught) {
      setError(safeProductError(
        caught instanceof Error ? caught.message : null,
        'The Manager Decision Queue could not be loaded. Please try again.',
      ));
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [band, enabled, evidence]);

  useEffect(() => {
    if (!enabled) {
      setQueue(null);
      setLoading(false);
      return;
    }
    void load(false);
  }, [enabled, load]);

  if (!enabled) {
    return <Card>
      <Flex direction="column" gap="small">
        <Flex direction="row" justify="between" align="center">
          <Heading>Manager Decision Queue</Heading>
          <StatusTag variant="default">Enterprise</StatusTag>
        </Flex>
        <Text>Prioritise open deals by deterministic evidence, action urgency, comparable commercial value, and evidence quality.</Text>
        <Text variant="microcopy">The queue becomes available with Enterprise entitlement and respects assigned pipeline, team, owner, and region scope.</Text>
      </Flex>
    </Card>;
  }

  return <Flex direction="column" gap="medium">
    <Flex direction="row" justify="between" align="center" gap="medium">
      <Flex direction="column" gap="extra-small">
        <Heading>Manager Decision Queue</Heading>
        <Text>Review the deals that need intervention first, with one owned next action and the evidence behind the priority.</Text>
      </Flex>
      <Flex direction="row" gap="small" align="center">
        <StatusTag variant="success">Explainable</StatusTag>
        <Button variant="secondary" disabled={loading || refreshing} onClick={() => void load(true)}>
          {refreshing ? 'Refreshing…' : 'Refresh queue'}
        </Button>
      </Flex>
    </Flex>

    <Flex direction="column" gap="extra-small">
      <Text variant="microcopy">PRIORITY FILTER</Text>
      <Flex direction="row" gap="small" wrap="wrap">
        {BAND_OPTIONS.map((option) => <Button
          key={option.value}
          variant={band === option.value ? 'primary' : 'secondary'}
          disabled={loading || refreshing}
          onClick={() => setBand(option.value)}
        >{option.label}</Button>)}
      </Flex>
    </Flex>

    <Flex direction="column" gap="extra-small">
      <Text variant="microcopy">EVIDENCE FILTER</Text>
      <Flex direction="row" gap="small" wrap="wrap">
        {EVIDENCE_OPTIONS.map((option) => <Button
          key={option.value}
          variant={evidence === option.value ? 'primary' : 'secondary'}
          disabled={loading || refreshing}
          onClick={() => setEvidence(option.value)}
        >{option.label}</Button>)}
      </Flex>
    </Flex>

    {error && <Alert title="Manager Decision Queue unavailable" variant="danger">{error}</Alert>}
    {loading && <LoadingSpinner label="Loading Manager Decision Queue" />}

    {!loading && queue && <>
      <Flex direction="row" gap="medium" wrap="wrap">
        <Card>
          <Text variant="microcopy">ACT NOW</Text>
          <Heading>{queue.summary.actNow}</Heading>
          <StatusTag variant={queue.summary.actNow > 0 ? 'danger' : 'success'}>{queue.summary.actNow > 0 ? 'Intervention' : 'Clear'}</StatusTag>
        </Card>
        <Card>
          <Text variant="microcopy">REVIEW</Text>
          <Heading>{queue.summary.review}</Heading>
          <StatusTag variant={queue.summary.review > 0 ? 'warning' : 'success'}>{queue.summary.review > 0 ? 'Manager review' : 'Clear'}</StatusTag>
        </Card>
        <Card>
          <Text variant="microcopy">OVERDUE ACTIONS</Text>
          <Heading>{queue.summary.overdueActions}</Heading>
          <StatusTag variant={queue.summary.overdueActions > 0 ? 'danger' : 'success'}>{queue.summary.overdueActions > 0 ? 'Past due' : 'On time'}</StatusTag>
        </Card>
        <Card>
          <Text variant="microcopy">FULL DEAL BRIEF COVERAGE</Text>
          <Heading>{queue.summary.fullDealBriefCoveragePercent}%</Heading>
          <Text>{queue.summary.fullDealBriefDeals} of {queue.summary.totalOpenDeals} open deals</Text>
        </Card>
      </Flex>

      {(queue.summary.readinessOnlyDeals > 0 || queue.summary.staleDealBriefDeals > 0) && <Alert title="Some deals have limited portfolio evidence" variant="warning">
        {queue.summary.readinessOnlyDeals} deals are readiness-only and {queue.summary.staleDealBriefDeals} have stale Deal Brief evidence. Opening or refreshing a deal record captures a current bounded snapshot; missing evidence is not proof that a deal will be lost.
      </Alert>}

      {queue.amountCohorts.length > 0 && <Card>
        <Heading>Comparable amount cohorts</Heading>
        <Text>Commercial importance is ranked only within a safe currency cohort; currencies are never combined.</Text>
        {queue.amountCohorts.slice(0, 6).map((cohort) => <Text key={`${cohort.basis}:${cohort.label}`} variant="microcopy">
          • {cohort.label}: {cohort.deals} deals · {compactNumber(cohort.totalAmount)} recorded
        </Text>)}
      </Card>}

      {queue.items.length === 0
        ? <Alert title="No deals match the selected filters" variant="success">Change the priority or evidence filter to review another part of the open pipeline.</Alert>
        : <Flex direction="column" gap="small">
            <Text variant="microcopy">Showing {queue.items.length} ranked deals from {queue.summary.totalOpenDeals} current open deals · generated {formatDate(queue.generatedAt)}</Text>
            {queue.items.map((item, index) => <Card key={item.dealId}>
              <Flex direction="column" gap="small">
                <Flex direction="row" justify="between" align="center" gap="medium">
                  <Flex direction="column" gap="extra-small">
                    <Text variant="microcopy">#{index + 1} · DEAL {item.dealId}</Text>
                    <Heading>{item.dealName}</Heading>
                    <Text>{item.pipelineLabel ?? 'Pipeline unavailable'} · {item.stageLabel ?? 'Stage unavailable'}{item.ownerId ? ` · Owner ${item.ownerId}` : ' · Owner unassigned'}</Text>
                  </Flex>
                  <Flex direction="column" gap="extra-small">
                    <Heading>{item.priorityScore}/100</Heading>
                    <StatusTag variant={bandVariant(item.band)}>{item.band.replaceAll('_', ' ')}</StatusTag>
                  </Flex>
                </Flex>

                <Flex direction="row" gap="small" wrap="wrap">
                  <StatusTag variant={readinessVariant(item.readinessStatus)}>Readiness {item.readinessScore}/100</StatusTag>
                  <StatusTag variant={evidenceVariant(item.evidenceMode)}>{evidenceLabel(item.evidenceMode)}</StatusTag>
                  <StatusTag variant={item.evidenceConfidence === 'high' ? 'success' : item.evidenceConfidence === 'medium' ? 'warning' : 'default'}>{item.evidenceCoveragePercent}% evidence · {item.evidenceConfidence}</StatusTag>
                  {item.nextAction?.overdue && <StatusTag variant="danger">Action overdue</StatusTag>}
                  {item.overdueRemediationCount > 0 && <StatusTag variant="danger">{item.overdueRemediationCount} overdue remediation</StatusTag>}
                </Flex>

                <Flex direction="row" gap="large" wrap="wrap">
                  <Flex direction="column" gap="extra-small">
                    <Text variant="microcopy">COMMERCIAL CONTEXT</Text>
                    <Text>{formatAmount(item)}</Text>
                    <Text variant="microcopy">{item.amount.comparable && item.amount.cohortPercentile !== null
                      ? `Cohort percentile: ${item.amount.cohortPercentile}/100 within ${item.amount.label}`
                      : 'No safe comparable-currency percentile is available.'}</Text>
                  </Flex>
                  <Flex direction="column" gap="extra-small">
                    <Text variant="microcopy">PRIORITY COMPONENTS</Text>
                    <Text>Attention {item.deterministicAttentionScore} · urgency {item.actionUrgencyScore} · commercial {item.commercialImportanceScore} · evidence review {item.evidenceReviewScore}</Text>
                    <Text variant="microcopy">Stage age: {item.stageAgeDays === null ? 'unavailable' : `${Math.round(item.stageAgeDays)} days`} · {item.issueCount} readiness issues</Text>
                  </Flex>
                </Flex>

                {item.nextAction
                  ? <Alert title={item.nextAction.label} variant={actionVariant(item.nextAction.priority)}>
                      {item.nextAction.action} Owner: {item.nextAction.owner === 'manager' ? 'Sales manager' : 'Deal owner'}. {item.nextAction.overdue ? `Overdue since ${formatDate(item.nextAction.dueAt)}.` : `Due: ${formatDate(item.nextAction.dueAt)}.`} Source: {actionSourceLabel(item.nextAction.source)}. Why: {item.nextAction.rationale}
                    </Alert>
                  : <Alert title="No owned next action is recorded" variant="warning">Review the deal and create a dated next action before relying on this opportunity in a management decision.</Alert>}

                {item.reasons.length > 0 && <>
                  <Divider />
                  <Flex direction="column" gap="extra-small">
                    <Text format={{ fontWeight: 'bold' }}>Why this deal is prioritised</Text>
                    {item.reasons.slice(0, 5).map((reason) => <Flex key={reason.code} direction="row" gap="small" align="center">
                      <StatusTag variant={reasonVariant(reason.severity)}>{reason.dimension.replaceAll('_', ' ')}</StatusTag>
                      <Text>{reason.label}</Text>
                    </Flex>)}
                  </Flex>
                </>}

                <Flex direction="row" justify="between" align="center" gap="small">
                  <Text variant="microcopy">Assessment: {formatDate(item.assessedAt)} · {item.openRemediationCount} open remediations</Text>
                  <Link href={{ url: item.recordUrl, external: true }}>Open deal record</Link>
                </Flex>
              </Flex>
            </Card>)}
          </Flex>}

      <Alert title="How to read this queue" variant="info">
        Priority combines deterministic Deal Brief or readiness evidence, action urgency, comparable-currency commercial importance, and evidence quality. It is not buyer intent, a forecast category, a win probability, or expected financial loss.
      </Alert>
    </>}
  </Flex>;
}
