import assert from 'node:assert/strict';
import test from 'node:test';
import { buildBuyerCommittee } from '../dist/buyer-committee.js';
import {
  BUYER_COMMITTEE_COMPANY_PROPERTIES,
  BUYER_COMMITTEE_CONTACT_PROPERTIES,
  loadBuyerCommitteeData,
} from '../dist/buyer-committee-data.js';

const fetchedAt = '2026-08-30T00:00:00.000Z';

function strongFixture() {
  return {
    contacts: [
      {
        id: '101',
        properties: { firstname: 'Alice', lastname: 'Singh', jobtitle: 'VP Finance', hs_buying_role: 'BUDGET_HOLDER' },
        associationTypes: [{ category: 'USER_DEFINED', typeId: 11, label: 'Decision maker' }],
      },
      {
        id: '102',
        properties: { firstname: 'Bob', lastname: 'Lee', jobtitle: 'Operations Lead', hs_buying_role: 'CHAMPION' },
        associationTypes: [{ category: 'USER_DEFINED', typeId: 12, label: 'Champion' }],
      },
      {
        id: '103',
        properties: { firstname: 'Chen', lastname: 'Wei', jobtitle: 'CTO', hs_buying_role: 'TECHNICAL_EVALUATOR' },
        associationTypes: [],
      },
    ],
    companies: [{ id: '201', properties: { name: 'Acme', domain: 'acme.example' }, associationTypes: [{ category: 'HUBSPOT_DEFINED', typeId: 5, label: 'Primary' }] }],
    contactsTruncated: false,
    companiesTruncated: false,
    fetchedAt,
  };
}

test('strong relationship coverage requires explicit core buying roles', () => {
  const result = buildBuyerCommittee(strongFixture(), Date.parse(fetchedAt));
  assert.equal(result.relationshipCoverage.status, 'strong');
  assert.equal(result.relationshipCoverage.confidence, 'high');
  assert.equal(result.relationshipCoverage.singleThreaded, false);
  assert.deepEqual(result.relationshipCoverage.missingCoreRoles, []);
  assert.equal(result.relationshipCoverage.primaryCompany?.primaryEvidence, 'association_label');
  for (const role of ['decision_maker', 'budget_holder', 'champion']) {
    assert.equal(result.relationshipCoverage.roleCoverage.find((item) => item.role === role)?.status, 'explicit');
  }
});

test('single-threaded and unlabeled deals produce concrete relationship actions', () => {
  const result = buildBuyerCommittee({
    contacts: [{ id: '101', properties: { firstname: 'Only', lastname: 'Contact', jobtitle: 'Coordinator' }, associationTypes: [] }],
    companies: [
      { id: '201', properties: { name: 'Company A' }, associationTypes: [] },
      { id: '202', properties: { name: 'Company B' }, associationTypes: [] },
    ],
    contactsTruncated: false,
    companiesTruncated: false,
    fetchedAt,
  }, Date.parse(fetchedAt));
  assert.equal(result.relationshipCoverage.status, 'weak');
  assert.equal(result.relationshipCoverage.singleThreaded, true);
  assert.equal(result.relationshipCoverage.primaryCompany, null);
  for (const code of [
    'multi_thread_relationship',
    'confirm_decision_maker',
    'confirm_budget_holder',
    'identify_champion',
    'confirm_primary_company',
  ]) assert.ok(result.relationshipActions.some((item) => item.code === code), `missing ${code}`);
});

test('job titles remain inferred and cannot create strong coverage', () => {
  const result = buildBuyerCommittee({
    contacts: [
      { id: '101', properties: { firstname: 'A', jobtitle: 'Chief Financial Officer' }, associationTypes: [] },
      { id: '102', properties: { firstname: 'B', jobtitle: 'Director of Technology' }, associationTypes: [] },
      { id: '103', properties: { firstname: 'C', jobtitle: 'Operations Manager' }, associationTypes: [] },
    ],
    companies: [{ id: '201', properties: { name: 'Acme' }, associationTypes: [] }],
    contactsTruncated: false,
    companiesTruncated: false,
    fetchedAt,
  }, Date.parse(fetchedAt));
  assert.notEqual(result.relationshipCoverage.status, 'strong');
  assert.equal(result.relationshipCoverage.confidence, 'low');
  assert.equal(result.relationshipCoverage.roleCoverage.find((item) => item.role === 'decision_maker')?.status, 'inferred_only');
  assert.ok(result.relationshipActions.some((item) => item.code === 'confirm_decision_maker'));
});

test('relationship output does not expose email addresses', () => {
  const fixture = strongFixture();
  fixture.contacts[0].properties.email = 'alice@example.com';
  const result = buildBuyerCommittee(fixture, Date.parse(fetchedAt));
  assert.doesNotMatch(JSON.stringify(result), /alice@example\.com/);
  assert.ok(!BUYER_COMMITTEE_CONTACT_PROPERTIES.includes('email'));
});

