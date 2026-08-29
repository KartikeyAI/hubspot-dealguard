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
import { PLAN_COMPARISON, productPlanLabel, safeProductError, subscriptionLabel } from './product-ui';

const API_BASE = 'https://dealguard-api.rokad.co/api/v1';
type Json = Record<string, any>;

type Billing = {
  tier: string;
  status: string;
  currentPeriodEnd: string | null;
  checkoutConfigured: boolean;
  portalConfigured: boolean;
  entitled: boolean;
};

type Access = { role: string; entitled: boolean };
type Dashboard = {
  totalDeals?: number;
  readyDeals?: number;
  atRiskDeals?: number;
  criticalDeals?: number;
  averageScore?: number;
  incompleteHandoffs?: number;
  lastScanAt?: string | null;
  nextScanAt?: string | null;
  topIssues?: Array<{ code: string; label: string; count: number }>;
};

type Coverage = {
  amountPercent?: number;
  companyCurrencyAmountPercent?: number;
  currencyCodePercent?: number;
  stageAgePercent?: number;
  ownerPercent?: number;
};

type SourceCurrency = {
  currencyCode: string | null;
  totalDeals: number;
  dealsWithAmount: number;
  pipelineAmount: number;
  amountWithReadinessGaps: number;
};

type Monetary = {
  canAggregate: boolean;
  mode: 'company_currency' | 'single_deal_currency' | 'unavailable';
  currencyCode: string | null;
  currencyLabel: string;
  pipelineAmount: number | null;
  amountWithReadinessGaps: number | null;
  amountCoveragePercent: number;
  companyCurrencyCoveragePercent: number;
  sourceCurrencyCoveragePercent: number;
  sourceCurrencyCount: number;
  unknownCurrencyDeals: number;
  sourceCurrencies: SourceCurrency[];
  reason: string | null;
};

type BenchmarkRow = Json & {
  label: string;
  scoreDelta: number;
  averageScore: number;
  totalDeals: number;
};

type AttentionDeal = Json & {
  attentionScore?: number;
  riskSignal?: number;
  band: 'high' | 'medium' | 'low';
  stage?: string | null;
};

type Analytics = {
  redacted?: boolean;
  generatedAt?: string;
  current?: Json & {
    totalDeals?: number;
    readyDeals?: number;
    atRiskDeals?: number;
    criticalDeals?: number;
    averageScore?: number;
    amountWithReadinessGaps?: number | null;
    pipelineAmount?: number | null;
    oldestAssessmentAt?: string | null;
    latestAssessmentAt?: string | null;
    coverage?: Coverage;
  };
  monetary?: Monetary;
  trend?: Array<Json & {
    averageScore?: number;
    amountWithReadinessGaps?: number | null;
  }>;
  benchmarking?: {
    workspaceAverageScore: number;
    owners: BenchmarkRow[];
    teams: BenchmarkRow[];
  };
  attentionPriority?: {
    methodology: string;
    deals: AttentionDeal[];
    highPriorityDeals: number;
  };
  predictiveRisk?: {
    methodology: string;
    deals: AttentionDeal[];
    highRiskDeals: number;
  };
  outcomeCorrelation?: {
    sampleSize: number;
    won: number;
    lost: number;
    winRate: number;
    wonAverageScore: number;
    lostAverageScore: number;
    scoreDelta: number;
    wonAverageIssues: number;
    lostAverageIssues: number;
    wonAverageStageAgeDays: number;
    lostAverageStageAgeDays: number;
    confidence: string;
  };
};

type RequestOptions = { method?: 'GET' | 'POST'; body?: Record<string, unknown> };

hubspot.extend<'home'>(() => <DealGuardHome />);

