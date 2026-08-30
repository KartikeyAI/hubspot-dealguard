import type {
  BuyerCommitteeCompany,
  BuyerCommitteeContact,
  BuyerCommitteeIntelligence,
  BuyerRole,
  BuyerRoleCoverage,
  BuyerRoleEvidence,
  RelationshipAction,
  RelationshipCoverage,
  RelationshipSignal,
  RoleEvidenceSource,
} from './buyer-committee-types.js';
import type {
  BuyerCommitteeCompanyRecord,
  BuyerCommitteeContactRecord,
  BuyerCommitteeData,
} from './buyer-committee-data.js';

const ROLE_LABELS: Record<BuyerRole, string> = {
  decision_maker: 'Decision maker',
  budget_holder: 'Budget holder',
  champion: 'Champion',
  executive_sponsor: 'Executive sponsor',
  technical_evaluator: 'Technical evaluator',
  procurement: 'Procurement',
  legal_compliance: 'Legal or compliance',
  end_user: 'End user',
  influencer: 'Influencer',
  implementer: 'Implementer',
  blocker: 'Blocker',
};

const CORE_ROLES: BuyerRole[] = ['decision_maker', 'budget_holder', 'champion'];
const SCORE_ROLES: Array<{ role: BuyerRole; weight: number }> = [
  { role: 'decision_maker', weight: 25 },
  { role: 'budget_holder', weight: 20 },
  { role: 'champion', weight: 20 },
  { role: 'executive_sponsor', weight: 10 },
  { role: 'technical_evaluator', weight: 10 },
];
const ALL_ROLES = Object.keys(ROLE_LABELS) as BuyerRole[];

function normalize(value: string): string {
  return value.toLowerCase().replace(/[_\-/]+/g, ' ').replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
}

function rolesFromText(value: string): BuyerRole[] {
  const text = normalize(value);
  if (!text) return [];
  const roles = new Set<BuyerRole>();
  if (/decision|decider|signatory|approver/.test(text)) roles.add('decision_maker');
  if (/budget|economic buyer|finance owner|financial buyer/.test(text)) roles.add('budget_holder');
  if (/champion|advocate|internal sponsor/.test(text)) roles.add('champion');
  if (/executive sponsor|c suite|executive buyer/.test(text)) roles.add('executive_sponsor');
  if (/technical|technology|security|engineering|architect|information technology/.test(text)) roles.add('technical_evaluator');
  if (/procurement|purchasing|sourcing|vendor management/.test(text)) roles.add('procurement');
  if (/legal|counsel|compliance|privacy/.test(text)) roles.add('legal_compliance');
  if (/end user|business user/.test(text)) roles.add('end_user');
  if (/influencer/.test(text)) roles.add('influencer');
  if (/implementer|implementation owner/.test(text)) roles.add('implementer');
  if (/blocker|detractor/.test(text)) roles.add('blocker');
  return [...roles];
}

function titleHints(value: string | null | undefined): BuyerRole[] {
  if (!value) return [];
  const text = normalize(value);
  const roles = new Set<BuyerRole>();
  if (/\b(chief|ceo|cfo|coo|cto|cio|cmo|founder|owner|president|managing director)\b/.test(text)) roles.add('executive_sponsor');
  if (/\b(vice president|vp|head|director|chief|founder|owner|president|managing director)\b/.test(text)) roles.add('decision_maker');
  if (/\b(cfo|finance|financial|budget)\b/.test(text)) roles.add('budget_holder');
  if (/\b(cto|cio|technology|technical|engineering|engineer|architect|security|information technology|it director|it manager)\b/.test(text)) roles.add('technical_evaluator');
  if (/\b(procurement|purchasing|sourcing|vendor management)\b/.test(text)) roles.add('procurement');
  if (/\b(legal|counsel|compliance|privacy|risk officer)\b/.test(text)) roles.add('legal_compliance');
  return [...roles];
}

function splitRoleValues(value: string | null | undefined): string[] {
  return value ? value.split(/[;,|]+/).map((item) => item.trim()).filter(Boolean) : [];
}

function associationLabels(record: { associationTypes: Array<{ label: string | null }> }): string[] {
  return [...new Set(record.associationTypes.map((item) => item.label?.trim()).filter((item): item is string => Boolean(item)))];
}

function evidenceForContact(record: BuyerCommitteeContactRecord): BuyerRoleEvidence[] {
  const evidence: BuyerRoleEvidence[] = [];
  for (const label of associationLabels(record)) {
    for (const role of rolesFromText(label)) {
      evidence.push({ role, source: 'deal_association_label', sourceLabel: label, confidence: 'confirmed' });
    }
  }
  for (const value of splitRoleValues(record.properties.hs_buying_role)) {
    for (const role of rolesFromText(value)) {
      evidence.push({ role, source: 'contact_buying_role', sourceLabel: value, confidence: 'contextual' });
    }
  }
  for (const role of titleHints(record.properties.jobtitle)) {
    evidence.push({ role, source: 'job_title_hint', sourceLabel: record.properties.jobtitle ?? '', confidence: 'inferred' });
  }
  return evidence.filter((item, index, all) => all.findIndex((candidate) => candidate.role === item.role && candidate.source === item.source && candidate.sourceLabel === item.sourceLabel) === index);
}

