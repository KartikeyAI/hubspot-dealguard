import React, { useEffect, useState } from 'react';
import { Alert, Button, Card, Divider, Flex, Heading, Link, LoadingSpinner, StatusTag, Text, hubspot } from '@hubspot/ui-extensions';
import { PLAN_COMPARISON, productPlanLabel, safeProductError, subscriptionLabel } from '../product-ui';

const API_BASE = 'https://dealguard-api.rokad.co/api/v1';
type Billing = { tier: string; status: string; currentPeriodEnd: string | null; checkoutConfigured: boolean; portalConfigured: boolean };

export const DealGuardPlanOverview = () => {
  const [billing, setBilling] = useState<Billing | null>(null);
  const [loading, setLoading] = useState(true);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [checkoutUrl, setCheckoutUrl] = useState<string | null>(null);
  const [portalUrl, setPortalUrl] = useState<string | null>(null);
  const request = async (path: string, method: 'GET' | 'POST' = 'GET', body?: Record<string, unknown>) => { const response = await hubspot.fetch(`${API_BASE}${path}`, { method, timeout: 15000, ...(body ? { body } : {}) }); const data = await response.json(); if (!response.ok) throw new Error(safeProductError(data?.error?.message)); return data; };
  useEffect(() => { void (async () => { try { setBilling(await request('/billing')); } catch (caught) { setError(safeProductError(caught instanceof Error ? caught.message : null)); } finally { setLoading(false); } })(); }, []);
  const run = async (task: () => Promise<void>) => { setWorking(true); setError(null); try { await task(); } catch (caught) { setError(safeProductError(caught instanceof Error ? caught.message : null)); } finally { setWorking(false); } };
  if (loading) return <LoadingSpinner label="Loading plan and subscription" />;
  if (!billing) return <Alert title="Plan information unavailable" variant="danger">{error ?? 'Your plan information is temporarily unavailable. Please try again.'}</Alert>;

  const plan = productPlanLabel(billing.tier);
  const nextTier = billing.tier === 'free' ? 'growth' : 'enterprise';
  return <Flex direction="column" gap="large">
    {error && <Alert title="We couldn't complete that action" variant="danger">{error}</Alert>}
    <Flex direction="row" justify="between" align="center" gap="medium"><Flex direction="column" gap="extra-small"><Heading>Plan & subscription</Heading><Text>Manage your DealGuard plan and understand what your workspace can use.</Text></Flex><StatusTag variant={billing.status === 'active' ? 'success' : 'warning'}>{subscriptionLabel(billing.status)}</StatusTag></Flex>
    <Card><Flex direction="column" gap="small"><Flex direction="row" justify="between" align="center"><Flex direction="column" gap="extra-small"><Text variant="microcopy">CURRENT PLAN</Text><Heading>{plan}</Heading></Flex><StatusTag variant={billing.tier === 'free' ? 'default' : 'success'}>{billing.tier === 'enterprise' ? 'Full governance' : billing.tier === 'free' ? 'Core' : 'Automation'}</StatusTag></Flex><Text>{billing.tier === 'free' ? 'Core readiness scoring and weekly visibility for teams getting started.' : billing.tier === 'growth' || billing.tier === 'beta_growth' ? 'Automation, native reporting and faster monitoring for active revenue teams.' : 'Organisation-wide governance, approvals, compliance controls and advanced operations.'}</Text>{billing.currentPeriodEnd && <Text variant="microcopy">Current subscription period ends {new Date(billing.currentPeriodEnd).toLocaleDateString()}.</Text>}<Divider /><Flex direction="row" gap="small" wrap="wrap">{billing.tier !== 'enterprise' && <Button disabled={working || !billing.checkoutConfigured} onClick={() => void run(async () => { const result = await request('/billing/checkout', 'POST', { tier: nextTier, interval: 'year', usageMode: 'capped', overageEnabled: false }); setCheckoutUrl(result.url); })}>{billing.tier === 'free' ? 'Upgrade to Growth' : 'Explore Enterprise'}</Button>}<Button variant="secondary" disabled={working || !billing.portalConfigured} onClick={() => void run(async () => { const result = await request('/billing/portal', 'POST', {}); setPortalUrl(result.url); })}>Manage subscription</Button></Flex>{checkoutUrl && <Alert title="Secure checkout ready" variant="success"><Link href={{ url: checkoutUrl, external: true }}>Continue to checkout</Link></Alert>}{portalUrl && <Link href={{ url: portalUrl, external: true }}>Open subscription management</Link>}</Flex></Card>
    <Flex direction="column" gap="small"><Flex direction="row" justify="between" align="center"><Flex direction="column"><Heading>Compare plans</Heading><Text>Capabilities increase progressively from readiness visibility to automation and enterprise governance.</Text></Flex><StatusTag variant="default">You have {plan}</StatusTag></Flex>{PLAN_COMPARISON.map((row) => <Card key={row.feature}><Flex direction="column" gap="small"><Text format={{ fontWeight: 'bold' }}>{row.feature}</Text><Flex direction="row" gap="medium" wrap="wrap"><Text><Text format={{ fontWeight: billing.tier === 'free' ? 'bold' : 'normal' }}>Free</Text> · {row.free}</Text><Text><Text format={{ fontWeight: billing.tier === 'growth' || billing.tier === 'beta_growth' ? 'bold' : 'normal' }}>Growth</Text> · {row.growth}</Text><Text><Text format={{ fontWeight: billing.tier === 'enterprise' ? 'bold' : 'normal' }}>Enterprise</Text> · {row.enterprise}</Text></Flex></Flex></Card>)}</Flex>
    <Alert title="Need more control?" variant="info">Growth is designed for teams that need automation and native reporting. Enterprise adds governed policies, approvals, scoped access and compliance controls.</Alert>
  </Flex>;
};
