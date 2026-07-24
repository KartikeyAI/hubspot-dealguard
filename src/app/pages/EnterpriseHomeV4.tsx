import React, { useCallback, useEffect, useState } from 'react';
import { Alert, Button, Card, Divider, Flex, Heading, Link, LoadingSpinner, StatusTag, Text, hubspot } from '@hubspot/ui-extensions';
import { PLAN_COMPARISON, productPlanLabel, safeProductError, subscriptionLabel } from '../product-ui';

const API_BASE = 'https://dealguard-api.rokad.co/api/v1';
type Json = Record<string, any>;
type Billing = { tier: string; status: string; currentPeriodEnd: string | null; checkoutConfigured: boolean; portalConfigured: boolean; entitled: boolean };
type Access = { role: string; entitled: boolean };
type Dashboard = { totalDeals?: number; readyDeals?: number; atRiskDeals?: number; criticalDeals?: number; averageScore?: number; incompleteHandoffs?: number; lastScanAt?: string | null; nextScanAt?: string | null; topIssues?: Array<{ code: string; label: string; count: number }> };

hubspot.extend<'home'>(() => <DealGuardHome />);

const DealGuardHome = () => {
  const [loading, setLoading] = useState(true);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [dashboard, setDashboard] = useState<Dashboard>({});
  const [billing, setBilling] = useState<Billing | null>(null);
  const [access, setAccess] = useState<Access | null>(null);
  const [overview, setOverview] = useState<Json>({});
  const [checkoutUrl, setCheckoutUrl] = useState<string | null>(null);
  const [portalUrl, setPortalUrl] = useState<string | null>(null);

  const request = async (path: string, options?: { method?: 'GET' | 'POST'; body?: Record<string, unknown> }) => {
    const response = await hubspot.fetch(`${API_BASE}${path}`, { method: options?.method ?? 'GET', timeout: 20000, ...(options?.body ? { body: options.body } : {}) });
    const data = await response.json();
    if (!response.ok) throw new Error(safeProductError(data?.error?.message));
    return data;
  };
  const load = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      const [dashboardData, billingData, accessData, overviewData] = await Promise.all([request('/dashboard'), request('/billing'), request('/enterprise/access'), request('/enterprise/overview')]);
      setDashboard(dashboardData); setBilling(billingData); setAccess(accessData); setOverview(overviewData);
    } catch (caught) { setError(safeProductError(caught instanceof Error ? caught.message : null, 'DealGuard Home could not be loaded. Please try again.')); }
    finally { setLoading(false); }
  }, []);
  useEffect(() => { void load(); }, [load]);
  const action = async (task: () => Promise<void>, success: string) => { setWorking(true); setError(null); setNotice(null); try { await task(); setNotice(success); } catch (caught) { setError(safeProductError(caught instanceof Error ? caught.message : null)); } finally { setWorking(false); } };

  if (loading) return <LoadingSpinner label="Loading DealGuard" />;
  if (!billing || !access) return <Alert title="DealGuard unavailable" variant="danger">{error ?? 'Your DealGuard workspace is temporarily unavailable. Please try again.'}</Alert>;

  const plan = productPlanLabel(billing.tier);
  const health = String(overview?.health?.status ?? 'healthy');
  const healthy = health === 'healthy' || health === 'ok';
  const readyPercent = dashboard.totalDeals ? Math.round(((dashboard.readyDeals ?? 0) / dashboard.totalDeals) * 100) : 0;
  const needsAttention = (dashboard.criticalDeals ?? 0) + (dashboard.atRiskDeals ?? 0) + (dashboard.incompleteHandoffs ?? 0);
  const role = access.role.replaceAll('_', ' ');

  return <Flex direction="column" gap="large">
    {error && <Alert title="We couldn't complete that action" variant="danger">{error}</Alert>}
    {notice && <Alert title="Update complete" variant="success">{notice}</Alert>}

    <Flex direction="row" justify="between" align="center" gap="medium">
      <Flex direction="column" gap="extra-small"><Heading>Revenue readiness</Heading><Text>See what needs attention across your pipeline, then act on the highest-impact gaps.</Text></Flex>
      <Flex direction="row" gap="small" align="center"><StatusTag variant={healthy ? 'success' : 'warning'}>{healthy ? 'Workspace healthy' : 'Needs attention'}</StatusTag><StatusTag variant={billing.tier === 'free' ? 'default' : 'success'}>{plan} plan</StatusTag></Flex>
    </Flex>

    {needsAttention > 0 ? <Alert title={`${needsAttention} item${needsAttention === 1 ? '' : 's'} need attention`} variant={(dashboard.criticalDeals ?? 0) > 0 ? 'danger' : 'warning'}>{(dashboard.criticalDeals ?? 0) > 0 ? `${dashboard.criticalDeals} critical deal${dashboard.criticalDeals === 1 ? '' : 's'} should be reviewed first.` : 'Review at-risk deals and incomplete handoffs to improve pipeline readiness.'}</Alert> : <Alert title="Pipeline is in good shape" variant="success">No critical, at-risk or incomplete handoff items are currently reported.</Alert>}

    <Flex direction="row" gap="medium" wrap="wrap">
      <Card><Flex direction="column" gap="extra-small"><Text variant="microcopy">READINESS SCORE</Text><Heading>{dashboard.averageScore ?? 0}/100</Heading><Text>{dashboard.totalDeals ?? 0} deals assessed</Text></Flex></Card>
      <Card><Flex direction="column" gap="extra-small"><Text variant="microcopy">READY PIPELINE</Text><Heading>{readyPercent}%</Heading><Text>{dashboard.readyDeals ?? 0} deals ready</Text></Flex></Card>
      <Card><Flex direction="column" gap="extra-small"><Text variant="microcopy">AT RISK</Text><Heading>{dashboard.atRiskDeals ?? 0}</Heading><StatusTag variant={(dashboard.atRiskDeals ?? 0) > 0 ? 'warning' : 'success'}>{(dashboard.atRiskDeals ?? 0) > 0 ? 'Review' : 'Clear'}</StatusTag></Flex></Card>
      <Card><Flex direction="column" gap="extra-small"><Text variant="microcopy">CRITICAL</Text><Heading>{dashboard.criticalDeals ?? 0}</Heading><StatusTag variant={(dashboard.criticalDeals ?? 0) > 0 ? 'danger' : 'success'}>{(dashboard.criticalDeals ?? 0) > 0 ? 'Action required' : 'Clear'}</StatusTag></Flex></Card>
      <Card><Flex direction="column" gap="extra-small"><Text variant="microcopy">HANDOFFS</Text><Heading>{dashboard.incompleteHandoffs ?? 0}</Heading><StatusTag variant={(dashboard.incompleteHandoffs ?? 0) > 0 ? 'warning' : 'success'}>{(dashboard.incompleteHandoffs ?? 0) > 0 ? 'Pending' : 'Complete'}</StatusTag></Flex></Card>
    </Flex>

    <Flex direction="row" gap="medium" wrap="wrap">
      <Card><Flex direction="column" gap="small"><Flex direction="row" justify="between" align="center"><Heading>Workspace</Heading><StatusTag variant={healthy ? 'success' : 'warning'}>{healthy ? 'Operational' : 'Review status'}</StatusTag></Flex><Text><Text format={{ fontWeight: 'bold' }}>Policy</Text> · {overview?.activePolicy?.name ?? 'Default readiness policy'}</Text><Text><Text format={{ fontWeight: 'bold' }}>Your access</Text> · {role}</Text><Divider /><Text variant="microcopy">Last assessment: {dashboard.lastScanAt ? new Date(dashboard.lastScanAt).toLocaleString() : 'Not completed yet'}</Text><Text variant="microcopy">Next assessment: {dashboard.nextScanAt ? new Date(dashboard.nextScanAt).toLocaleString() : 'Scheduled automatically'}</Text><Button variant="secondary" disabled={working} onClick={() => void load()}>Refresh data</Button></Flex></Card>
      <Card><Flex direction="column" gap="small"><Flex direction="row" justify="between" align="center"><Heading>Plan & subscription</Heading><StatusTag variant={billing.status === 'active' ? 'success' : 'warning'}>{subscriptionLabel(billing.status)}</StatusTag></Flex><Text><Text format={{ fontWeight: 'bold' }}>{plan}</Text> plan</Text><Text>{billing.tier === 'free' ? 'Unlock native reporting, automation and daily monitoring with Growth.' : billing.tier === 'growth' || billing.tier === 'beta_growth' ? 'Your plan includes automation and native reporting. Enterprise adds organisation-wide governance.' : 'Enterprise governance is enabled for this workspace.'}</Text>{billing.currentPeriodEnd && <Text variant="microcopy">Current period ends {new Date(billing.currentPeriodEnd).toLocaleDateString()}.</Text>}<Flex direction="row" gap="small" wrap="wrap">{billing.tier !== 'enterprise' && <Button disabled={working || !billing.checkoutConfigured} onClick={() => void action(async () => { const result = await request('/billing/checkout', { method: 'POST', body: { tier: billing.tier === 'free' ? 'growth' : 'enterprise', interval: 'year', usageMode: 'capped', overageEnabled: false } }); setCheckoutUrl(result.url); }, 'Your secure plan checkout is ready.')}>{billing.tier === 'free' ? 'Upgrade to Growth' : 'Explore Enterprise'}</Button>}<Button variant="secondary" disabled={working || !billing.portalConfigured} onClick={() => void action(async () => { const result = await request('/billing/portal', { method: 'POST', body: {} }); setPortalUrl(result.url); }, 'Subscription management is ready.')}>Manage subscription</Button></Flex>{checkoutUrl && <Link href={{ url: checkoutUrl, external: true }}>Continue to secure checkout</Link>}{portalUrl && <Link href={{ url: portalUrl, external: true }}>Open subscription management</Link>}</Flex></Card>
    </Flex>

    <Flex direction="column" gap="small"><Flex direction="row" justify="between" align="center"><Flex direction="column"><Heading>Priority readiness gaps</Heading><Text>Start with the issues affecting the most deals.</Text></Flex>{(dashboard.topIssues ?? []).length > 0 && <StatusTag variant="warning">Top {(dashboard.topIssues ?? []).slice(0, 5).length}</StatusTag>}</Flex>{(dashboard.topIssues ?? []).length > 0 ? (dashboard.topIssues ?? []).slice(0, 5).map((issue, index) => <Card key={issue.code}><Flex direction="row" justify="between" align="center" gap="medium"><Flex direction="column" gap="extra-small"><Text format={{ fontWeight: 'bold' }}>{index + 1}. {issue.label}</Text><Text variant="microcopy">Improving this rule can raise readiness across affected deals.</Text></Flex><StatusTag variant={index === 0 ? 'danger' : 'warning'}>{issue.count} affected</StatusTag></Flex></Card>) : <Card><Text>No recurring readiness gaps are currently reported.</Text></Card>}</Flex>

    <Flex direction="column" gap="small"><Flex direction="row" justify="between" align="center"><Flex direction="column"><Heading>Plans</Heading><Text>Compare capabilities when you need more automation or governance.</Text></Flex><StatusTag variant="default">Current: {plan}</StatusTag></Flex>{PLAN_COMPARISON.map((row) => <Card key={row.feature}><Flex direction="column" gap="extra-small"><Text format={{ fontWeight: 'bold' }}>{row.feature}</Text><Flex direction="row" gap="medium" wrap="wrap"><Text>Free · {row.free}</Text><Text>Growth · {row.growth}</Text><Text>Enterprise · {row.enterprise}</Text></Flex></Flex></Card>)}</Flex>
  </Flex>;
};