function contact(record: BuyerCommitteeContactRecord): BuyerCommitteeContact {
  const firstname = record.properties.firstname?.trim() ?? '';
  const lastname = record.properties.lastname?.trim() ?? '';
  const displayName = `${firstname} ${lastname}`.trim() || `Contact ${record.id}`;
  const roleEvidence = evidenceForContact(record);
  const explicitRoles = [...new Set(roleEvidence.filter((item) => item.source !== 'job_title_hint').map((item) => item.role))];
  const inferredRoles = [...new Set(roleEvidence.filter((item) => item.source === 'job_title_hint').map((item) => item.role))];
  return {
    id: record.id,
    displayName,
    jobTitle: record.properties.jobtitle?.trim() || null,
    associationLabels: associationLabels(record),
    roleEvidence,
    explicitRoles,
    inferredRoles,
    updatedAt: record.updatedAt ?? record.properties.lastmodifieddate ?? null,
  };
}

function company(record: BuyerCommitteeCompanyRecord, onlyCompany: boolean): BuyerCommitteeCompany {
  const labels = associationLabels(record);
  const primaryByLabel = labels.some((label) => /\bprimary\b/i.test(label));
  const primary = onlyCompany || primaryByLabel;
  return {
    id: record.id,
    name: record.properties.name?.trim() || `Company ${record.id}`,
    domain: record.properties.domain?.trim() || null,
    industry: record.properties.industry?.trim() || null,
    associationLabels: labels,
    primary,
    primaryEvidence: primaryByLabel ? 'association_label' : onlyCompany ? 'only_associated_company' : null,
    updatedAt: record.updatedAt ?? record.properties.hs_lastmodifieddate ?? null,
  };
}

function roleCoverage(contacts: BuyerCommitteeContact[]): BuyerRoleCoverage[] {
  return ALL_ROLES.map((role) => {
    const explicitPeople = contacts.filter((item) => item.explicitRoles.includes(role));
    const inferredPeople = contacts.filter((item) => !item.explicitRoles.includes(role) && item.inferredRoles.includes(role));
    const status: BuyerRoleCoverage['status'] = explicitPeople.length > 0 ? 'explicit' : inferredPeople.length > 0 ? 'inferred_only' : 'missing';
    const sources = new Set<RoleEvidenceSource>();
    for (const person of [...explicitPeople, ...inferredPeople]) {
      for (const evidence of person.roleEvidence.filter((item) => item.role === role)) sources.add(evidence.source);
    }
    return {
      role,
      label: ROLE_LABELS[role],
      core: CORE_ROLES.includes(role),
      status,
      people: (explicitPeople.length > 0 ? explicitPeople : inferredPeople).map((item) => item.displayName),
      sources: [...sources],
    };
  });
}

function evidenceFactor(coverage: BuyerRoleCoverage): number {
  if (coverage.sources.includes('deal_association_label')) return 1;
  if (coverage.sources.includes('contact_buying_role')) return .8;
  if (coverage.sources.includes('job_title_hint')) return .25;
  return 0;
}

function addDays(now: number, days: number): string {
  return new Date(now + days * 86_400_000).toISOString();
}

