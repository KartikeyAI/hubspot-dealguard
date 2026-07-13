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
  MultiSelect,
  NumberInput,
  Select,
  StatusTag,
  Text,
  Toggle,
  hubspot,
} from '@hubspot/ui-extensions';

const API_BASE = 'https://dealguard-api.rokad.co/api/v1';

type Severity = 'info' | 'warning' | 'critical';
type CustomRule = { property: string; label: string; weight: number; severity: Severity; stageIds: string[] };
type Settings = {
  rules: {
    staleDays: number; maxStageAgeDays: number; requireOwner: boolean; requireAmount: boolean;
    requireCloseDate: boolean; requireNextStep: boolean; requireCompany: boolean; requireContact: boolean;
    excludedPipelineIds: string[]; excludedStageIds: string[]; customRequiredProperties: CustomRule[];
  };
  digest: { enabled: boolean; frequency: 'daily' | 'weekly'; recipients: string[]; dayOfWeek: number; hourUtc: number };
};
type ProblemDeal = {
  dealId: string; dealName: string; pipelineLabel: string; stageLabel: string; score: number;
  status: 'ready' | 'at_risk' | 'critical'; readinessSummary: string; assessedAt: string;
};
type Dashboard = {
  plan: 'free' | 'growth' | 'beta_growth'; totalDeals: number; readyDeals: number; atRiskDeals: number;
  criticalDeals: number; averageScore: number; incompleteHandoffs: number; lastScanAt: string | null; nextScanAt: string;
  topIssues: Array<{ code: string; label: string; count: number }>; problemDeals: ProblemDeal[];
  latestScan: null | { id: string; trigger: 'manual' | 'scheduled' | 'install'; status: 'running' | 'completed' | 'failed'; startedAt: string; completedAt: string | null; scannedCount: number; errorMessage: string | null };
};
type Metadata = {
  pipelines: Array<{ id: string; label: string; stages: Array<{ id: string; label: string }> }>;
  properties: Array<{ name: string; label: string; groupName: string; type: string; fieldType: string }>;
};
type SettingsResponse = { plan: Dashboard['plan']; settings: Settings };
type RequestOptions = { method?: 'GET' | 'PUT' | 'POST'; body?: Record<string, unknown> };

hubspot.extend<'settings'>(() => <DealGuardSettings />);

