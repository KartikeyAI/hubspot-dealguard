import { DEFAULT_SETTINGS, PLAN_LIMITS } from './config.js';
import { AppError } from './errors.js';
import type { CustomPropertyRule, DigestSettings, RuleSettings, TenantSettings, PlanId, IssueSeverity } from './types.js';

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PROPERTY_PATTERN = /^[a-zA-Z][a-zA-Z0-9_]{0,127}$/;

function bool(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

function boundedInteger(value: unknown, fallback: number, min: number, max: number): number {
  const number = Number(value);
  if (!Number.isInteger(number)) return fallback;
  return Math.min(max, Math.max(min, number));
}

function stringArray(value: unknown, max = 100): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((item): item is string => typeof item === 'string' && item.length <= 128))].slice(0, max);
}

function customRule(value: unknown): CustomPropertyRule | null {
  if (!value || typeof value !== 'object') return null;
  const rule = value as Record<string, unknown>;
  const property = typeof rule.property === 'string' ? rule.property.trim() : '';
  const label = typeof rule.label === 'string' ? rule.label.trim() : '';
  const severity: IssueSeverity = rule.severity === 'critical' || rule.severity === 'info' ? rule.severity : 'warning';
  if (!PROPERTY_PATTERN.test(property) || !label || label.length > 100) return null;
  return {
    property,
    label,
    weight: boundedInteger(rule.weight, 10, 1, 30),
    severity,
    stageIds: stringArray(rule.stageIds, 50),
  };
}

export function parseSettings(value: unknown, plan: PlanId): TenantSettings {
  const input = value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
  const ruleInput = input.rules && typeof input.rules === 'object' ? (input.rules as Record<string, unknown>) : {};
  const digestInput = input.digest && typeof input.digest === 'object' ? (input.digest as Record<string, unknown>) : {};
  const limits = PLAN_LIMITS[plan];

  const customRequiredProperties = Array.isArray(ruleInput.customRequiredProperties)
    ? ruleInput.customRequiredProperties
        .map(customRule)
        .filter((rule): rule is CustomPropertyRule => Boolean(rule))
        .slice(0, limits.maxCustomRules)
    : [];

  const rules: RuleSettings = {
    staleDays: boundedInteger(ruleInput.staleDays, DEFAULT_SETTINGS.rules.staleDays, 1, 90),
    maxStageAgeDays: boundedInteger(ruleInput.maxStageAgeDays, DEFAULT_SETTINGS.rules.maxStageAgeDays, 1, 365),
    requireOwner: bool(ruleInput.requireOwner, DEFAULT_SETTINGS.rules.requireOwner),
    requireAmount: bool(ruleInput.requireAmount, DEFAULT_SETTINGS.rules.requireAmount),
    requireCloseDate: bool(ruleInput.requireCloseDate, DEFAULT_SETTINGS.rules.requireCloseDate),
    requireNextStep: bool(ruleInput.requireNextStep, DEFAULT_SETTINGS.rules.requireNextStep),
    requireCompany: bool(ruleInput.requireCompany, DEFAULT_SETTINGS.rules.requireCompany),
    requireContact: bool(ruleInput.requireContact, DEFAULT_SETTINGS.rules.requireContact),
    excludedPipelineIds: stringArray(ruleInput.excludedPipelineIds, 50),
    excludedStageIds: stringArray(ruleInput.excludedStageIds, 200),
    customRequiredProperties,
  };

  const requestedFrequency = digestInput.frequency === 'daily' ? 'daily' : 'weekly';
  const digest: DigestSettings = {
    enabled: bool(digestInput.enabled, false),
    frequency: limits.digestFrequencies.includes(requestedFrequency) ? requestedFrequency : 'weekly',
    recipients: stringArray(digestInput.recipients, 10).filter((email) => EMAIL_PATTERN.test(email)),
    dayOfWeek: boundedInteger(digestInput.dayOfWeek, 1, 0, 6),
    hourUtc: boundedInteger(digestInput.hourUtc, 8, 0, 23),
  };
  if (digest.enabled && digest.recipients.length === 0) {
    throw new AppError(400, 'digest_recipient_required', 'At least one valid digest recipient is required.');
  }

  return { rules, digest };
}
