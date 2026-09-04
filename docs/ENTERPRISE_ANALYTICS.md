# Enterprise analytics model

DealGuard Enterprise analytics are derived from deterministic assessments and operational events. Every metric must identify whether it represents current state, a historical observation, an operational event, or outcome evidence.

## Views

- Executive
- RevOps
- Sales manager
- Representative

## Trustworthy state semantics

### Current state

Current pipeline analytics use the latest recorded assessment for each open deal, independent of the selected historical reporting window. Repeated assessments do not multiply deal counts or amounts.

### Historical trend

Daily trend points use the latest assessment for each deal on that calendar day. This removes duplicate same-day assessments. A future carry-forward snapshot model will be required before interpreting a missing daily assessment as a zero or closed state.

### Outcome evidence

Win/loss evidence uses one latest open assessment before the latest recorded close outcome for each deal. Post-close assessments are excluded from the evidence row so the known outcome cannot leak into the pre-close signal.

### Policy impact

Policy impact uses one latest assessment per deal and policy within the selected period. Assessment frequency must not make one deal dominate a policy comparison.

## Metrics

- Readiness score and distribution
- Recorded pipeline amount and amount with readiness gaps
- Stage ageing and heat map
- Failure-pattern frequency
- Owner, team, region, pipeline and stage breakdowns
- Handoff completion and SLA
- Remediation backlog, overdue volume and MTTR
- Policy impact before and after publication
- Alert and delivery performance

`amountWithReadinessGaps` means the recorded amount attached to deals that have one or more readiness gaps. It is not expected financial loss, forecast probability, or risk-adjusted revenue.

## Currency handling

DealGuard stores both the deal's source currency code and HubSpot's amount in company currency when those values are available.

Amounts are aggregated only when one of these conditions is true:

1. Every amount-bearing deal in the selected view has a HubSpot company-currency amount. The aggregate is then reported using the company-currency basis.
2. Every amount-bearing deal has the same valid source currency code. The aggregate is then reported in that one source currency.

When currencies are mixed or unknown and company-currency coverage is incomplete, DealGuard returns `null` for aggregate monetary values. It never sums incomparable currencies and never invents a currency symbol.

Historical rows created before the trustworthy-currency migration remain unconverted. A full post-deployment portal scan is required to establish current currency coverage.

## Attention priority

The attention-priority score combines deterministic readiness score, stage age, and unresolved issue count. It is a review-prioritisation signal, not a machine-learning win probability or expected-loss estimate.

## Data trust

Analytics responses expose:

- generation time;
- oldest and latest current assessment timestamps;
- amount-field coverage;
- company-currency coverage;
- source-currency-code coverage;
- stage-age coverage;
- owner coverage;
- monetary reporting mode and suppression reason.

The HubSpot App Home surfaces these values so users can determine whether the evidence is fresh and sufficiently complete before acting.

## Drill-down

Every aggregate must retain a path to the underlying deal, policy, remediation case or delivery event. Saved views store filters and display preferences, not copied CRM records.

## Exports

Analytics exports follow the secure-download and audit controls used by other enterprise exports. Monetary columns include their reporting basis, currency code where known, and comparable-currency coverage. Suppressed monetary values remain blank rather than being exported as zero.
