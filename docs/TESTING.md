# Validation and test plan

## Automated validation

Run the complete repository check:

```bash
npm install --ignore-scripts
npm install --ignore-scripts --prefix src/app/cards
npm install --ignore-scripts --prefix src/app/settings
npm run check
```

This validates:

- Worker TypeScript under strict compiler settings.
- Deal-record UI extension against the current `@hubspot/ui-extensions` types.
- Connected-app settings extension against the current UI-extension types.
- Deterministic scoring, custom rules, closed-won and closed-lost behavior.
- Free-plan limits and digest validation.
- AES-256-GCM token round trips and OAuth-state primitives.

Validate the database separately:

```bash
npx wrangler d1 migrations apply dealguard-production --local
```

Smoke-test the Worker:

```bash
npx wrangler dev --local
curl http://127.0.0.1:8787/health
```

## HubSpot test-account acceptance suite

1. Install through OAuth into a configurable developer test account.
2. Confirm only the declared read scopes are requested.
3. Confirm the installation scan runs in the background and finishes.
4. Add the DealGuard card to a deal record.
5. Exercise a complete deal, a stale deal, an overdue deal, a closed-lost deal, and a closed-won deal.
6. Confirm readiness deductions match configured rules.
7. Confirm closed-lost deals are excluded from active-pipeline scoring.
8. Confirm a critical closed-won deal cannot be handed off.
9. Resolve the critical condition, refresh, and confirm handoff.
10. Configure pipeline and stage exclusions.
11. Add stage-specific custom required-property rules.
12. Verify Free plan clamps custom rules to three and digest frequency to weekly.
13. Promote the portal to `beta_growth` and verify Growth entitlements.
14. Enable email, send a test digest, and verify scheduled delivery.
15. Revoke OAuth and verify reauthorization behavior.
16. Execute data deletion and confirm credentials and derived data are destroyed.

HubSpot CLI project validation and upload require an authenticated Rokad developer account:

```bash
hs account auth
hs project validate
hs project lint
hs project upload
```