function finite(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function percentage(value: unknown): number {
  const parsed = finite(value);
  return parsed === null ? 0 : Math.max(0, Math.min(100, Math.round(parsed)));
}

function coverageVariant(value: number): 'success' | 'warning' | 'danger' {
  if (value >= 95) return 'success';
  if (value >= 75) return 'warning';
  return 'danger';
}

function compactNumber(value: number): string {
  return new Intl.NumberFormat('en', {
    maximumFractionDigits: value >= 1_000 ? 0 : 1,
    notation: Math.abs(value) >= 1_000_000 ? 'compact' : 'standard',
  }).format(value);
}

function formatMoney(value: unknown, currencyCode: string | null, fallbackLabel: string): string {
  const parsed = finite(value);
  if (parsed === null) return '—';
  if (currencyCode && /^[A-Z]{3}$/.test(currencyCode)) {
    try {
      return new Intl.NumberFormat('en', {
        style: 'currency',
        currency: currencyCode,
        maximumFractionDigits: 0,
        notation: Math.abs(parsed) >= 1_000_000 ? 'compact' : 'standard',
      }).format(parsed);
    } catch {
      return `${currencyCode} ${compactNumber(parsed)}`;
    }
  }
  return `${compactNumber(parsed)} ${fallbackLabel}`;
}

function formatDate(value: string | null | undefined): string {
  return value ? new Date(value).toLocaleString() : 'Not available';
}

function ageInHours(value: string | null | undefined): number | null {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? Math.max(0, (Date.now() - parsed) / 3_600_000) : null;
}

function ageLabel(hours: number | null): string {
  if (hours === null) return 'No current assessment';
  if (hours < 1) return 'Less than one hour old';
  if (hours < 24) return `${Math.floor(hours)} hour${Math.floor(hours) === 1 ? '' : 's'} old`;
  const days = Math.floor(hours / 24);
  return `${days} day${days === 1 ? '' : 's'} old`;
}

function signed(value: number): string {
  return `${value > 0 ? '+' : ''}${value}`;
}

const DealGuardHome = () => {
  const [loading, setLoading] = useState(true);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [dashboard, setDashboard] = useState<Dashboard>({});
  const [billing, setBilling] = useState<Billing | null>(null);
  const [access, setAccess] = useState<Access | null>(null);
  const [overview, setOverview] = useState<Json>({});
  const [analytics, setAnalytics] = useState<Analytics | null>(null);
  const [checkoutUrl, setCheckoutUrl] = useState<string | null>(null);
  const [portalUrl, setPortalUrl] = useState<string | null>(null);

  const request = async (path: string, options?: RequestOptions) => {
    const response = await hubspot.fetch(`${API_BASE}${path}`, {
      method: options?.method ?? 'GET',
      timeout: 20_000,
      ...(options?.body ? { body: options.body } : {}),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(safeProductError(data?.error?.message));
    return data;
  };

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [dashboardData, billingData, accessData, overviewData, analyticsData] = await Promise.all([
        request('/dashboard'),
        request('/billing'),
        request('/enterprise/access'),
        request('/enterprise/overview'),
        request('/enterprise/analytics?days=90').catch(() => null),
      ]);
      setDashboard(dashboardData);
      setBilling(billingData);
      setAccess(accessData);
      setOverview(overviewData);
      setAnalytics(analyticsData);
    } catch (caught) {
      setError(safeProductError(
        caught instanceof Error ? caught.message : null,
        'DealGuard Home could not be loaded. Please try again.',
      ));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const action = async (task: () => Promise<void>, success: string) => {
    setWorking(true);
    setError(null);
    setNotice(null);
    try {
      await task();
      setNotice(success);
    } catch (caught) {
      setError(safeProductError(caught instanceof Error ? caught.message : null));
    } finally {
      setWorking(false);
    }
  };

  if (loading) return <LoadingSpinner label="Loading DealGuard" />;
  if (!billing || !access) {
    return <Alert title="DealGuard unavailable" variant="danger">{error ?? 'Your DealGuard workspace is temporarily unavailable. Please try again.'}</Alert>;
  }

  const plan = productPlanLabel(billing.tier);
  const healthy = ['healthy', 'ok'].includes(String(overview?.health?.status ?? 'healthy'));
  const readyPercent = dashboard.totalDeals
    ? Math.round((dashboard.readyDeals ?? 0) / dashboard.totalDeals * 100)
    : 0;
  const needsAttention = (dashboard.criticalDeals ?? 0)
    + (dashboard.atRiskDeals ?? 0)
    + (dashboard.incompleteHandoffs ?? 0);
  const role = access.role.replaceAll('_', ' ');
  const analyticsAvailable = Boolean(analytics && !analytics.redacted);
  const current = analytics?.current ?? {};
  const coverage = current.coverage ?? {};
  const monetary = analytics?.monetary;
  const trend = analytics?.trend ?? [];
  const first = trend[0];
  const last = trend[trend.length - 1];
  const scoreDelta = first && last
    ? Number(last.averageScore ?? 0) - Number(first.averageScore ?? 0)
    : 0;
  const firstGapAmount = finite(first?.amountWithReadinessGaps);
  const lastGapAmount = finite(last?.amountWithReadinessGaps);
  const gapAmountDelta = firstGapAmount !== null && lastGapAmount !== null
    ? lastGapAmount - firstGapAmount
    : null;
  const policyCompliance = dashboard.totalDeals
    ? Math.round((dashboard.readyDeals ?? 0) / dashboard.totalDeals * 100)
    : 100;
  const remediationOpen = (dashboard.criticalDeals ?? 0) + (dashboard.atRiskDeals ?? 0);
  const pipelineAmount = monetary?.canAggregate ? monetary.pipelineAmount : null;
  const amountWithReadinessGaps = monetary?.canAggregate ? monetary.amountWithReadinessGaps : null;
  const gapPercent = finite(pipelineAmount) && Number(pipelineAmount) > 0 && finite(amountWithReadinessGaps) !== null
    ? Math.round(Number(amountWithReadinessGaps) / Number(pipelineAmount) * 100)
    : null;
  const amountCoverage = percentage(coverage.amountPercent ?? monetary?.amountCoveragePercent);
  const companyCurrencyCoverage = percentage(
    coverage.companyCurrencyAmountPercent ?? monetary?.companyCurrencyCoveragePercent,
  );
  const currencyCodeCoverage = percentage(coverage.currencyCodePercent ?? monetary?.sourceCurrencyCoveragePercent);
  const stageAgeCoverage = percentage(coverage.stageAgePercent);
  const ownerCoverage = percentage(coverage.ownerPercent);
  const newestAssessmentAge = ageInHours(current.latestAssessmentAt ?? dashboard.lastScanAt);
  const staleCurrentState = newestAssessmentAge === null || newestAssessmentAge > 48;
  const benchmarks = analytics?.benchmarking;
  const owners = benchmarks?.owners ?? [];
  const leadingOwner = owners.length > 0
    ? [...owners].sort((left, right) => Number(right.scoreDelta) - Number(left.scoreDelta))[0]
    : null;
  const laggingOwner = owners.length > 0
    ? [...owners].sort((left, right) => Number(left.scoreDelta) - Number(right.scoreDelta))[0]
    : null;
  const attention = analytics?.attentionPriority ?? (analytics?.predictiveRisk ? {
    methodology: analytics.predictiveRisk.methodology,
    deals: analytics.predictiveRisk.deals,
    highPriorityDeals: analytics.predictiveRisk.highRiskDeals,
  } : null);
  const topAttention = attention?.deals?.[0];
  const topAttentionScore = topAttention
    ? Number(topAttention.attentionScore ?? topAttention.riskSignal ?? 0)
    : null;
  const outcomes = analytics?.outcomeCorrelation;
  const sourceCurrencies = monetary?.sourceCurrencies ?? [];
  const sourceCurrencyText = sourceCurrencies.length > 0
    ? sourceCurrencies.map((item) => item.currencyCode ?? 'Unknown currency').join(', ')
    : 'No currency values observed';
  const moneyLabel = monetary?.currencyLabel ?? 'company currency';
  const currencyBasis = monetary?.mode === 'company_currency'
    ? 'HubSpot company-currency amounts'
    : monetary?.mode === 'single_deal_currency'
      ? `single deal currency (${monetary.currencyCode ?? 'unknown'})`
      : 'not aggregated';

  return <Flex direction="column" gap="large">
    {error && <Alert title="We couldn't complete that action" variant="danger">{error}</Alert>}
    {notice && <Alert title="Update complete" variant="success">{notice}</Alert>}

    <Flex direction="row" justify="between" align="center" gap="medium">
      <Flex direction="column" gap="extra-small">
        <Heading>Revenue readiness</Heading>
        <Text>See what needs attention across your pipeline, then act on the highest-impact readiness gaps.</Text>
      </Flex>
      <Flex direction="row" gap="small">
        <StatusTag variant={healthy ? 'success' : 'warning'}>{healthy ? 'Workspace healthy' : 'Needs attention'}</StatusTag>
        <StatusTag variant={billing.tier === 'free' ? 'default' : 'success'}>{plan} plan</StatusTag>
      </Flex>
    </Flex>

    {needsAttention > 0
      ? <Alert title={`${needsAttention} items need attention`} variant={(dashboard.criticalDeals ?? 0) > 0 ? 'danger' : 'warning'}>
          {(dashboard.criticalDeals ?? 0) > 0
            ? `${dashboard.criticalDeals} critical deals should be reviewed first.`
            : 'Review at-risk deals and incomplete handoffs.'}
        </Alert>
      : <Alert title="Pipeline is in good shape" variant="success">No critical, at-risk or incomplete handoff items are currently reported.</Alert>}

    {analyticsAvailable && staleCurrentState && <Alert title="Current-state assessments may be stale" variant="warning">
      The newest assessment is {ageLabel(newestAssessmentAge)}. Refresh the portal scan before using this view for a forecast or management decision.
    </Alert>}

    {analyticsAvailable && monetary && !monetary.canAggregate && <Alert title="Currency-safe totals are not available" variant="warning">
      {monetary.reason ?? 'DealGuard cannot safely aggregate the current amount data.'} Native deal amounts remain available per currency; they are never summed across currencies.
    </Alert>}

    <Flex direction="row" gap="medium" wrap="wrap">
      <Card>
        <Text variant="microcopy">READINESS SCORE</Text>
        <Heading>{dashboard.averageScore ?? 0}/100</Heading>
        <Text>{dashboard.totalDeals ?? 0} deals assessed</Text>
      </Card>
      <Card>
        <Text variant="microcopy">READY PIPELINE</Text>
        <Heading>{readyPercent}%</Heading>
        <Text>{dashboard.readyDeals ?? 0} deals ready</Text>
      </Card>
      <Card>
        <Text variant="microcopy">AT RISK</Text>
        <Heading>{dashboard.atRiskDeals ?? 0}</Heading>
        <StatusTag variant={(dashboard.atRiskDeals ?? 0) > 0 ? 'warning' : 'success'}>{(dashboard.atRiskDeals ?? 0) > 0 ? 'Review' : 'Clear'}</StatusTag>
      </Card>
      <Card>
        <Text variant="microcopy">CRITICAL</Text>
        <Heading>{dashboard.criticalDeals ?? 0}</Heading>
        <StatusTag variant={(dashboard.criticalDeals ?? 0) > 0 ? 'danger' : 'success'}>{(dashboard.criticalDeals ?? 0) > 0 ? 'Action required' : 'Clear'}</StatusTag>
      </Card>
    </Flex>

    <Flex direction="column" gap="small">
      <Heading>Pipeline intelligence</Heading>
      <Text>A 90-day view of readiness movement, governance, remediation and recorded amount with readiness gaps.</Text>
      <Flex direction="row" gap="medium" wrap="wrap">
        <Card>
          <Text variant="microcopy">READINESS TREND</Text>
          <Heading>{signed(scoreDelta)} pts</Heading>
          <StatusTag variant={scoreDelta > 0 ? 'success' : scoreDelta < 0 ? 'warning' : 'default'}>{scoreDelta > 0 ? 'Improving' : scoreDelta < 0 ? 'Declining' : 'Stable'}</StatusTag>
        </Card>
        <Card>
          <Text variant="microcopy">AMOUNT COVERAGE</Text>
          <Heading>{amountCoverage}%</Heading>
          <StatusTag variant={coverageVariant(amountCoverage)}>{amountCoverage >= 95 ? 'Strong' : amountCoverage >= 75 ? 'Review' : 'Incomplete'}</StatusTag>
        </Card>
        <Card>
          <Text variant="microcopy">READINESS COMPLIANCE</Text>
          <Heading>{policyCompliance}%</Heading>
          <Text>{dashboard.readyDeals ?? 0} of {dashboard.totalDeals ?? 0} ready</Text>
        </Card>
        <Card>
          <Text variant="microcopy">REMEDIATION</Text>
          <Heading>{remediationOpen}</Heading>
          <Text>{dashboard.criticalDeals ?? 0} critical · {dashboard.atRiskDeals ?? 0} at risk</Text>
        </Card>
        <Card>
          <Text variant="microcopy">AMOUNT WITH READINESS GAPS</Text>
          <Heading>{analyticsAvailable ? formatMoney(amountWithReadinessGaps, monetary?.currencyCode ?? null, moneyLabel) : '—'}</Heading>
          <Text>{analyticsAvailable
            ? gapPercent === null
              ? 'A safe percentage cannot be calculated from the available currency data.'
              : `${gapPercent}% of recorded pipeline amount has readiness gaps.`
            : 'Available with Enterprise analytics.'}</Text>
          {analyticsAvailable && gapAmountDelta !== null && <Text variant="microcopy">
            {gapAmountDelta === 0
              ? '90-day recorded amount is stable.'
              : `${gapAmountDelta > 0 ? 'Up' : 'Down'} ${formatMoney(Math.abs(gapAmountDelta), monetary?.currencyCode ?? null, moneyLabel)} across comparable company-currency trend points.`}
          </Text>}
        </Card>
      </Flex>
    </Flex>

    {analyticsAvailable && <Flex direction="column" gap="small">
      <Flex direction="row" justify="between">
        <Flex direction="column">
          <Heading>Decision intelligence</Heading>
          <Text>Owner benchmarks, deterministic attention priorities and pre-close outcome evidence.</Text>
        </Flex>
        <StatusTag variant="success">Explainable evidence</StatusTag>
      </Flex>
      <Flex direction="row" gap="medium" wrap="wrap">
        <Card>
          <Text variant="microcopy">BENCHMARKING</Text>
          <Heading>{benchmarks?.workspaceAverageScore ?? 0}/100</Heading>
          <Text>Workspace readiness baseline</Text>
          {leadingOwner && <Text variant="microcopy">Leading owner: {leadingOwner.label} · {signed(Number(leadingOwner.scoreDelta))} pts</Text>}
        </Card>
        <Card>
          <Text variant="microcopy">OWNER BENCHMARK GAP</Text>
          <Heading>{laggingOwner ? `${signed(Number(laggingOwner.scoreDelta))} pts` : '—'}</Heading>
          <Text>{laggingOwner
            ? `${laggingOwner.label} is farthest from the workspace readiness baseline in this view.`
            : 'More owner history is needed.'}</Text>
          {laggingOwner && <StatusTag variant={Number(laggingOwner.scoreDelta) < 0 ? 'warning' : 'success'}>{Number(laggingOwner.scoreDelta) < 0 ? 'Below baseline' : 'On track'}</StatusTag>}
        </Card>
        <Card>
          <Text variant="microcopy">ATTENTION PRIORITY</Text>
          <Heading>{attention?.highPriorityDeals ?? 0}</Heading>
          <Text>Open deals with a high deterministic attention score</Text>
          {topAttentionScore !== null && <Text variant="microcopy">Highest score: {topAttentionScore}/100 · {topAttention?.stage ?? 'Current stage'}</Text>}
          <StatusTag variant={(attention?.highPriorityDeals ?? 0) > 0 ? 'danger' : 'success'}>{(attention?.highPriorityDeals ?? 0) > 0 ? 'Investigate' : 'Clear'}</StatusTag>
        </Card>
        <Card>
          <Text variant="microcopy">WIN / LOSS EVIDENCE</Text>
          <Heading>{outcomes?.sampleSize ?? 0}</Heading>
          <Text>Deals with a usable pre-close assessment and one recorded outcome</Text>
          {outcomes && outcomes.sampleSize > 0 && <Text variant="microcopy">Won deals scored {signed(outcomes.scoreDelta)} pts versus lost · {outcomes.winRate}% observed win rate</Text>}
          <StatusTag variant={outcomes?.confidence === 'strong' ? 'success' : outcomes?.confidence === 'directional' ? 'warning' : 'default'}>{outcomes?.confidence === 'strong' ? 'Strong sample' : outcomes?.confidence === 'directional' ? 'Directional' : 'Limited sample'}</StatusTag>
        </Card>
      </Flex>
      <Alert title="How to read attention priority" variant="info">
        Attention scores combine readiness score, stage ageing and unresolved issue count. They prioritize review; they are not machine-learning win probabilities or expected-loss estimates.
      </Alert>
    </Flex>}

    {analyticsAvailable && <Flex direction="column" gap="small">
      <Heading>Data trust and freshness</Heading>
      <Text>Coverage and freshness explain how much evidence supports this view before a team acts on it.</Text>
      <Flex direction="row" gap="medium" wrap="wrap">
        <Card>
          <Text variant="microcopy">AMOUNT COVERAGE</Text>
          <Heading>{amountCoverage}%</Heading>
          <StatusTag variant={coverageVariant(amountCoverage)}>{amountCoverage >= 95 ? 'Strong' : 'Incomplete'}</StatusTag>
        </Card>
        <Card>
          <Text variant="microcopy">COMPANY-CURRENCY COVERAGE</Text>
          <Heading>{companyCurrencyCoverage}%</Heading>
          <StatusTag variant={coverageVariant(companyCurrencyCoverage)}>{monetary?.canAggregate ? 'Safe to aggregate' : 'Not safe to aggregate'}</StatusTag>
        </Card>
        <Card>
          <Text variant="microcopy">STAGE-AGE COVERAGE</Text>
          <Heading>{stageAgeCoverage}%</Heading>
          <StatusTag variant={coverageVariant(stageAgeCoverage)}>{stageAgeCoverage >= 95 ? 'Strong' : 'Incomplete'}</StatusTag>
        </Card>
        <Card>
          <Text variant="microcopy">OWNER COVERAGE</Text>
          <Heading>{ownerCoverage}%</Heading>
          <StatusTag variant={coverageVariant(ownerCoverage)}>{ownerCoverage >= 95 ? 'Strong' : 'Incomplete'}</StatusTag>
        </Card>
      </Flex>
      <Card>
        <Heading>Evidence details</Heading>
        <Text>Newest current assessment · {formatDate(current.latestAssessmentAt)}</Text>
        <Text>Oldest current assessment · {formatDate(current.oldestAssessmentAt)}</Text>
        <Text>Analytics generated · {formatDate(analytics?.generatedAt)}</Text>
        <Text>Current-state freshness · {ageLabel(newestAssessmentAge)}</Text>
        <Text>Currency basis · {currencyBasis}</Text>
        <Text>Source currency-code coverage · {currencyCodeCoverage}%</Text>
        <Text>Observed source currencies · {sourceCurrencyText}</Text>
      </Card>
    </Flex>}

    <Flex direction="row" gap="medium" wrap="wrap">
      <Card>
        <Heading>Workspace</Heading>
        <StatusTag variant={healthy ? 'success' : 'warning'}>{healthy ? 'Operational' : 'Review status'}</StatusTag>
        <Text>Policy · {overview?.activePolicy?.name ?? 'Default readiness policy'}</Text>
        <Text>Your access · {role}</Text>
        <Divider />
        <Text variant="microcopy">Last portal scan: {formatDate(dashboard.lastScanAt)}</Text>
        <Button variant="secondary" disabled={working} onClick={() => void load()}>Refresh data</Button>
      </Card>
      <Card>
        <Heading>Plan & subscription</Heading>
        <StatusTag variant={billing.status === 'active' ? 'success' : 'warning'}>{subscriptionLabel(billing.status)}</StatusTag>
        <Text>{plan} plan</Text>
        <Flex direction="row" gap="small">
          {billing.tier !== 'enterprise' && <Button
            disabled={working || !billing.checkoutConfigured}
            onClick={() => void action(async () => {
              const result = await request('/billing/checkout', {
                method: 'POST',
                body: {
                  tier: billing.tier === 'free' ? 'growth' : 'enterprise',
                  interval: 'year',
                  usageMode: 'capped',
                  overageEnabled: false,
                },
              });
              setCheckoutUrl(result.url);
            }, 'Your secure plan checkout is ready.')}
          >{billing.tier === 'free' ? 'Upgrade to Growth' : 'Explore Enterprise'}</Button>}
          <Button
            variant="secondary"
            disabled={working || !billing.portalConfigured}
            onClick={() => void action(async () => {
              const result = await request('/billing/portal', { method: 'POST', body: {} });
              setPortalUrl(result.url);
            }, 'Subscription management is ready.')}
          >Manage subscription</Button>
        </Flex>
        {checkoutUrl && <Link href={{ url: checkoutUrl, external: true }}>Continue to secure checkout</Link>}
        {portalUrl && <Link href={{ url: portalUrl, external: true }}>Open subscription management</Link>}
      </Card>
    </Flex>

    <Flex direction="column" gap="small">
      <Heading>Priority readiness gaps</Heading>
      {(dashboard.topIssues ?? []).slice(0, 5).map((item, index) => <Card key={item.code}>
        <Flex direction="row" justify="between">
          <Text format={{ fontWeight: 'bold' }}>{index + 1}. {item.label}</Text>
          <StatusTag variant={index === 0 ? 'danger' : 'warning'}>{item.count} affected</StatusTag>
        </Flex>
      </Card>)}
    </Flex>

    <Flex direction="column" gap="small">
      <Heading>Plans</Heading>
      {PLAN_COMPARISON.map((row) => <Card key={row.feature}>
        <Text format={{ fontWeight: 'bold' }}>{row.feature}</Text>
        <Text>Free · {row.free}</Text>
        <Text>Growth · {row.growth}</Text>
        <Text>Enterprise · {row.enterprise}</Text>
      </Card>)}
    </Flex>
  </Flex>;
};
