# Optional read-only Breeze adapters

These unpublished project components are intentionally outside canonical `src/` and are disabled by default. They have not been uploaded or approved. The core product and native AI do not depend on Breeze availability.

## Activation gates

1. Review the five manifests against the current HubSpot agent-tool reference and test account capabilities. `supportedClients` contains AGENTS, GET_DATA and `llmConfig.actionDescription`. All outputs are string-valued. Inputs stay optional at definition level during development; the service requires an explicit deal ID.
2. Add only eligible, reviewed components to a separate test project build. Never enable the public canonical build merely because backend tests pass.
3. Record the actual action-definition ID for each approved tool and configure `DEALGUARD_BREEZE_ACTION_IDS` as a JSON tool-to-numeric-ID map. Set `DEALGUARD_BREEZE_ENABLED=true` only after review. No IDs are fabricated here.
4. A portal-wide administrator separately enables Breeze consent, chooses the daily invocation cap, and assigns `breeze.use` where needed. Native AI consent is not a substitute.
5. Execute real account tests for signatures, identity, scope, missing evidence, retries, agent recognition and outputs. Complete applicable marketplace/tool approval before publication.

## Boundaries

Requests accept the signed body origin user/portal, bound action-definition ID and AGENTS context. URL or tool-input identities, conflicting aliases, unbounded bodies and unsupported inputs are rejected. The handlers reuse the curated evidence service and recheck current scope and consent. They do not invoke our native AI provider, execute actions, create work or authorize a remediation preview.

Callbacks are bound to actor, tool, deal, request hash and consent revision. Accepted duplicate callbacks have a five-minute retry window, consume a read-budget unit, and recompute permission-scoped evidence; previous output is never cached. The metadata ledger is retained for thirty days unless held. This is bounded replay handling, not a claim that legacy v2 signatures provide timestamp freshness or infinite replay protection after retention.

No raw provider payload, customer communication body or AI response is stored in this ledger. Optional metadata cleanup respects active legal holds. No live tool invocation or review approval is claimed.

Reference reviewed: https://developers.hubspot.com/docs/apps/developer-platform/add-features/agent-tools/reference (September 19, 2026).
