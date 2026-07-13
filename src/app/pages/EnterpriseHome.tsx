import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Alert,
  Button,
  Card,
  Divider,
  Flex,
  Heading,
  Input,
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
  staleDays: number;
  maxStageAgeDays: number;
  requireOwner: boolean;
  requireAmount: boolean;
  requireCloseDate: boolean;
  requireNextStep: boolean;
  requireCompany: boolean;
  requireContact: boolean;
  excludedPipelineIds: string[];
  excludedStageIds: string[];
  customRequiredProperties: Array<Record<string, unknown>>;
};
type Policy = {
  id: string;
  versionNumber: number;
  name: string;
  description: string;
  status: PolicyStatus;
  rules: Rules;
  changeSummary: string;
  createdByEmail: string | null;
  approvedByEmail: string | null;
  publishedByEmail: string | null;
  createdAt: string;
  updatedAt: string;
};
type RoleAssignment = { userId: string | null; userEmail: string | null; role: GovernanceRole; updatedAt: string };
type AuditEvent = { id: string; action: string; userId: string | null; userEmail: string | null; metadata: unknown; createdAt: string };
type Overview = {
  governance: { role: GovernanceRole; permissions: string[]; governanceEnabled: boolean; installerBootstrap: boolean };
  activePolicy: Policy | null;
  latestSimulation: null | {
    id: string; policyId: string; status: 'running' | 'completed' | 'failed'; totalDeals: number;
    changedDeals: number; readyDeals: number; atRiskDeals: number; criticalDeals: number;
    averageScore: number; previousAverageScore: number; errorMessage: string | null;
  };
  current: {
    totalDeals: number; readyDeals: number; atRiskDeals: number; criticalDeals: number;
    averageScore: number; totalPipelineAmount: number; amountAtRisk: number; incompleteHandoffs: number;
  };
  trend: Array<{ date: string; averageScore: number; amountAtRisk: number; criticalDeals: number }>;
  byPipeline: Array<{ pipelineId: string; pipelineLabel: string; totalDeals: number; criticalDeals: number; amountAtRisk: number; averageScore: number }>;
  byOwner: Array<{ ownerId: string; totalDeals: number; criticalDeals: number; amountAtRisk: number; averageScore: number }>;
  pendingApprovals: number;
  openExceptions: number;
};
type RequestOptions = { method?: 'GET' | 'POST' | 'PUT'; body?: Record<string, unknown> };

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