test('loader uses bounded date-versioned association and object batch reads', async () => {
  const calls = [];
  const client = {
    async request(path, init) {
      calls.push({ path, body: init?.body ? JSON.parse(String(init.body)) : null });
      if (path === '/crm/associations/2026-03/deals/contacts/batch/read') {
        return { results: [{ from: { id: '77' }, to: [{ toObjectId: '101', associationTypes: [{ category: 'USER_DEFINED', typeId: 11, label: 'Decision maker' }] }] }] };
      }
      if (path === '/crm/associations/2026-03/deals/companies/batch/read') {
        return { results: [{ from: { id: '77' }, to: [{ toObjectId: '201', associationTypes: [{ category: 'HUBSPOT_DEFINED', typeId: 5, label: 'Primary' }] }] }] };
      }
      if (path === '/crm/objects/2026-03/contacts/batch/read') return { results: [{ id: '101', properties: { firstname: 'Alice' } }] };
      if (path === '/crm/objects/2026-03/companies/batch/read') return { results: [{ id: '201', properties: { name: 'Acme' } }] };
      throw new Error(`unexpected ${path}`);
    },
  };
  const result = await loadBuyerCommitteeData(client, '77');
  assert.equal(result.contacts.length, 1);
  assert.equal(result.companies.length, 1);
  assert.deepEqual(calls.map((item) => item.path).sort(), [
    '/crm/associations/2026-03/deals/companies/batch/read',
    '/crm/associations/2026-03/deals/contacts/batch/read',
    '/crm/objects/2026-03/companies/batch/read',
    '/crm/objects/2026-03/contacts/batch/read',
  ]);
  const contactRead = calls.find((item) => item.path === '/crm/objects/2026-03/contacts/batch/read');
  const companyRead = calls.find((item) => item.path === '/crm/objects/2026-03/companies/batch/read');
  assert.deepEqual(contactRead.body.properties, [...BUYER_COMMITTEE_CONTACT_PROPERTIES]);
  assert.deepEqual(companyRead.body.properties, [...BUYER_COMMITTEE_COMPANY_PROPERTIES]);
});

test('loader marks results truncated when one association page exceeds the bounded read limit', async () => {
  const client = {
    async request(path) {
      if (path === '/crm/associations/2026-03/deals/contacts/batch/read') {
        return {
          results: [{
            from: { id: '77' },
            to: Array.from({ length: 101 }, (_, index) => ({ toObjectId: String(index + 1), associationTypes: [] })),
          }],
        };
      }
      if (path === '/crm/associations/2026-03/deals/companies/batch/read') {
        return { results: [{ from: { id: '77' }, to: [] }] };
      }
      if (path === '/crm/objects/2026-03/contacts/batch/read') {
        return { results: Array.from({ length: 100 }, (_, index) => ({ id: String(index + 1), properties: { firstname: `Contact ${index + 1}` } })) };
      }
      if (path === '/crm/objects/2026-03/companies/batch/read') return { results: [] };
      throw new Error(`unexpected ${path}`);
    },
  };
  const result = await loadBuyerCommitteeData(client, '77');
  assert.equal(result.contacts.length, 100);
  assert.equal(result.contactsTruncated, true);
});

test('a single contact cannot produce strong coverage even when every role is labeled', () => {
  const result = buildBuyerCommittee({
    contacts: [{
      id: '101',
      properties: { firstname: 'One', lastname: 'Person', hs_buying_role: 'DECISION_MAKER;BUDGET_HOLDER;CHAMPION;EXECUTIVE_SPONSOR;TECHNICAL_EVALUATOR' },
      associationTypes: [],
    }],
    companies: [{ id: '201', properties: { name: 'Acme' }, associationTypes: [] }],
    contactsTruncated: false,
    companiesTruncated: false,
    fetchedAt,
  }, Date.parse(fetchedAt));
  assert.equal(result.relationshipCoverage.singleThreaded, true);
  assert.notEqual(result.relationshipCoverage.status, 'strong');
});

test('deal-to-primary-company type ID is recognized even when HubSpot omits the label text', () => {
  const fixture = strongFixture();
  fixture.companies[0].associationTypes = [{ category: 'HUBSPOT_DEFINED', typeId: 5, label: null }];
  const result = buildBuyerCommittee(fixture, Date.parse(fetchedAt));
  assert.equal(result.relationshipCoverage.primaryCompany?.primaryEvidence, 'association_label');
});

test('loader treats partial object reads as truncated evidence', async () => {
  const client = {
    async request(path) {
      if (path === '/crm/associations/2026-03/deals/contacts/batch/read') {
        return { results: [{ from: { id: '77' }, to: [{ toObjectId: '101' }, { toObjectId: '102' }] }] };
      }
      if (path === '/crm/associations/2026-03/deals/companies/batch/read') return { results: [{ from: { id: '77' }, to: [] }] };
      if (path === '/crm/objects/2026-03/contacts/batch/read') return { results: [{ id: '101', properties: { firstname: 'Readable' } }] };
      if (path === '/crm/objects/2026-03/companies/batch/read') return { results: [] };
      throw new Error(`unexpected ${path}`);
    },
  };
  const result = await loadBuyerCommitteeData(client, '77');
  assert.equal(result.contacts.length, 1);
  assert.equal(result.contactsTruncated, true);
});

test('loader stops safely when HubSpot repeats an association cursor without new records', async () => {
  let contactCalls = 0;
  const client = {
    async request(path) {
      if (path === '/crm/associations/2026-03/deals/contacts/batch/read') {
        contactCalls += 1;
        return { results: [{ from: { id: '77' }, to: contactCalls === 1 ? [{ toObjectId: '101' }] : [], paging: { next: { after: 'same-cursor' } } }] };
      }
      if (path === '/crm/associations/2026-03/deals/companies/batch/read') return { results: [{ from: { id: '77' }, to: [] }] };
      if (path === '/crm/objects/2026-03/contacts/batch/read') return { results: [{ id: '101', properties: { firstname: 'A' } }] };
      if (path === '/crm/objects/2026-03/companies/batch/read') return { results: [] };
      throw new Error(`unexpected ${path}`);
    },
  };
  const result = await loadBuyerCommitteeData(client, '77');
  assert.equal(contactCalls, 2);
  assert.equal(result.contactsTruncated, true);
});
