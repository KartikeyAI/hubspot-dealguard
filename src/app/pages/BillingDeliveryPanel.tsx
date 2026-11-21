import React, { useEffect, useRef, useState } from 'react';
import { Alert, Button, Card, Flex, Heading, LoadingSpinner, Text, hubspot } from '@hubspot/ui-extensions';
import { safeProductError } from './product-ui';

type Outcome = { status: 'pending' | 'reported' | 'failed' | 'ignored'; reason: string | null; events: number; oldestObservationAt: string | null };
type DeliveryStatus = { generatedAt: string; coverage: 'retained_events'; readOnly: true; outcomes: Outcome[] };
const LABELS = { pending: 'Pending retry', reported: 'Provider acknowledged', failed: 'Reconciliation required', ignored: 'Not sent to provider' };

export function BillingDeliveryPanel({ enabled }: { enabled: boolean }) {
  const [data, setData] = useState<DeliveryStatus | null>(null), [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false); const generation = useRef(0), inFlight = useRef(false);
  useEffect(() => {
    if (!enabled) { setData(null); setError(null); setBusy(false); inFlight.current = false; }
    return () => { generation.current += 1; inFlight.current = false; };
  }, [enabled]);
  async function load() {
    if (!enabled || inFlight.current) return;
    const current = ++generation.current; inFlight.current = true; setBusy(true); setError(null); setData(null);
    try {
      const response = await hubspot.fetch('https://dealguard-api.rokad.co/api/v1/billing/delivery', { method: 'GET', timeout: 20000 });
      const result = await response.json();
      if (!response.ok) throw new Error(safeProductError(result?.error?.message));
      if (result.coverage !== 'retained_events' || result.readOnly !== true || !Array.isArray(result.outcomes)
        || result.outcomes.some((row: Outcome) => !Object.hasOwn(LABELS, row.status) || !Number.isSafeInteger(row.events) || row.events < 0)) {
        throw new Error('Billing delivery status could not be verified.');
      }
      if (current === generation.current) setData(result);
    } catch (problem) {
      if (current === generation.current) setError(safeProductError(problem instanceof Error ? problem.message : null));
    } finally {
      if (current === generation.current) { setBusy(false); inFlight.current = false; }
    }
  }
  if (!enabled) return null;
  return <Card><Flex direction="column" gap="small">
    <Heading>Usage delivery</Heading>
    <Text>Read-only status of retained usage events. Delivery acknowledgment is not an invoice or payment confirmation.</Text>
    <Button disabled={busy} onClick={() => void load()}>Load delivery status</Button>
    {busy ? <LoadingSpinner label="Loading billing delivery status" /> : null}
    {error ? <Alert title="Billing delivery unavailable" variant="warning">{error}</Alert> : null}
    {data ? <>
      <Text>Generated: {data.generatedAt}</Text>
      {data.outcomes.length === 0 ? <Text>No retained usage events.</Text> : data.outcomes.map(row => <Flex direction="column" gap="extra-small" key={`${row.status}:${row.reason ?? ''}`}>
        <Text>{LABELS[row.status]}: {row.events}{row.reason ? ` · ${row.reason.replaceAll('_', ' ')}` : ''}</Text>
        <Text variant="microcopy">Oldest retained observation: {row.oldestObservationAt ?? 'Unavailable'}</Text>
      </Flex>)}
      <Text>Withheld events need comparison with original provider records. This screen does not resend, retarget, refund, or change event times. Local-only and failed delivery still count toward consumed allowances.</Text>
    </> : null}
  </Flex></Card>;
}
