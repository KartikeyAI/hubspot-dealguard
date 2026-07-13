import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Alert,
  Button,
  Card,
  Divider,
  Flex,
  Heading,
  Input,
  Link,
  LoadingSpinner,
  NumberInput,
  Select,
  StatusTag,
  Text,
  TextArea,
  Toggle,
  hubspot,
} from '@hubspot/ui-extensions';
import {
  HeaderActions,
  PrimaryHeaderActionButton,
  SecondaryHeaderActionButton,
} from '@hubspot/ui-extensions/pages/home';

const API_BASE = 'https://dealguard-api.rokad.co/api/v1';

type PolicyStatus = 'draft' | 'pending_approval' | 'approved' | 'published' | 'superseded' | 'rejected';
type GovernanceRole = 'admin' | 'policy_admin' | 'approver' | 'manager' | 'viewer';
type Rules = {
  staleDays: number; maxStageAgeDays: number; requireOwner: boolean; requireAmount: boolean;
  requireCloseDate: boolean; requireNextStep: boolean; requireCompany: boolean; requireContact: boolean;
  excludedPipelineIds: string[]; excludedStageIds: string[]; customRequiredProperties: Array<Record<string, unknown>>;
};
type Policy = {
  id: string; versionNumber: number; name: string; description: string; status: PolicyStatus; rules: Rules;
  changeSummary: string; createdByEmail: string | null; approvedByEmail: string | null;
  publishedByEmail: string | null; createdAt: string; updatedAt: string;
};
type RoleAssignment = { userId: string | null; userEmail: string | null; role: GovernanceRole; updatedAt: string };
type AuditEvent = { id: string; action: string; userId: string | null; userEmail: string | null; metadata: unknown; createdAt: string };
type Overview = {
  governance: { role: GovernanceRole; permissions: string[]; governanceEnabled: boolean; installerBootstrap: boolean };
  activePolicy: Policy | null;
  latestSimulation: null | { id: string; policyId: string; status: 'running' | 'completed' | 'failed'; totalDeals: number; changedDeals: number; readyDeals: number; atRiskDeals: number; criticalDeals: number; averageScore: number; previousAverageScore: number; errorMessage: string | null };
  current: { totalDeals: number; readyDeals: number; atRiskDeals: number; criticalDeals: number; averageScore: number; totalPipelineAmount: number; amountAtRisk: number; incompleteHandoffs: number };
  trend: Array<{ date: string; averageScore: number; amountAtRisk: number; criticalDeals: number }>;
  byPipeline: Array<{ pipelineId: string; pipelineLabel: string; totalDeals: number; criticalDeals: number; amountAtRisk: number; averageScore: number }>;
  byOwner: Array<{ ownerId: string; totalDeals: number; criticalDeals: number; amountAtRisk: number; averageScore: number }>;
  pendingApprovals: number; openExceptions: number;
};
type BillingStatus = {
  tier: 'free' | 'growth' | 'enterprise'; status: string; provider: 'stripe' | 'manual' | null;
  currentPeriodEnd: string | null; trialEndsAt: string | null; graceEndsAt: string | null;
  cancelAtPeriodEnd: boolean; entitled: boolean; checkoutConfigured: boolean; portalConfigured: boolean;
};
type Health = {
  status: 'healthy' | 'degraded' | 'failing'; lastScanSuccessAt: string | null; lastWebhookSuccessAt: string | null;
  lastDeliverySuccessAt: string | null; lastFailureAt: string | null; consecutiveFailures: number; lastError: string | null;
  pendingDeliveries: number; failedDeliveries: number; deadLetters: number; overdueRemediations: number;
  subscription: BillingStatus; updatedAt: string | null;
};
type Remediation = {
  id: string; dealId: string; issueCode: string; title: string; description: string; severity: 'info' | 'warning' | 'critical';
  status: 'open' | 'acknowledged' | 'in_progress' | 'resolved' | 'waived' | 'overdue' | 'closed';
  priority: 'low' | 'medium' | 'high' | 'urgent'; ownerId: string | null; ownerEmail: string | null; dueAt: string | null;
  source: string; hubSpotTaskId: string | null; resolutionNote: string | null; createdAt: string; updatedAt: string;
};
type RemediationSummary = { open: number; overdue: number; critical: number; dueSoon: number; averageResolutionHours: number };
type Destination = { id: string; type: 'teams_workflow' | 'webhook' | 'email'; name: string; eventTypes: string[]; minimumSeverity: 'info' | 'warning' | 'critical'; pipelineIds: string[]; enabled: boolean; configured: boolean; createdAt: string; updatedAt: string };
type OutboxEvent = { id: string; eventType: string; severity: 'info' | 'warning' | 'critical'; aggregateType: string; aggregateId: string; status: 'pending' | 'processing' | 'delivered' | 'failed' | 'dead_letter'; attempts: number; lastError: string | null; availableAt: string; createdAt: string; deliveredAt: string | null };
type RequestOptions = { method?: 'GET' | 'POST' | 'PUT' | 'DELETE'; body?: Record<string, unknown> };

