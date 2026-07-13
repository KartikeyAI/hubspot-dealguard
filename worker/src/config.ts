import type { PlanId, TenantSettings } from './types.js';

export const CORE_DEAL_PROPERTIES = [
  'dealname',
  'pipeline',
  'dealstage',
  'hubspot_owner_id',
  'amount',
  'closedate',
  'hs_next_step',
  'hs_last_sales_activity_timestamp',
  'hs_lastmodifieddate',
  'description',
] as const;

export const DEALGUARD_NATIVE_PROPERTY_NAMES = [
  'dealguard_readiness_score',
  'dealguard_readiness_status',
  'dealguard_readiness_grade',
  'dealguard_issue_count',
  'dealguard_handoff_status',
  'dealguard_last_assessed_at',
  'dealguard_readiness_summary',
] as const;

export const DEFAULT_SETTINGS: TenantSettings = {
  rules: {
    staleDays: 7,
    maxStageAgeDays: 21,
    requireOwner: true,
    requireAmount: true,
    requireCloseDate: true,
    requireNextStep: true,
    requireCompany: true,
    requireContact: true,
    excludedPipelineIds: [],
    excludedStageIds: [],
    customRequiredProperties: [],
  },
  digest: {
    enabled: false,
    frequency: 'weekly',
    recipients: [],
    dayOfWeek: 1,
    hourUtc: 8,
  },
  notifications: {
    slack: {
      enabled: false,
      alertOnCritical: true,
      alertOnHandoffRequired: true,
      alertOnHandoffConfirmed: true,
      cooldownMinutes: 120,
    },
  },
  nativeSync: {
    enabled: false,
    includeSummary: true,
  },
};

export interface PlanLimits {
  maxDealsPerScan: number;
  minScanIntervalMinutes: number;
  historyDays: number;
  maxCustomRules: number;
  digestFrequencies: Array<'daily' | 'weekly'>;
  slackNotifications: boolean;
  workflowActions: boolean;
  nativeSync: boolean;
}

export const PLAN_LIMITS: Record<PlanId, PlanLimits> = {
  free: {
    maxDealsPerScan: 250,
    minScanIntervalMinutes: 1440,
    historyDays: 30,
    maxCustomRules: 3,
    digestFrequencies: ['weekly'],
    slackNotifications: false,
    workflowActions: false,
    nativeSync: false,
  },
  growth: {
    maxDealsPerScan: 5000,
    minScanIntervalMinutes: 60,
    historyDays: 365,
    maxCustomRules: 25,
    digestFrequencies: ['daily', 'weekly'],
    slackNotifications: true,
    workflowActions: true,
    nativeSync: true,
  },
  beta_growth: {
    maxDealsPerScan: 5000,
    minScanIntervalMinutes: 60,
    historyDays: 365,
    maxCustomRules: 25,
    digestFrequencies: ['daily', 'weekly'],
    slackNotifications: true,
    workflowActions: true,
    nativeSync: true,
  },
};

export const REQUIRED_HUBSPOT_SCOPES = [
  'crm.objects.deals.read',
  'crm.objects.deals.write',
  'crm.objects.contacts.read',
  'crm.objects.companies.read',
  'crm.schemas.deals.read',
  'crm.schemas.deals.write',
] as const;

export const APP_VERSION = '1.2.0-beta.1';
