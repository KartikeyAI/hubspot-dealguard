export function productPlanLabel(plan: string | null | undefined): string {
  if (!plan) return 'Free';
  if (plan === 'beta_growth') return 'Growth Preview';
  return plan.charAt(0).toUpperCase() + plan.slice(1).replaceAll('_', ' ');
}

export function subscriptionLabel(status: string | null | undefined): string {
  if (!status) return 'No active subscription';
  if (status === 'active') return 'Active subscription';
  if (status === 'trialing') return 'Trial subscription';
  if (status === 'past_due') return 'Payment attention required';
  if (status === 'cancelled' || status === 'canceled') return 'Subscription cancelled';
  return status.replaceAll('_', ' ');
}

const INTERNAL_PATTERNS = [
  /relation\s+["'`]?[^^\s"'`]+["'`]?\s+does not exist/i,
  /column\s+["'`]?[^^\s"'`]+["'`]?\s+does not exist/i,
  /postgres(?:ql)?/i, /neon/i, /cloudflare/i, /dodo(?:\s+payments)?/i, /sqlstate/i,
  /syntax error at or near/i, /violates .* constraint/i, /duplicate key value/i, /worker\/src\//i,
];

export function safeProductError(message: unknown, fallback = 'DealGuard could not complete that action. Please try again.'): string {
  if (typeof message !== 'string' || !message.trim()) return fallback;
  return INTERNAL_PATTERNS.some((pattern) => pattern.test(message)) ? fallback : message;
}

export const PLAN_COMPARISON = [
  { feature: 'Readiness scoring & deal cards', free: 'Included', growth: 'Included', enterprise: 'Included' },
  { feature: 'Custom required-property rules', free: 'Up to 3', growth: 'Up to 25', enterprise: 'Advanced governance' },
  { feature: 'Scheduled pipeline digest', free: 'Weekly', growth: 'Daily or weekly', enterprise: 'Advanced routing' },
  { feature: 'HubSpot-native reporting fields', free: '—', growth: 'Included', enterprise: 'Included' },
  { feature: 'Slack alerts & workflow actions', free: '—', growth: 'Included', enterprise: 'Advanced routing' },
  { feature: 'Policies, approvals & scoped access', free: '—', growth: '—', enterprise: 'Included' },
  { feature: 'Compliance & reliability controls', free: '—', growth: '—', enterprise: 'Included' },
] as const;
