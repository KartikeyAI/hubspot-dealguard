import React, { useState } from 'react';
import { Alert, Button, Divider, Flex, Heading, Link, StatusTag, Text, hubspot } from '@hubspot/ui-extensions';
import {
  API_BASE,
  CardLoading,
  CardUnavailable,
  commercialVariant,
  formatDate,
  useDealAssessment,
} from './deal-intelligence-shared';

hubspot.extend<'crm.record.tab'>(({ context }) => <DealGuardCommercialCard dealId={String(context.crm.objectId)} />);

function amount(value: number | null, currency: string | null): string {
  if (value === null) return 'Not available';
  return `${currency ?? 'Currency unknown'} ${value.toLocaleString(undefined, { maximumFractionDigits: 2 })}`;
}

const DealGuardCommercialCard = ({ dealId }: { dealId: string }) => {
  const { assessment, loading, working, error, notice, load } = useDealAssessment(dealId);
  const [authorizationWorking, setAuthorizationWorking] = useState(false);
  const [authorizationError, setAuthorizationError] = useState<string | null>(null);
  const [authorizeUrl, setAuthorizeUrl] = useState<string | null>(null);

  if (loading) return <CardLoading label="Loading commercial integrity" />;
  if (!assessment) return <CardUnavailable error={error} />;
  const commercial = assessment.intelligence?.commercialIntegrity;

  const prepareAuthorization = async () => {
    setAuthorizationWorking(true);
    setAuthorizationError(null);
    try {
      const response = await hubspot.fetch(`${API_BASE}/integrations/hubspot/commercial-access`, {
        method: 'POST',
        body: {},
        timeout: 15000,
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data?.error?.message ?? 'Commercial authorization could not be prepared.');
      setAuthorizeUrl(typeof data?.authorizeUrl === 'string' ? data.authorizeUrl : null);
      if (!data?.authorizeUrl) await load(true);
    } catch (caught) {
      setAuthorizationError(caught instanceof Error ? caught.message : 'Commercial authorization could not be prepared.');
    } finally {
      setAuthorizationWorking(false);
    }
  };

  if (!commercial) {
    return <Flex direction="column" gap="medium">
      {error && <Alert title="Action failed" variant="danger">{error}</Alert>}
      <Alert title="Commercial evidence is not available" variant="warning">Refresh the deal to evaluate optional quote and line-item metadata. Core readiness and Deal Brief evidence remain available when this module cannot be loaded.</Alert>
      <Button onClick={() => void load(true)} disabled={working}>Refresh commercial evidence</Button>
    </Flex>;
  }

  const authorizationRequired = commercial.authorization.status === 'required';
  const authorizationPartial = commercial.authorization.status === 'partial';

  return <Flex direction="column" gap="medium">
    {error && <Alert title="Action failed" variant="danger">{error}</Alert>}
    {notice && <Alert title="Done" variant="success">{notice}</Alert>}
    {authorizationError && <Alert title="Authorization failed" variant="danger">{authorizationError}</Alert>}

    <Flex direction="row" justify="between" align="center" gap="medium">
      <Flex direction="column" gap="extra-small">
        <Heading>Commercial integrity</Heading>
        <Text>{commercial.summary}</Text>
      </Flex>
      <StatusTag variant={commercialVariant(commercial.status)}>{commercial.status.replaceAll('_', ' ')}</StatusTag>
    </Flex>
    <Text>{commercial.score === null ? 'Score unavailable' : `${commercial.score}/100`} · {commercial.confidence} confidence · {commercial.coverage.percent}% source coverage.</Text>

    {(authorizationRequired || authorizationPartial) && <Alert title="Optional commercial authorization" variant={authorizationRequired ? 'warning' : 'info'}>
      DealGuard needs the optional quote and line-item read permissions to evaluate the complete commercial package. Missing: {commercial.authorization.missingScopes.join(', ') || 'none'}. Existing DealGuard features continue to work without these permissions.
    </Alert>}
    {(authorizationRequired || authorizationPartial) && <Flex direction="row" gap="small" align="center" wrap="wrap">
      <Button onClick={() => void prepareAuthorization()} disabled={authorizationWorking}>Prepare commercial authorization</Button>
      {authorizeUrl && <Link href={authorizeUrl}>Open HubSpot authorization</Link>}
    </Flex>}

    <Divider />
    <Heading>Line-item evidence</Heading>
    {commercial.coverage.lineItems ? <>
      <Text>{commercial.lineItems.count} associated line item{commercial.lineItems.count === 1 ? '' : 's'} · {commercial.lineItems.completeCount} complete · {commercial.lineItems.incompleteCount} incomplete.</Text>
      <Text>Amount coverage: {commercial.lineItems.amountCoveragePercent}% · subtotal: {amount(commercial.lineItems.subtotal, commercial.lineItems.subtotalCurrencyCode)}.</Text>
      <Text>Deal/subtotal difference: {commercial.lineItems.dealAmountDifferencePercent === null ? 'Not comparable' : `${commercial.lineItems.dealAmountDifferencePercent}%`} · discounted items: {commercial.lineItems.discountedCount} · maximum recorded discount: {commercial.lineItems.maximumDiscountPercent === null ? 'None detected' : `${commercial.lineItems.maximumDiscountPercent}%`}.</Text>
      <Text>Recurring line items: {commercial.lineItems.recurringCount}.</Text>
    </> : <Text>Line-item evidence is not authorized or unavailable.</Text>}

    <Divider />
    <Heading>Quote evidence</Heading>
    {commercial.coverage.quotes ? <>
      <Text>{commercial.quotes.count} associated quote{commercial.quotes.count === 1 ? '' : 's'} · {commercial.quotes.currentCount} current · {commercial.quotes.acceptedCount} accepted · {commercial.quotes.issuedCount} issued.</Text>
      <Text>Draft: {commercial.quotes.draftCount} · pending: {commercial.quotes.pendingCount} · expired: {commercial.quotes.expiredCount} · rejected: {commercial.quotes.rejectedCount}.</Text>
      <Text>Latest current quote: {amount(commercial.quotes.latestCurrentQuoteAmount, commercial.quotes.latestCurrentQuoteCurrencyCode)} · deal/quote difference: {commercial.quotes.dealAmountDifferencePercent === null ? 'Not comparable' : `${commercial.quotes.dealAmountDifferencePercent}%`}.</Text>
      <Text>Next expiration: {formatDate(commercial.quotes.nextExpirationAt)}{commercial.quotes.nearestExpirationDays === null ? '' : ` · ${commercial.quotes.nearestExpirationDays} days away`}.</Text>
    </> : <Text>Quote evidence is not authorized or unavailable.</Text>}

    <Divider />
    <Heading>Commercial signals</Heading>
    {commercial.signals.length === 0
      ? <Text>No material commercial signal is currently available.</Text>
      : commercial.signals.map((item) => <Flex key={item.code} direction="row" justify="between" gap="small">
          <Text>{item.label}: {item.detail}</Text>
          <StatusTag variant={item.direction === 'positive' ? 'success' : item.direction === 'negative' ? item.severity === 'critical' ? 'danger' : 'warning' : 'default'}>{item.direction}</StatusTag>
        </Flex>)}

    {commercial.coverage.truncated && <Alert title="Commercial evidence is bounded" variant="warning">The deal exceeds the on-demand association limit or contains unreadable associated records. Confidence is reduced and totals may not represent the complete commercial package.</Alert>}
    <Alert title="Evidence boundary" variant="info">DealGuard reads structured quote and line-item metadata only. It does not inspect proposal documents, contract terms, attachments, payment details, or approval content. Discount thresholds are review prompts, not proof that a discount is unauthorized.</Alert>
    {commercial.limitations.map((item, index) => <Text key={`commercial-limitation-${index}`} variant="microcopy">• {item}</Text>)}
    <Text variant="microcopy">Evidence fetched {formatDate(commercial.fetchedAt)}.</Text>
    <Button variant="secondary" onClick={() => void load(true)} disabled={working}>Refresh commercial evidence</Button>
  </Flex>;
};
