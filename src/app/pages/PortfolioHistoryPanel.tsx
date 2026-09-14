import React, { useEffect, useRef, useState } from 'react';
import { Alert, Button, Card, Flex, Heading, LoadingSpinner, Select, Table,
  TableHead, TableHeader, TableBody, TableRow, TableCell, Text, hubspot } from '@hubspot/ui-extensions';
import { safeProductError } from './product-ui';

const API_BASE = 'https://dealguard-api.rokad.co/api/v1';
const PAGE_SIZE = 7;
type Point = {
  date: string; snapshotAt: string; evidenceStatus: string; openDeals: number;
  averageScore: number | null; assessedDeals: number; carriedForwardDeals: number;
  freshness: { freshDeals: number; agingDeals: number; staleDeals: number; oldestObservedAt: string | null };
  monetary: { mode: string; currencyCode: string | null; pipelineAmount: number | null };
};
type History = { status: string; reason: string | null; generatedAt: string; points: Point[] };

function money(point: Point): string {
  const monetary = point.monetary;
  if (monetary.pipelineAmount === null) return 'Unavailable';
  const basis = monetary.mode === 'company_currency' ? 'company currency' : monetary.currencyCode;
  return `${monetary.pipelineAmount.toLocaleString('en', { maximumFractionDigits: 2 })} ${basis ?? ''}`;
}

/** On-demand history has no additional request cost until explicitly loaded. */
export function PortfolioHistoryPanel({ enabled }: { enabled: boolean }) {
  const [days, setDays] = useState(30);
  const [history, setHistory] = useState<History | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [page, setPage] = useState(0);
  const requestId = useRef(0);

  useEffect(() => {
    requestId.current += 1;
    setHistory(null); setBusy(false); setError(null); setPage(0);
    return () => { requestId.current += 1; };
  }, [enabled]);

  async function load() {
    if (!enabled || busy) return;
    const id = ++requestId.current;
    setBusy(true); setError(null); setHistory(null); setPage(0);
    try {
      const response = await hubspot.fetch(`${API_BASE}/enterprise/portfolio-history?days=${days}`, {
        method: 'GET', timeout: 20_000,
      });
      const data = await response.json();
      if (!response.ok) throw new Error(safeProductError(data?.error?.message));
      if (!['available', 'unavailable'].includes(data?.status) || !Array.isArray(data?.points)) {
        throw new Error('Portfolio history is unavailable. Please try again.');
      }
      if (id === requestId.current) setHistory(data as History);
    } catch (err) {
      if (id === requestId.current) setError(safeProductError(err instanceof Error ? err.message : ''));
    } finally {
      if (id === requestId.current) setBusy(false);
    }
  }

  if (!enabled) return null;
  const points = history?.points ?? [];
  const end = Math.max(0, points.length - page * PAGE_SIZE);
  const displayed = points.slice(Math.max(0, end - PAGE_SIZE), end).reverse();
  return <Card><Flex direction="column" gap="medium">
    <Heading>Portfolio history and evidence age</Heading>
    <Text>Daily portfolio states reconstructed from retained assessments, within your current access. This is separate from the same-day assessment trend.</Text>
    <Flex direction="row" gap="small" align="end">
      {busy ? <Text>Window: {days} calendar days (UTC)</Text> : <Select name="portfolio-history-days" label="Calendar days (UTC)" value={days}
        options={[7, 30, 90].map((value) => ({ label: `${value} days`, value }))}
        onChange={(value) => { requestId.current += 1; setDays(Number(value)); setHistory(null); setError(null); setPage(0); }} />}
      <Button onClick={load} disabled={busy}>Load history</Button>
    </Flex>
    {busy ? <LoadingSpinner label="Loading recorded portfolio history" /> : null}
    {error ? <Alert title="History could not be loaded" variant="warning">{error}</Alert> : null}
    {history?.status === 'unavailable' ? <Alert title="History unavailable" variant="warning">
      {history.reason === 'portfolio_limit_exceeded'
        ? 'This history view supports up to 10,000 deals within your assigned access. No partial totals are shown.'
        : history.reason === 'invalid_assessment_timestamps'
          ? 'Some retained assessment timestamps are invalid. History is withheld until the evidence is repaired.'
          : 'The history result is incomplete. No partial totals are shown.'}
    </Alert> : null}
    {history?.status === 'available' ? <>
      <Text>Generated {history.generatedAt}. Today is partial. Carrying a prior observation forward does not make its evidence fresh.</Text>
      <Text>Fresh: up to 24 hours; aging: over 24 to 72 hours; stale: over 72 hours, measured at each daily cutoff.</Text>
      <Table><TableHead><TableRow>
        <TableHeader>UTC day</TableHeader><TableHeader>Open deals</TableHeader><TableHeader>Readiness</TableHeader>
        <TableHeader>Assessed / carried</TableHeader><TableHeader>Fresh / aging / stale</TableHeader>
        <TableHeader>Recorded amount</TableHeader><TableHeader>Oldest open evidence</TableHeader>
      </TableRow></TableHead><TableBody>
        {displayed.map((point) => <TableRow key={point.date}>
          <TableCell><Text>{point.date}</Text></TableCell>
          <TableCell><Text>{point.evidenceStatus === 'no_observations' ? 'No retained observation' : String(point.openDeals)}</Text></TableCell>
          <TableCell><Text>{point.averageScore === null ? 'Unavailable' : `${point.averageScore}/100`}</Text></TableCell>
          <TableCell><Text>{point.evidenceStatus === 'no_observations' ? 'Unavailable' : `${point.assessedDeals} / ${point.carriedForwardDeals}`}</Text></TableCell>
          <TableCell><Text>{point.evidenceStatus === 'no_observations' ? 'Unavailable' : `${point.freshness.freshDeals} / ${point.freshness.agingDeals} / ${point.freshness.staleDeals}`}</Text></TableCell>
          <TableCell><Text>{money(point)}</Text></TableCell>
          <TableCell><Text>{point.freshness.oldestObservedAt ?? 'Unavailable'}</Text></TableCell>
        </TableRow>)}
      </TableBody></Table>
      <Flex direction="row" gap="small">
        <Button disabled={page === 0} onClick={() => setPage((value) => Math.max(0, value - 1))}>Newer days</Button>
        <Button disabled={end <= PAGE_SIZE} onClick={() => setPage((value) => value + 1)}>Older days</Button>
      </Flex>
      <Text>Amounts are comparable only within their stated currency basis. Missing retained history is not zero pipeline. Unrecorded deletion or reassignment is not inferred; portfolio or policy changes do not prove improvement.</Text>
    </> : null}
  </Flex></Card>;
}
