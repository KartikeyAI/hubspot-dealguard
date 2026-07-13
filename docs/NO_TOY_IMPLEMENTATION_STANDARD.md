# No-toy implementation standard

A DealGuard enterprise capability must include:

1. Persistent data model and migration.
2. Permission-enforced backend behavior.
3. Input validation and bounded resource use.
4. Idempotency or concurrency controls where applicable.
5. Audit attribution.
6. Failure visibility and recovery path.
7. Product UI or documented API surface.
8. Automated tests.
9. Deployment and acceptance documentation.
10. Live platform validation before release.

Placeholder handlers, hard-coded success responses and unaudited in-memory state do not satisfy this standard.
