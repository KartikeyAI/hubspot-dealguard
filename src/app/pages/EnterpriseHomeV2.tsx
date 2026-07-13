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
type RequestOptions = { method?: 'GET' | 'POST' | 'PUT' | 'DELETE'; body?: Json };

hubspot.extend<'home'>(() => <EnterpriseHomeV2 />);

function money(value: unknown): string {
  return new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 }).format(Number(value ?? 0));
}

function date(value: unknown): string {
  return value ? new Date(String(value)).toLocaleString() : 'Not set';
}

function statusVariant(status: string): 'success' | 'warning' | 'danger' | 'default' {
  if (['active', 'manual', 'healthy', 'operational', 'meeting', 'published', 'approved', 'completed', 'resolved', 'passing', 'paid'].includes(status)) return 'success';
  if (['pending', 'trialing', 'on_hold', 'past_due', 'degraded', 'queued', 'in_progress', 'acknowledged', 'monitoring', 'identified', 'insufficient_data'].includes(status)) return 'warning';
  if (['failed', 'expired', 'cancelled', 'critical', 'failing', 'breached', 'dead_letter', 'overdue', 'rejected', 'major_outage'].includes(status)) return 'danger';
  return 'default';
}

const EnterpriseHomeV2 = () => {
  const [section, setSection] = useState<Section>('overview');
  const [loading, setLoading] = useState(true);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [checkoutUrl, setCheckoutUrl] = useState<string | null>(null);
  const [portalUrl, setPortalUrl] = useState<string | null>(null);
  const [secureExportUrl, setSecureExportUrl] = useState<string | null>(null);

  const [access, setAccess] = useState<Json | null>(null);
  const [billing, setBilling] = useState<Json | null>(null);
  const [analytics, setAnalytics] = useState<Json | null>(null);
  const [templates, setTemplates] = useState<Json[]>([]);
  const [policies, setPolicies] = useState<Json[]>([]);
  const [roles, setRoles] = useState<Json[]>([]);
  const [approvals, setApprovals] = useState<Json[]>([]);
  const [remediations, setRemediations] = useState<Json[]>([]);
  const [remediationSummary, setRemediationSummary] = useState<Json | null>(null);
  const [alerts, setAlerts] = useState<Json | null>(null);
  const [compliance, setCompliance] = useState<Json | null>(null);
  const [reliability, setReliability] = useState<Json | null>(null);
  const [usage, setUsage] = useState<Json | null>(null);

  const [selectedPolicy, setSelectedPolicy] = useState('');
  const [segments, setSegments] = useState<Json[]>([]);
  const [policyDiff, setPolicyDiff] = useState<Json[]>([]);
  const [policyImport, setPolicyImport] = useState('');
  const [segmentName, setSegmentName] = useState('Strategic opportunities');
  const [segmentPipelineIds, setSegmentPipelineIds] = useState('');
  const [segmentOwnerIds, setSegmentOwnerIds] = useState('');
  const [segmentTeamIds, setSegmentTeamIds] = useState('');
  const [segmentRegionCodes, setSegmentRegionCodes] = useState('');
  const [segmentMinAmount, setSegmentMinAmount] = useState(100000);
  const [segmentStaleDays, setSegmentStaleDays] = useState(3);

  const [viewName, setViewName] = useState('Executive pipeline view');
  const [analyticsDays, setAnalyticsDays] = useState(90);
  const [analyticsAudience, setAnalyticsAudience] = useState('executive');

  const [roleEmail, setRoleEmail] = useState('');
  const [roleUserId, setRoleUserId] = useState('');
  const [roleName, setRoleName] = useState('viewer');
  const [rolePipelines, setRolePipelines] = useState('');
  const [roleTeams, setRoleTeams] = useState('');
  const [roleOwners, setRoleOwners] = useState('');
  const [roleRegions, setRoleRegions] = useState('');

  const [bulkCaseIds, setBulkCaseIds] = useState('');
  const [bulkOperation, setBulkOperation] = useState('acknowledge');
  const [evidenceCaseId, setEvidenceCaseId] = useState('');
  const [evidenceLabel, setEvidenceLabel] = useState('Resolution evidence');
  const [evidenceValue, setEvidenceValue] = useState('');
  const [commentValue, setCommentValue] = useState('');

  const [channelType, setChannelType] = useState('slack_webhook');
  const [channelName, setChannelName] = useState('Sales critical alerts');
  const [channelEndpoint, setChannelEndpoint] = useState('');
  const [channelRecipients, setChannelRecipients] = useState('');
  const [routeName, setRouteName] = useState('Critical pipeline alerts');
  const [routeChannelIds, setRouteChannelIds] = useState('');
  const [routeEventTypes, setRouteEventTypes] = useState('deal.critical,handoff.required,remediation.overdue');
  const [routePipelineIds, setRoutePipelineIds] = useState('');
  const [routeTeamIds, setRouteTeamIds] = useState('');
  const [routeOwnerIds, setRouteOwnerIds] = useState('');
  const [routeRegionCodes, setRouteRegionCodes] = useState('');

  const [auditRetention, setAuditRetention] = useState(2555);
  const [operationalRetention, setOperationalRetention] = useState(365);
  const [legalHoldName, setLegalHoldName] = useState('Investigation hold');
  const [legalHoldReason, setLegalHoldReason] = useState('Preserve records for an active investigation.');
  const [siemName, setSiemName] = useState('Enterprise SIEM');
  const [siemEndpoint, setSiemEndpoint] = useState('');
  const [exportScope, setExportScope] = useState('complete');
  const [exportFormat, setExportFormat] = useState('json');
  const [downloadPath, setDownloadPath] = useState<string | null>(null);

  const [sloService, setSloService] = useState('scan');
  const [sloAvailability, setSloAvailability] = useState(99.9);
  const [sloLatency, setSloLatency] = useState(30000);
  const [syntheticName, setSyntheticName] = useState('Worker health');
  const [syntheticType, setSyntheticType] = useState('health');
  const [syntheticTarget, setSyntheticTarget] = useState('https://dealguard-api.rokad.co/health');
  const [incidentTitle, setIncidentTitle] = useState('');
  const [incidentSeverity, setIncidentSeverity] = useState('minor');

  const [checkoutTier, setCheckoutTier] = useState('growth');
  const [checkoutInterval, setCheckoutInterval] = useState('month');
  const [usageMode, setUsageMode] = useState('capped');
  const [overageEnabled, setOverageEnabled] = useState(false);
  const [allowanceMetric, setAllowanceMetric] = useState('ai_credit');
  const [includedQuantity, setIncludedQuantity] = useState(500);
  const [hardLimit, setHardLimit] = useState(2000);

  const request = async (path: string, options: RequestOptions = {}): Promise<any> => {
    const response = await hubspot.fetch(`${API_BASE}${path}`, {
      method: options.method ?? 'GET',
      timeout: 20000,
      ...(options.body ? { body: options.body } : {}),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data?.error?.message ?? `DealGuard request failed (${response.status}).`);
    return data;
  };

  const safeRequest = async (path: string): Promise<any | null> => {
    try { return await request(path); } catch { return null; }
  };

  const load = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      const [accessData, billingData] = await Promise.all([request('/enterprise/access'), request('/billing')]);
      setAccess(accessData); setBilling(billingData);
      const [analyticsData, templateData, policyData, roleData, approvalData, remediationData, remediationSummaryData, alertData, complianceData, reliabilityData, usageData] = await Promise.all([
        safeRequest(`/enterprise/analytics?days=${analyticsDays}&audience=${analyticsAudience}`),
        safeRequest('/enterprise/policy-templates'),
        safeRequest('/governance/policies'),
        safeRequest('/enterprise/roles'),
        safeRequest('/enterprise/change-approvals'),
        safeRequest('/remediations?limit=100'),
        safeRequest('/remediations/summary'),
        safeRequest('/enterprise/alerts'),
        safeRequest('/enterprise/compliance'),
        safeRequest('/enterprise/reliability'),
        safeRequest('/billing/usage'),
      ]);
      setAnalytics(analyticsData);
      setTemplates(templateData?.templates ?? []);
      setPolicies(policyData?.policies ?? []);
      setRoles(roleData?.roles ?? []);
      setApprovals(approvalData?.approvals ?? []);
      setRemediations(remediationData?.cases ?? []);
      setRemediationSummary(remediationSummaryData);
      setAlerts(alertData);
      setCompliance(complianceData);
      setReliability(reliabilityData);
      setUsage(usageData);
      if (!selectedPolicy && policyData?.policies?.length) setSelectedPolicy(String(policyData.policies[0].id));
      const settings = complianceData?.settings;
      if (settings) {
        setAuditRetention(Number(settings.auditRetentionDays ?? 2555));
        setOperationalRetention(Number(settings.operationalRetentionDays ?? 365));
      }
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Enterprise App Home could not be loaded.');
    } finally { setLoading(false); }
  }, [analyticsDays, analyticsAudience, selectedPolicy]);

  useEffect(() => { void load(); }, [load]);

  const act = async (fn: () => Promise<void>, success: string) => {
    setWorking(true); setError(null); setNotice(null);
    try { await fn(); setNotice(success); await load(); }
    catch (caught) { setError(caught instanceof Error ? caught.message : 'The action failed.'); }
    finally { setWorking(false); }
  };

  const prepareSecureDownload = async (kind: 'policy' | 'analytics' | 'audit' | 'data_export', options: { resourceId?: string; format?: string; params?: Json } = {}) => {
    await act(async () => {
      const result = await request('/enterprise/downloads', { method: 'POST', body: { kind, ...options } });
      setSecureExportUrl(result.url);
    }, 'A one-time secure download is ready for ten minutes.');
  };

  const loadPolicyDetail = async () => {
    if (!selectedPolicy) return;
    await act(async () => {
      const [segmentData, diffData] = await Promise.all([
        request(`/governance/policies/${selectedPolicy}/segments`),
        request(`/governance/policies/${selectedPolicy}/diff`),
      ]);
      setSegments(segmentData.segments ?? []); setPolicyDiff(diffData.diff ?? []);
    }, 'Policy segmentation and diff loaded.');
  };

  const sectionOptions = useMemo(() => [
    { label: 'Executive overview', value: 'overview' }, { label: 'Policy governance', value: 'policies' },
    { label: 'Analytics', value: 'analytics' }, { label: 'Roles and approvals', value: 'access' },
    { label: 'Remediation operations', value: 'remediation' }, { label: 'Alerts and routing', value: 'alerts' },
    { label: 'Compliance', value: 'compliance' }, { label: 'Reliability', value: 'reliability' },
    { label: 'Billing and usage', value: 'billing' },
  ], []);

  if (loading) return <LoadingSpinner label="Loading DealGuard Enterprise" />;
  if (!access || !billing) return <Alert title="DealGuard Enterprise unavailable" variant="danger">{error ?? 'Enterprise access could not be verified.'}</Alert>;

  const can = (permission: string) => access.permissions?.includes('*') || access.permissions?.includes(permission);
  const current = analytics?.current ?? {};

  const overviewSection = <Flex direction="column" gap="large">
    <Flex direction="row" gap="medium" wrap="wrap">
      <Card><Heading>{current.averageScore ?? 0}</Heading><Text>Average readiness</Text></Card>
      <Card><Heading>{current.totalDeals ?? 0}</Heading><Text>Assessed deals</Text></Card>
      <Card><Heading>${money(current.amountAtRisk)}</Heading><Text>Pipeline amount at risk</Text></Card>
      <Card><Heading>{current.criticalEvents ?? 0}</Heading><Text>Critical assessment events</Text></Card>
      <Card><Heading>{remediationSummary?.overdue ?? 0}</Heading><Text>Overdue remediations</Text></Card>
    </Flex>
    <Card><Flex direction="column" gap="small">
      <Flex direction="row" justify="between" align="center"><Heading>Commercial entitlement</Heading><StatusTag variant={statusVariant(String(billing.status))}>{billing.tier} · {billing.status}</StatusTag></Flex>
      <Text>Provider: {billing.provider ?? 'none'} · Billing: {billing.billingInterval ?? 'none'} · Usage mode: {billing.usageMode}</Text>
      <Text>Current period: {date(billing.currentPeriodStart)} → {date(billing.currentPeriodEnd)}</Text>
    </Flex></Card>
    <Card><Flex direction="column" gap="small">
      <Heading>Service reliability</Heading>
      {(reliability?.slos ?? []).slice(0, 8).map((slo: Json) => <Flex key={slo.service} direction="row" justify="between"><Text>{slo.service}</Text><StatusTag variant={statusVariant(String(slo.status))}>{slo.status}</StatusTag></Flex>)}
      {!reliability?.slos?.length && <Text>No SLOs configured yet.</Text>}
    </Flex></Card>
    <Card><Flex direction="column" gap="small"><Heading>Current authority</Heading><Text>Role: {access.role}</Text><Text>Permissions: {(access.permissions ?? []).join(', ')}</Text><Text>Scoped pipelines: {(access.scope?.pipelineIds ?? []).join(', ') || 'All permitted'}</Text></Flex></Card>
  </Flex>;

  const policiesSection = <Flex direction="column" gap="large">
    <Heading>Policy templates and segmented governance</Heading>
    <Flex direction="row" gap="small" wrap="wrap">{templates.map((template) => <Button key={template.id} variant="secondary" disabled={working || !can('policy.manage')} onClick={() => void act(async () => { await request(`/enterprise/policy-templates/${encodeURIComponent(template.id)}/apply`, { method: 'POST', body: {} }); }, `Created a draft from ${template.name}.`)}>{template.name}</Button>)}</Flex>
    <Select name="selectedPolicy" label="Policy version" options={policies.map((policy) => ({ label: `v${policy.versionNumber} · ${policy.name} · ${policy.status}`, value: String(policy.id) }))} value={selectedPolicy} onChange={(value) => setSelectedPolicy(String(value))} />
    <Flex direction="row" gap="small" wrap="wrap"><Button onClick={() => void loadPolicyDetail()} disabled={!selectedPolicy || working}>Load segments and diff</Button><Button variant="secondary" disabled={!selectedPolicy || working || !can('policy.export')} onClick={() => void prepareSecureDownload('policy', { resourceId: selectedPolicy })}>Prepare secure policy export</Button></Flex>
    <Card><Flex direction="column" gap="small">
      <Heading>Add segment</Heading>
      <Input name="segmentName" label="Segment name" value={segmentName} onChange={setSegmentName} />
      <Input name="segmentPipelines" label="Pipeline IDs, comma separated" value={segmentPipelineIds} onChange={setSegmentPipelineIds} />
      <Input name="segmentOwners" label="Owner IDs, comma separated" value={segmentOwnerIds} onChange={setSegmentOwnerIds} />
      <Input name="segmentTeams" label="Team IDs, comma separated" value={segmentTeamIds} onChange={setSegmentTeamIds} />
      <Input name="segmentRegions" label="Region codes, comma separated" value={segmentRegionCodes} onChange={setSegmentRegionCodes} />
      <NumberInput name="segmentMin" label="Minimum deal amount" value={segmentMinAmount} min={0} onChange={(value) => setSegmentMinAmount(Number(value))} />
      <NumberInput name="segmentStale" label="Stale after days" value={segmentStaleDays} min={1} max={90} onChange={(value) => setSegmentStaleDays(Number(value))} />
      <Button disabled={!selectedPolicy || working || !can('policy.manage')} onClick={() => void act(async () => {
        await request(`/governance/policies/${selectedPolicy}/segments`, { method: 'POST', body: {
          name: segmentName, priority: 100, conditions: {
            pipelineIds: segmentPipelineIds.split(',').map((v) => v.trim()).filter(Boolean), ownerIds: segmentOwnerIds.split(',').map((v) => v.trim()).filter(Boolean),
            teamIds: segmentTeamIds.split(',').map((v) => v.trim()).filter(Boolean), regionCodes: segmentRegionCodes.split(',').map((v) => v.trim()).filter(Boolean), minAmount: segmentMinAmount,
          }, rulesOverride: { staleDays: segmentStaleDays },
        } });
      }, 'Policy segment created.')}>Create segment</Button>
    </Flex></Card>
    {segments.map((segment) => <Card key={segment.id}><Flex direction="column" gap="extra-small"><Text format={{ fontWeight: 'bold' }}>{segment.name}</Text><Text>Priority {segment.priority} · {segment.enabled ? 'enabled' : 'disabled'}</Text><Text>{JSON.stringify(segment.conditions)}</Text><Button variant="secondary" disabled={working || !can('policy.manage')} onClick={() => void act(async () => { await request(`/governance/policies/${selectedPolicy}/segments/${segment.id}`, { method: 'DELETE' }); }, 'Segment deleted.')}>Delete segment</Button></Flex></Card>)}
    <Card><Heading>Policy diff</Heading>{policyDiff.length ? policyDiff.slice(0, 100).map((item, index) => <Text key={`${item.path}-${index}`}>{item.path}: {JSON.stringify(item.before)} → {JSON.stringify(item.after)}</Text>) : <Text>No diff loaded.</Text>}</Card>
    <Card><Flex direction="column" gap="small"><Heading>Import policy package</Heading><TextArea name="policyImport" label="DealGuard policy JSON" value={policyImport} onChange={setPolicyImport} /><Button disabled={working || !can('policy.manage')} onClick={() => void act(async () => { await request('/governance/policies/import', { method: 'POST', body: JSON.parse(policyImport) }); }, 'Policy package imported.')}>Import</Button></Flex></Card>
  </Flex>;

  const analyticsSection = <Flex direction="column" gap="large">
    <Flex direction="row" gap="medium" wrap="wrap"><NumberInput name="analyticsDays" label="History window (days)" value={analyticsDays} min={1} max={730} onChange={(value) => setAnalyticsDays(Number(value))} /><Select name="audience" label="Audience" value={analyticsAudience} options={[{ label: 'Executive', value: 'executive' }, { label: 'RevOps', value: 'revops' }, { label: 'Sales manager', value: 'sales_manager' }, { label: 'Representative', value: 'representative' }]} onChange={(value) => setAnalyticsAudience(String(value))} /><Button onClick={() => void load()} disabled={working}>Refresh analytics</Button></Flex>
    <Flex direction="row" gap="medium" wrap="wrap"><Card><Heading>{current.averageScore ?? 0}</Heading><Text>Average score</Text></Card><Card><Heading>${money(current.pipelineAmount)}</Heading><Text>Pipeline amount</Text></Card><Card><Heading>${money(current.amountAtRisk)}</Heading><Text>Amount at risk</Text></Card><Card><Heading>{current.averageStageAgeDays ?? 0}</Heading><Text>Average stage age</Text></Card></Flex>
    <Card><Heading>Readiness trend</Heading>{(analytics?.trend ?? []).slice(-30).map((point: Json) => <Text key={point.date}>{point.date}: score {point.averageScore}, ${money(point.amountAtRisk)} at risk, {point.critical} critical</Text>)}</Card>
    <Card><Heading>Stage-aging heatmap</Heading>{(analytics?.stageAgingHeatmap ?? []).slice(0, 50).map((item: Json) => <Text key={`${item.pipeline}-${item.stage}`}>{item.pipeline} / {item.stage}: {item.deals} deals, {item.averageAgeDays} average days, {item.critical} critical</Text>)}</Card>
    <Card><Heading>Failure patterns</Heading>{(analytics?.failurePatterns ?? []).slice(0, 30).map((item: Json) => <Text key={item.code}>{item.code}: {item.count}</Text>)}</Card>
    <Card><Flex direction="column" gap="small"><Heading>Save view</Heading><Input name="viewName" label="View name" value={viewName} onChange={setViewName} /><Button disabled={working} onClick={() => void act(async () => { await request('/enterprise/analytics/views', { method: 'POST', body: { name: viewName, audience: analyticsAudience, filters: { days: analyticsDays }, isShared: true } }); }, 'Analytics view saved.')}>Save shared view</Button><Button variant="secondary" disabled={working || !can('analytics.export')} onClick={() => void prepareSecureDownload('analytics', { format: 'csv', params: { days: analyticsDays, audience: analyticsAudience } })}>Prepare secure analytics CSV</Button></Flex></Card>
  </Flex>;

  const accessSection = <Flex direction="column" gap="large">
    <Heading>Enterprise roles and scopes</Heading>
    {roles.map((role) => <Card key={role.id}><Flex direction="row" justify="between" align="center" gap="small"><Flex direction="column"><Text format={{ fontWeight: 'bold' }}>{role.userEmail ?? role.userId}</Text><Text>{role.role} · pipelines {(role.scope?.pipelineIds ?? []).join(', ') || 'all'} · teams {(role.scope?.teamIds ?? []).join(', ') || 'all'}</Text></Flex><Button variant="secondary" disabled={working || !can('role.manage')} onClick={() => void act(async () => { await request(`/enterprise/roles/${role.id}`, { method: 'DELETE' }); }, 'Role removed.')}>Remove</Button></Flex></Card>)}
    <Card><Flex direction="column" gap="small"><Heading>Assign role</Heading><Input name="roleEmail" label="HubSpot user email" value={roleEmail} onChange={setRoleEmail} /><Input name="roleUserId" label="HubSpot user ID (optional)" value={roleUserId} onChange={setRoleUserId} /><Select name="roleName" label="Role" value={roleName} options={['administrator','policy_administrator','revops_manager','sales_manager','reviewer','remediation_manager','compliance_auditor','billing_administrator','viewer'].map((value) => ({ label: value.replaceAll('_',' '), value }))} onChange={(value) => setRoleName(String(value))} /><Input name="rolePipelines" label="Pipeline scope IDs" value={rolePipelines} onChange={setRolePipelines} /><Input name="roleTeams" label="Team scope IDs" value={roleTeams} onChange={setRoleTeams} /><Input name="roleOwners" label="Owner scope IDs" value={roleOwners} onChange={setRoleOwners} /><Input name="roleRegions" label="Region scope codes" value={roleRegions} onChange={setRoleRegions} /><Button disabled={working || !can('role.manage')} onClick={() => void act(async () => { await request('/enterprise/roles', { method: 'PUT', body: { userEmail: roleEmail || undefined, userId: roleUserId || undefined, role: roleName, scope: { pipelineIds: rolePipelines.split(',').map((v) => v.trim()).filter(Boolean), teamIds: roleTeams.split(',').map((v) => v.trim()).filter(Boolean), ownerIds: roleOwners.split(',').map((v) => v.trim()).filter(Boolean), regionCodes: roleRegions.split(',').map((v) => v.trim()).filter(Boolean) } } }); }, 'Enterprise role assigned.')}>Assign role</Button></Flex></Card>
    <Heading>Two-person approvals</Heading>
    {approvals.slice(0, 100).map((approval) => <Card key={approval.id}><Flex direction="column" gap="small"><Flex direction="row" justify="between"><Text format={{ fontWeight: 'bold' }}>{approval.changeType}</Text><StatusTag variant={statusVariant(String(approval.status))}>{approval.status}</StatusTag></Flex><Text>{approval.resourceType} · {approval.resourceId} · requested by {approval.requestedByEmail ?? 'system'}</Text>{approval.status === 'pending' && <Flex direction="row" gap="small"><Button disabled={working || !can('change.approve')} onClick={() => void act(async () => { await request(`/enterprise/change-approvals/${approval.id}/approve`, { method: 'POST', body: { comment: 'Approved in DealGuard App Home.' } }); }, 'Change approved.')}>Approve</Button><Button variant="secondary" disabled={working || !can('change.approve')} onClick={() => void act(async () => { await request(`/enterprise/change-approvals/${approval.id}/reject`, { method: 'POST', body: { comment: 'Rejected in DealGuard App Home.' } }); }, 'Change rejected.')}>Reject</Button></Flex>}</Flex></Card>)}
  </Flex>;

  const remediationSection = <Flex direction="column" gap="large">
    <Flex direction="row" gap="medium" wrap="wrap"><Card><Heading>{remediationSummary?.open ?? 0}</Heading><Text>Open</Text></Card><Card><Heading>{remediationSummary?.overdue ?? 0}</Heading><Text>Overdue</Text></Card><Card><Heading>{remediationSummary?.critical ?? 0}</Heading><Text>Critical</Text></Card><Card><Heading>{remediationSummary?.averageResolutionHours ?? 0}h</Heading><Text>Average resolution</Text></Card></Flex>
    {remediations.slice(0, 100).map((item) => <Card key={item.id}><Flex direction="column" gap="small"><Flex direction="row" justify="between"><Text format={{ fontWeight: 'bold' }}>{item.title}</Text><StatusTag variant={statusVariant(String(item.status))}>{item.status}</StatusTag></Flex><Text>Deal {item.dealId} · {item.severity} · due {date(item.dueAt)} · owner {item.ownerEmail ?? item.ownerId ?? 'unassigned'}</Text><Flex direction="row" gap="small" wrap="wrap"><Button variant="secondary" disabled={working} onClick={() => { setEvidenceCaseId(String(item.id)); setEvidenceValue(''); setCommentValue(''); }}>Use in evidence form</Button><Button disabled={working || !can('remediation.manage')} onClick={() => void act(async () => { await request(`/remediations/${item.id}/acknowledge`, { method: 'POST', body: {} }); }, 'Remediation acknowledged.')}>Acknowledge</Button></Flex></Flex></Card>)}
    <Card><Flex direction="column" gap="small"><Heading>Evidence and comments</Heading><Input name="evidenceCase" label="Case ID" value={evidenceCaseId} onChange={setEvidenceCaseId} /><Input name="evidenceLabel" label="Evidence label" value={evidenceLabel} onChange={setEvidenceLabel} /><TextArea name="evidenceValue" label="Evidence value or HTTPS URL" value={evidenceValue} onChange={setEvidenceValue} /><Button disabled={working || !can('remediation.evidence')} onClick={() => void act(async () => { await request(`/remediations/${evidenceCaseId}/evidence`, { method: 'POST', body: { type: evidenceValue.startsWith('https://') ? 'url' : 'text', label: evidenceLabel, value: evidenceValue } }); }, 'Evidence submitted.')}>Submit evidence</Button><TextArea name="caseComment" label="Comment" value={commentValue} onChange={setCommentValue} /><Button variant="secondary" disabled={working || !can('remediation.manage')} onClick={() => void act(async () => { await request(`/remediations/${evidenceCaseId}/comments`, { method: 'POST', body: { body: commentValue } }); }, 'Comment added.')}>Add comment</Button></Flex></Card>
    <Card><Flex direction="column" gap="small"><Heading>Bulk remediation operation</Heading><TextArea name="bulkCases" label="Case IDs, comma or newline separated" value={bulkCaseIds} onChange={setBulkCaseIds} /><Select name="bulkOperation" label="Operation" value={bulkOperation} options={['assign','acknowledge','start','resolve','waive','set_due_date','set_priority'].map((value) => ({ label: value.replaceAll('_',' '), value }))} onChange={(value) => setBulkOperation(String(value))} /><Button disabled={working || !can('remediation.bulk')} onClick={() => void act(async () => { const created = await request('/remediations/bulk', { method: 'POST', body: { operation: bulkOperation, caseIds: bulkCaseIds.split(/[\n,]/).map((v) => v.trim()).filter(Boolean), parameters: {} } }); await request(`/remediations/bulk/${created.id}/run`, { method: 'POST', body: {} }); }, 'Bulk remediation operation completed.')}>Execute bulk operation</Button></Flex></Card>
  </Flex>;

  const alertsSection = <Flex direction="column" gap="large">
    <Heading>Notification channels</Heading>
    {(alerts?.channels ?? []).map((channel: Json) => <Card key={channel.id}><Flex direction="row" justify="between"><Text>{channel.name} · {channel.type}</Text><StatusTag variant={channel.enabled ? 'success' : 'default'}>{channel.enabled ? 'enabled' : 'disabled'}</StatusTag></Flex></Card>)}
    <Card><Flex direction="column" gap="small"><Heading>Create channel</Heading><Select name="channelType" label="Type" value={channelType} options={[{label:'Slack webhook',value:'slack_webhook'},{label:'Microsoft Teams Workflow',value:'teams_workflow'},{label:'Email',value:'email'},{label:'Signed webhook',value:'webhook'}]} onChange={(value) => setChannelType(String(value))} /><Input name="channelName" label="Name" value={channelName} onChange={setChannelName} />{channelType === 'email' ? <Input name="channelRecipients" label="Recipients, comma separated" value={channelRecipients} onChange={setChannelRecipients} /> : <Input name="channelEndpoint" label="HTTPS endpoint" value={channelEndpoint} onChange={setChannelEndpoint} />}<Button disabled={working || !can('alert.manage')} onClick={() => void act(async () => { await request('/enterprise/alerts/channels', { method: 'POST', body: { type: channelType, name: channelName, endpoint: channelEndpoint || undefined, recipients: channelRecipients.split(',').map((v) => v.trim()).filter(Boolean) } }); }, 'Notification channel created.')}>Create channel</Button></Flex></Card>
    <Heading>Routing</Heading>{(alerts?.routes ?? []).map((route: Json) => <Card key={route.id}><Text format={{ fontWeight:'bold' }}>{route.name}</Text><Text>{route.minimumSeverity}+ · channels {(route.channelIds ?? []).join(', ')} · pipelines {(route.pipelineIds ?? []).join(', ') || 'all'}</Text></Card>)}
    <Card><Flex direction="column" gap="small"><Heading>Create route</Heading><Input name="routeName" label="Name" value={routeName} onChange={setRouteName} /><Input name="routeChannels" label="Channel IDs" value={routeChannelIds} onChange={setRouteChannelIds} /><Input name="routeEvents" label="Event types" value={routeEventTypes} onChange={setRouteEventTypes} /><Input name="routePipelines" label="Pipeline IDs" value={routePipelineIds} onChange={setRoutePipelineIds} /><Input name="routeTeams" label="Team IDs" value={routeTeamIds} onChange={setRouteTeamIds} /><Input name="routeOwners" label="Owner IDs" value={routeOwnerIds} onChange={setRouteOwnerIds} /><Input name="routeRegions" label="Region codes" value={routeRegionCodes} onChange={setRouteRegionCodes} /><Button disabled={working || !can('alert.manage')} onClick={() => void act(async () => { await request('/enterprise/alerts/routes', { method:'POST', body: { name: routeName, channelIds: routeChannelIds.split(',').map((v) => v.trim()).filter(Boolean), eventTypes: routeEventTypes.split(',').map((v) => v.trim()).filter(Boolean), pipelineIds: routePipelineIds.split(',').map((v) => v.trim()).filter(Boolean), teamIds: routeTeamIds.split(',').map((v) => v.trim()).filter(Boolean), ownerIds: routeOwnerIds.split(',').map((v) => v.trim()).filter(Boolean), regionCodes: routeRegionCodes.split(',').map((v) => v.trim()).filter(Boolean), minimumSeverity:'critical', directOwner:true, directManager:true, suppressionWindowMinutes:120 } }); }, 'Notification route created.')}>Create route</Button></Flex></Card>
  </Flex>;

  const complianceSection = <Flex direction="column" gap="large">
    <Card><Flex direction="column" gap="small"><Heading>Retention policy</Heading><NumberInput name="auditRetention" label="Audit retention days" value={auditRetention} min={365} max={36500} onChange={(value) => setAuditRetention(Number(value))} /><NumberInput name="operationalRetention" label="Operational retention days" value={operationalRetention} min={30} max={3650} onChange={(value) => setOperationalRetention(Number(value))} /><Button disabled={working || !can('compliance.manage')} onClick={() => void act(async () => { await request('/enterprise/compliance', { method:'PUT', body:{ auditRetentionDays:auditRetention, operationalRetentionDays:operationalRetention, dataRegion:'global' } }); }, 'Compliance retention updated.')}>Save retention</Button></Flex></Card>
    <Card><Flex direction="column" gap="small"><Heading>Immutable audit chain</Heading><Button disabled={working || !can('audit.view')} onClick={() => void act(async () => { const result = await request('/enterprise/compliance/audit/verify'); if (!result.valid) throw new Error(`Audit chain verification failed at ${result.failures?.length ?? 0} events.`); }, 'Audit chain verified.')}>Verify chain</Button><Flex direction="row" gap="small" wrap="wrap"><Button variant="secondary" disabled={working || !can('audit.export')} onClick={() => void prepareSecureDownload('audit', { format: 'csv' })}>Prepare CSV</Button><Button variant="secondary" disabled={working || !can('audit.export')} onClick={() => void prepareSecureDownload('audit', { format: 'json' })}>Prepare JSON</Button><Button variant="secondary" disabled={working || !can('audit.export')} onClick={() => void prepareSecureDownload('audit', { format: 'jsonl' })}>Prepare JSONL</Button></Flex></Flex></Card>
    <Card><Flex direction="column" gap="small"><Heading>Legal hold</Heading><Input name="holdName" label="Name" value={legalHoldName} onChange={setLegalHoldName} /><TextArea name="holdReason" label="Reason" value={legalHoldReason} onChange={setLegalHoldReason} /><Button disabled={working || !can('legal_hold.manage')} onClick={() => void act(async () => { await request('/enterprise/compliance/legal-holds', { method:'POST', body:{ name:legalHoldName, reason:legalHoldReason, scope:{all:true} } }); }, 'Legal hold created.')}>Create legal hold</Button>{(compliance?.legalHolds ?? []).map((hold:Json)=><Flex key={hold.id} direction="row" justify="between"><Text>{hold.name} · {hold.status}</Text>{hold.status==='active'&&<Button variant="secondary" disabled={working||!can('legal_hold.manage')} onClick={()=>void act(async()=>{await request(`/enterprise/compliance/legal-holds/${hold.id}/release`,{method:'POST',body:{}});},'Legal hold released.')}>Release</Button>}</Flex>)}</Flex></Card>
    <Card><Flex direction="column" gap="small"><Heading>SIEM destination</Heading><Input name="siemName" label="Name" value={siemName} onChange={setSiemName} /><Input name="siemEndpoint" label="HTTPS endpoint" value={siemEndpoint} onChange={setSiemEndpoint} /><Button disabled={working || !can('siem.manage')} onClick={() => void act(async () => { await request('/enterprise/compliance/siem', { method:'POST', body:{ name:siemName, endpoint:siemEndpoint, eventFilters:[] } }); }, 'SIEM destination created.')}>Create SIEM destination</Button></Flex></Card>
    <Card><Flex direction="column" gap="small"><Heading>Customer data export</Heading><Select name="exportScope" label="Scope" value={exportScope} options={['audit','configuration','operational','complete'].map((value)=>({label:value,value}))} onChange={(value)=>setExportScope(String(value))}/><Select name="exportFormat" label="Format" value={exportFormat} options={['json','csv','jsonl'].map((value)=>({label:value.toUpperCase(),value}))} onChange={(value)=>setExportFormat(String(value))}/><Button disabled={working || !can('data_export.manage')} onClick={() => void act(async () => { const result=await request('/enterprise/compliance/exports',{method:'POST',body:{scope:exportScope,format:exportFormat}}); const secure=await request('/enterprise/downloads',{method:'POST',body:{kind:'data_export',resourceId:result.id,format:exportFormat}}); setSecureExportUrl(secure.url); setDownloadPath(null); }, 'Data export prepared.')}>Prepare export</Button>{downloadPath&&<Text>Legacy download path prepared: {downloadPath}</Text>}</Flex></Card>
  </Flex>;

  const reliabilitySection = <Flex direction="column" gap="large">
    {(reliability?.slos ?? []).map((slo:Json)=><Card key={slo.service}><Flex direction="row" justify="between"><Flex direction="column"><Text format={{fontWeight:'bold'}}>{slo.service}</Text><Text>Availability {slo.actual?.availability ?? 'n/a'}% / {slo.targets?.availability}% · p95 {slo.actual?.latencyP95Ms ?? 'n/a'} ms / {slo.targets?.latencyP95Ms ?? 'n/a'} ms</Text></Flex><StatusTag variant={statusVariant(String(slo.status))}>{slo.status}</StatusTag></Flex></Card>)}
    <Card><Flex direction="column" gap="small"><Heading>Service objective</Heading><Input name="sloService" label="Service" value={sloService} onChange={setSloService}/><NumberInput name="sloAvailability" label="Availability target %" value={sloAvailability} min={90} max={100} onChange={(value)=>setSloAvailability(Number(value))}/><NumberInput name="sloLatency" label="p95 latency target ms" value={sloLatency} min={1} max={600000} onChange={(value)=>setSloLatency(Number(value))}/><Button disabled={working||!can('reliability.manage')} onClick={()=>void act(async()=>{await request('/enterprise/reliability/slos',{method:'POST',body:{service:sloService,availabilityTarget:sloAvailability,successRateTarget:sloAvailability,latencyP95MsTarget:sloLatency,windowDays:30}});},'SLO updated.')}>Save SLO</Button></Flex></Card>
    <Card><Flex direction="column" gap="small"><Heading>Synthetic check</Heading><Input name="syntheticName" label="Name" value={syntheticName} onChange={setSyntheticName}/><Select name="syntheticType" label="Type" value={syntheticType} options={['health','oauth','hubspot_api','webhook','delivery','billing'].map((value)=>({label:value,value}))} onChange={(value)=>setSyntheticType(String(value))}/><Input name="syntheticTarget" label="Target (where applicable)" value={syntheticTarget} onChange={setSyntheticTarget}/><Button disabled={working||!can('reliability.manage')} onClick={()=>void act(async()=>{await request('/enterprise/reliability/synthetics',{method:'POST',body:{name:syntheticName,checkType:syntheticType,target:syntheticTarget,intervalMinutes:15,enabled:true}});},'Synthetic check created.')}>Create synthetic check</Button></Flex></Card>
    <Card><Flex direction="column" gap="small"><Heading>Incident</Heading><Input name="incidentTitle" label="Title" value={incidentTitle} onChange={setIncidentTitle}/><Select name="incidentSeverity" label="Severity" value={incidentSeverity} options={['minor','major','critical'].map((value)=>({label:value,value}))} onChange={(value)=>setIncidentSeverity(String(value))}/><Button disabled={working||!can('reliability.manage')||!incidentTitle} onClick={()=>void act(async()=>{await request('/enterprise/reliability/incidents',{method:'POST',body:{title:incidentTitle,severity:incidentSeverity,affectedServices:[sloService],publicMessage:'We are investigating an issue.',global:true}});},'Incident created.')}>Create incident</Button></Flex></Card>
    <Card><Heading>Backup and restore evidence</Heading><Text>Backup manifests and restore-test evidence are registered through the deployment runbook after Cloudflare D1 export and isolated restore validation. The App Home displays the latest recorded evidence.</Text>{(reliability?.backups??[]).slice(0,10).map((item:Json)=><Text key={item.id}>{item.backup_type} · {item.status} · {date(item.completed_at)}</Text>)}{(reliability?.restoreTests??[]).slice(0,10).map((item:Json)=><Text key={item.id}>Restore {item.status} · {date(item.completed_at)}</Text>)}</Card>
  </Flex>;

  const billingSection = <Flex direction="column" gap="large">
    <Card><Flex direction="column" gap="small"><Flex direction="row" justify="between"><Heading>Dodo Payments subscription</Heading><StatusTag variant={statusVariant(String(billing.status))}>{billing.tier} · {billing.status}</StatusTag></Flex><Text>Merchant-of-Record provider: {billing.provider ?? 'not connected'}</Text><Text>Period: {date(billing.currentPeriodStart)} → {date(billing.currentPeriodEnd)}</Text><Text>Usage mode: {billing.usageMode} · overage {billing.overageEnabled ? 'enabled' : 'disabled'}</Text></Flex></Card>
    <Card><Flex direction="column" gap="small"><Heading>Start or change subscription</Heading><Select name="checkoutTier" label="Tier" value={checkoutTier} options={[{label:'Growth',value:'growth'},{label:'Enterprise',value:'enterprise'}]} onChange={(value)=>setCheckoutTier(String(value))}/><Select name="checkoutInterval" label="Billing interval" value={checkoutInterval} options={[{label:'Monthly',value:'month'},{label:'Annual',value:'year'}]} onChange={(value)=>setCheckoutInterval(String(value))}/><Select name="usageMode" label="Usage mode" value={usageMode} options={[{label:'Capped predictable spend',value:'capped'},{label:'Metered overage',value:'metered'}]} onChange={(value)=>setUsageMode(String(value))}/><Toggle label="Enable overage billing" checked={overageEnabled} onChange={setOverageEnabled}/><Button disabled={working||!can('billing.manage')||!billing.checkoutConfigured} onClick={()=>void act(async()=>{const result=await request('/billing/checkout',{method:'POST',body:{tier:checkoutTier,interval:checkoutInterval,usageMode,overageEnabled}});setCheckoutUrl(result.url);},'Dodo checkout created.')}>Create secure checkout</Button>{checkoutUrl&&<Link href={{url:checkoutUrl,external:true}}>Open Dodo Payments checkout</Link>}<Button variant="secondary" disabled={working||!billing.portalConfigured} onClick={()=>void act(async()=>{const result=await request('/billing/portal',{method:'POST',body:{}});setPortalUrl(result.url);},'Customer portal session created.')}>Open customer portal</Button>{portalUrl&&<Link href={{url:portalUrl,external:true}}>Open Dodo customer portal</Link>}</Flex></Card>
    <Heading>Allowances and usage</Heading>{(billing.allowances??[]).map((allowance:Json)=><Card key={allowance.metric}><Text format={{fontWeight:'bold'}}>{allowance.metric}</Text><Text>Consumed {allowance.consumedQuantity} · included {allowance.includedQuantity} · hard limit {allowance.hardLimit??'unlimited'} · overage {allowance.overageEnabled?'on':'off'}</Text></Card>)}
    <Card><Flex direction="column" gap="small"><Heading>Configure allowance</Heading><Select name="allowanceMetric" label="Metric" value={allowanceMetric} options={['ai_credit','active_deal_overage','event_overage','retention_gb_month'].map((value)=>({label:value,value}))} onChange={(value)=>setAllowanceMetric(String(value))}/><NumberInput name="included" label="Included quantity" value={includedQuantity} min={0} onChange={(value)=>setIncludedQuantity(Number(value))}/><NumberInput name="hardLimit" label="Hard limit" value={hardLimit} min={0} onChange={(value)=>setHardLimit(Number(value))}/><Toggle label="Allow paid overage" checked={overageEnabled} onChange={setOverageEnabled}/><Button disabled={working||!can('billing.allowance.manage')} onClick={()=>void act(async()=>{await request('/billing/allowances',{method:'PUT',body:{metric:allowanceMetric,includedQuantity,hardLimit,overageEnabled}});},'Billing allowance updated.')}>Save allowance</Button></Flex></Card>
    <Card><Heading>Current-period metering</Heading>{(usage?.usage??[]).map((item:Json)=><Text key={item.event_name}>{item.event_name}: {item.quantity} units across {item.events} events</Text>)}</Card>
  </Flex>;

  const sections: Record<Section, React.ReactNode> = { overview:overviewSection, policies:policiesSection, analytics:analyticsSection, access:accessSection, remediation:remediationSection, alerts:alertsSection, compliance:complianceSection, reliability:reliabilitySection, billing:billingSection };

  return <Flex direction="column" gap="large">
    <HeaderActions><PrimaryHeaderActionButton onClick={() => void load()}>Refresh</PrimaryHeaderActionButton><SecondaryHeaderActionButton onClick={() => setSection('billing')}>Billing</SecondaryHeaderActionButton></HeaderActions>
    {error&&<Alert title="Action failed" variant="danger">{error}</Alert>}{notice&&<Alert title="DealGuard Enterprise" variant="success">{notice}</Alert>}{secureExportUrl&&<Alert title="Secure export ready" variant="success"><Link href={{url:secureExportUrl,external:true}}>Download once — expires in ten minutes</Link></Alert>}
    <Flex direction="row" justify="between" align="center" gap="medium"><Flex direction="column" gap="extra-small"><Heading>DealGuard Enterprise</Heading><Text>Revenue policy, remediation, analytics, compliance, reliability and commercial operations.</Text></Flex><StatusTag variant={billing.entitled?'success':'warning'}>{billing.tier}</StatusTag></Flex>
    <Select name="section" label="Enterprise workspace" value={section} options={sectionOptions} onChange={(value)=>setSection(String(value) as Section)}/><Divider/>
    {sections[section]}
  </Flex>;
};
