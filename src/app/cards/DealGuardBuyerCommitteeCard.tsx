import React from 'react';
import { Alert, Button, Divider, Flex, Heading, StatusTag, Text, hubspot } from '@hubspot/ui-extensions';
import {
  CardLoading,
  CardUnavailable,
  buyerRoleLabel,
  relationshipVariant,
  roleCoverageVariant,
  useDealAssessment,
} from './deal-intelligence-shared';

hubspot.extend<'crm.record.tab'>(({ context }) => <DealGuardBuyerCommitteeCard dealId={String(context.crm.objectId)} />);

const sourceDescription = (source: string): string => {
  if (source === 'deal_association_label') return 'deal label';
  if (source === 'contact_buying_role') return 'contact buying role';
  return 'job-title hint';
};

const DealGuardBuyerCommitteeCard = ({ dealId }: { dealId: string }) => {
  const { assessment, loading, working, error, notice, load } = useDealAssessment(dealId);
  if (loading) return <CardLoading label="Loading relationship coverage" />;
  if (!assessment) return <CardUnavailable error={error} />;
  const relationship = assessment.intelligence?.relationshipCoverage;

  if (!relationship) {
    return <Flex direction="column" gap="medium">
      {error && <Alert title="Action failed" variant="danger">{error}</Alert>}
      <Alert title="Relationship evidence is not available" variant="warning">Refresh the deal to retrieve current contact, company, association-label, and buying-role evidence. Readiness remains available even when this optional enrichment cannot be loaded.</Alert>
      <Button onClick={() => void load(true)} disabled={working}>Refresh relationship evidence</Button>
    </Flex>;
  }

  const coreRoles = relationship.roleCoverage.filter((item) => item.core);
  const supportingRoles = relationship.roleCoverage.filter((item) => !item.core && item.status !== 'missing');

  return <Flex direction="column" gap="medium">
    {error && <Alert title="Action failed" variant="danger">{error}</Alert>}
    {notice && <Alert title="Done" variant="success">{notice}</Alert>}
    <Flex direction="row" justify="between" align="center" gap="medium">
      <Flex direction="column" gap="extra-small">
        <Heading>Relationship coverage</Heading>
        <Text>{relationship.summary}</Text>
      </Flex>
      <StatusTag variant={relationshipVariant(relationship.status)}>{relationship.status}</StatusTag>
    </Flex>
    <Text>{relationship.score}/100 · confidence {relationship.confidence} · {relationship.contactCount} contacts · {relationship.companyCount} companies.</Text>
    <Text>{relationship.singleThreaded ? 'The deal is single-threaded.' : 'The deal has multiple associated stakeholders.'} Explicit role coverage: {relationship.explicitRoleCoveragePercent}%.</Text>

    <Divider />
    <Heading>Core buying roles</Heading>
    {coreRoles.map((item) => <Flex key={item.role} direction="column" gap="extra-small">
      <Flex direction="row" justify="between" gap="small">
        <Text format={{ fontWeight: 'bold' }}>{item.label}</Text>
        <StatusTag variant={roleCoverageVariant(item.status)}>{item.status === 'inferred_only' ? 'Inferred only' : item.status}</StatusTag>
      </Flex>
      <Text variant="microcopy">{item.people.length > 0 ? item.people.join(', ') : 'No person identified'}{item.sources.length > 0 ? ` · ${item.sources.map(sourceDescription).join(', ')}` : ''}</Text>
    </Flex>)}

    {supportingRoles.length > 0 && <>
      <Divider />
      <Heading>Supporting roles</Heading>
      {supportingRoles.map((item) => <Text key={item.role}>• {item.label}: {item.people.join(', ')} ({item.status === 'explicit' ? 'explicit evidence' : 'job-title hint only'})</Text>)}
    </>}

    <Divider />
    <Heading>Associated stakeholders</Heading>
    {relationship.contacts.length === 0
      ? <Alert title="No customer contacts associated" variant="danger">Associate customer stakeholders with this deal before relying on relationship coverage.</Alert>
      : relationship.contacts.slice(0, 10).map((person) => {
          const explicit = person.explicitRoles.map(buyerRoleLabel);
          const inferred = person.inferredRoles.filter((role) => !person.explicitRoles.includes(role)).map(buyerRoleLabel);
          return <Flex key={person.id} direction="column" gap="extra-small">
            <Text format={{ fontWeight: 'bold' }}>{person.displayName}{person.jobTitle ? ` · ${person.jobTitle}` : ''}</Text>
            <Text variant="microcopy">Explicit: {explicit.length > 0 ? explicit.join(', ') : 'none'} · Inferred: {inferred.length > 0 ? inferred.join(', ') : 'none'}</Text>
            {person.associationLabels.length > 0 && <Text variant="microcopy">Deal labels: {person.associationLabels.join(', ')}</Text>}
          </Flex>;
        })}
    {relationship.contactsTruncated && <Text variant="microcopy">Contact evidence is truncated at the bounded on-demand limit.</Text>}

    <Divider />
    <Heading>Account context</Heading>
    {relationship.primaryCompany
      ? <Text>Primary buying company: {relationship.primaryCompany.name}{relationship.primaryCompany.domain ? ` · ${relationship.primaryCompany.domain}` : ''}. Evidence: {relationship.primaryCompany.primaryEvidence === 'association_label' ? 'HubSpot primary association label' : 'only associated company'}.</Text>
      : <Text>No unambiguous primary buying company is identified.</Text>}
    {relationship.companies.filter((item) => !item.primary).slice(0, 5).map((item) => <Text key={item.id}>• {item.name}{item.domain ? ` · ${item.domain}` : ''}{item.industry ? ` · ${item.industry}` : ''}</Text>)}

    <Divider />
    <Heading>Relationship signals</Heading>
    {relationship.signals.map((item) => <Flex key={item.code} direction="row" justify="between" gap="small">
      <Text>{item.label}: {item.detail}</Text>
      <StatusTag variant={item.direction === 'positive' ? 'success' : item.severity === 'critical' ? 'danger' : item.severity === 'warning' ? 'warning' : 'default'}>{item.direction}</StatusTag>
    </Flex>)}

    <Alert title="Evidence boundary" variant="info">Association labels are deal-specific. HubSpot buying-role values are contact-level context. Job-title hints are visibly marked as inferred and never confirm authority or buyer intent. DealGuard does not inspect communications content in this view.</Alert>
    <Button variant="secondary" onClick={() => void load(true)} disabled={working}>Refresh relationship evidence</Button>
  </Flex>;
};
