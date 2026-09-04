import type { IssueSeverity } from './types.js';

export type BuyerRole =
  | 'decision_maker'
  | 'budget_holder'
  | 'champion'
  | 'executive_sponsor'
  | 'technical_evaluator'
  | 'procurement'
  | 'legal_compliance'
  | 'end_user'
  | 'influencer'
  | 'implementer'
  | 'blocker';

export type RoleEvidenceSource =
  | 'deal_association_label'
  | 'contact_buying_role'
  | 'job_title_hint';

export interface BuyerRoleEvidence {
  role: BuyerRole;
  source: RoleEvidenceSource;
  sourceLabel: string;
  confidence: 'confirmed' | 'contextual' | 'inferred';
}

export interface BuyerCommitteeContact {
  id: string;
  displayName: string;
  jobTitle: string | null;
  associationLabels: string[];
  roleEvidence: BuyerRoleEvidence[];
  explicitRoles: BuyerRole[];
  inferredRoles: BuyerRole[];
  updatedAt: string | null;
}

export interface BuyerCommitteeCompany {
  id: string;
  name: string;
  domain: string | null;
  industry: string | null;
  associationLabels: string[];
  primary: boolean;
  primaryEvidence: 'association_label' | 'only_associated_company' | null;
  updatedAt: string | null;
}

export interface BuyerRoleCoverage {
  role: BuyerRole;
  label: string;
  core: boolean;
  status: 'explicit' | 'inferred_only' | 'missing';
  people: string[];
  sources: RoleEvidenceSource[];
}

export interface RelationshipSignal {
  code: string;
  label: string;
  direction: 'positive' | 'negative' | 'neutral';
  severity: IssueSeverity;
  detail: string;
  evidenceCodes: string[];
}

export interface RelationshipAction {
  code: string;
  label: string;
  action: string;
  priority: 'high' | 'medium' | 'low';
  rationale: string;
  owner: 'deal_owner' | 'manager';
  dueAt: string | null;
  evidenceCodes: string[];
}

export interface RelationshipCoverage {
  methodology: 'hubspot_association_and_contact_role_evidence';
  score: number;
  status: 'strong' | 'partial' | 'weak';
  confidence: 'high' | 'medium' | 'low';
  summary: string;
  contactCount: number;
  companyCount: number;
  singleThreaded: boolean;
  explicitRoleCoveragePercent: number;
  labeledAssociationCoveragePercent: number;
  contacts: BuyerCommitteeContact[];
  companies: BuyerCommitteeCompany[];
  primaryCompany: BuyerCommitteeCompany | null;
  roleCoverage: BuyerRoleCoverage[];
  missingCoreRoles: BuyerRole[];
  explicitRoles: BuyerRole[];
  inferredOnlyRoles: BuyerRole[];
  signals: RelationshipSignal[];
  relationshipActions: RelationshipAction[];
  fetchedAt: string;
  contactsTruncated: boolean;
  companiesTruncated: boolean;
  limitations: string[];
  notBuyerIntent: true;
  notWinProbability: true;
}

export interface BuyerCommitteeIntelligence {
  relationshipCoverage: RelationshipCoverage;
  relationshipActions: RelationshipAction[];
}