hubspot.extend<'home'>(() => <EnterpriseHome />);

function money(value: number): string {
  return new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 }).format(value);
}
function policyVariant(status: PolicyStatus): 'success' | 'warning' | 'danger' | 'default' {
  if (status === 'published' || status === 'approved') return 'success';
  if (status === 'pending_approval' || status === 'draft') return 'warning';
  if (status === 'rejected') return 'danger';
  return 'default';
}
function healthVariant(status: Health['status']): 'success' | 'warning' | 'danger' {
  return status === 'healthy' ? 'success' : status === 'degraded' ? 'warning' : 'danger';
}
function remediationVariant(status: Remediation['status']): 'success' | 'warning' | 'danger' | 'default' {
  if (status === 'resolved' || status === 'closed') return 'success';
  if (status === 'overdue') return 'danger';
  if (status === 'open' || status === 'in_progress' || status === 'acknowledged') return 'warning';
  return 'default';
}

const EnterpriseHome = () => {
  const [overview, setOverview] = useState<Overview | null>(null);
  const [policies, setPolicies] = useState<Policy[]>([]);
  const [roles, setRoles] = useState<RoleAssignment[]>([]);
  const [auditEvents, setAuditEvents] = useState<AuditEvent[]>([]);
  const [billing, setBilling] = useState<BillingStatus | null>(null);
  const [health, setHealth] = useState<Health | null>(null);
  const [remediationSummaryData, setRemediationSummaryData] = useState<RemediationSummary | null>(null);
  const [remediations, setRemediations] = useState<Remediation[]>([]);
  const [destinations, setDestinations] = useState<Destination[]>([]);
  const [outbox, setOutbox] = useState<OutboxEvent[]>([]);
  const [selected, setSelected] = useState<Policy | null>(null);
  const [roleEmail, setRoleEmail] = useState('');
  const [roleValue, setRoleValue] = useState<GovernanceRole>('viewer');
  const [destinationType, setDestinationType] = useState<Destination['type']>('teams_workflow');
  const [destinationName, setDestinationName] = useState('');
  const [destinationEndpoint, setDestinationEndpoint] = useState('');
  const [destinationRecipients, setDestinationRecipients] = useState('');
  const [checkoutUrl, setCheckoutUrl] = useState<string | null>(null);
  const [portalUrl, setPortalUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const fetchJson = async (path: string, options?: RequestOptions) => {
    const response = await hubspot.fetch(`${API_BASE}${path}`, {
      method: options?.method ?? 'GET', timeout: 20000, ...(options?.body ? { body: options.body } : {}),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data?.error?.message ?? 'DealGuard enterprise request failed.');
    return data;
  };

  const load = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      const [overviewData, policyData, billingData, healthData, remediationSummaryResponse, remediationResponse, destinationResponse, outboxResponse] = await Promise.all([
        fetchJson('/enterprise/overview') as Promise<Overview>,
        fetchJson('/governance/policies') as Promise<{ policies: Policy[] }>,
        fetchJson('/billing') as Promise<BillingStatus>,
        fetchJson('/operations/health') as Promise<Health>,
        fetchJson('/remediations/summary') as Promise<RemediationSummary>,
        fetchJson('/remediations?limit=25') as Promise<{ cases: Remediation[] }>,
        fetchJson('/operations/destinations') as Promise<{ destinations: Destination[] }>,
        fetchJson('/operations/outbox?limit=25') as Promise<{ events: OutboxEvent[] }>,
      ]);
      const permissions = new Set(overviewData.governance.permissions);
      const [roleData, auditData] = await Promise.all([
        permissions.has('role.manage') ? fetchJson('/governance/roles') as Promise<{ roles: RoleAssignment[] }> : Promise.resolve({ roles: [] as RoleAssignment[] }),
        permissions.has('audit.view') ? fetchJson('/governance/audit?limit=30') as Promise<{ events: AuditEvent[] }> : Promise.resolve({ events: [] as AuditEvent[] }),
      ]);
      setOverview(overviewData); setPolicies(policyData.policies); setRoles(roleData.roles); setAuditEvents(auditData.events);
      setBilling(billingData); setHealth(healthData); setRemediationSummaryData(remediationSummaryResponse);
      setRemediations(remediationResponse.cases); setDestinations(destinationResponse.destinations); setOutbox(outboxResponse.events);
      setSelected((current) => current ? policyData.policies.find((policy) => policy.id === current.id) ?? null : null);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Enterprise home could not be loaded.');
    } finally { setLoading(false); }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const run = async (task: () => Promise<void>, success: string) => {
    setWorking(true); setError(null); setNotice(null);
    try { await task(); setNotice(success); await load(); }
    catch (caught) { setError(caught instanceof Error ? caught.message : 'The enterprise action failed.'); }
    finally { setWorking(false); }
  };

  const enable = () => run(async () => { await fetchJson('/governance/enable', { method: 'POST', body: {} }); }, 'Enterprise governance enabled.');
  const createDraft = () => run(async () => { const created = await fetchJson('/governance/policies', { method: 'POST', body: { name: 'Policy revision', changeSummary: 'Enterprise governance revision' } }) as Policy; setSelected(created); }, 'Policy draft created.');
  const scan = () => run(async () => { await fetchJson('/scans', { method: 'POST', body: {} }); }, 'Assessment scan started.');
  const assignRole = () => run(async () => { if (!roleEmail.trim()) throw new Error('Enter a HubSpot user email.'); await fetchJson('/governance/roles', { method: 'PUT', body: { userEmail: roleEmail.trim(), role: roleValue } }); setRoleEmail(''); }, 'Governance role assigned.');
  const policyAction = (policy: Policy, action: 'submit' | 'approve' | 'reject' | 'publish' | 'rollback' | 'simulate') => run(async () => {
    await fetchJson(`/governance/policies/${policy.id}/${action}`, { method: 'POST', body: action === 'approve' ? { comment: 'Approved from DealGuard Enterprise Home.' } : action === 'reject' ? { comment: 'Rejected from DealGuard Enterprise Home.' } : {} });
  }, action === 'simulate' ? 'Policy simulation started.' : `Policy ${action} completed.`);
  const saveDraft = () => selected ? run(async () => { const updated = await fetchJson(`/governance/policies/${selected.id}`, { method: 'PUT', body: { name: selected.name, description: selected.description, changeSummary: selected.changeSummary, rules: selected.rules } }) as Policy; setSelected(updated); }, 'Policy draft saved.') : Promise.resolve();
  const remediationAction = (item: Remediation, action: 'acknowledge' | 'start' | 'resolve' | 'waive' | 'close' | 'reopen') => run(async () => { await fetchJson(`/remediations/${item.id}/${action}`, { method: 'POST', body: action === 'resolve' ? { note: 'Resolved from DealGuard Enterprise Home.' } : {} }); }, `Remediation ${action} completed.`);
  const createDestinationAction = () => run(async () => {
    await fetchJson('/operations/destinations', { method: 'POST', body: {
      type: destinationType, name: destinationName,
      ...(destinationType === 'email' ? { recipients: destinationRecipients.split(',').map((item) => item.trim()).filter(Boolean) } : { endpoint: destinationEndpoint }),
      eventTypes: [], minimumSeverity: 'info', pipelineIds: [],
    } });
    setDestinationName(''); setDestinationEndpoint(''); setDestinationRecipients('');
  }, 'Notification destination created.');
  const toggleDestination = (item: Destination) => run(async () => { await fetchJson(`/operations/destinations/${item.id}`, { method: 'PUT', body: { name: item.name, enabled: !item.enabled } }); }, `Destination ${item.enabled ? 'disabled' : 'enabled'}.`);
  const removeDestination = (item: Destination) => run(async () => { await fetchJson(`/operations/destinations/${item.id}`, { method: 'DELETE' }); }, 'Destination deleted.');
  const replay = (item: OutboxEvent) => run(async () => { await fetchJson(`/operations/outbox/${item.id}/replay`, { method: 'POST', body: {} }); }, 'Delivery event queued for replay.');
  const prepareCheckout = (tier: 'growth' | 'enterprise', interval: 'month' | 'year') => run(async () => { const result = await fetchJson('/billing/checkout', { method: 'POST', body: { tier, interval } }) as { url: string }; setCheckoutUrl(result.url); }, 'Secure Stripe checkout is ready.');
  const preparePortal = () => run(async () => { const result = await fetchJson('/billing/portal', { method: 'POST', body: {} }) as { url: string }; setPortalUrl(result.url); }, 'Stripe Customer Portal is ready.');

  const permissions = useMemo(() => new Set(overview?.governance.permissions ?? []), [overview]);
  const canAdmin = overview?.governance.role === 'admin';
  const canRemediate = canAdmin || overview?.governance.role === 'manager' || overview?.governance.role === 'policy_admin';

  if (loading) return <LoadingSpinner label="Loading DealGuard Enterprise" />;
  if (!overview || !billing || !health || !remediationSummaryData) return <Alert title="DealGuard Enterprise unavailable" variant="danger">{error ?? 'Enterprise data is unavailable.'}</Alert>;

  return (
    <Flex direction="column" gap="large">
      <HeaderActions>
        <PrimaryHeaderActionButton onClick={() => void scan()} disabled={working}>Run assessment scan</PrimaryHeaderActionButton>
        <SecondaryHeaderActionButton onClick={() => void load()} disabled={working}>Refresh</SecondaryHeaderActionButton>
        {permissions.has('policy.manage') && overview.governance.governanceEnabled && <SecondaryHeaderActionButton onClick={() => void createDraft()} disabled={working}>Create policy draft</SecondaryHeaderActionButton>}
      </HeaderActions>
      {error && <Alert title="Action failed" variant="danger">{error}</Alert>}
      {notice && <Alert title="DealGuard Enterprise" variant="success">{notice}</Alert>}

      <Flex direction="row" justify="between" align="center" gap="medium">
        <Flex direction="column" gap="extra-small"><Heading>DealGuard Enterprise</Heading><Text>Revenue governance, remediation operations, routed delivery, and commercial controls inside HubSpot.</Text></Flex>
        <Flex direction="row" gap="small"><StatusTag variant={healthVariant(health.status)}>{health.status}</StatusTag><StatusTag variant={billing.entitled ? 'success' : 'warning'}>{billing.tier} · {billing.status}</StatusTag></Flex>
      </Flex>

      <Flex direction="row" gap="medium" wrap="wrap">
        <Card><Text format={{ fontWeight: 'bold' }}>{overview.current.averageScore}</Text><Text>Average readiness</Text></Card>
        <Card><Text format={{ fontWeight: 'bold' }}>{overview.current.criticalDeals}</Text><Text>Critical deals</Text></Card>
        <Card><Text format={{ fontWeight: 'bold' }}>{money(overview.current.amountAtRisk)}</Text><Text>Pipeline amount at risk</Text></Card>
        <Card><Text format={{ fontWeight: 'bold' }}>{remediationSummaryData.open}</Text><Text>Open remediations</Text></Card>
        <Card><Text format={{ fontWeight: 'bold' }}>{health.deadLetters}</Text><Text>Dead letters</Text></Card>
      </Flex>

      <Heading>Service health</Heading>
      <Alert title={`Portal operations: ${health.status}`} variant={healthVariant(health.status)}>
        Pending deliveries: {health.pendingDeliveries} · Failed: {health.failedDeliveries} · Dead letters: {health.deadLetters} · Overdue remediations: {health.overdueRemediations}.{health.lastError ? ` Last error: ${health.lastError}` : ''}
      </Alert>

      <Divider /><Heading>Subscription</Heading>
      <Card><Flex direction="column" gap="small">
        <Flex direction="row" justify="between" align="center" gap="small"><Text format={{ fontWeight: 'bold' }}>{billing.tier.toUpperCase()}</Text><StatusTag variant={billing.entitled ? 'success' : 'warning'}>{billing.status}</StatusTag></Flex>
        <Text>Provider: {billing.provider ?? 'none'}{billing.currentPeriodEnd ? ` · Period ends ${new Date(billing.currentPeriodEnd).toLocaleDateString()}` : ''}{billing.graceEndsAt ? ` · Grace ends ${new Date(billing.graceEndsAt).toLocaleDateString()}` : ''}</Text>
        {canAdmin && billing.checkoutConfigured && <Flex direction="row" gap="small" wrap="wrap">
          <Button variant="secondary" onClick={() => void prepareCheckout('growth', 'month')} disabled={working}>Growth monthly</Button>
          <Button variant="secondary" onClick={() => void prepareCheckout('enterprise', 'month')} disabled={working}>Enterprise monthly</Button>
          <Button variant="secondary" onClick={() => void prepareCheckout('enterprise', 'year')} disabled={working}>Enterprise annual</Button>
          {billing.portalConfigured && <Button variant="secondary" onClick={() => void preparePortal()} disabled={working}>Manage billing</Button>}
        </Flex>}
        {checkoutUrl && <Link href={{ url: checkoutUrl, external: true }}>Open secure Stripe checkout</Link>}
        {portalUrl && <Link href={{ url: portalUrl, external: true }}>Open Stripe Customer Portal</Link>}
      </Flex></Card>

      {!overview.governance.governanceEnabled && billing.tier === 'enterprise' && <Alert title="Enterprise governance is not enabled" variant="warning">Enable governance to capture a baseline policy and lock direct scoring-rule changes.</Alert>}
      {!overview.governance.governanceEnabled && permissions.has('governance.enable') && billing.entitled && billing.tier === 'enterprise' && <Button onClick={() => void enable()} disabled={working}>Enable enterprise governance</Button>}

      <Divider /><Heading>Remediation operations</Heading>
      <Flex direction="row" gap="medium" wrap="wrap">
        <Text><Text format={{ fontWeight: 'bold' }}>{remediationSummaryData.critical}</Text> critical</Text>
        <Text><Text format={{ fontWeight: 'bold' }}>{remediationSummaryData.overdue}</Text> overdue</Text>
        <Text><Text format={{ fontWeight: 'bold' }}>{remediationSummaryData.dueSoon}</Text> due within 24h</Text>
        <Text><Text format={{ fontWeight: 'bold' }}>{remediationSummaryData.averageResolutionHours}</Text> average resolution hours</Text>
      </Flex>
      {remediations.length === 0 ? <Text>No remediation cases are open.</Text> : remediations.map((item) => <Card key={item.id}><Flex direction="column" gap="small">
        <Flex direction="row" justify="between" align="center" gap="small"><Text format={{ fontWeight: 'bold' }}>{item.title}</Text><StatusTag variant={remediationVariant(item.status)}>{item.status.replace('_', ' ')}</StatusTag></Flex>
        <Text>Deal {item.dealId} · {item.severity} · {item.priority}{item.dueAt ? ` · due ${new Date(item.dueAt).toLocaleString()}` : ''}</Text>
        <Text>{item.description}</Text>
        {item.hubSpotTaskId && <Text variant="microcopy">HubSpot task {item.hubSpotTaskId}</Text>}
        {canRemediate && <Flex direction="row" gap="small" wrap="wrap">
          {item.status === 'open' && <Button variant="secondary" onClick={() => void remediationAction(item, 'acknowledge')} disabled={working}>Acknowledge</Button>}
          {['open', 'acknowledged', 'overdue'].includes(item.status) && <Button variant="secondary" onClick={() => void remediationAction(item, 'start')} disabled={working}>Start</Button>}
          {['open', 'acknowledged', 'in_progress', 'overdue'].includes(item.status) && <Button onClick={() => void remediationAction(item, 'resolve')} disabled={working}>Resolve</Button>}
          {['resolved', 'waived', 'closed'].includes(item.status) && <Button variant="secondary" onClick={() => void remediationAction(item, 'reopen')} disabled={working}>Reopen</Button>}
        </Flex>}
      </Flex></Card>)}

      <Divider /><Heading>Delivery destinations</Heading>
      {canAdmin && billing.tier === 'enterprise' && <Card><Flex direction="column" gap="small">
        <Flex direction="row" gap="medium" wrap="wrap">
          <Select name="destinationType" label="Type" value={destinationType} options={[{ label: 'Microsoft Teams Workflow', value: 'teams_workflow' }, { label: 'Signed webhook', value: 'webhook' }, { label: 'Email', value: 'email' }]} onChange={(value) => setDestinationType(String(value) as Destination['type'])} />
          <Input name="destinationName" label="Name" value={destinationName} onChange={setDestinationName} />
        </Flex>
        {destinationType === 'email'
          ? <Input name="destinationRecipients" label="Recipients (comma separated)" value={destinationRecipients} onChange={setDestinationRecipients} />
          : <Input name="destinationEndpoint" label="HTTPS endpoint" value={destinationEndpoint} onChange={setDestinationEndpoint} />}
        <Button variant="secondary" onClick={() => void createDestinationAction()} disabled={working || !destinationName.trim()}>Create destination</Button>
      </Flex></Card>}
      {destinations.map((item) => <Card key={item.id}><Flex direction="row" justify="between" align="center" gap="small">
        <Flex direction="column" gap="extra-small"><Text format={{ fontWeight: 'bold' }}>{item.name}</Text><Text>{item.type.replace('_', ' ')} · minimum {item.minimumSeverity}</Text></Flex>
        <Flex direction="row" gap="small"><StatusTag variant={item.enabled ? 'success' : 'default'}>{item.enabled ? 'enabled' : 'disabled'}</StatusTag>{canAdmin && <Button variant="secondary" onClick={() => void toggleDestination(item)}>{item.enabled ? 'Disable' : 'Enable'}</Button>}{canAdmin && <Button variant="secondary" onClick={() => void removeDestination(item)}>Delete</Button>}</Flex>
      </Flex></Card>)}

      <Divider /><Heading>Delivery queue</Heading>
      {outbox.length === 0 ? <Text>No delivery events are recorded.</Text> : outbox.map((item) => <Card key={item.id}><Flex direction="column" gap="extra-small">
        <Flex direction="row" justify="between" align="center" gap="small"><Text format={{ fontWeight: 'bold' }}>{item.eventType}</Text><StatusTag variant={item.status === 'delivered' ? 'success' : item.status === 'dead_letter' ? 'danger' : 'warning'}>{item.status.replace('_', ' ')}</StatusTag></Flex>
        <Text>{item.aggregateType} {item.aggregateId} · attempts {item.attempts}</Text>
        {item.lastError && <Text>{item.lastError}</Text>}
        {canAdmin && ['failed', 'dead_letter'].includes(item.status) && <Button variant="secondary" onClick={() => void replay(item)} disabled={working}>Replay</Button>}
      </Flex></Card>)}

      <Divider /><Heading>Pipeline exposure</Heading>
      {overview.byPipeline.length === 0 ? <Text>No pipeline analytics are available until a scan completes.</Text> : overview.byPipeline.map((pipeline) => <Card key={pipeline.pipelineId}><Flex direction="row" justify="between" align="center" gap="small"><Flex direction="column" gap="extra-small"><Text format={{ fontWeight: 'bold' }}>{pipeline.pipelineLabel}</Text><Text>{pipeline.totalDeals} deals · readiness {pipeline.averageScore}</Text></Flex><Flex direction="column" gap="extra-small"><Text format={{ fontWeight: 'bold' }}>{money(pipeline.amountAtRisk)}</Text><Text>{pipeline.criticalDeals} critical</Text></Flex></Flex></Card>)}

      <Divider /><Flex direction="row" justify="between" align="center" gap="small"><Heading>Policy versions</Heading>{permissions.has('policy.manage') && overview.governance.governanceEnabled && <Button variant="secondary" onClick={() => void createDraft()} disabled={working}>Create draft</Button>}</Flex>
      {policies.map((policy) => <Card key={policy.id}><Flex direction="column" gap="small">
        <Flex direction="row" justify="between" align="center" gap="small"><Text format={{ fontWeight: 'bold' }}>v{policy.versionNumber} · {policy.name}</Text><StatusTag variant={policyVariant(policy.status)}>{policy.status.replace('_', ' ')}</StatusTag></Flex><Text>{policy.changeSummary || policy.description || 'No change summary.'}</Text>
        <Flex direction="row" gap="small" wrap="wrap">
          {['draft', 'rejected'].includes(policy.status) && permissions.has('policy.manage') && <Button variant="secondary" onClick={() => setSelected(policy)}>Edit</Button>}
          {['draft', 'rejected'].includes(policy.status) && permissions.has('policy.submit') && <Button variant="secondary" onClick={() => void policyAction(policy, 'submit')} disabled={working}>Submit</Button>}
          {policy.status === 'pending_approval' && permissions.has('policy.approve') && <Button variant="secondary" onClick={() => void policyAction(policy, 'approve')} disabled={working}>Approve</Button>}
          {policy.status === 'pending_approval' && permissions.has('policy.approve') && <Button variant="secondary" onClick={() => void policyAction(policy, 'reject')} disabled={working}>Reject</Button>}
          {policy.status === 'approved' && permissions.has('policy.publish') && <Button onClick={() => void policyAction(policy, 'publish')} disabled={working}>Publish</Button>}
          {permissions.has('policy.simulate') && policy.status !== 'published' && <Button variant="secondary" onClick={() => void policyAction(policy, 'simulate')} disabled={working}>Simulate</Button>}
          {permissions.has('policy.manage') && ['published', 'superseded'].includes(policy.status) && <Button variant="secondary" onClick={() => void policyAction(policy, 'rollback')} disabled={working}>Rollback draft</Button>}
        </Flex>
      </Flex></Card>)}

      {selected && ['draft', 'rejected'].includes(selected.status) && <><Divider /><Heading>Edit policy v{selected.versionNumber}</Heading><TextArea name="policyDescription" label="Description" value={selected.description} onChange={(value) => setSelected({ ...selected, description: value })} /><TextArea name="policySummary" label="Change summary" value={selected.changeSummary} onChange={(value) => setSelected({ ...selected, changeSummary: value })} /><Flex direction="row" gap="medium" wrap="wrap"><NumberInput name="policyStaleDays" label="Stale after days" min={1} max={90} value={selected.rules.staleDays} onChange={(value) => setSelected({ ...selected, rules: { ...selected.rules, staleDays: Number(value) } })} /><NumberInput name="policyStageAge" label="Maximum days in stage" min={1} max={365} value={selected.rules.maxStageAgeDays} onChange={(value) => setSelected({ ...selected, rules: { ...selected.rules, maxStageAgeDays: Number(value) } })} /></Flex><Toggle label="Require deal owner" checked={selected.rules.requireOwner} onChange={(value) => setSelected({ ...selected, rules: { ...selected.rules, requireOwner: value } })} /><Toggle label="Require amount" checked={selected.rules.requireAmount} onChange={(value) => setSelected({ ...selected, rules: { ...selected.rules, requireAmount: value } })} /><Toggle label="Require close date" checked={selected.rules.requireCloseDate} onChange={(value) => setSelected({ ...selected, rules: { ...selected.rules, requireCloseDate: value } })} /><Toggle label="Require next step" checked={selected.rules.requireNextStep} onChange={(value) => setSelected({ ...selected, rules: { ...selected.rules, requireNextStep: value } })} /><Flex direction="row" gap="small"><Button onClick={() => void saveDraft()} disabled={working}>Save draft</Button><Button variant="secondary" onClick={() => setSelected(null)}>Close editor</Button></Flex></>}

      {permissions.has('role.manage') && <><Divider /><Heading>Governance roles</Heading><Flex direction="row" gap="medium" wrap="wrap"><Input name="roleEmail" label="HubSpot user email" value={roleEmail} onChange={setRoleEmail} /><Select name="roleValue" label="DealGuard role" value={roleValue} options={[{ label: 'Administrator', value: 'admin' }, { label: 'Policy administrator', value: 'policy_admin' }, { label: 'Approver', value: 'approver' }, { label: 'Manager', value: 'manager' }, { label: 'Viewer', value: 'viewer' }]} onChange={(value) => setRoleValue(String(value) as GovernanceRole)} /></Flex><Button variant="secondary" onClick={() => void assignRole()} disabled={working || !roleEmail.trim()}>Assign role</Button>{roles.map((role) => <Card key={`${role.userId ?? ''}:${role.userEmail ?? ''}`}><Flex direction="row" justify="between" align="center" gap="small"><Text>{role.userEmail ?? role.userId ?? 'Unknown user'}</Text><StatusTag variant={role.role === 'admin' ? 'success' : 'default'}>{role.role.replace('_', ' ')}</StatusTag></Flex></Card>)}</>}

      {permissions.has('audit.view') && <><Divider /><Heading>Recent governance activity</Heading>{auditEvents.length === 0 ? <Text>No audit events are available.</Text> : auditEvents.map((event) => <Card key={event.id}><Flex direction="column" gap="extra-small"><Flex direction="row" justify="between" align="center" gap="small"><Text format={{ fontWeight: 'bold' }}>{event.action}</Text><Text variant="microcopy">{new Date(event.createdAt).toLocaleString()}</Text></Flex><Text>{event.userEmail ?? event.userId ?? 'System'}</Text></Flex></Card>)}</>}
    </Flex>
  );
};
