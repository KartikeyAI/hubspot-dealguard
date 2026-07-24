import React, { useCallback, useEffect, useState } from 'react';
import { Alert, Button, Card, Flex, Heading, Link, LoadingSpinner, StatusTag, Text, hubspot } from '@hubspot/ui-extensions';
import { PLAN_COMPARISON, productPlanLabel, safeProductError, subscriptionLabel } from '../product-ui';

const API_BASE = 'https://dealguard-api.rokad.co/api/v1';
type Json = Record<string, any>;
type Billing = { tier: string; status: string; currentPeriodEnd: string | null; checkoutConfigured: boolean; portalConfigured: boolean; entitled: boolean };
type Access = { role: string; entitled: boolean };

type Dashboard = {
  totalDeals?: number; readyDeals?: number; atRiskDeals?: number; criticalDeals?: number; averageScore?: number;
  incompleteHandoffs?: number; lastScanAt?: string | null; nextScanAt?: string | null;
  topIssues?: Array<{ code: string; label: string; count: number }>;
};

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
      const [dashboardData, billingData, accessData, overviewData] = await Promise.all([
        request('/dashboard'), request('/billing'), request('/enterprise/access'), request('/enterprise/overview'),
      ]);
      setDashboard(dashboardData); setBilling(billingData); setAccess(accessData); setOverview(overviewData);
    } catch (caught) { setError(safeProductError(caught instanceof Error ? caught.message : null, 'DealGuard Home could not be loaded. Please try again.')); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const action = async (task: () => Promise<void>, success: string) => {
    setWorking(true); setError(null); setNotice(null);
    try { await task(); setNotice(success); }
    catch (caught) { setError(safeProductError(caught instanceof Error ? caught.message : null)); }
    finally { setWorking(false); }
  };

  if (loading) return <LoadingSpinner label="Loading DealGuard" />;
  if (!billing || !access) return <Alert title="DealGuard unavailable" variant="danger">{error ?? 'DealGuard Home is temporarily unavailable.'}</Alert>;

  const plan = productPlanLabel(billing.tier);
  const health = overview?.health?.status ?? 'healthy';
  const readyPercent = dashboard.totalDeals ? Math.round(((dashboard.readyDeals ?? 0) / dashboard.totalDeals) * 100) : 0;

  return <Flex direction="column" gap="large">
    {error && <Alert title="Something went wrong" variant="danger">{error}</Alert>}
    {notice && <Alert title="Done" variant="success">{notice}</Alert>}

    <Flex direction="row" justify="between" align="center" gap="medium">
      <Flex direction="column" gap="extra-small">
        <Heading>DealGuard</Heading>
        <Text>Revenue readiness, risk visibility and governed handoffs for your HubSpot pipeline.</Text>
      </Flex>
      <Flex direction="row" gap="small" align="center"><StatusTag variant={billing.entitled ? 'success' : 'default'}>{plan}</StatusTag><StatusTag variant={billing.status === 'active' ? 'success' : 'warning'}>{subscriptionLabel(billing.status)}</StatusTag></Flex>
    </Flex>

    <Flex direction="row" gap="medium" wrap="wrap">
      <Card><Heading>{dashboard.averageScore ?? 0}/100</Heading><Text>Average readiness</Text><Text variant="microcopy">Across {dashboard.totalDeals ?? 0} assessed deals</Text></Card>
      <Card><Heading>{readyPercent}%</Heading><Text>Pipeline ready</Text><Text variant="microcopy">{dashboard.readyDeals ?? 0} deals currently ready</Text></Card>
      <Card><Heading>{dashboard.atRiskDeals ?? 0}</Heading><Text>Deals at risk</Text><Text variant="microcopy">Require attention before progression</Text></Card>
      <Card><Heading>{dashboard.criticalDeals ?? 0}</Heading><Text>Critical deals</Text><Text variant="microcopy">Highest-priority readiness gaps</Text></Card>
      <Card><Heading>{dashboard.incompleteHandoffs ?? 0}</Heading><Text>Handoffs pending</Text><Text variant="microcopy">Closed-won deals awaiting completion</Text></Card>
    </Flex>

    <Flex direction="row" gap="medium" wrap="wrap">
      <Card><Flex direction="column" gap="small"><Flex direction="row" justify="between"><Heading>Workspace status</Heading><StatusTag variant={health === 'healthy' ? 'success' : 'warning'}>{health}</StatusTag></Flex><Text>Access: {access.role.replaceAll('_', ' ')}</Text><Text>Active policy: {overview?.activePolicy?.name ?? 'Default readiness policy'}</Text><Text variant="microcopy">Last completed scan: {dashboard.lastScanAt ? new Date(dashboard.lastScanAt).toLocaleString() : 'Not completed yet'}</Text><Button variant="secondary" disabled={working} onClick={() => void load()}>Refresh</Button></Flex></Card>
      <Card><Flex direction="column" gap="small"><Heading>Your subscription</Heading><Text><Text format={{ fontWeight: 'bold' }}>{plan}</Text> · {subscriptionLabel(billing.status)}</Text><Text>{billing.currentPeriodEnd ? `Current period ends ${new Date(billing.currentPeriodEnd).toLocaleDateString()}.` : 'Subscription period information will appear here when available.'}</Text><Flex direction="row" gap="small" wrap="wrap"><Button disabled={working || !billing.checkoutConfigured} onClick={() => void action(async () => { const result = await request('/billing/checkout', { method: 'POST', body: { tier: billing.tier === 'enterprise' ? 'enterprise' : 'growth', interval: 'year', usageMode: 'capped', overageEnabled: false } }); setCheckoutUrl(result.url); }, 'Secure upgrade checkout is ready.')}>{billing.tier === 'free' ? 'Upgrade to Growth' : 'Change plan'}</Button><Button variant="secondary" disabled={working || !billing.portalConfigured} onClick={() => void action(async () => { const result = await request('/billing/portal', { method: 'POST', body: {} }); setPortalUrl(result.url); }, 'Subscription management is ready.')}>Manage subscription</Button></Flex>{checkoutUrl && <Link href={{ url: checkoutUrl, external: true }}>Continue to secure checkout</Link>}{portalUrl && <Link href={{ url: portalUrl, external: true }}>Open subscription management</Link>}</Flex></Card>
    </Flex>

    {(dashboard.topIssues ?? []).length > 0 && <Card><Flex direction="column" gap="small"><Heading>Top readiness gaps</Heading><Text>These are the most common reasons deals are losing readiness points right now.</Text>{(dashboard.topIssues ?? []).slice(0, 5).map((issue) => <Flex key={issue.code} direction="row" justify="between"><Text>{issue.label}</Text><StatusTag variant="warning">{issue.count} deals</StatusTag></Flex>)}</Flex></Card>}

    <Flex direction="column" gap="small">
      <Flex direction="row" justify="between" align="center"><Flex direction="column"><Heading>Compare plans</Heading><Text>Choose the level of automation and governance your revenue team needs.</Text></Flex>{billing.tier === 'free' && <StatusTag variant="warning">Upgrade available</StatusTag>}</Flex>
      {PLAN_COMPARISON.map((row) => <Card key={row.feature}><Flex direction="column" gap="extra-small"><Text format={{ fontWeight: 'bold' }}>{row.feature}</Text><Flex direction="row" gap="medium" wrap="wrap"><Text>Free: {row.free}</Text><Text>Growth: {row.growth}</Text><Text>Enterprise: {row.enterprise}</Text></Flex></Flex></Card>)}
    </Flex>

    <Alert title="Product information only" variant="info">DealGuard shows product-level status and actions here. Infrastructure vendors, database schema details and internal service errors are intentionally kept out of the customer experience.</Alert>
  </Flex>;
};
