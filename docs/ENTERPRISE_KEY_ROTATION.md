# Enterprise encryption-key rotation

1. Introduce the new key as an additional active decrypt key.
2. Pause configuration changes that write encrypted credentials.
3. Re-encrypt HubSpot, Slack, Teams, webhook and SIEM credentials in bounded batches.
4. Verify each record with decrypt-after-write checks.
5. Record progress and failures.
6. Resume writes using the new primary key.
7. Retain the old key only for the approved rollback window.
8. Remove the old key after verification and approval.
9. Audit the rotation without logging plaintext secrets.