function buildSignals(
  contacts: BuyerCommitteeContact[],
  companies: BuyerCommitteeCompany[],
  coverage: BuyerRoleCoverage[],
  explicitCoveragePercent: number,
  contactsTruncated: boolean,
  companiesTruncated: boolean,
): RelationshipSignal[] {
  const signals: RelationshipSignal[] = [];
  if (contacts.length === 0) signals.push({ code: 'no_associated_contacts', label: 'No associated customer stakeholders', direction: 'negative', severity: 'critical', detail: 'The deal has no associated contact evidence, so DealGuard cannot identify who is involved in the buying process.', evidenceCodes: ['associated_contacts:0'] });
  else if (contacts.length === 1) signals.push({ code: 'single_threaded', label: 'Single-threaded relationship', direction: 'negative', severity: 'warning', detail: `${contacts[0]!.displayName} is the only associated customer stakeholder.`, evidenceCodes: [`associated_contacts:${contacts.length}`] });
  else signals.push({ code: 'multi_threaded', label: 'Multiple stakeholders associated', direction: 'positive', severity: 'info', detail: `${contacts.length} customer stakeholders are associated with this deal.`, evidenceCodes: [`associated_contacts:${contacts.length}`] });

  for (const role of CORE_ROLES) {
    const item = coverage.find((candidate) => candidate.role === role)!;
    if (item.status === 'missing') signals.push({ code: `missing_${role}`, label: `${item.label} not identified`, direction: 'negative', severity: role === 'champion' ? 'warning' : 'critical', detail: `No explicit or title-derived evidence currently identifies a ${item.label.toLowerCase()}.`, evidenceCodes: [`role:${role}:missing`] });
    else if (item.status === 'inferred_only') signals.push({ code: `inferred_only_${role}`, label: `${item.label} is only inferred`, direction: 'neutral', severity: 'warning', detail: `${item.people.join(', ')} may cover this role based on job title, but no deal association label or HubSpot buying-role value confirms it.`, evidenceCodes: [`role:${role}:inferred_only`] });
  }

  if (contacts.length > 0 && explicitCoveragePercent < 50) signals.push({ code: 'role_data_sparse', label: 'Buying-role data is sparse', direction: 'neutral', severity: 'info', detail: `Only ${explicitCoveragePercent}% of associated contacts have an explicit deal label or HubSpot buying-role value.`, evidenceCodes: [`explicit_role_coverage:${explicitCoveragePercent}`] });
  if (companies.length === 0) signals.push({ code: 'company_missing', label: 'Buying company not associated', direction: 'negative', severity: 'warning', detail: 'No associated company is available to anchor account context.', evidenceCodes: ['associated_companies:0'] });
  if (companies.length > 1 && !companies.some((item) => item.primary)) signals.push({ code: 'primary_company_missing', label: 'Primary company is unclear', direction: 'negative', severity: 'warning', detail: `${companies.length} companies are associated, but none is identified as primary.`, evidenceCodes: [`associated_companies:${companies.length}`, 'primary_company:false'] });
  if (contactsTruncated || companiesTruncated) signals.push({ code: 'relationship_result_truncated', label: 'Relationship evidence was truncated', direction: 'neutral', severity: 'info', detail: 'The deal exceeds DealGuard’s bounded on-demand relationship read limit; the displayed coverage may be incomplete.', evidenceCodes: [`contacts_truncated:${contactsTruncated}`, `companies_truncated:${companiesTruncated}`] });
  return signals;
}

function buildActions(signals: RelationshipSignal[], now: number): RelationshipAction[] {
  const actions: RelationshipAction[] = [];
  const has = (code: string) => signals.some((item) => item.code === code);
  if (has('no_associated_contacts')) actions.push({ code: 'associate_customer_stakeholders', label: 'Associate customer stakeholders', action: 'Associate at least two people who are actively involved in this opportunity, then label their buying roles.', priority: 'high', rationale: 'A deal without associated customer contacts cannot be multi-threaded or governed using relationship evidence.', owner: 'deal_owner', dueAt: addDays(now, 2), evidenceCodes: ['no_associated_contacts'] });
  else if (has('single_threaded')) actions.push({ code: 'multi_thread_relationship', label: 'Multi-thread the opportunity', action: 'Engage and associate another relevant stakeholder so the opportunity does not depend on one relationship.', priority: 'high', rationale: 'The current deal is represented by one associated contact.', owner: 'deal_owner', dueAt: addDays(now, 3), evidenceCodes: ['single_threaded'] });
  if (has('missing_decision_maker') || has('inferred_only_decision_maker')) actions.push({ code: 'confirm_decision_maker', label: 'Confirm the decision maker', action: 'Identify the person with final decision authority and record the role using a deal association label or HubSpot buying role.', priority: 'high', rationale: 'Decision authority is missing or based only on a job-title inference.', owner: 'deal_owner', dueAt: addDays(now, 3), evidenceCodes: signals.filter((item) => /decision_maker/.test(item.code)).map((item) => item.code) });
  if (has('missing_budget_holder') || has('inferred_only_budget_holder')) actions.push({ code: 'confirm_budget_holder', label: 'Confirm budget ownership', action: 'Identify who controls or approves the budget and record that role explicitly.', priority: 'high', rationale: 'Budget authority is missing or only inferred.', owner: 'deal_owner', dueAt: addDays(now, 3), evidenceCodes: signals.filter((item) => /budget_holder/.test(item.code)).map((item) => item.code) });
  if (has('missing_champion')) actions.push({ code: 'identify_champion', label: 'Identify an internal champion', action: 'Confirm who will advocate for the change internally and record the champion relationship.', priority: 'medium', rationale: 'No champion evidence is present on the associated contacts.', owner: 'deal_owner', dueAt: addDays(now, 5), evidenceCodes: ['missing_champion'] });
  if (has('primary_company_missing')) actions.push({ code: 'confirm_primary_company', label: 'Confirm the primary buying company', action: 'Mark the company that owns the buying process as the primary deal association.', priority: 'medium', rationale: 'Several companies are associated and the account context is ambiguous.', owner: 'deal_owner', dueAt: addDays(now, 5), evidenceCodes: ['primary_company_missing'] });
  if (has('role_data_sparse')) actions.push({ code: 'complete_buying_roles', label: 'Complete buying-role labels', action: 'Add explicit deal association labels or HubSpot buying-role values for the associated stakeholders.', priority: 'low', rationale: 'Most associated contacts do not have explicit role evidence.', owner: 'deal_owner', dueAt: addDays(now, 7), evidenceCodes: ['role_data_sparse'] });
  return actions.slice(0, 6);
}

