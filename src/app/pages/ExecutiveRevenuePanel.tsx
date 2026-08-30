import React, { useCallback, useState } from 'react';
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
const CANDIDATE_LIMIT = 10;
const DAY_MS = 86_400_000;

type Json = Record<string, any>;
type PeriodPreset = 'current_quarter' | 'next_quarter' | 'next_90_days';
type Confidence = 'high' | 'medium' | 'low';
type Movement = 'established' | 'directional' | 'baseline_only';
type Candidate = Json & {
  dealId: string;
  dealName: string;
  recordUrl: string;
  kind: 'slippage_review' | 'pull_in_review';
  priorityScore: number;
  evidenceConfidence: Confidence;
  reasons: Array<Json & { code: string; label: string; severity: 'critical' | 'warning' | 'info'; dimension: string }>;
};
type ExecutiveView = Json & {
  generatedAt: string;
  period: { start: string; end: string };
  source: Json & { truncated: boolean; loadedDeals: number; maxDeals: number; comparisonSnapshotDate: string | null };
  summary: Json;
  coverage: Json;
  confidence: { level: Confidence; score: number; movement: Movement; explanation: string };
  amountCohorts: Json[];
  movement: Json & { status: Movement; amountCohorts: Json[] };
  concentration: Json[];
  slippageReviewCandidates: Candidate[];
  pullInReviewCandidates: Candidate[];
};

const PERIOD_OPTIONS: Array<{ value: PeriodPreset; label: string }> = [
  { value: 'current_quarter', label: 'Current quarter' },
  { value: 'next_quarter', label: 'Next quarter' },
  { value: 'next_90_days', label: 'Next 90 days' },
];

const FORECAST_LABELS: Record<string, string> = {
  commit: 'Commit', best_case: 'Best case', pipeline: 'Pipeline',
  not_forecasted: 'Not forecasted', closed_won: 'Closed won',
  custom: 'Custom category', unavailable: 'Unavailable',
};

function quarterRange(offset: number): { start: string; end: string } {
  const now = new Date();
  const month = Math.floor(now.getUTCMonth() / 3) * 3 + offset * 3;
  const start = new Date(Date.UTC(now.getUTCFullYear(), month, 1));
  const end = new Date(Date.UTC(now.getUTCFullYear(), month + 3, 1) - 1);
  return { start: start.toISOString().slice(0, 10), end: end.toISOString().slice(0, 10) };
}

function periodParams(preset: PeriodPreset): { start: string; end: string } | null {
  if (preset === 'current_quarter') return null;
  if (preset === 'next_quarter') return quarterRange(1);
  const start = new Date();
  const end = new Date(start.getTime() + 89 * DAY_MS);
  return { start: start.toISOString().slice(0, 10), end: end.toISOString().slice(0, 10) };
}

function buildPath(preset: PeriodPreset, refresh: boolean): string {
  const params = new URLSearchParams({ candidateLimit: String(CANDIDATE_LIMIT) });
  const period = periodParams(preset);
  if (period) {
    params.set('periodStart', period.start);
    params.set('periodEnd', period.end);
  }
  if (refresh) params.set('refresh', 'true');
  return `/enterprise/executive-revenue?${params.toString()}`;
}

function compact(value: number): string {
  return new Intl.NumberFormat('en', {
    maximumFractionDigits: Math.abs(value) >= 1_000 ? 0 : 1,
    notation: Math.abs(value) >= 1_000_000 ? 'compact' : 'standard',
  }).format(value);
}

function money(value: number | null, code: string | null, label: string): string {
  if (value === null || !Number.isFinite(value)) return 'Amount unavailable';
  if (code && /^[A-Z]{3}$/.test(code)) {
    try {
      return new Intl.NumberFormat('en', {
        style: 'currency', currency: code, maximumFractionDigits: 0,
        notation: Math.abs(value) >= 1_000_000 ? 'compact' : 'standard',
      }).format(value);
    } catch {
      return `${code} ${compact(value)}`;
    }
  }
  return `${compact(value)} ${label}`;
}

function date(value: string | null): string {
  return value ? new Date(value).toLocaleDateString() : 'Not available';
}

function dateTime(value: string | null): string {
  return value ? new Date(value).toLocaleString() : 'Not available';
}

function confidenceVariant(value: Confidence): 'success' | 'warning' | 'danger' {
  return value === 'high' ? 'success' : value === 'medium' ? 'warning' : 'danger';
}

function movementVariant(value: Movement): 'success' | 'warning' | 'default' {
  return value === 'established' ? 'success' : value === 'directional' ? 'warning' : 'default';
}

