import React, { useEffect, useState } from 'react';
import { Alert, Button, Card, Flex, Heading, Link, LoadingSpinner, StatusTag, Text, hubspot } from '@hubspot/ui-extensions';
import { PLAN_COMPARISON, productPlanLabel, safeProductError, subscriptionLabel } from '../product-ui';

const API_BASE = 'https://dealguard-api.rokad.co/api/v1';
type Billing = { tier: string; status: string; currentPeriodEnd: string | null; checkoutConfigured: boolean; portalConfigured: boolean };

hubspot.extend<'settings'>(() => <DealGuardPlanOverview />);

const DealGuardPlanOverview = () => {
  const [billing, setBilling] = useState<Billing | null>(null);
  const [loading, setLoading] = useState(true);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [checkoutUrl, setCheckoutUrl] = useState<string | null>(null);
  const [portalUrl, setPortalUrl] = useState<string | null>(null);

  const request = async (path: string, method: 'GET' | 'POST' = 'GET', body?: Record<string, unknown>) => {
    const response = await hubspot.fetch(`${API_BASE}${path}`, { method, timeout: 15000, ...(body ? { body } : {}) });
    const data = await response.json();
    if (!response.ok) throw new Error(safeProductError(data?.error?.message));
    return data;
  };

  useEffect(() => { void (async () => { try { setBilling(await request('/billing')); } catch (caught) { setError(safeProductError(caught instanceof Error ? caught.message : null)); } finally { setLoading(false); } })(); }, []);

  const run = async (task: () => Promise<void>) => { setWorking(true); setError(null); try { await task(); } catch (caught) { setError(safeProductError(caught instanceof Error ? caught.message : null)); } finally { setWorking(false); } };
  if (loading) return <LoadingSpinner label="Loading subscription settings" />;
  if (!billing) return <Alert title="Subscription unavailable" variant="danger">{error ?? 'Subscription information is temporarily unavailable.'}</Alert>;

  return <Flex direction="column" gap="large">
    {error && <Alert title="Action failed" variant="danger">{error}</Alert>}
    <Flex direction="row" justify="between" align="center"><Flex direction="column"><Heading>Plan & subscription</Heading><Text>Review your current plan, compare capabilities and manage upgrades.</Text></Flex><Flex direction="row" gap="small"><StatusTag variant={billing.tier === 'free' ? 'default' : 'success'}>{productPlanLabel(billing.tier)}</StatusTag><StatusTag variant={billing.status === 'active' ? 'success' : 'warning'}>{subscriptionLabel(billing.status)}</StatusTag></Flex></Flex>
    <Card><Flex direction="column" gap="small"><Heading>{productPlanLabel(billing.tier)}</Heading><Text>{subscriptionLabel(billing.status)}{billing.currentPeriodEnd ? ` · current period ends ${new Date(billing.currentPeriodEnd).toLocaleDateString()}` : ''}</Text><Flex direction="row" gap="small" wrap="wrap"><Button disabled={working || !billing.checkoutConfigured} onClick={() => void run(async () => { const result = await request('/billing/checkout', 'POST', { tier: billing.tier === 'enterprise' ? 'enterprise' : 'growth', interval: 'year', usageMode: 'capped', overageEnabled: false }); setCheckoutUrl(result.url); })}>{billing.tier === 'free' ? 'Upgrade to Growth' : 'Change plan'}</Button><Button variant="secondary" disabled={working || !billing.portalConfigured} onClick={() => void run(async () => { const result = await request('/billing/portal', 'POST', {}); setPortalUrl(result.url); })}>Manage subscription</Button></Flex>{checkoutUrl && <Link href={{ url: checkoutUrl, external: true }}>Continue to secure checkout</Link>}{portalUrl && <Link href={{ url: portalUrl, external: true }}>Open subscription management</Link>}</Flex></Card>
    <Heading>Plan comparison</Heading>
    {PLAN_COMPARISON.map((row) => <Card key={row.feature}><Flex direction="column" gap="extra-small"><Text format={{ fontWeight: 'bold' }}>{row.feature}</Text><Text>Free · {row.free}</Text><Text>Growth · {row.growth}</Text><Text>Enterprise · {row.enterprise}</Text></Flex></Card>)}
  </Flex>;
};