export function buildBuyerCommittee(data: BuyerCommitteeData, now = Date.now()): BuyerCommitteeIntelligence {
  const contacts = data.contacts.map(contact);
  const companies = data.companies.map((item) => company(item, data.companies.length === 1));
  const coverage = roleCoverage(contacts);
  const explicitContacts = contacts.filter((item) => item.explicitRoles.length > 0).length;
  const labeledContacts = contacts.filter((item) => item.associationLabels.length > 0).length;
  const explicitRoleCoveragePercent = contacts.length > 0 ? Math.round(explicitContacts / contacts.length * 100) : 0;
  const labeledAssociationCoveragePercent = contacts.length > 0 ? Math.round(labeledContacts / contacts.length * 100) : 0;

  let score = 0;
  for (const item of SCORE_ROLES) {
    score += item.weight * evidenceFactor(coverage.find((candidate) => candidate.role === item.role)!);
  }
  score += contacts.length >= 3 ? 10 : contacts.length === 2 ? 6 : 0;
  score += companies.some((item) => item.primary) ? 5 : 0;
  score = Math.max(0, Math.min(100, Math.round(score)));

  const explicitRoles = coverage.filter((item) => item.status === 'explicit').map((item) => item.role);
  const inferredOnlyRoles = coverage.filter((item) => item.status === 'inferred_only').map((item) => item.role);
  const missingCoreRoles = coverage.filter((item) => item.core && item.status === 'missing').map((item) => item.role);
  const coreRolesNeedingConfirmation = coverage.filter((item) => item.core && item.status !== 'explicit');
  const status: RelationshipCoverage['status'] = score >= 75 && coreRolesNeedingConfirmation.length === 0
    ? 'strong'
    : score >= 45
      ? 'partial'
      : 'weak';
  const confidence: RelationshipCoverage['confidence'] = !data.contactsTruncated && explicitContacts >= 2 && explicitRoleCoveragePercent >= 60
    ? 'high'
    : explicitContacts > 0 || labeledContacts > 0
      ? 'medium'
      : 'low';
  const signals = buildSignals(contacts, companies, coverage, explicitRoleCoveragePercent, data.contactsTruncated, data.companiesTruncated);
  const relationshipActions = buildActions(signals, now);
  const summary = contacts.length === 0
    ? 'No associated customer contacts are available for relationship analysis.'
    : status === 'strong'
      ? `Relationship coverage is strong across ${contacts.length} associated stakeholders.`
      : status === 'partial'
        ? `Relationship coverage is partial; ${coreRolesNeedingConfirmation.length} core buying role${coreRolesNeedingConfirmation.length === 1 ? '' : 's'} still need explicit confirmation.`
        : `Relationship coverage is weak and the opportunity depends on incomplete stakeholder evidence.`;
  const limitations = [
    'Association labels are deal-specific evidence; HubSpot buying-role values are contact-level context and may apply beyond this deal.',
    'Job-title hints are explicitly marked as inferred and do not confirm decision authority, budget authority, advocacy, or buyer intent.',
    'This model does not inspect communications, meetings, notes, call recordings, or message content.',
  ];
  if (data.contactsTruncated || data.companiesTruncated) limitations.push('The on-demand read was truncated at 100 contacts or 20 companies.');

  const relationshipCoverage: RelationshipCoverage = {
    methodology: 'hubspot_association_and_contact_role_evidence',
    score,
    status,
    confidence,
    summary,
    contactCount: contacts.length,
    companyCount: companies.length,
    singleThreaded: contacts.length === 1,
    explicitRoleCoveragePercent,
    labeledAssociationCoveragePercent,
    contacts,
    companies,
    primaryCompany: companies.find((item) => item.primary) ?? null,
    roleCoverage: coverage,
    missingCoreRoles,
    explicitRoles,
    inferredOnlyRoles,
    signals,
    relationshipActions,
    fetchedAt: data.fetchedAt,
    contactsTruncated: data.contactsTruncated,
    companiesTruncated: data.companiesTruncated,
    limitations,
    notBuyerIntent: true,
    notWinProbability: true,
  };
  return { relationshipCoverage, relationshipActions };
}