const EnterpriseHome = () => {
  const [overview, setOverview] = useState<Overview | null>(null);
  const [policies, setPolicies] = useState<Policy[]>([]);
  const [roles, setRoles] = useState<RoleAssignment[]>([]);
  const [auditEvents, setAuditEvents] = useState<AuditEvent[]>([]);
  const [selected, setSelected] = useState<Policy | null>(null);
  const [roleEmail, setRoleEmail] = useState('');
  const [roleValue, setRoleValue] = useState<GovernanceRole>('viewer');
  const [loading, setLoading] = useState(true);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const fetchJson = async (path: string, options?: RequestOptions) => {
    const response = await hubspot.fetch(`${API_BASE}${path}`, {
      method: options?.method ?? 'GET',
      timeout: 20000,
      ...(options?.body ? { body: options.body } : {}),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data?.error?.message ?? 'DealGuard enterprise request failed.');
    return data;
  };

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [overviewData, policyData] = await Promise.all([
        fetchJson('/enterprise/overview') as Promise<Overview>,
        fetchJson('/governance/policies') as Promise<{ policies: Policy[] }>,
      ]);
      const permissions = new Set(overviewData.governance.permissions);
      const [roleData, auditData] = await Promise.all([
        permissions.has('role.manage')
          ? fetchJson('/governance/roles') as Promise<{ roles: RoleAssignment[] }>
          : Promise.resolve({ roles: [] as RoleAssignment[] }),
        permissions.has('audit.view')
          ? fetchJson('/governance/audit?limit=30') as Promise<{ events: AuditEvent[] }>
          : Promise.resolve({ events: [] as AuditEvent[] }),
      ]);
      setOverview(overviewData);
      setPolicies(policyData.policies);
      setRoles(roleData.roles);
      setAuditEvents(auditData.events);
      setSelected((current) => current ? policyData.policies.find((policy) => policy.id === current.id) ?? null : null);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Enterprise home could not be loaded.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const run = async (task: () => Promise<void>, success: string) => {
    setWorking(true);
    setError(null);
    setNotice(null);
    try {
      await task();
      setNotice(success);
      await load();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'The enterprise action failed.');
    } finally {
      setWorking(false);
    }
  };

  const enable = () => run(async () => { await fetchJson('/governance/enable', { method: 'POST', body: {} }); }, 'Enterprise governance enabled and the baseline policy published.');
  const createDraft = () => run(async () => {
    const created = await fetchJson('/governance/policies', { method: 'POST', body: { name: 'Policy revision', changeSummary: 'Enterprise governance revision' } }) as Policy;
    setSelected(created);
  }, 'A new policy draft was created from the active policy.');
  const scan = () => run(async () => { await fetchJson('/scans', { method: 'POST', body: {} }); }, 'A portal assessment scan was started.');
  const assignRole = () => run(async () => {
    if (!roleEmail.trim()) throw new Error('Enter a HubSpot user email.');
    await fetchJson('/governance/roles', { method: 'PUT', body: { userEmail: roleEmail.trim(), role: roleValue } });
    setRoleEmail('');
  }, 'Governance role assigned.');

  const policyAction = (policy: Policy, action: 'submit' | 'approve' | 'reject' | 'publish' | 'rollback' | 'simulate') => run(async () => {
    await fetchJson(`/governance/policies/${policy.id}/${action}`, { method: 'POST', body: action === 'approve' ? { comment: 'Approved from DealGuard Enterprise Home.' } : action === 'reject' ? { comment: 'Rejected from DealGuard Enterprise Home.' } : {} });
  }, action === 'simulate' ? 'Policy simulation started.' : `Policy ${action} completed.`);

  const saveDraft = () => {
    if (!selected) return Promise.resolve();
    return run(async () => {
      const updated = await fetchJson(`/governance/policies/${selected.id}`, {
        method: 'PUT',
        body: { name: selected.name, description: selected.description, changeSummary: selected.changeSummary, rules: selected.rules },
      }) as Policy;
      setSelected(updated);
    }, 'Policy draft saved.');
  };

  const permissions = useMemo(() => new Set(overview?.governance.permissions ?? []), [overview]);

  if (loading) return <LoadingSpinner label="Loading DealGuard Enterprise" />;
  if (!overview) return <Alert title="DealGuard Enterprise unavailable" variant="danger">{error ?? 'Enterprise data is unavailable.'}</Alert>;

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
        <Flex direction="column" gap="extra-small">
          <Heading>DealGuard Enterprise</Heading>
          <Text>Governed revenue operations, policy lifecycle controls, and pipeline risk analytics inside HubSpot.</Text>
        </Flex>
        <StatusTag variant={overview.governance.governanceEnabled ? 'success' : 'warning'}>{overview.governance.governanceEnabled ? `${overview.governance.role} · governed` : `${overview.governance.role} · governance off`}</StatusTag>
      </Flex>

      {!overview.governance.governanceEnabled && <Alert title="Enterprise governance is not enabled" variant="warning">Enable governance to capture a baseline policy, lock direct rule changes, and require versioned publication.</Alert>}
      {!overview.governance.governanceEnabled && permissions.has('governance.enable') && <Button onClick={() => void enable()} disabled={working}>Enable enterprise governance</Button>}

      <Flex direction="row" gap="medium" wrap="wrap">
        <Card><Text format={{ fontWeight: 'bold' }}>{overview.current.averageScore}</Text><Text>Average readiness</Text></Card>
        <Card><Text format={{ fontWeight: 'bold' }}>{overview.current.criticalDeals}</Text><Text>Critical deals</Text></Card>
        <Card><Text format={{ fontWeight: 'bold' }}>{money(overview.current.amountAtRisk)}</Text><Text>Pipeline amount at risk</Text></Card>
        <Card><Text format={{ fontWeight: 'bold' }}>{overview.current.incompleteHandoffs}</Text><Text>Incomplete handoffs</Text></Card>
        <Card><Text format={{ fontWeight: 'bold' }}>{overview.pendingApprovals}</Text><Text>Policies awaiting approval</Text></Card>
      </Flex>

      {overview.activePolicy && <Card><Flex direction="column" gap="extra-small">
        <Flex direction="row" justify="between" align="center" gap="small"><Text format={{ fontWeight: 'bold' }}>Active policy v{overview.activePolicy.versionNumber}: {overview.activePolicy.name}</Text><StatusTag variant="success">published</StatusTag></Flex>
        <Text>{overview.activePolicy.description || 'No policy description.'}</Text>
        <Text variant="microcopy">Published by {overview.activePolicy.publishedByEmail ?? 'an administrator'}</Text>
      </Flex></Card>}

      {overview.latestSimulation && <Alert title={`Latest policy simulation: ${overview.latestSimulation.status}`} variant={overview.latestSimulation.status === 'failed' ? 'danger' : overview.latestSimulation.status === 'running' ? 'warning' : 'success'}>
        {overview.latestSimulation.status === 'completed'
          ? `${overview.latestSimulation.changedDeals} of ${overview.latestSimulation.totalDeals} deals would change. Average score: ${overview.latestSimulation.previousAverageScore} → ${overview.latestSimulation.averageScore}.`
          : overview.latestSimulation.status === 'failed' ? overview.latestSimulation.errorMessage ?? 'Simulation failed.' : 'DealGuard is evaluating the draft against current deals.'}
      </Alert>}

      <Divider /><Heading>Pipeline exposure</Heading>
      {overview.byPipeline.length === 0 ? <Text>No pipeline analytics are available until a scan completes.</Text> : overview.byPipeline.map((pipeline) => <Card key={pipeline.pipelineId}><Flex direction="row" justify="between" align="center" gap="small">
        <Flex direction="column" gap="extra-small"><Text format={{ fontWeight: 'bold' }}>{pipeline.pipelineLabel}</Text><Text>{pipeline.totalDeals} deals · readiness {pipeline.averageScore}</Text></Flex>
        <Flex direction="column" gap="extra-small"><Text format={{ fontWeight: 'bold' }}>{money(pipeline.amountAtRisk)}</Text><Text>{pipeline.criticalDeals} critical</Text></Flex>
      </Flex></Card>)}

      <Divider /><Flex direction="row" justify="between" align="center" gap="small"><Heading>Policy versions</Heading>{permissions.has('policy.manage') && overview.governance.governanceEnabled && <Button variant="secondary" onClick={() => void createDraft()} disabled={working}>Create draft</Button>}</Flex>
      {policies.map((policy) => <Card key={policy.id}><Flex direction="column" gap="small">
        <Flex direction="row" justify="between" align="center" gap="small"><Text format={{ fontWeight: 'bold' }}>v{policy.versionNumber} · {policy.name}</Text><StatusTag variant={policyVariant(policy.status)}>{policy.status.replace('_', ' ')}</StatusTag></Flex>
        <Text>{policy.changeSummary || policy.description || 'No change summary.'}</Text>
        <Flex direction="row" gap="small" wrap="wrap">
          {['draft', 'rejected'].includes(policy.status) && permissions.has('policy.manage') && <Button variant="secondary" onClick={() => setSelected(policy)}>Edit</Button>}
          {['draft', 'rejected'].includes(policy.status) && permissions.has('policy.submit') && <Button variant="secondary" onClick={() => void policyAction(policy, 'submit')} disabled={working}>Submit</Button>}
          {policy.status === 'pending_approval' && permissions.has('policy.approve') && <Button variant="secondary" onClick={() => void policyAction(policy, 'approve')} disabled={working}>Approve</Button>}
          {policy.status === 'pending_approval' && permissions.has('policy.approve') && <Button variant="secondary" onClick={() => void policyAction(policy, 'reject')} disabled={working}>Reject</Button>}
          {policy.status === 'approved' && permissions.has('policy.publish') && <Button onClick={() => void policyAction(policy, 'publish')} disabled={working}>Publish</Button>}
          {permissions.has('policy.simulate') && policy.status !== 'published' && <Button variant="secondary" onClick={() => void policyAction(policy, 'simulate')} disabled={working}>Simulate</Button>}
          {permissions.has('policy.manage') && ['published', 'superseded'].includes(policy.status) && <Button variant="secondary" onClick={() => void policyAction(policy, 'rollback')} disabled={working}>Create rollback draft</Button>}
        </Flex>
      </Flex></Card>)}

      {selected && ['draft', 'rejected'].includes(selected.status) && <>
        <Divider /><Heading>Edit policy v{selected.versionNumber}</Heading>
        <TextArea name="policyDescription" label="Description" value={selected.description} onChange={(value) => setSelected({ ...selected, description: value })} />
        <TextArea name="policySummary" label="Change summary" value={selected.changeSummary} onChange={(value) => setSelected({ ...selected, changeSummary: value })} />
        <Flex direction="row" gap="medium" wrap="wrap">
          <NumberInput name="policyStaleDays" label="Stale after days" min={1} max={90} value={selected.rules.staleDays} onChange={(value) => setSelected({ ...selected, rules: { ...selected.rules, staleDays: Number(value) } })} />
          <NumberInput name="policyStageAge" label="Maximum days in stage" min={1} max={365} value={selected.rules.maxStageAgeDays} onChange={(value) => setSelected({ ...selected, rules: { ...selected.rules, maxStageAgeDays: Number(value) } })} />
        </Flex>
        <Toggle label="Require deal owner" checked={selected.rules.requireOwner} onChange={(value) => setSelected({ ...selected, rules: { ...selected.rules, requireOwner: value } })} />
        <Toggle label="Require amount" checked={selected.rules.requireAmount} onChange={(value) => setSelected({ ...selected, rules: { ...selected.rules, requireAmount: value } })} />
        <Toggle label="Require close date" checked={selected.rules.requireCloseDate} onChange={(value) => setSelected({ ...selected, rules: { ...selected.rules, requireCloseDate: value } })} />
        <Toggle label="Require next step" checked={selected.rules.requireNextStep} onChange={(value) => setSelected({ ...selected, rules: { ...selected.rules, requireNextStep: value } })} />
        <Toggle label="Require company association" checked={selected.rules.requireCompany} onChange={(value) => setSelected({ ...selected, rules: { ...selected.rules, requireCompany: value } })} />
        <Toggle label="Require contact association" checked={selected.rules.requireContact} onChange={(value) => setSelected({ ...selected, rules: { ...selected.rules, requireContact: value } })} />
        <Flex direction="row" gap="small"><Button onClick={() => void saveDraft()} disabled={working}>Save draft</Button><Button variant="secondary" onClick={() => setSelected(null)}>Close editor</Button></Flex>
      </>}

      {permissions.has('role.manage') && <>
        <Divider /><Heading>Governance roles</Heading>
        <Text>Assign application-level authority independently from ordinary HubSpot record access.</Text>
        <Flex direction="row" gap="medium" wrap="wrap">
          <Input name="roleEmail" label="HubSpot user email" value={roleEmail} onChange={setRoleEmail} />
          <Select name="roleValue" label="DealGuard role" value={roleValue} options={[
            { label: 'Administrator', value: 'admin' },
            { label: 'Policy administrator', value: 'policy_admin' },
            { label: 'Approver', value: 'approver' },
            { label: 'Manager', value: 'manager' },
            { label: 'Viewer', value: 'viewer' },
          ]} onChange={(value) => setRoleValue(String(value) as GovernanceRole)} />
        </Flex>
        <Button variant="secondary" onClick={() => void assignRole()} disabled={working || !roleEmail.trim()}>Assign role</Button>
        {roles.map((role) => <Card key={`${role.userId ?? ''}:${role.userEmail ?? ''}`}><Flex direction="row" justify="between" align="center" gap="small"><Text>{role.userEmail ?? role.userId ?? 'Unknown user'}</Text><StatusTag variant={role.role === 'admin' ? 'success' : 'default'}>{role.role.replace('_', ' ')}</StatusTag></Flex></Card>)}
      </>}

      {permissions.has('audit.view') && <>
        <Divider /><Heading>Recent governance activity</Heading>
        <Text>Latest actor-attributed configuration, policy, scan, and integration events. Full CSV export is available through the enterprise audit API.</Text>
        {auditEvents.length === 0 ? <Text>No audit events are available.</Text> : auditEvents.map((event) => <Card key={event.id}><Flex direction="column" gap="extra-small">
          <Flex direction="row" justify="between" align="center" gap="small"><Text format={{ fontWeight: 'bold' }}>{event.action}</Text><Text variant="microcopy">{new Date(event.createdAt).toLocaleString()}</Text></Flex>
          <Text>{event.userEmail ?? event.userId ?? 'System'}</Text>
        </Flex></Card>)}
      </>}
    </Flex>
  );
};
