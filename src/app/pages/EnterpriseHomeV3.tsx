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
type Json = Record<string, any>;
type Section = 'overview' | 'policies' | 'analytics' | 'access' | 'remediation' | 'alerts' | 'compliance' | 'reliability' | 'billing';
type RequestOptions = { method?: 'GET' | 'POST' | 'PUT' | 'DELETE'; body?: Record<string, unknown> };

type Access = { role: string; permissions: string[]; scope: Json; entitled: boolean; bootstrap: boolean };
type Billing = {
  tier: string; status: string; provider: string | null; customerId: string | null; subscriptionId: string | null;
  currentPeriodStart: string | null; currentPeriodEnd: string | null; usageMode: 'capped' | 'metered'; overageEnabled: boolean;
  checkoutConfigured: boolean; portalConfigured: boolean; entitled: boolean; allowances: Json[];
  scheduledTier?: string | null; scheduledChangeAt?: string | null; scheduledChangeProviderState?: string | null;
};
type Dimensions = { teamProperty: string | null; regionProperty: string | null; dealTypeProperty: string | null };

type Policy = { id: string; name: string; versionNumber: number; status: string; description?: string; changeSummary?: string; rules?: Json };
type Remediation = { id: string; dealId: string; title: string; severity: string; status: string; ownerEmail?: string | null; ownerId?: string | null; dueAt?: string | null };

const sections: Array<{ label: string; value: Section }> = [
  { label: 'Overview', value: 'overview' },
  { label: 'Policies', value: 'policies' },
  { label: 'Analytics', value: 'analytics' },
  { label: 'Access & approvals', value: 'access' },
  { label: 'Remediation', value: 'remediation' },
  { label: 'Alerts', value: 'alerts' },
  { label: 'Compliance', value: 'compliance' },
  { label: 'Reliability', value: 'reliability' },
  { label: 'Billing', value: 'billing' },
];

function date(value: unknown): string {
  if (!value) return '—';
  const parsed = Date.parse(String(value));
  return Number.isFinite(parsed) ? new Date(parsed).toLocaleString() : String(value);
}
function money(value: unknown): string {
  return new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 }).format(Number(value ?? 0));
}
function csv(value: string): string[] {
  return value.split(/[\n,]/).map((item) => item.trim()).filter(Boolean);
}
function statusVariant(status: string): 'success' | 'warning' | 'danger' | 'default' {
  if (['active', 'published', 'approved', 'healthy', 'completed', 'resolved', 'closed', 'delivered', 'applied'].includes(status)) return 'success';
  if (['pending', 'pending_approval', 'draft', 'degraded', 'open', 'acknowledged', 'in_progress', 'past_due', 'trialing'].includes(status)) return 'warning';
  if (['failed', 'rejected', 'failing', 'overdue', 'dead_letter', 'cancelled', 'expired'].includes(status)) return 'danger';
  return 'default';
}

hubspot.extend<'home'>(() => <EnterpriseHome />);