function readinessVariant(value: string | null): 'success' | 'warning' | 'danger' | 'default' {
  return value === 'ready' ? 'success' : value === 'at_risk' ? 'warning' : value === 'critical' ? 'danger' : 'default';
}

function reasonVariant(value: string): 'danger' | 'warning' | 'default' {
  return value === 'critical' ? 'danger' : value === 'warning' ? 'warning' : 'default';
}

function concentrationVariant(value: string): 'danger' | 'warning' | 'success' | 'default' {
  return value === 'concentrated' ? 'danger' : value === 'watch' ? 'warning' : value === 'diversified' ? 'success' : 'default';
}

function CandidateList({ title, description, items }: { title: string; description: string; items: Candidate[] }) {
  return <Flex direction="column" gap="small">
    <Flex direction="column" gap="extra-small"><Heading>{title}</Heading><Text>{description}</Text></Flex>
    {items.length === 0
      ? <Alert title="No candidates in this review queue" variant="success">The current deterministic criteria did not identify a deal for this review queue.</Alert>
      : items.map((item, index) => <Card key={`${item.kind}:${item.dealId}`}>
          <Flex direction="column" gap="small">
            <Flex direction="row" justify="between" align="center" gap="medium">
              <Flex direction="column" gap="extra-small">
                <Text variant="microcopy">#{index + 1} · DEAL {item.dealId}</Text>
                <Heading>{item.dealName}</Heading>
                <Text>{item.pipelineLabel ?? 'Pipeline unavailable'} · {item.stageLabel ?? 'Stage unavailable'}{item.ownerId ? ` · Owner ${item.ownerId}` : ' · Owner unassigned'}</Text>
              </Flex>
              <Flex direction="column" gap="extra-small">
                <Heading>{item.priorityScore}/100</Heading>
                <StatusTag variant={item.kind === 'slippage_review' ? 'danger' : 'success'}>{item.kind === 'slippage_review' ? 'Slippage review' : 'Pull-in review'}</StatusTag>
              </Flex>
            </Flex>
            <Flex direction="row" gap="small" wrap="wrap">
              <StatusTag variant={readinessVariant(item.readinessStatus)}>Readiness {item.readinessScore ?? '—'}/100</StatusTag>
              <StatusTag variant={confidenceVariant(item.evidenceConfidence)}>{item.evidenceConfidence} evidence confidence</StatusTag>
              <StatusTag variant="default">Recorded forecast: {FORECAST_LABELS[item.forecastCategory] ?? item.forecastCategory}</StatusTag>
              {item.decisionStatus ? <StatusTag variant={item.decisionStatus === 'intervention_required' ? 'danger' : item.decisionStatus === 'watch' ? 'warning' : 'success'}>{item.decisionStatus.replaceAll('_', ' ')}</StatusTag> : null}
            </Flex>
            <Flex direction="row" gap="large" wrap="wrap">
              <Flex direction="column" gap="extra-small">
                <Text variant="microcopy">RECORDED CLOSE DATE</Text>
                <Text>{date(item.currentCloseDate)}</Text>
                <Text variant="microcopy">Previous: {date(item.previousCloseDate)}{item.closeDateDeltaDays === null ? '' : ` · ${item.closeDateDeltaDays > 0 ? '+' : ''}${Math.round(item.closeDateDeltaDays)} days`}</Text>
              </Flex>
              <Flex direction="column" gap="extra-small">
                <Text variant="microcopy">COMMERCIAL CONTEXT</Text>
                <Text>{money(item.amount.value, item.amount.currencyCode, item.amount.label)}</Text>
                <Text variant="microcopy">{item.amount.comparable ? `Comparable within ${item.amount.label}` : 'No safe comparable-currency cohort'}</Text>
              </Flex>
            </Flex>
            {item.reasons.length > 0 ? <>
              <Divider />
              <Text format={{ fontWeight: 'bold' }}>Why this deal is listed</Text>
              {item.reasons.slice(0, 6).map((reason) => <Flex key={reason.code} direction="row" gap="small" align="center">
                <StatusTag variant={reasonVariant(reason.severity)}>{reason.dimension.replaceAll('_', ' ')}</StatusTag><Text>{reason.label}</Text>
              </Flex>)}
            </> : null}
            <Flex direction="row" justify="between" align="center">
              <Text variant="microcopy">This is a deterministic review prompt, not a prediction.</Text>
              <Link href={{ url: item.recordUrl, external: true }}>Open deal record</Link>
            </Flex>
          </Flex>
        </Card>)}
  </Flex>;
}

