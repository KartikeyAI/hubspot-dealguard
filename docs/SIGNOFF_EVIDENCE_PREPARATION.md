# Preparing stable-release evidence

See `STABLE_3_0_SIGNOFF.md` for the authoritative approval and artifact contract.

## Evidence preparation (unsigned)

`npm run release:evidence -- init --output .release/reviewer-input` creates all eleven
report templates for the exact checked-out source. The `.release` parent must already
exist. Every check starts as `not_run`, measurements and observation times are null,
and there are no signatures. Initialization can run on an alpha for planning, but its
reports cannot later be reused as evidence for a different stable commit.

For an actual stable candidate, collect real reports with independent evidence links,
then run:

```sh
npm run release:evidence -- assemble \
  --input .release/reviewer-input \
  --output .release/reviewer-package \
  --staging-run <verified-staging-run-id> \
  --hours 12
```

Assembly uses the verifier's same check/measurement validation, requires stable v3,
rejects incomplete/stale/mixed-source/oversized/symlink inputs, and never overwrites
an existing output. It copies report bytes unchanged and creates their SHA-256-bound
dossier plus an empty `signatures.json`. No provider is contacted, measurement inferred,
key generated, person impersonated, or signature created. It returns
`approvalAccepted: false` and `productionReady: false`.

Each appointed reviewer must inspect original evidence, sign the exact dossier as
specified above, and supply their detached signature. Only the existing protected
`release:signoff` verifier can accept those approvals; preparation is not approval.
The separately controlled artifact upload and actual key enrollment remain operating
steps. Do not commit evidence, customer identifiers, signatures, private keys or
credentials. Keep reports in the protected evidence system and `.release` workspace.

Commercial concurrency implementation and its test boundaries are documented in
`STABLE_BILLING_CONSISTENCY.md`. Provider/customer acceptance remains independent of
those disposable-database and simulated-transport tests.
