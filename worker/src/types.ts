export interface D1Result<T = unknown> {
  results?: T[];
  success: boolean;
  meta?: Record<string, unknown>;
}

export interface D1PreparedStatement {
  bind(...values: unknown[]): D1PreparedStatement;
  first<T = Record<string, unknown>>(column?: string): Promise<T | null>;
  run<T = unknown>(): Promise<D1Result<T>>;
  all<T = Record<string, unknown>>(): Promise<D1Result<T>>;
}

export interface D1Database {
  prepare(query: string): D1PreparedStatement;
  batch<T = unknown>(statements: D1PreparedStatement[]): Promise<D1Result<T>[]>;
  exec(query: string): Promise<D1Result>;
}

export interface ExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
  passThroughOnException(): void;
}

export interface ScheduledEvent {
  scheduledTime: number;
  cron: string;
}

export interface Env {
  DB: D1Database;
  APP_BASE_URL: string;
  HUBSPOT_APP_ID: string;
  HUBSPOT_CLIENT_ID: string;
  HUBSPOT_CLIENT_SECRET: string;
  TOKEN_ENCRYPTION_KEY: string;
  RESEND_API_KEY?: string;
  EMAIL_FROM: string;
  SUPPORT_EMAIL: string;
  ADMIN_API_KEY?: string;
  SLACK_CLIENT_ID?: string;
  SLACK_CLIENT_SECRET?: string;
}

export type PlanId = 'free' | 'growth' | 'beta_growth';
export type AssessmentStatus = 'ready' | 'at_risk' | 'critical';
export type IssueSeverity = 'info' | 'warning' | 'critical';
export type GovernanceRole = 'admin' | 'policy_admin' | 'approver' | 'manager' | 'viewer';
export type PolicyStatus = 'draft' | 'pending_approval' | 'approved' | 'published' | 'superseded' | 'rejected';

export interface RuleSettings {
  staleDays: number;
  maxStageAgeDays: number;
  requireOwner: boolean;
  requireAmount: boolean;
  requireCloseDate: boolean;
  requireNextStep: boolean;
  requireCompany: boolean;
  requireContact: boolean;
  excludedPipelineIds: string[];
  excludedStageIds: string[];
  customRequiredProperties: CustomPropertyRule[];
}

export interface CustomPropertyRule {
  property: string;
  label: string;
  weight: number;
  severity: IssueSeverity;
  stageIds: string[];
}

export interface DigestSettings {
  enabled: boolean;
  frequency: 'daily' | 'weekly';
  recipients: string[];
  dayOfWeek: number;
  hourUtc: number;
}

export interface SlackNotificationSettings {
  enabled: boolean;
  alertOnCritical: boolean;
  alertOnHandoffRequired: boolean;
  alertOnHandoffConfirmed: boolean;
  cooldownMinutes: number;
}

export interface NotificationSettings {
  slack: SlackNotificationSettings;
}

export interface NativeSyncSettings {
  enabled: boolean;
  includeSummary: boolean;
}

export interface GovernanceSettings {
  enabled: boolean;
  requireApproval: boolean;
  preventSelfApproval: boolean;
}

export interface TenantSettings {
  rules: RuleSettings;
  digest: DigestSettings;
  notifications: NotificationSettings;
  nativeSync: NativeSyncSettings;
  governance: GovernanceSettings;
}

export interface TenantRow {
  portal_id: string;
  app_id: string;
  account_name: string | null;
  hub_domain: string | null;
  installer_email: string | null;
  access_token_cipher: string;
  access_token_iv: string;
  refresh_token_cipher: string;
  refresh_token_iv: string;
  token_expires_at: string;
  scopes_json: string;
  settings_json: string;
  plan: PlanId;
  status: 'active' | 'disconnected' | 'deleted';
  installed_at: string;
  updated_at: string;
  last_scan_at: string | null;
  next_scan_at: string;
  last_digest_at: string | null;
}

export interface HubSpotTokenResponse {
  token_type: string;
  refresh_token: string;
  access_token: string;
  expires_in: number;
}

export interface HubSpotTokenInfo {
  token: string;
  user: string;
  hub_domain: string;
  scopes: string[];
  hub_id: number;
  app_id: number;
  user_id: number;
  expires_in: number;
}

export interface HubSpotObject {
  id: string;
  properties: Record<string, string | null | undefined>;
  createdAt?: string;
  updatedAt?: string;
  archived?: boolean;
  associations?: Record<string, { results: Array<{ id: string; type: string }> }>;
}

export interface HubSpotSearchResponse {
  total: number;
  results: HubSpotObject[];
  paging?: { next?: { after: string; link?: string } };
}

export interface HubSpotPropertyOption {
  label: string;
  value: string;
  displayOrder: number;
  hidden: boolean;
}

