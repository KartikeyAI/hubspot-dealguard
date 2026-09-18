import React, { useEffect, useRef, useState } from 'react';
import { Alert, Button, Card, Flex, Heading, LoadingSpinner, Select, Text, hubspot } from '@hubspot/ui-extensions';
import { safeProductError } from './product-ui';
const ROOT = 'https://dealguard-api.rokad.co/api/v1/enterprise/background-intelligence';
type Status = { settings: { enabled: boolean; refreshHours: number; dailyRequestLimit: number };
  requestsToday: number; lastRunAt: string | null; jobs: Array<{status: string;count: number}>;
  coverage: {open_deals: number; recent_briefs: number} | null };
export function BackgroundIntelligencePanel({ enabled }: {enabled: boolean}) {
  const [status,setStatus] = useState<Status|null>(null);
  const [hours,setHours] = useState(24), [budget,setBudget] = useState(1000);
  const [busy,setBusy] = useState(false), [error,setError] = useState<string|null>(null);
  const version = useRef(0);
  useEffect(() => { if (!enabled) { setStatus(null); setBusy(false); } return () => { version.current += 1; }; },[enabled]);
  const request = async (action: 'load'|'enable'|'pause'|'retry') => {
    if (!enabled || busy) return;
    const current = ++version.current; setBusy(true); setError(null);
    try {
      const response = await hubspot.fetch(`${ROOT}${action === 'retry' ? '/retry' : ''}`, {
        method: action === 'load' ? 'GET' : action === 'retry' ? 'POST' : 'PUT', timeout: 20000,
        ...(action === 'enable' || action === 'pause' ? { body: { enabled: action === 'enable', refreshHours: hours, dailyRequestLimit: budget } } : {}),
      });
      let data = await response.json();
      if (!response.ok) throw new Error(safeProductError(data?.error?.message));
      if (action === 'retry') {
        const refreshed = await hubspot.fetch(ROOT, {method:'GET',timeout:20000});
        data = await refreshed.json();
        if (!refreshed.ok) throw new Error(safeProductError(data?.error?.message));
      }
      if (current !== version.current) return;
      setStatus(data); setHours(data.settings.refreshHours); setBudget(data.settings.dailyRequestLimit);
    } catch (problem) { if (current === version.current) setError(safeProductError(problem instanceof Error ? problem.message : undefined)); }
    finally { if (current === version.current) setBusy(false); }
  };
  if (!enabled) return null;
  return <Card><Flex direction="column" gap="small">
    <Heading>Background intelligence</Heading>
    <Text>Opt-in enrichment for recorded open deals, including deals nobody has opened. Portal-wide scan permission is required. This does not send notifications or change HubSpot fields.</Text>
    <Button disabled={busy} onClick={() => request('load')}>Load background status</Button>
    {busy ? <LoadingSpinner label="Updating background intelligence" /> : null}
    {error ? <Alert title="Background controls unavailable" variant="warning">{error}</Alert> : null}
    {status ? <>
      <Text>{status.settings.enabled ? 'Enabled' : 'Paused'} · {status.requestsToday} request reservations used this UTC day · last run {status.lastRunAt ?? 'Not run'}</Text>
      <Text>{status.coverage?.recent_briefs ?? 0} recently generated matching briefs / {status.coverage?.open_deals ?? 0} recorded open deals. This is coverage, not a promise that every enrichment source is current.</Text>
      <Text>{status.jobs.map(job=>`${job.status}: ${job.count}`).join(' · ') || 'No jobs yet'}</Text>
      {!busy ? <Flex direction="row" gap="small">
        <Select name="background-refresh" label="Refresh target (hours)" value={hours}
          options={[1,6,12,24,48,72].map(value=>({label:String(value),value}))} onChange={value=>setHours(Number(value))} />
        <Select name="background-budget" label="Daily request budget (UTC)" value={budget}
          options={[100,500,1000,5000,10000].map(value=>({label:String(value),value}))} onChange={value=>setBudget(Number(value))} />
      </Flex> : null}
      <Flex direction="row" gap="small">
        <Button disabled={busy} onClick={()=>request('enable')}>Enable with these limits</Button>
        <Button disabled={busy || !status.settings.enabled} onClick={()=>request('pause')}>Pause enrichment</Button>
        <Button disabled={busy || !status.settings.enabled} onClick={()=>request('retry')}>Retry failed jobs</Button>
      </Flex>
      <Text>The refresh interval is a target, not a guarantee. Queue size, budgets and provider failures can delay coverage. Pausing stops new admissions; an already admitted read may finish.</Text>
    </> : null}
  </Flex></Card>;
}