const EnterpriseHome = () => {
  const [section, setSection] = useState<Section>('overview');
  const [loading, setLoading] = useState(true);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [access, setAccess] = useState<Access | null>(null);
  const [billing, setBilling] = useState<Billing | null>(null);
  const [overview, setOverview] = useState<Json | null>(null);
  const [analytics, setAnalytics] = useState<Json | null>(null);
  const [roles, setRoles] = useState<Json[]>([]);
  const [approvals, setApprovals] = useState<Json[]>([]);
  const [templates, setTemplates] = useState<Json[]>([]);
  const [policies, setPolicies] = useState<Policy[]>([]);
  const [segments, setSegments] = useState<Json[]>([]);
  const [policyDiff, setPolicyDiff] = useState<Json[]>([]);
  const [selectedPolicy, setSelectedPolicy] = useState('');
  const [remediations, setRemediations] = useState<Remediation[]>([]);
  const [remediationSummary, setRemediationSummary] = useState<Json | null>(null);
  const [alerts, setAlerts] = useState<Json | null>(null);
  const [compliance, setCompliance] = useState<Json | null>(null);
  const [reliability, setReliability] = useState<Json | null>(null);
  const [usage, setUsage] = useState<Json | null>(null);
  const [metadata, setMetadata] = useState<Json | null>(null);
  const [dimensions, setDimensions] = useState<Dimensions>({ teamProperty: null, regionProperty: null, dealTypeProperty: null });
  const [secureUrl, setSecureUrl] = useState<string | null>(null);

  const [draftName, setDraftName] = useState('Enterprise policy revision');
  const [draftSummary, setDraftSummary] = useState('Governed enterprise policy change');
  const [templateName, setTemplateName] = useState('');
  const [segmentName, setSegmentName] = useState('Enterprise segment');
  const [segmentPriority, setSegmentPriority] = useState(100);
  const [segmentPipelines, setSegmentPipelines] = useState('');
  const [segmentStages, setSegmentStages] = useState('');
  const [segmentTeams, setSegmentTeams] = useState('');
  const [segmentOwners, setSegmentOwners] = useState('');
  const [segmentRegions, setSegmentRegions] = useState('');
  const [segmentDealTypes, setSegmentDealTypes] = useState('');
  const [segmentMinAmount, setSegmentMinAmount] = useState(0);
  const [segmentMaxAmount, setSegmentMaxAmount] = useState(0);
  const [policyImport, setPolicyImport] = useState('');

  const [analyticsDays, setAnalyticsDays] = useState(90);
  const [analyticsAudience, setAnalyticsAudience] = useState('executive');
  const [viewName, setViewName] = useState('');

  const [roleEmail, setRoleEmail] = useState('');
  const [roleUserId, setRoleUserId] = useState('');
  const [roleName, setRoleName] = useState('viewer');
  const [rolePipelines, setRolePipelines] = useState('');
  const [roleTeams, setRoleTeams] = useState('');
  const [roleOwners, setRoleOwners] = useState('');
  const [roleRegions, setRoleRegions] = useState('');

  const [caseId, setCaseId] = useState('');
  const [evidenceLabel, setEvidenceLabel] = useState('Resolution evidence');
  const [evidenceValue, setEvidenceValue] = useState('');
  const [commentValue, setCommentValue] = useState('');
  const [bulkCases, setBulkCases] = useState('');
  const [bulkOperation, setBulkOperation] = useState('assign');

  const [channelType, setChannelType] = useState('slack_webhook');
  const [channelName, setChannelName] = useState('');
  const [channelEndpoint, setChannelEndpoint] = useState('');
  const [channelRecipients, setChannelRecipients] = useState('');
  const [routeName, setRouteName] = useState('');
  const [routeChannels, setRouteChannels] = useState('');
  const [routeEvents, setRouteEvents] = useState('');
  const [routePipelines, setRoutePipelines] = useState('');
  const [routeTeams, setRouteTeams] = useState('');
  const [routeOwners, setRouteOwners] = useState('');
  const [routeRegions, setRouteRegions] = useState('');

  const [auditRetention, setAuditRetention] = useState(2555);
  const [operationalRetention, setOperationalRetention] = useState(730);
  const [holdName, setHoldName] = useState('');
  const [holdReason, setHoldReason] = useState('');
  const [siemName, setSiemName] = useState('');
  const [siemEndpoint, setSiemEndpoint] = useState('');
  const [exportScope, setExportScope] = useState('complete');
  const [exportFormat, setExportFormat] = useState('json');

  const [sloService, setSloService] = useState('api');
  const [sloAvailability, setSloAvailability] = useState(99.9);
  const [sloLatency, setSloLatency] = useState(2000);
  const [syntheticName, setSyntheticName] = useState('Production health');
  const [syntheticType, setSyntheticType] = useState('health');
  const [syntheticTarget, setSyntheticTarget] = useState('');
  const [incidentTitle, setIncidentTitle] = useState('');
  const [incidentSeverity, setIncidentSeverity] = useState('major');

  const [checkoutTier, setCheckoutTier] = useState('enterprise');
  const [checkoutInterval, setCheckoutInterval] = useState('year');
  const [usageMode, setUsageMode] = useState('capped');
  const [overageEnabled, setOverageEnabled] = useState(false);
  const [checkoutUrl, setCheckoutUrl] = useState<string | null>(null);
  const [portalUrl, setPortalUrl] = useState<string | null>(null);
  const [planEffectiveAt, setPlanEffectiveAt] = useState('next_billing_date');
  const [prorationMode, setProrationMode] = useState('prorated_immediately');
  const [paymentFailureMode, setPaymentFailureMode] = useState('prevent_change');
  const [planPreview, setPlanPreview] = useState<Json | null>(null);
  const [allowanceMetric, setAllowanceMetric] = useState('active_deal_overage');
  const [includedQuantity, setIncludedQuantity] = useState(5000);
  const [hardLimit, setHardLimit] = useState(10000);

  const request = async (path: string, options?: RequestOptions) => {
    const response = await hubspot.fetch(`${API_BASE}${path}`, {
      method: options?.method ?? 'GET',
      timeout: 25000,
      ...(options?.body ? { body: options.body } : {}),
    });
    const data = await response.json();
    if (!response.ok) {
      const detail = data?.error?.details?.approvalId ? ` Approval: ${data.error.details.approvalId}.` : '';
      throw new Error(`${data?.error?.message ?? 'DealGuard enterprise request failed.'}${detail}`);
    }
    return data;
  };

  const can = useCallback((permission: string) => Boolean(access?.permissions?.some((granted) => granted === '*' || granted === permission || (granted.endsWith('.*') && permission.startsWith(granted.slice(0, -1))))), [access]);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [accessData, billingData, overviewData, analyticsData, roleData, approvalData, templateData, policyData, remediationData, remediationSummaryData, alertData, complianceData, reliabilityData, usageData, metadataData, dimensionData] = await Promise.all([
        request('/enterprise/access') as Promise<Access>,
        request('/billing') as Promise<Billing>,
        request('/enterprise/overview'),
        request(`/enterprise/analytics?days=${analyticsDays}&audience=${encodeURIComponent(analyticsAudience)}`),
        request('/enterprise/roles'),
        request('/enterprise/change-approvals'),
        request('/enterprise/policy-templates'),
        request('/governance/policies'),
        request('/remediations?limit=100'),
        request('/remediations/summary'),
        request('/enterprise/alerts'),
        request('/enterprise/compliance'),
        request('/enterprise/reliability'),
        request('/billing/usage'),
        request('/metadata'),
        request('/enterprise/policy-dimensions'),
      ]);
      setAccess(accessData);
      setBilling(billingData);
      setOverview(overviewData);
      setAnalytics(analyticsData);
      setRoles(roleData.roles ?? []);
      setApprovals(approvalData.approvals ?? []);
      setTemplates(templateData.templates ?? []);
      setPolicies(policyData.policies ?? []);
      setRemediations(remediationData.cases ?? []);
      setRemediationSummary(remediationSummaryData);
      setAlerts(alertData);
      setCompliance(complianceData);
      setReliability(reliabilityData);
      setUsage(usageData);
      setMetadata(metadataData);
      setDimensions(dimensionData);
      setAuditRetention(Number(complianceData.settings?.auditRetentionDays ?? 2555));
      setOperationalRetention(Number(complianceData.settings?.operationalRetentionDays ?? 730));
      const selected = selectedPolicy || policyData.policies?.[0]?.id || '';
      setSelectedPolicy(selected);
      if (selected) {
        const [segmentData, diffData] = await Promise.all([
          request(`/governance/policies/${selected}/segments`),
          request(`/governance/policies/${selected}/diff`),
        ]);
        setSegments(segmentData.segments ?? []);
        setPolicyDiff(diffData.diff ?? []);
      } else {
        setSegments([]);
        setPolicyDiff([]);
      }
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Enterprise App Home could not be loaded.');
    } finally {
      setLoading(false);
    }
  }, [analyticsAudience, analyticsDays, selectedPolicy]);

  useEffect(() => { void load(); }, [load]);

  const act = async (task: () => Promise<void>, success: string) => {
    setWorking(true); setError(null); setNotice(null);
    try {
      await task();
      setNotice(success);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'The enterprise action failed.');
    } finally {
      await load();
      setWorking(false);
    }
  };

  const secureDownload = async (kind: string, body: Json) => act(async () => {
    const result = await request('/enterprise/downloads', { method: 'POST', body: { kind, ...body } });
    setSecureUrl(result.url);
  }, 'Secure single-use export prepared.');

  const propertyOptions = useMemo(() => [
    { label: 'Not configured', value: '' },
    ...((metadata?.properties ?? []) as Json[]).map((item) => ({ label: `${item.label} (${item.name})`, value: String(item.name) })),
  ], [metadata]);

  if (loading || !access || !billing) return <LoadingSpinner label="Loading DealGuard Enterprise" />;

  const current = analytics?.current ?? {};
  const overviewSection = <Flex direction="column" gap="large">
    <Flex direction="row" gap="medium" wrap="wrap">
      <Card><Heading>{current.averageScore ?? 0}</Heading><Text>Average readiness</Text></Card>
      <Card><Heading>${money(current.amountAtRisk)}</Heading><Text>Amount at risk</Text></Card>
      <Card><Heading>{current.critical ?? current.criticalDeals ?? 0}</Heading><Text>Critical deals</Text></Card>
      <Card><Heading>{remediationSummary?.overdue ?? 0}</Heading><Text>Overdue remediation</Text></Card>
    </Flex>
    <Card><Heading>Enterprise posture</Heading><Text>Role: {access.role} · {access.entitled ? 'Enterprise entitled' : 'Enterprise subscription required'}</Text><Text>Active policy: {overview?.activePolicy?.name ?? 'No published policy'} · pending approvals {approvals.filter((item) => item.status === 'pending').length}</Text><Text>Dodo subscription: {billing.tier} · {billing.status} · {billing.usageMode}</Text></Card>
    <Card><Heading>Operational health</Heading><Text>{reliability?.summary?.status ?? overview?.health?.status ?? 'unknown'} · dead letters {overview?.health?.deadLetters ?? 0} · open incidents {(reliability?.incidents ?? []).filter((item: Json) => item.status !== 'resolved').length}</Text></Card>
  </Flex>;

  const policySection = <Flex direction="column" gap="large">
    <Card><Flex direction="column" gap="small"><Heading>Policy dimension mappings</Heading><Text>Map the customer’s own HubSpot deal properties used for team, region, and deal-type segmentation. Pipeline, stage, owner, and amount are native.</Text><Select name="teamDimension" label="Team property" value={dimensions.teamProperty ?? ''} options={propertyOptions} onChange={(value) => setDimensions({ ...dimensions, teamProperty: String(value) || null })} /><Select name="regionDimension" label="Region property" value={dimensions.regionProperty ?? ''} options={propertyOptions} onChange={(value) => setDimensions({ ...dimensions, regionProperty: String(value) || null })} /><Select name="dealTypeDimension" label="Deal type property" value={dimensions.dealTypeProperty ?? ''} options={propertyOptions} onChange={(value) => setDimensions({ ...dimensions, dealTypeProperty: String(value) || null })} /><Button disabled={working || !can('policy.manage')} onClick={() => void act(async () => { await request('/enterprise/policy-dimensions', { method: 'PUT', body: dimensions as unknown as Record<string, unknown> }); }, 'Policy dimension mappings saved.')}>Save mappings</Button></Flex></Card>
    <Card><Flex direction="column" gap="small"><Heading>Create policy draft</Heading><Input name="draftName" label="Name" value={draftName} onChange={setDraftName} /><Input name="draftSummary" label="Change summary" value={draftSummary} onChange={setDraftSummary} /><Button disabled={working || !can('policy.manage')} onClick={() => void act(async () => { const created = await request('/governance/policies', { method: 'POST', body: { name: draftName, changeSummary: draftSummary } }); setSelectedPolicy(created.id); }, 'Policy draft created.')}>Create draft</Button></Flex></Card>
    <Flex direction="row" gap="small" wrap="wrap"><Select name="selectedPolicy" label="Policy version" value={selectedPolicy} options={policies.map((item) => ({ label: `v${item.versionNumber} · ${item.name} · ${item.status}`, value: item.id }))} onChange={(value) => setSelectedPolicy(String(value))} /><Button variant="secondary" disabled={!selectedPolicy || working || !can('policy.submit')} onClick={() => void act(async () => { await request(`/governance/policies/${selectedPolicy}/submit`, { method: 'POST', body: {} }); }, 'Policy submitted.')}>Submit</Button><Button variant="secondary" disabled={!selectedPolicy || working || !can('policy.approve')} onClick={() => void act(async () => { await request(`/governance/policies/${selectedPolicy}/approve`, { method: 'POST', body: { comment: 'Approved in Enterprise App Home.' } }); }, 'Policy approved.')}>Approve</Button><Button variant="secondary" disabled={!selectedPolicy || working || !can('policy.publish')} onClick={() => void act(async () => { await request(`/governance/policies/${selectedPolicy}/publish`, { method: 'POST', body: {} }); }, 'Policy published.')}>Publish</Button><Button variant="secondary" disabled={!selectedPolicy || working || !can('policy.simulate')} onClick={() => void act(async () => { await request(`/governance/policies/${selectedPolicy}/simulate`, { method: 'POST', body: {} }); }, 'Production-equivalent simulation started.')}>Simulate</Button><Button variant="secondary" disabled={!selectedPolicy || working || !can('policy.manage')} onClick={() => void act(async () => { const created = await request(`/governance/policies/${selectedPolicy}/rollback`, { method: 'POST', body: { name: 'Rollback draft', changeSummary: 'Rollback generated from Enterprise App Home.' } }); setSelectedPolicy(created.id); }, 'Rollback draft created.')}>Rollback</Button></Flex>
    <Card><Flex direction="column" gap="small"><Heading>Policy template</Heading><Select name="template" label="Template" value={templateName} options={templates.map((item) => ({ label: item.name, value: item.id ?? item.slug ?? item.name }))} onChange={(value) => setTemplateName(String(value))} /><Button disabled={working || !templateName || !can('policy.manage')} onClick={() => void act(async () => { const created = await request(`/enterprise/policy-templates/${encodeURIComponent(templateName)}/apply`, { method: 'POST', body: {} }); setSelectedPolicy(created.id); }, 'Template applied to a new draft.')}>Apply template</Button></Flex></Card>
    <Card><Flex direction="column" gap="small"><Heading>Add scoped segment</Heading><Input name="segmentName" label="Name" value={segmentName} onChange={setSegmentName} /><NumberInput name="segmentPriority" label="Priority" value={segmentPriority} min={0} max={10000} onChange={(value) => setSegmentPriority(Number(value))} /><Input name="segmentPipelines" label="Pipeline IDs" value={segmentPipelines} onChange={setSegmentPipelines} /><Input name="segmentStages" label="Stage IDs" value={segmentStages} onChange={setSegmentStages} /><Input name="segmentTeams" label="Team values" value={segmentTeams} onChange={setSegmentTeams} /><Input name="segmentOwners" label="Owner IDs" value={segmentOwners} onChange={setSegmentOwners} /><Input name="segmentRegions" label="Region values" value={segmentRegions} onChange={setSegmentRegions} /><Input name="segmentDealTypes" label="Deal-type values" value={segmentDealTypes} onChange={setSegmentDealTypes} /><Flex direction="row" gap="medium" wrap="wrap"><NumberInput name="segmentMin" label="Minimum amount" value={segmentMinAmount} min={0} onChange={(value) => setSegmentMinAmount(Number(value))} /><NumberInput name="segmentMax" label="Maximum amount (0 = none)" value={segmentMaxAmount} min={0} onChange={(value) => setSegmentMaxAmount(Number(value))} /></Flex><Button disabled={working || !selectedPolicy || !can('policy.manage')} onClick={() => void act(async () => { await request(`/governance/policies/${selectedPolicy}/segments`, { method: 'POST', body: { name: segmentName, priority: segmentPriority, enabled: true, conditions: { pipelineIds: csv(segmentPipelines), stageIds: csv(segmentStages), teamIds: csv(segmentTeams), ownerIds: csv(segmentOwners), regionCodes: csv(segmentRegions), dealTypes: csv(segmentDealTypes), minAmount: segmentMinAmount || null, maxAmount: segmentMaxAmount || null }, rulesOverride: {} } }); }, 'Policy segment created.')}>Create segment</Button></Flex></Card>
    {segments.map((item) => <Card key={item.id}><Flex direction="row" justify="between" align="center" gap="small"><Flex direction="column"><Text format={{ fontWeight: 'bold' }}>{item.name}</Text><Text>Priority {item.priority} · {JSON.stringify(item.conditions)}</Text></Flex><Button variant="secondary" disabled={working || !can('policy.manage')} onClick={() => void act(async () => { await request(`/governance/policies/${selectedPolicy}/segments/${item.id}`, { method: 'DELETE' }); }, 'Policy segment deleted.')}>Delete</Button></Flex></Card>)}
    <Card><Heading>Policy diff</Heading>{policyDiff.length ? policyDiff.slice(0, 100).map((item, index) => <Text key={`${item.path}-${index}`}>{item.path}: {JSON.stringify(item.before)} → {JSON.stringify(item.after)}</Text>) : <Text>No changes to display.</Text>}</Card>
    <Card><Flex direction="column" gap="small"><Heading>Import / export</Heading><TextArea name="policyImport" label="Policy package JSON" value={policyImport} onChange={setPolicyImport} /><Button disabled={working || !can('policy.manage') || !policyImport} onClick={() => void act(async () => { const created = await request('/governance/policies/import', { method: 'POST', body: JSON.parse(policyImport) }); setSelectedPolicy(created.id); }, 'Policy package imported.')}>Import</Button><Button variant="secondary" disabled={!selectedPolicy || working} onClick={() => void secureDownload('policy', { resourceId: selectedPolicy, format: 'json' })}>Prepare secure export</Button></Flex></Card>
  </Flex>;

  const analyticsSection = <Flex direction="column" gap="large">
    <Flex direction="row" gap="medium" wrap="wrap"><NumberInput name="days" label="History days" value={analyticsDays} min={1} max={730} onChange={(value) => setAnalyticsDays(Number(value))} /><Select name="audience" label="Audience" value={analyticsAudience} options={[{ label: 'Executive', value: 'executive' }, { label: 'RevOps', value: 'revops' }, { label: 'Sales manager', value: 'sales_manager' }, { label: 'Representative', value: 'representative' }]} onChange={(value) => setAnalyticsAudience(String(value))} /><Button onClick={() => void load()} disabled={working}>Refresh</Button></Flex>
    <Flex direction="row" gap="medium" wrap="wrap"><Card><Heading>{current.averageScore ?? 0}</Heading><Text>Average score</Text></Card><Card><Heading>${money(current.pipelineAmount)}</Heading><Text>Pipeline</Text></Card><Card><Heading>${money(current.amountAtRisk)}</Heading><Text>At risk</Text></Card><Card><Heading>{current.averageStageAgeDays ?? 0}</Heading><Text>Average stage age</Text></Card></Flex>
    <Card><Heading>Readiness trend</Heading>{(analytics?.trend ?? []).slice(-30).map((item: Json) => <Text key={item.date}>{item.date}: score {item.averageScore} · ${money(item.amountAtRisk)} at risk · {item.critical} critical</Text>)}</Card>
    <Card><Heading>Stage-aging heatmap</Heading>{(analytics?.stageAgingHeatmap ?? []).slice(0, 50).map((item: Json) => <Text key={`${item.pipeline}-${item.stage}`}>{item.pipeline} / {item.stage}: {item.deals} deals · {item.averageAgeDays} days · {item.critical} critical</Text>)}</Card>
    <Card><Heading>Failure patterns</Heading>{(analytics?.failurePatterns ?? []).slice(0, 30).map((item: Json) => <Text key={item.code}>{item.code}: {item.count}</Text>)}</Card>
    <Card><Flex direction="column" gap="small"><Heading>Saved view and export</Heading><Input name="viewName" label="View name" value={viewName} onChange={setViewName} /><Button disabled={working || !viewName} onClick={() => void act(async () => { await request('/enterprise/analytics/views', { method: 'POST', body: { name: viewName, audience: analyticsAudience, filters: { days: analyticsDays }, isShared: true } }); }, 'Analytics view saved.')}>Save shared view</Button><Button variant="secondary" disabled={working || !can('analytics.export')} onClick={() => void secureDownload('analytics', { format: 'csv', params: { days: analyticsDays, audience: analyticsAudience } })}>Prepare secure CSV</Button></Flex></Card>
  </Flex>;

  const accessSection = <Flex direction="column" gap="large">
    <Heading>Enterprise roles and scopes</Heading>
    {roles.map((item) => <Card key={item.id}><Flex direction="row" justify="between" align="center" gap="small"><Flex direction="column"><Text format={{ fontWeight: 'bold' }}>{item.userEmail ?? item.userId}</Text><Text>{item.role} · pipelines {(item.scope?.pipelineIds ?? []).join(', ') || 'all'} · teams {(item.scope?.teamIds ?? []).join(', ') || 'all'}</Text></Flex><Button variant="secondary" disabled={working || !can('role.manage')} onClick={() => void act(async () => { await request(`/enterprise/roles/${item.id}`, { method: 'DELETE', body: {} }); }, 'Role removal requested or applied.')}>Remove</Button></Flex></Card>)}
    <Card><Flex direction="column" gap="small"><Heading>Assign scoped role</Heading><Input name="roleEmail" label="HubSpot user email" value={roleEmail} onChange={setRoleEmail} /><Input name="roleUserId" label="HubSpot user ID (optional)" value={roleUserId} onChange={setRoleUserId} /><Select name="role" label="Role" value={roleName} options={['administrator','policy_administrator','revops_manager','sales_manager','reviewer','remediation_manager','compliance_auditor','billing_administrator','viewer'].map((value) => ({ label: value.replaceAll('_', ' '), value }))} onChange={(value) => setRoleName(String(value))} /><Input name="rolePipelines" label="Pipeline scope IDs" value={rolePipelines} onChange={setRolePipelines} /><Input name="roleTeams" label="Team scope values" value={roleTeams} onChange={setRoleTeams} /><Input name="roleOwners" label="Owner scope IDs" value={roleOwners} onChange={setRoleOwners} /><Input name="roleRegions" label="Region scope values" value={roleRegions} onChange={setRoleRegions} /><Button disabled={working || !can('role.manage')} onClick={() => void act(async () => { await request('/enterprise/roles', { method: 'PUT', body: { userEmail: roleEmail || undefined, userId: roleUserId || undefined, role: roleName, scope: { pipelineIds: csv(rolePipelines), teamIds: csv(roleTeams), ownerIds: csv(roleOwners), regionCodes: csv(roleRegions) } } }); }, 'Role assignment requested or applied.')}>Assign role</Button></Flex></Card>
    <Heading>Two-person approvals</Heading>
    {approvals.slice(0, 100).map((item) => <Card key={item.id}><Flex direction="column" gap="small"><Flex direction="row" justify="between"><Text format={{ fontWeight: 'bold' }}>{item.changeType}</Text><StatusTag variant={statusVariant(String(item.status))}>{item.status}</StatusTag></Flex><Text>{item.resourceType} · {item.resourceId} · requested by {item.requestedByEmail ?? 'system'}</Text><Text>{JSON.stringify(item.requestedPayload ?? {})}</Text>{item.status === 'pending' && <Flex direction="row" gap="small"><Button disabled={working || !can('change.approve')} onClick={() => void act(async () => { await request(`/enterprise/change-approvals/${item.id}/approve`, { method: 'POST', body: { comment: 'Approved in DealGuard Enterprise.' } }); }, 'Change approved. The requester can repeat the exact action.')}>Approve</Button><Button variant="secondary" disabled={working || !can('change.approve')} onClick={() => void act(async () => { await request(`/enterprise/change-approvals/${item.id}/reject`, { method: 'POST', body: { comment: 'Rejected in DealGuard Enterprise.' } }); }, 'Change rejected.')}>Reject</Button></Flex>}</Flex></Card>)}
  </Flex>;

  const remediationSection = <Flex direction="column" gap="large">
    <Flex direction="row" gap="medium" wrap="wrap"><Card><Heading>{remediationSummary?.open ?? 0}</Heading><Text>Open</Text></Card><Card><Heading>{remediationSummary?.overdue ?? 0}</Heading><Text>Overdue</Text></Card><Card><Heading>{remediationSummary?.critical ?? 0}</Heading><Text>Critical</Text></Card><Card><Heading>{remediationSummary?.averageResolutionHours ?? 0}h</Heading><Text>MTTR</Text></Card></Flex>
    {remediations.map((item) => <Card key={item.id}><Flex direction="column" gap="small"><Flex direction="row" justify="between"><Text format={{ fontWeight: 'bold' }}>{item.title}</Text><StatusTag variant={statusVariant(item.status)}>{item.status}</StatusTag></Flex><Text>Deal {item.dealId} · {item.severity} · due {date(item.dueAt)} · {item.ownerEmail ?? item.ownerId ?? 'unassigned'}</Text><Flex direction="row" gap="small" wrap="wrap"><Button variant="secondary" onClick={() => setCaseId(item.id)}>Use in evidence form</Button>{['acknowledge','start','resolve','waive','close','reopen'].map((action) => <Button key={action} variant="secondary" disabled={working || !can('remediation.manage')} onClick={() => void act(async () => { await request(`/remediations/${item.id}/${action}`, { method: 'POST', body: action === 'resolve' || action === 'waive' ? { note: `${action} from Enterprise App Home.` } : {} }); }, `Remediation ${action} completed.`)}>{action}</Button>)}</Flex></Flex></Card>)}
    <Card><Flex direction="column" gap="small"><Heading>Evidence and comments</Heading><Input name="caseId" label="Case ID" value={caseId} onChange={setCaseId} /><Input name="evidenceLabel" label="Evidence label" value={evidenceLabel} onChange={setEvidenceLabel} /><TextArea name="evidence" label="Evidence text or HTTPS URL" value={evidenceValue} onChange={setEvidenceValue} /><Button disabled={working || !caseId || !can('remediation.evidence')} onClick={() => void act(async () => { await request(`/remediations/${caseId}/evidence`, { method: 'POST', body: { type: evidenceValue.startsWith('https://') ? 'url' : 'text', label: evidenceLabel, value: evidenceValue } }); }, 'Evidence submitted.')}>Submit evidence</Button><TextArea name="comment" label="Comment" value={commentValue} onChange={setCommentValue} /><Button variant="secondary" disabled={working || !caseId || !can('remediation.manage')} onClick={() => void act(async () => { await request(`/remediations/${caseId}/comments`, { method: 'POST', body: { body: commentValue } }); }, 'Comment added.')}>Add comment</Button></Flex></Card>
    <Card><Flex direction="column" gap="small"><Heading>Bulk remediation</Heading><TextArea name="bulkCases" label="Case IDs" value={bulkCases} onChange={setBulkCases} /><Select name="bulkOperation" label="Operation" value={bulkOperation} options={['assign','acknowledge','start','resolve','waive','set_due_date','set_priority','create_tasks'].map((value) => ({ label: value.replaceAll('_', ' '), value }))} onChange={(value) => setBulkOperation(String(value))} /><Button disabled={working || !can('remediation.bulk')} onClick={() => void act(async () => { const created = await request('/remediations/bulk', { method: 'POST', body: { operation: bulkOperation, caseIds: csv(bulkCases), parameters: {} } }); await request(`/remediations/bulk/${created.id}/run`, { method: 'POST', body: {} }); }, 'Bulk remediation completed.')}>Execute bulk operation</Button></Flex></Card>
  </Flex>;

  const alertsSection = <Flex direction="column" gap="large">
    <Heading>Notification channels</Heading>{(alerts?.channels ?? []).map((item: Json) => <Card key={item.id}><Flex direction="row" justify="between"><Text>{item.name} · {item.type}</Text><StatusTag variant={item.enabled ? 'success' : 'default'}>{item.enabled ? 'enabled' : 'disabled'}</StatusTag></Flex></Card>)}
    <Card><Flex direction="column" gap="small"><Heading>Create channel</Heading><Select name="channelType" label="Type" value={channelType} options={[{ label: 'Slack webhook', value: 'slack_webhook' }, { label: 'Microsoft Teams Workflow', value: 'teams_workflow' }, { label: 'Email', value: 'email' }, { label: 'Signed webhook', value: 'webhook' }]} onChange={(value) => setChannelType(String(value))} /><Input name="channelName" label="Name" value={channelName} onChange={setChannelName} />{channelType === 'email' ? <Input name="recipients" label="Recipients" value={channelRecipients} onChange={setChannelRecipients} /> : <Input name="endpoint" label="HTTPS endpoint" value={channelEndpoint} onChange={setChannelEndpoint} />}<Button disabled={working || !can('alert.manage')} onClick={() => void act(async () => { await request('/enterprise/alerts/channels', { method: 'POST', body: { type: channelType, name: channelName, endpoint: channelEndpoint || undefined, recipients: csv(channelRecipients) } }); }, 'Notification channel created.')}>Create channel</Button></Flex></Card>
    <Heading>Routing and escalation</Heading>{(alerts?.routes ?? []).map((item: Json) => <Card key={item.id}><Text format={{ fontWeight: 'bold' }}>{item.name}</Text><Text>{item.minimumSeverity}+ · channels {(item.channelIds ?? []).join(', ')} · pipelines {(item.pipelineIds ?? []).join(', ') || 'all'} · teams {(item.teamIds ?? []).join(', ') || 'all'}</Text></Card>)}
    <Card><Flex direction="column" gap="small"><Heading>Create route</Heading><Input name="routeName" label="Name" value={routeName} onChange={setRouteName} /><Input name="routeChannels" label="Channel IDs" value={routeChannels} onChange={setRouteChannels} /><Input name="routeEvents" label="Event types" value={routeEvents} onChange={setRouteEvents} /><Input name="routePipelines" label="Pipeline IDs" value={routePipelines} onChange={setRoutePipelines} /><Input name="routeTeams" label="Team values" value={routeTeams} onChange={setRouteTeams} /><Input name="routeOwners" label="Owner IDs" value={routeOwners} onChange={setRouteOwners} /><Input name="routeRegions" label="Region values" value={routeRegions} onChange={setRouteRegions} /><Button disabled={working || !can('alert.manage')} onClick={() => void act(async () => { await request('/enterprise/alerts/routes', { method: 'POST', body: { name: routeName, channelIds: csv(routeChannels), eventTypes: csv(routeEvents), pipelineIds: csv(routePipelines), teamIds: csv(routeTeams), ownerIds: csv(routeOwners), regionCodes: csv(routeRegions), minimumSeverity: 'warning', directOwner: true, directManager: true, suppressionWindowMinutes: 120 } }); }, 'Notification route created.')}>Create route</Button></Flex></Card>
  </Flex>;

  const complianceSection = <Flex direction="column" gap="large">
    <Card><Flex direction="column" gap="small"><Heading>Retention</Heading><NumberInput name="auditRetention" label="Audit retention days" value={auditRetention} min={365} max={36500} onChange={(value) => setAuditRetention(Number(value))} /><NumberInput name="operationalRetention" label="Operational retention days" value={operationalRetention} min={30} max={3650} onChange={(value) => setOperationalRetention(Number(value))} /><Button disabled={working || !can('compliance.manage')} onClick={() => void act(async () => { await request('/enterprise/compliance', { method: 'PUT', body: { auditRetentionDays: auditRetention, operationalRetentionDays: operationalRetention, dataRegion: 'global' } }); }, 'Retention update requested or applied.')}>Save retention</Button></Flex></Card>
    <Card><Flex direction="column" gap="small"><Heading>Immutable audit chain</Heading><Button disabled={working || !can('audit.view')} onClick={() => void act(async () => { const result = await request('/enterprise/compliance/audit/verify'); if (!result.valid) throw new Error(`Audit chain failed at ${result.failures?.length ?? 0} events.`); }, 'Audit chain verified.')}>Verify chain</Button><Flex direction="row" gap="small" wrap="wrap">{['csv','json','jsonl'].map((format) => <Button key={format} variant="secondary" disabled={working || !can('audit.export')} onClick={() => void secureDownload('audit', { format })}>Prepare {format.toUpperCase()}</Button>)}</Flex></Flex></Card>
    <Card><Flex direction="column" gap="small"><Heading>Legal hold</Heading><Input name="holdName" label="Name" value={holdName} onChange={setHoldName} /><TextArea name="holdReason" label="Reason" value={holdReason} onChange={setHoldReason} /><Button disabled={working || !can('legal_hold.manage')} onClick={() => void act(async () => { await request('/enterprise/compliance/legal-holds', { method: 'POST', body: { name: holdName, reason: holdReason, scope: { all: true } } }); }, 'Legal hold created.')}>Create hold</Button>{(compliance?.legalHolds ?? []).map((item: Json) => <Flex key={item.id} direction="row" justify="between"><Text>{item.name} · {item.status}</Text>{item.status === 'active' && <Button variant="secondary" disabled={working || !can('legal_hold.manage')} onClick={() => void act(async () => { await request(`/enterprise/compliance/legal-holds/${item.id}/release`, { method: 'POST', body: {} }); }, 'Legal-hold release requested or applied.')}>Release</Button>}</Flex>)}</Flex></Card>
    <Card><Flex direction="column" gap="small"><Heading>SIEM</Heading><Input name="siemName" label="Name" value={siemName} onChange={setSiemName} /><Input name="siemEndpoint" label="HTTPS endpoint" value={siemEndpoint} onChange={setSiemEndpoint} /><Button disabled={working || !can('siem.manage')} onClick={() => void act(async () => { await request('/enterprise/compliance/siem', { method: 'POST', body: { name: siemName, endpoint: siemEndpoint, eventFilters: [] } }); }, 'SIEM destination requested or created.')}>Create SIEM destination</Button></Flex></Card>
    <Card><Flex direction="column" gap="small"><Heading>Customer data export</Heading><Select name="exportScope" label="Scope" value={exportScope} options={['audit','configuration','operational','complete'].map((value) => ({ label: value, value }))} onChange={(value) => setExportScope(String(value))} /><Select name="exportFormat" label="Format" value={exportFormat} options={['json','csv','jsonl'].map((value) => ({ label: value.toUpperCase(), value }))} onChange={(value) => setExportFormat(String(value))} /><Button disabled={working || !can('data_export.manage')} onClick={() => void act(async () => { const job = await request('/enterprise/compliance/exports', { method: 'POST', body: { scope: exportScope, format: exportFormat } }); const secure = await request('/enterprise/downloads', { method: 'POST', body: { kind: 'data_export', resourceId: job.id, format: exportFormat } }); setSecureUrl(secure.url); }, 'Customer data export prepared.')}>Prepare export</Button></Flex></Card>
  </Flex>;

  const reliabilitySection = <Flex direction="column" gap="large">
    {(reliability?.slos ?? []).map((item: Json) => <Card key={item.service}><Flex direction="row" justify="between"><Flex direction="column"><Text format={{ fontWeight: 'bold' }}>{item.service}</Text><Text>Availability {item.actual?.availability ?? 'n/a'}% / {item.targets?.availability}% · p95 {item.actual?.latencyP95Ms ?? 'n/a'}ms / {item.targets?.latencyP95Ms ?? 'n/a'}ms</Text></Flex><StatusTag variant={statusVariant(String(item.status))}>{item.status}</StatusTag></Flex></Card>)}
    <Card><Flex direction="column" gap="small"><Heading>Service objective</Heading><Input name="sloService" label="Service" value={sloService} onChange={setSloService} /><NumberInput name="sloAvailability" label="Availability target %" value={sloAvailability} min={90} max={100} onChange={(value) => setSloAvailability(Number(value))} /><NumberInput name="sloLatency" label="p95 latency target ms" value={sloLatency} min={1} max={600000} onChange={(value) => setSloLatency(Number(value))} /><Button disabled={working || !can('reliability.manage')} onClick={() => void act(async () => { await request('/enterprise/reliability/slos', { method: 'POST', body: { service: sloService, availabilityTarget: sloAvailability, successRateTarget: sloAvailability, latencyP95MsTarget: sloLatency, windowDays: 30 } }); }, 'SLO saved.')}>Save SLO</Button></Flex></Card>
    <Card><Flex direction="column" gap="small"><Heading>Synthetic check</Heading><Input name="syntheticName" label="Name" value={syntheticName} onChange={setSyntheticName} /><Select name="syntheticType" label="Type" value={syntheticType} options={['health','oauth','hubspot_api','webhook','delivery','billing'].map((value) => ({ label: value, value }))} onChange={(value) => setSyntheticType(String(value))} /><Input name="syntheticTarget" label="Target" value={syntheticTarget} onChange={setSyntheticTarget} /><Button disabled={working || !can('reliability.manage')} onClick={() => void act(async () => { await request('/enterprise/reliability/synthetics', { method: 'POST', body: { name: syntheticName, checkType: syntheticType, target: syntheticTarget, intervalMinutes: 15, enabled: true } }); }, 'Synthetic check created.')}>Create check</Button></Flex></Card>
    <Card><Flex direction="column" gap="small"><Heading>Incident</Heading><Input name="incidentTitle" label="Title" value={incidentTitle} onChange={setIncidentTitle} /><Select name="incidentSeverity" label="Severity" value={incidentSeverity} options={['minor','major','critical'].map((value) => ({ label: value, value }))} onChange={(value) => setIncidentSeverity(String(value))} /><Button disabled={working || !can('reliability.manage') || !incidentTitle} onClick={() => void act(async () => { await request('/enterprise/reliability/incidents', { method: 'POST', body: { title: incidentTitle, severity: incidentSeverity, affectedServices: [sloService], publicMessage: 'We are investigating an issue.', global: true } }); }, 'Incident created.')}>Create incident</Button></Flex></Card>
    <Card><Heading>Backup and restore evidence</Heading>{(reliability?.backups ?? []).slice(0, 10).map((item: Json) => <Text key={item.id}>{item.backup_type} · {item.status} · {date(item.completed_at)}</Text>)}{(reliability?.restoreTests ?? []).slice(0, 10).map((item: Json) => <Text key={item.id}>Restore {item.status} · {date(item.completed_at)}</Text>)}</Card>
  </Flex>;

  const billingSection = <Flex direction="column" gap="large">
    <Card><Flex direction="column" gap="small"><Flex direction="row" justify="between"><Heading>Dodo Payments subscription</Heading><StatusTag variant={statusVariant(billing.status)}>{billing.tier} · {billing.status}</StatusTag></Flex><Text>Provider: {billing.provider ?? 'not connected'} · period {date(billing.currentPeriodStart)} → {date(billing.currentPeriodEnd)}</Text><Text>Usage: {billing.usageMode} · overage {billing.overageEnabled ? 'enabled' : 'disabled'}</Text>{billing.scheduledTier && <Text>Scheduled: {billing.scheduledTier} at {date(billing.scheduledChangeAt)} · {billing.scheduledChangeProviderState ?? 'scheduled'}</Text>}</Flex></Card>
    <Card><Flex direction="column" gap="small"><Heading>New subscription</Heading><Select name="checkoutTier" label="Tier" value={checkoutTier} options={[{ label: 'Growth', value: 'growth' }, { label: 'Enterprise', value: 'enterprise' }]} onChange={(value) => setCheckoutTier(String(value))} /><Select name="checkoutInterval" label="Interval" value={checkoutInterval} options={[{ label: 'Monthly', value: 'month' }, { label: 'Annual', value: 'year' }]} onChange={(value) => setCheckoutInterval(String(value))} /><Select name="usageMode" label="Usage mode" value={usageMode} options={[{ label: 'Capped predictable spend', value: 'capped' }, { label: 'Metered overage', value: 'metered' }]} onChange={(value) => setUsageMode(String(value))} /><Toggle label="Enable overage" checked={overageEnabled} onChange={setOverageEnabled} /><Button disabled={working || !can('billing.manage') || !billing.checkoutConfigured} onClick={() => void act(async () => { const result = await request('/billing/checkout', { method: 'POST', body: { tier: checkoutTier, interval: checkoutInterval, usageMode, overageEnabled } }); setCheckoutUrl(result.url); }, 'Dodo checkout created.')}>Create checkout</Button>{checkoutUrl && <Link href={{ url: checkoutUrl, external: true }}>Open Dodo checkout</Link>}<Button variant="secondary" disabled={working || !billing.portalConfigured} onClick={() => void act(async () => { const result = await request('/billing/portal', { method: 'POST', body: {} }); setPortalUrl(result.url); }, 'Dodo customer portal created.')}>Customer portal</Button>{portalUrl && <Link href={{ url: portalUrl, external: true }}>Open Dodo customer portal</Link>}</Flex></Card>
    {billing.provider === 'dodo' && <Card><Flex direction="column" gap="small"><Heading>Provider-backed plan change</Heading><Select name="planTier" label="Target tier" value={checkoutTier} options={[{ label: 'Growth', value: 'growth' }, { label: 'Enterprise', value: 'enterprise' }]} onChange={(value) => setCheckoutTier(String(value))} /><Select name="planInterval" label="Target interval" value={checkoutInterval} options={[{ label: 'Monthly', value: 'month' }, { label: 'Annual', value: 'year' }]} onChange={(value) => setCheckoutInterval(String(value))} /><Select name="effective" label="Effective" value={planEffectiveAt} options={[{ label: 'Immediately', value: 'immediately' }, { label: 'Next billing date', value: 'next_billing_date' }]} onChange={(value) => setPlanEffectiveAt(String(value))} /><Select name="proration" label="Proration" value={prorationMode} options={['prorated_immediately','full_immediately','difference_immediately','do_not_bill'].map((value) => ({ label: value.replaceAll('_', ' '), value }))} onChange={(value) => setProrationMode(String(value))} /><Select name="paymentFailure" label="If payment fails" value={paymentFailureMode} options={[{ label: 'Prevent change', value: 'prevent_change' }, { label: 'Apply change', value: 'apply_change' }]} onChange={(value) => setPaymentFailureMode(String(value))} /><Flex direction="row" gap="small" wrap="wrap"><Button variant="secondary" disabled={working || !can('billing.manage')} onClick={() => void act(async () => { const result = await request('/billing/plan-change/preview', { method: 'POST', body: { tier: checkoutTier, interval: checkoutInterval, effectiveAt: planEffectiveAt, prorationBillingMode: prorationMode, onPaymentFailure: paymentFailureMode } }); setPlanPreview(result); }, 'Plan-change preview loaded.')}>Preview</Button><Button disabled={working || !can('billing.manage')} onClick={() => void act(async () => { await request('/billing/plan-change', { method: 'POST', body: { tier: checkoutTier, interval: checkoutInterval, effectiveAt: planEffectiveAt, prorationBillingMode: prorationMode, onPaymentFailure: paymentFailureMode } }); }, 'Plan change requested or applied after approval.')}>Request change</Button>{billing.scheduledTier && <Button variant="secondary" disabled={working || !can('billing.manage')} onClick={() => void act(async () => { await request('/billing/plan-change', { method: 'DELETE', body: {} }); }, 'Scheduled change cancellation requested or applied.')}>Cancel scheduled change</Button>}</Flex>{planPreview && <Text>{JSON.stringify(planPreview.preview ?? planPreview)}</Text>}</Flex></Card>}
    <Heading>Allowances and usage</Heading>{(billing.allowances ?? []).map((item: Json) => <Card key={item.metric}><Text format={{ fontWeight: 'bold' }}>{item.metric}</Text><Text>Consumed {item.consumedQuantity} · included {item.includedQuantity} · hard limit {item.hardLimit ?? 'unlimited'} · overage {item.overageEnabled ? 'on' : 'off'}</Text></Card>)}
    <Card><Flex direction="column" gap="small"><Heading>Configure allowance</Heading><Select name="allowance" label="Metric" value={allowanceMetric} options={['ai_credit','active_deal_overage','event_overage','retention_gb_month'].map((value) => ({ label: value, value }))} onChange={(value) => setAllowanceMetric(String(value))} /><NumberInput name="included" label="Included quantity" value={includedQuantity} min={0} onChange={(value) => setIncludedQuantity(Number(value))} /><NumberInput name="limit" label="Hard limit" value={hardLimit} min={0} onChange={(value) => setHardLimit(Number(value))} /><Toggle label="Allow paid overage" checked={overageEnabled} onChange={setOverageEnabled} /><Button disabled={working || !can('billing.allowance.manage')} onClick={() => void act(async () => { await request('/billing/allowances', { method: 'PUT', body: { metric: allowanceMetric, includedQuantity, hardLimit, overageEnabled } }); }, 'Allowance update requested or applied.')}>Save allowance</Button></Flex></Card>
    <Card><Heading>Current-period metering</Heading>{(usage?.usage ?? []).map((item: Json) => <Text key={item.event_name}>{item.event_name}: {item.quantity} units across {item.events} events</Text>)}</Card>
  </Flex>;

  const content: Record<Section, React.ReactNode> = { overview: overviewSection, policies: policySection, analytics: analyticsSection, access: accessSection, remediation: remediationSection, alerts: alertsSection, compliance: complianceSection, reliability: reliabilitySection, billing: billingSection };

  return <Flex direction="column" gap="large">
    <HeaderActions><PrimaryHeaderActionButton onClick={() => void load()}>Refresh</PrimaryHeaderActionButton><SecondaryHeaderActionButton onClick={() => setSection('billing')}>Billing</SecondaryHeaderActionButton></HeaderActions>
    {error && <Alert title="Action requires attention" variant="danger">{error}</Alert>}
    {notice && <Alert title="DealGuard Enterprise" variant="success">{notice}</Alert>}
    {secureUrl && <Alert title="Secure export ready" variant="success"><Link href={{ url: secureUrl, external: true }}>Download once — expires in ten minutes</Link></Alert>}
    <Flex direction="row" justify="between" align="center" gap="medium"><Flex direction="column"><Heading>DealGuard Enterprise</Heading><Text>Revenue governance, remediation, analytics, compliance, reliability, and Dodo commercial operations.</Text></Flex><StatusTag variant={billing.entitled ? 'success' : 'warning'}>{billing.tier}</StatusTag></Flex>
    <Select name="workspace" label="Enterprise workspace" value={section} options={sections} onChange={(value) => setSection(String(value) as Section)} />
    <Divider />
    {content[section]}
  </Flex>;
};