export interface HubSpotPropertyDefinition {
  groupName: string;
  name: string;
  label: string;
  description: string;
  type: string;
  fieldType: string;
  options?: HubSpotPropertyOption[];
}

export interface HubSpotProperty {
  name: string;
  label: string;
  groupName: string;
  type: string;
  fieldType: string;
  options?: HubSpotPropertyOption[];
  hidden?: boolean;
  calculated?: boolean;
  modificationMetadata?: { readOnlyValue?: boolean; readOnlyDefinition?: boolean };
}

export interface HubSpotDealUpdate {
  id: string;
  properties: Record<string, string>;
}

export interface HubSpotPipeline {
  id: string;
  label: string;
  stages: Array<{
    id: string;
    label: string;
    displayOrder: number;
    metadata?: {
      isClosed?: string | boolean;
      probability?: string | number;
    };
  }>;
}

export interface StageInfo {
  id: string;
  label: string;
  pipelineId: string;
  pipelineLabel: string;
  isClosed: boolean;
  isWon: boolean;
  enteredAtProperty: string;
}

export interface NormalizedDeal {
  id: string;
  properties: Record<string, string | null | undefined>;
  contactCount: number;
  companyCount: number;
  stage?: StageInfo;
}

export interface AssessmentIssue {
  code: string;
  label: string;
  description: string;
  severity: IssueSeverity;
  weight: number;
  property?: string;
}

export interface DealAssessment {
  dealId: string;
  dealName: string;
  pipelineLabel: string;
  stageLabel: string;
  pipelineId?: string;
  stageId?: string;
  ownerId?: string | null;
  dealAmount?: number | null;
  score: number;
  grade: 'A' | 'B' | 'C' | 'D' | 'F';
  status: AssessmentStatus;
  issues: AssessmentIssue[];
  readinessSummary: string;
  isClosed: boolean;
  isWon: boolean;
  handoffEligible: boolean;
  assessedAt: string;
}

export interface ScanStatus {
  id: string;
  trigger: 'manual' | 'scheduled' | 'install';
  status: 'running' | 'completed' | 'failed';
  startedAt: string;
  completedAt: string | null;
  scannedCount: number;
  errorMessage: string | null;
}

export interface ProblemDeal {
  dealId: string;
  dealName: string;
  pipelineLabel: string;
  stageLabel: string;
  score: number;
  status: AssessmentStatus;
  readinessSummary: string;
  assessedAt: string;
}

export interface DashboardSummary {
  plan: PlanId;
  totalDeals: number;
  readyDeals: number;
  atRiskDeals: number;
  criticalDeals: number;
  averageScore: number;
  incompleteHandoffs: number;
  lastScanAt: string | null;
  nextScanAt: string;
  topIssues: Array<{ code: string; label: string; count: number }>;
  problemDeals: ProblemDeal[];
  latestScan: ScanStatus | null;
}

export interface RequestIdentity {
  portalId: string;
  userId: string | null;
  userEmail: string | null;
  appId: string | null;
}

export interface GovernanceContext {
  role: GovernanceRole;
  permissions: string[];
  governanceEnabled: boolean;
  installerBootstrap: boolean;
}

export interface PolicyVersion {
  id: string;
  portalId: string;
  versionNumber: number;
  name: string;
  description: string;
  status: PolicyStatus;
  rules: RuleSettings;
  checksum: string;
  changeSummary: string;
  basedOnPolicyId: string | null;
  createdByUserId: string | null;
  createdByEmail: string | null;
  submittedAt: string | null;
  approvedAt: string | null;
  approvedByEmail: string | null;
  publishedAt: string | null;
  publishedByEmail: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface PolicySimulation {
  id: string;
  policyId: string;
  status: 'running' | 'completed' | 'failed';
  totalDeals: number;
  changedDeals: number;
  readyDeals: number;
  atRiskDeals: number;
  criticalDeals: number;
  averageScore: number;
  previousAverageScore: number;
  errorMessage: string | null;
  startedAt: string;
  completedAt: string | null;
}

export interface EnterpriseAnalyticsSnapshot {
  date: string;
  totalDeals: number;
  readyDeals: number;
  atRiskDeals: number;
  criticalDeals: number;
  averageScore: number;
  totalPipelineAmount: number;
  amountAtRisk: number;
  incompleteHandoffs: number;
}

export interface EnterpriseOverview {
  governance: GovernanceContext;
  activePolicy: PolicyVersion | null;
  latestSimulation: PolicySimulation | null;
  current: EnterpriseAnalyticsSnapshot;
  trend: EnterpriseAnalyticsSnapshot[];
  byPipeline: Array<{ pipelineId: string; pipelineLabel: string; totalDeals: number; criticalDeals: number; amountAtRisk: number; averageScore: number }>;
  byOwner: Array<{ ownerId: string; totalDeals: number; criticalDeals: number; amountAtRisk: number; averageScore: number }>;
  pendingApprovals: number;
  openExceptions: number;
}