export function ExecutiveRevenuePanel({ enabled }: { enabled: boolean }) {
  const [view, setView] = useState<ExecutiveView | null>(null);
  const [preset, setPreset] = useState<PeriodPreset>('current_quarter');
  const [loadedPreset, setLoadedPreset] = useState<PeriodPreset | null>(null);
  const [loading, setLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (refresh = false) => {
    if (!enabled) return;
    if (refresh) setRefreshing(true); else setLoading(true);
    setError(null);
    try {
      const response = await hubspot.fetch(`${API_BASE}${buildPath(preset, refresh)}`, { method: 'GET', timeout: 30_000 });
      const data = await response.json();
      if (!response.ok) throw new Error(safeProductError(data?.error?.message, 'The Executive Revenue View could not be loaded.'));
      setView(data as ExecutiveView);
      setLoadedPreset(preset);
    } catch (caught) {
      setError(safeProductError(caught instanceof Error ? caught.message : null, 'The Executive Revenue View could not be loaded. Please try again.'));
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [enabled, preset]);

  if (!enabled) {
    return <Card><Flex direction="column" gap="small">
      <Flex direction="row" justify="between" align="center"><Heading>Executive Revenue View</Heading><StatusTag variant="default">Enterprise</StatusTag></Flex>
      <Text>Review recorded period coverage, movement, slippage and pull-in prompts, concentration, and evidence confidence without mixing currencies.</Text>
      <Text variant="microcopy">The live view requires Enterprise entitlement and respects assigned pipeline, team, owner, and region scope.</Text>
    </Flex></Card>;
  }

  return <Flex direction="column" gap="medium">
    <Flex direction="row" justify="between" align="center" gap="medium">
      <Flex direction="column" gap="extra-small">
        <Heading>Executive Revenue View</Heading>
        <Text>Inspect recorded period coverage and portfolio movement using current CRM state, deterministic DealGuard evidence, and safe currency cohorts.</Text>
      </Flex>
      <Flex direction="row" gap="small" align="center">
        <StatusTag variant="success">Recorded evidence</StatusTag>
        <Button variant="secondary" disabled={loading || refreshing} onClick={() => void load(view !== null && loadedPreset === preset)}>
          {loading ? 'Loading…' : refreshing ? 'Refreshing…' : view !== null && loadedPreset === preset ? 'Refresh view' : 'Load period'}
        </Button>
      </Flex>
    </Flex>

    <Flex direction="column" gap="extra-small">
      <Text variant="microcopy">REPORTING PERIOD</Text>
      <Flex direction="row" gap="small" wrap="wrap">
        {PERIOD_OPTIONS.map((option) => <Button key={option.value} variant={preset === option.value ? 'primary' : 'secondary'} disabled={loading || refreshing} onClick={() => setPreset(option.value)}>{option.label}</Button>)}
      </Flex>
    </Flex>

    {error ? <Alert title="Executive Revenue View unavailable" variant="danger">{error}</Alert> : null}
    {view !== null && loadedPreset !== preset ? <Alert title="Reporting period changed" variant="info">Load the selected period to replace the currently displayed executive evidence.</Alert> : null}
    {loading ? <LoadingSpinner label="Loading Executive Revenue View" /> : null}
    {!loading && view === null ? <Alert title="Load executive evidence when needed" variant="info">This view performs a bounded current-deal read. It is loaded on demand so opening App Home does not automatically consume a large HubSpot API budget.</Alert> : null}

    {!loading && view ? <>
      {view.source.truncated ? <Alert title="The current deal source is bounded" variant="warning">DealGuard loaded {view.source.loadedDeals} deals, reaching the plan limit of {view.source.maxDeals}. Counts and movement may exclude older records outside that bound.</Alert> : null}

      <Flex direction="row" gap="medium" wrap="wrap">
        <Card><Text variant="microcopy">PERIOD DEALS</Text><Heading>{view.summary.periodDeals}</Heading><Text>{view.summary.totalOpenDeals} open · {date(view.period.start)} – {date(view.period.end)}</Text></Card>
        <Card><Text variant="microcopy">RECORDED COMMIT</Text><Heading>{view.summary.recordedCommitDeals}</Heading><Text>{view.summary.recordedBestCaseDeals} recorded Best case</Text></Card>
        <Card><Text variant="microcopy">OVERDUE CLOSE DATES</Text><Heading>{view.summary.overdueCloseDeals}</Heading><StatusTag variant={view.summary.overdueCloseDeals > 0 ? 'danger' : 'success'}>{view.summary.overdueCloseDeals > 0 ? 'Review' : 'Clear'}</StatusTag></Card>
        <Card><Text variant="microcopy">SLIPPAGE REVIEW</Text><Heading>{view.summary.slippageReviewDeals}</Heading><StatusTag variant={view.summary.slippageReviewDeals > 0 ? 'warning' : 'success'}>{view.summary.slippageReviewDeals > 0 ? 'Review prompts' : 'Clear'}</StatusTag></Card>
        <Card><Text variant="microcopy">PULL-IN REVIEW</Text><Heading>{view.summary.pullInReviewDeals}</Heading><StatusTag variant={view.summary.pullInReviewDeals > 0 ? 'success' : 'default'}>{view.summary.pullInReviewDeals > 0 ? 'Candidates' : 'None'}</StatusTag></Card>
        <Card><Text variant="microcopy">EVIDENCE CONFIDENCE</Text><Heading>{view.confidence.score}/100</Heading><StatusTag variant={confidenceVariant(view.confidence.level)}>{view.confidence.level}</StatusTag></Card>
      </Flex>

      <Alert title="Evidence confidence" variant={view.confidence.level === 'low' ? 'warning' : 'info'}>{view.confidence.explanation} Movement: {view.confidence.movement.replaceAll('_', ' ')}. Generated {dateTime(view.generatedAt)}.</Alert>

      <Flex direction="column" gap="small">
        <Heading>Currency-safe period coverage</Heading>
        <Text>Amounts are shown only in HubSpot company currency or within one known original deal currency. Different currencies are never combined.</Text>
        {view.amountCohorts.length === 0
          ? <Alert title="Comparable amount cohorts are unavailable" variant="warning">Complete deal currency or company-currency amount data before relying on portfolio amount totals.</Alert>
          : <Flex direction="row" gap="medium" wrap="wrap">{view.amountCohorts.slice(0, 6).map((cohort) => <Card key={cohort.key}>
              <Flex direction="column" gap="extra-small">
                <Flex direction="row" justify="between" align="center"><Heading>{cohort.label}</Heading><StatusTag variant={cohort.periodPipelineCoveragePercent >= 75 ? 'success' : cohort.periodPipelineCoveragePercent >= 50 ? 'warning' : 'default'}>{cohort.periodPipelineCoveragePercent}% in period</StatusTag></Flex>
                <Text>Open: {money(cohort.openAmount, cohort.currencyCode, cohort.label)}</Text>
                <Text>Recorded in period: {money(cohort.periodAmount, cohort.currencyCode, cohort.label)}</Text>
                <Text variant="microcopy">Overdue: {money(cohort.overdueAmount, cohort.currencyCode, cohort.label)} · undated: {money(cohort.undatedAmount, cohort.currencyCode, cohort.label)}</Text>
                <Divider />
                {cohort.categories.slice(0, 4).map((category: Json) => <Text key={`${cohort.key}:${category.category}`} variant="microcopy">{category.label}: {category.deals} deals · {money(category.amount, cohort.currencyCode, cohort.label)}</Text>)}
              </Flex>
            </Card>)}</Flex>}
      </Flex>

      <Flex direction="column" gap="small">
        <Flex direction="row" justify="between" align="center">
          <Flex direction="column" gap="extra-small"><Heading>Recorded movement</Heading><Text>Changes are compared with the latest stored daily executive snapshot before today.</Text></Flex>
          <StatusTag variant={movementVariant(view.movement.status)}>{view.movement.status.replaceAll('_', ' ')}</StatusTag>
        </Flex>
        {view.movement.status === 'baseline_only'
          ? <Alert title="Movement baseline established" variant="info">This is the first stored executive snapshot. A later request can compare recorded close dates, stages, amounts, and forecast categories against this baseline.</Alert>
          : <Flex direction="row" gap="medium" wrap="wrap">
              <Card><Text variant="microcopy">CLOSE-DATE PUSHES</Text><Heading>{view.movement.closeDatePushedDeals}</Heading><Text>{view.movement.closeDatePulledInDeals} pull-ins</Text></Card>
              <Card><Text variant="microcopy">PERIOD EXITS</Text><Heading>{view.movement.periodExitDeals}</Heading><Text>{view.movement.periodEntryDeals} entries</Text></Card>
              <Card><Text variant="microcopy">FORECAST DOWNGRADES</Text><Heading>{view.movement.forecastDowngradedDeals}</Heading><Text>{view.movement.forecastUpgradedDeals} upgrades</Text></Card>
              <Card><Text variant="microcopy">STAGE CHANGES</Text><Heading>{view.movement.stageChangedDeals}</Heading><Text>{view.movement.comparisonDeals} comparable deals</Text></Card>
              <Card><Text variant="microcopy">AMOUNT CHANGES</Text><Heading>{view.movement.amountIncreasedDeals + view.movement.amountDecreasedDeals}</Heading><Text>{view.movement.amountIncreasedDeals} increased · {view.movement.amountDecreasedDeals} decreased</Text></Card>
            </Flex>}
        {view.movement.amountCohorts.length > 0 ? <Flex direction="row" gap="medium" wrap="wrap">{view.movement.amountCohorts.slice(0, 6).map((cohort: Json) => <Card key={cohort.key}>
          <Heading>{cohort.label} movement</Heading>
          <Text variant="microcopy">Moved out: {money(cohort.periodExitAmount, cohort.currencyCode, cohort.label)}</Text>
          <Text variant="microcopy">Moved in: {money(cohort.periodEntryAmount, cohort.currencyCode, cohort.label)}</Text>
          <Text variant="microcopy">Pushed: {money(cohort.closeDatePushAmount, cohort.currencyCode, cohort.label)}</Text>
          <Text variant="microcopy">Pulled in: {money(cohort.closeDatePullInAmount, cohort.currencyCode, cohort.label)}</Text>
        </Card>)}</Flex> : null}
      </Flex>

      <CandidateList title="Slippage review" description="Deals with overdue dates, material pushes, period exits, or recorded forecast downgrades. These are review prompts, not predictions." items={view.slippageReviewCandidates} />
      <CandidateList title="Pull-in review" description="Strong deals recorded just beyond the period boundary that may merit management review. Inclusion does not predict an early close." items={view.pullInReviewCandidates} />

      <Flex direction="column" gap="small">
        <Heading>Portfolio concentration</Heading><Text>Concentration is calculated only inside one comparable currency cohort.</Text>
        {view.concentration.length === 0
          ? <Alert title="Concentration is unavailable" variant="warning">Comparable positive deal amounts are required before concentration can be assessed.</Alert>
          : view.concentration.slice(0, 4).map((cohort: Json) => <Card key={cohort.key}><Flex direction="column" gap="small">
              <Flex direction="row" justify="between" align="center"><Heading>{cohort.label}</Heading><Text>{money(cohort.totalAmount, cohort.currencyCode, cohort.label)}</Text></Flex>
              {cohort.dimensions.map((dimension: Json) => <Flex key={`${cohort.key}:${dimension.dimension}`} direction="row" justify="between" align="center" gap="medium">
                <Flex direction="column" gap="extra-small"><Text format={{ fontWeight: 'bold' }}>{dimension.dimension.charAt(0).toUpperCase() + dimension.dimension.slice(1)}</Text><Text>{dimension.topEntityLabel} · {dimension.topSharePercent}% of comparable amount</Text><Text variant="microcopy">HHI {dimension.hhi} · {dimension.entities.length} displayed entities</Text></Flex>
                <StatusTag variant={concentrationVariant(dimension.status)}>{dimension.status}</StatusTag>
              </Flex>)}
            </Flex></Card>)}
      </Flex>

      <Flex direction="column" gap="small">
        <Heading>Evidence coverage</Heading>
        <Flex direction="row" gap="medium" wrap="wrap">
          <Card><Text variant="microcopy">COMPARABLE AMOUNT</Text><Heading>{view.coverage.comparableAmountPercent}%</Heading><Text>{view.coverage.amountPercent}% has a recorded amount</Text></Card>
          <Card><Text variant="microcopy">CLOSE DATE</Text><Heading>{view.coverage.closeDatePercent}%</Heading><Text>{view.summary.undatedDeals} undated deals</Text></Card>
          <Card><Text variant="microcopy">FORECAST CATEGORY</Text><Heading>{view.coverage.forecastCategoryPercent}%</Heading><Text>Recorded CRM evidence only</Text></Card>
          <Card><Text variant="microcopy">CURRENT DEAL BRIEF</Text><Heading>{view.coverage.currentDealBriefPercent}%</Heading><Text>{view.coverage.currentAssessmentPercent}% assessed</Text></Card>
          <Card><Text variant="microcopy">MOVEMENT COMPARISON</Text><Heading>{view.coverage.comparisonSnapshotPercent}%</Heading><Text>Snapshot date: {date(view.source.comparisonSnapshotDate)}</Text></Card>
        </Flex>
      </Flex>

      <Alert title="How to read this view" variant="info">Recorded forecast categories, close dates, amounts, readiness, and Deal Brief evidence support deterministic management review. This view is not buyer intent, a calibrated forecast, a win probability, expected revenue, or expected financial loss. Period pipeline coverage is not quota coverage.</Alert>
    </> : null}
  </Flex>;
}
