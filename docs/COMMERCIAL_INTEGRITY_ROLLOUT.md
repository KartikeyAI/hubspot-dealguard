# Commercial Integrity rollout

1. Merge and deploy prerequisite PRs #17 through #21 in order.
2. Apply and verify migration `0015_trustworthy_intelligence_currency.sql` before the prerequisite Worker deployment.
3. Deploy this Worker slice and upload the HubSpot project with optional commercial scopes.
4. Confirm existing accounts continue to show `authorization_required` without commercial API calls.
5. Reauthorize one developer account for quote and line-item access.
6. Validate aligned, incomplete, expired, cross-currency, discounted, and truncated fixtures.
7. Confirm full scans, scheduled jobs, webhooks, and workflow actions issue no commercial reads.