const delay = (milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
function statusVariant(status: ProblemDeal['status']): 'success' | 'warning' | 'danger' {
  if (status === 'ready') return 'success';
  if (status === 'at_risk') return 'warning';
  return 'danger';
}

const DealGuardSettings = () => {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [dashboard, setDashboard] = useState<Dashboard | null>(null);
  const [metadata, setMetadata] = useState<Metadata | null>(null);
  const [plan, setPlan] = useState<Dashboard['plan']>('free');
  const [recipients, setRecipients] = useState('');
  const [loading, setLoading] = useState(true);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const fetchJson = async (path: string, options?: RequestOptions) => {
    const response = await hubspot.fetch(`${API_BASE}${path}`, {
      method: options?.method ?? 'GET', timeout: 15000, ...(options?.body ? { body: options.body } : {}),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data?.error?.message ?? 'DealGuard request failed.');
    return data;
  };

  const load = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      const [settingsData, dashboardData, metadataData] = await Promise.all([
        fetchJson('/settings') as Promise<SettingsResponse>, fetchJson('/dashboard') as Promise<Dashboard>, fetchJson('/metadata') as Promise<Metadata>,
      ]);
      setSettings(settingsData.settings); setPlan(settingsData.plan);
      setRecipients(settingsData.settings.digest.recipients.join(', ')); setDashboard(dashboardData); setMetadata(metadataData);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'DealGuard settings could not be loaded.');
    } finally { setLoading(false); }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const refreshDashboard = async (): Promise<Dashboard> => {
    const next = await fetchJson('/dashboard') as Dashboard; setDashboard(next); return next;
  };

  const save = async () => {
    if (!settings) return;
    setWorking(true); setError(null); setNotice(null);
    try {
      const payload: Settings = { ...settings, digest: { ...settings.digest, recipients: recipients.split(',').map((item) => item.trim()).filter(Boolean) } };
      const response = await fetchJson('/settings', { method: 'PUT', body: payload as unknown as Record<string, unknown> }) as SettingsResponse;
      setSettings(response.settings); setRecipients(response.settings.digest.recipients.join(', '));
      setNotice('Readiness rules and digest settings saved. New rules apply on the next scan.');
    } catch (caught) { setError(caught instanceof Error ? caught.message : 'Settings could not be saved.'); }
    finally { setWorking(false); }
  };

  const scan = async () => {
    setWorking(true); setError(null); setNotice(null);
    try {
      await fetchJson('/scans', { method: 'POST', body: {} });
      setNotice('Portal scan started. This page will update when the scan finishes.');
      for (let attempt = 0; attempt < 6; attempt += 1) {
        await delay(2000);
        const next = await refreshDashboard();
        if (next.latestScan?.status !== 'running') {
          setNotice(next.latestScan?.status === 'completed' ? `Scan completed: ${next.latestScan.scannedCount} deals assessed.` : 'The scan did not complete. Review the scan status below or contact support.');
          break;
        }
      }
    } catch (caught) { setError(caught instanceof Error ? caught.message : 'Portal scan could not be started.'); }
    finally { setWorking(false); }
  };

  const testDigest = async () => {
    setWorking(true); setError(null); setNotice(null);
    try { await fetchJson('/digest/test', { method: 'POST', body: {} }); setNotice('Test digest sent.'); }
    catch (caught) { setError(caught instanceof Error ? caught.message : 'Test digest failed.'); }
    finally { setWorking(false); }
  };

  const propertyOptions = useMemo(() => (metadata?.properties ?? []).map((property) => ({ label: `${property.label} (${property.name})`, value: property.name })), [metadata]);
  const pipelineOptions = useMemo(() => (metadata?.pipelines ?? []).map((pipeline) => ({ label: pipeline.label, value: pipeline.id })), [metadata]);
  const stageOptions = useMemo(() => (metadata?.pipelines ?? []).flatMap((pipeline) => pipeline.stages.map((stage) => ({ label: `${pipeline.label} — ${stage.label}`, value: stage.id }))), [metadata]);

  if (loading) return <LoadingSpinner label="Loading DealGuard settings" />;
  if (!settings || !dashboard || !metadata) return <Alert title="DealGuard unavailable" variant="danger">{error ?? 'Settings are unavailable.'}</Alert>;

  const maxCustomRules = plan === 'free' ? 3 : 25;
  const updateRule = <K extends keyof Settings['rules']>(key: K, value: Settings['rules'][K]) => setSettings({ ...settings, rules: { ...settings.rules, [key]: value } });
  const updateDigest = <K extends keyof Settings['digest']>(key: K, value: Settings['digest'][K]) => setSettings({ ...settings, digest: { ...settings.digest, [key]: value } });
  const updateCustomRule = (index: number, patch: Partial<CustomRule>) => updateRule('customRequiredProperties', settings.rules.customRequiredProperties.map((rule, ruleIndex) => ruleIndex === index ? { ...rule, ...patch } : rule));
  const addCustomRule = () => {
    if (settings.rules.customRequiredProperties.length >= maxCustomRules) return;
    const used = new Set(settings.rules.customRequiredProperties.map((rule) => rule.property));
    const property = metadata.properties.find((item) => !used.has(item.name));
    updateRule('customRequiredProperties', [...settings.rules.customRequiredProperties, { property: property?.name ?? '', label: property?.label ?? 'Required field', weight: 10, severity: 'warning', stageIds: [] }]);
  };
  const removeCustomRule = (index: number) => updateRule('customRequiredProperties', settings.rules.customRequiredProperties.filter((_, ruleIndex) => ruleIndex !== index));

  return (
    <Flex direction="column" gap="large">
      {error && <Alert title="Action failed" variant="danger">{error}</Alert>}
      {notice && <Alert title="DealGuard update" variant="success">{notice}</Alert>}
      <Flex direction="row" justify="between" align="center" gap="medium">
        <Flex direction="column" gap="extra-small"><Heading>DealGuard pipeline health</Heading><Text>Explainable readiness checks for active deals and closed-won sales-to-delivery handoffs.</Text></Flex>
        <StatusTag variant={plan === 'free' ? 'default' : 'success'}>{plan === 'beta_growth' ? 'Beta Growth' : plan}</StatusTag>
      </Flex>
      <Flex direction="row" gap="medium" wrap="wrap">
        <Text><Text format={{ fontWeight: 'bold' }}>{dashboard.averageScore}</Text> average score</Text>
        <Text><Text format={{ fontWeight: 'bold' }}>{dashboard.readyDeals}</Text> ready</Text>
        <Text><Text format={{ fontWeight: 'bold' }}>{dashboard.atRiskDeals}</Text> at risk</Text>
        <Text><Text format={{ fontWeight: 'bold' }}>{dashboard.criticalDeals}</Text> critical</Text>
        <Text><Text format={{ fontWeight: 'bold' }}>{dashboard.incompleteHandoffs}</Text> incomplete handoffs</Text>
      </Flex>
      {dashboard.latestScan && <Alert title={`Latest ${dashboard.latestScan.trigger} scan: ${dashboard.latestScan.status}`} variant={dashboard.latestScan.status === 'failed' ? 'danger' : dashboard.latestScan.status === 'running' ? 'warning' : 'success'}>
        {dashboard.latestScan.status === 'running' ? 'DealGuard is assessing this portal in the background.' : dashboard.latestScan.status === 'failed' ? dashboard.latestScan.errorMessage ?? 'The scan failed.' : `${dashboard.latestScan.scannedCount} deals were assessed.`}
      </Alert>}
      <Flex direction="row" gap="small" wrap="wrap"><Button onClick={() => void scan()} disabled={working || dashboard.latestScan?.status === 'running'}>Run portal scan</Button><Button variant="secondary" onClick={() => void refreshDashboard()} disabled={working}>Refresh dashboard</Button></Flex>

      {dashboard.problemDeals.length > 0 && <Flex direction="column" gap="small"><Heading>Deals requiring attention</Heading>{dashboard.problemDeals.map((deal) => <Card key={deal.dealId}><Flex direction="column" gap="extra-small">
        <Flex direction="row" justify="between" align="center" gap="small"><Text format={{ fontWeight: 'bold' }}>{deal.dealName}</Text><StatusTag variant={statusVariant(deal.status)}>{deal.score}/100</StatusTag></Flex>
        <Text>{deal.pipelineLabel} — {deal.stageLabel}</Text><Text>{deal.readinessSummary}</Text><Text variant="microcopy">Deal ID {deal.dealId} · assessed {new Date(deal.assessedAt).toLocaleString()}</Text>
      </Flex></Card>)}</Flex>}
      {dashboard.topIssues.length > 0 && <Flex direction="column" gap="extra-small"><Heading>Most frequent readiness gaps</Heading>{dashboard.topIssues.map((issue) => <Text key={issue.code}>• <Text format={{ fontWeight: 'bold' }}>{issue.label}</Text>: {issue.count} deals</Text>)}</Flex>}

      <Divider /><Heading>Readiness thresholds</Heading>
      <Flex direction="row" gap="medium" wrap="wrap">
        <NumberInput name="staleDays" label="Stale after days" description="Flag open deals without recent sales activity." value={settings.rules.staleDays} min={1} max={90} onChange={(value) => updateRule('staleDays', Number(value))} />
        <NumberInput name="maxStageAgeDays" label="Maximum days in stage" description="Flag open deals that remain in the same stage too long." value={settings.rules.maxStageAgeDays} min={1} max={365} onChange={(value) => updateRule('maxStageAgeDays', Number(value))} />
      </Flex>
      <Heading>Required deal information</Heading><Flex direction="column" gap="small">
        <Toggle label="Require a deal owner" checked={settings.rules.requireOwner} onChange={(value) => updateRule('requireOwner', value)} />
        <Toggle label="Require deal amount" checked={settings.rules.requireAmount} onChange={(value) => updateRule('requireAmount', value)} />
        <Toggle label="Require close date" checked={settings.rules.requireCloseDate} onChange={(value) => updateRule('requireCloseDate', value)} />
        <Toggle label="Require next step on open deals" checked={settings.rules.requireNextStep} onChange={(value) => updateRule('requireNextStep', value)} />
        <Toggle label="Require an associated company" checked={settings.rules.requireCompany} onChange={(value) => updateRule('requireCompany', value)} />
        <Toggle label="Require an associated contact" checked={settings.rules.requireContact} onChange={(value) => updateRule('requireContact', value)} />
      </Flex>
      <Heading>Scoring exclusions</Heading>
      <MultiSelect name="excludedPipelines" label="Excluded pipelines" description="Deals in these pipelines receive no readiness deductions." options={pipelineOptions} value={settings.rules.excludedPipelineIds} onChange={(value) => updateRule('excludedPipelineIds', value.map(String))} />
      <MultiSelect name="excludedStages" label="Excluded stages" description="Use this for administrative or non-revenue stages. Closed-lost deals are excluded automatically." options={stageOptions} value={settings.rules.excludedStageIds} onChange={(value) => updateRule('excludedStageIds', value.map(String))} />

      <Divider /><Flex direction="row" justify="between" align="center" gap="medium"><Flex direction="column" gap="extra-small"><Heading>Custom required-property rules</Heading><Text>Require portal-specific deal properties globally or only in selected stages.</Text></Flex><Text>{settings.rules.customRequiredProperties.length}/{maxCustomRules}</Text></Flex>
      {settings.rules.customRequiredProperties.map((rule, index) => <Card key={`${rule.property}-${index}`}><Flex direction="column" gap="small">
        <Select name={`customProperty${index}`} label="Deal property" options={propertyOptions} value={rule.property} onChange={(value) => { const propertyName = String(value); const property = metadata.properties.find((item) => item.name === propertyName); updateCustomRule(index, { property: propertyName, ...(property ? { label: property.label } : {}) }); }} />
        <Input name={`customLabel${index}`} label="User-facing label" value={rule.label} onChange={(value) => updateCustomRule(index, { label: value })} />
        <Flex direction="row" gap="medium" wrap="wrap">
          <Select name={`customSeverity${index}`} label="Severity" options={[{ label: 'Information', value: 'info' }, { label: 'Warning', value: 'warning' }, { label: 'Critical', value: 'critical' }]} value={rule.severity} onChange={(value) => updateCustomRule(index, { severity: String(value) as Severity })} />
          <NumberInput name={`customWeight${index}`} label="Score deduction" value={rule.weight} min={1} max={30} onChange={(value) => updateCustomRule(index, { weight: Number(value) })} />
        </Flex>
        <MultiSelect name={`customStages${index}`} label="Apply only in stages" description="Leave empty to apply this rule in every included stage." options={stageOptions} value={rule.stageIds} onChange={(value) => updateCustomRule(index, { stageIds: value.map(String) })} />
        <Button variant="secondary" onClick={() => removeCustomRule(index)} disabled={working}>Remove rule</Button>
      </Flex></Card>)}
      <Button variant="secondary" onClick={addCustomRule} disabled={working || settings.rules.customRequiredProperties.length >= maxCustomRules}>Add required-property rule</Button>

      <Divider /><Heading>Pipeline digest</Heading>
      <Toggle label="Enable scheduled email digest" checked={settings.digest.enabled} onChange={(value) => updateDigest('enabled', value)} />
      <Input name="digestRecipients" label="Recipients (comma separated)" value={recipients} onChange={setRecipients} />
      <Select name="digestFrequency" label="Frequency" value={settings.digest.frequency} options={plan === 'free' ? [{ label: 'Weekly', value: 'weekly' }] : [{ label: 'Daily', value: 'daily' }, { label: 'Weekly', value: 'weekly' }]} onChange={(value) => updateDigest('frequency', String(value) as Settings['digest']['frequency'])} />
      {settings.digest.frequency === 'weekly' && <Select name="digestDay" label="Weekly delivery day" value={settings.digest.dayOfWeek} options={[{ label: 'Sunday', value: 0 }, { label: 'Monday', value: 1 }, { label: 'Tuesday', value: 2 }, { label: 'Wednesday', value: 3 }, { label: 'Thursday', value: 4 }, { label: 'Friday', value: 5 }, { label: 'Saturday', value: 6 }]} onChange={(value) => updateDigest('dayOfWeek', Number(value))} />}
      <NumberInput name="digestHour" label="Delivery hour (UTC)" value={settings.digest.hourUtc} min={0} max={23} onChange={(value) => updateDigest('hourUtc', Number(value))} />
      <Flex direction="row" gap="small" wrap="wrap"><Button variant="primary" onClick={() => void save()} disabled={working}>Save settings</Button><Button variant="secondary" onClick={() => void testDigest()} disabled={working || !settings.digest.enabled}>Send test digest</Button></Flex>
      <Text variant="microcopy">Last completed scan: {dashboard.lastScanAt ? new Date(dashboard.lastScanAt).toLocaleString() : 'Not completed'} · Next scheduled scan: {new Date(dashboard.nextScanAt).toLocaleString()}</Text>
    </Flex>
  );
};
