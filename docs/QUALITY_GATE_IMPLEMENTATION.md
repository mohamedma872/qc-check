# Deterministic evidence gate (initial implementation)

Run `node runtime/quality-gate.js <run-directory>` after a QC run. Exit code 0 means the required summary and evidence fields exist and the verdict is PASS; exit code 1 means blocked.

The gate requires a PASS summary, no red findings, a report, state, screenshot files and an `evidence-manifest.json` containing commitSha, deviceId, osVersion, agentVersion, capturedAt, environment, runId and `reviewed: true`.

Every phase must pass. The phases the skill skips by design (`code-review`, `contract`, `tablet`, `ios`, `unit-tests`, `publish`) may be `skipped`, but only with a reason recorded in `state.json` (`state.js set <phase> skipped <reason>`). A skipped `ticket`, `test-plan`, `smoke`, `phone` or `report` phase, or any `pending`, `in_progress`, `fail` or `blocked` phase, blocks the run.

**Security boundary:** This is structural validation only. A forged manifest or fake screenshot can pass. The `reviewed` flag is not cryptographic proof or identity verification. A trusted CI attestation and independent reviewer workflow are required before treating this as a production release gate.

The GitHub workflow runs CLI tests, gate regression fixtures and the existing leak guard on pushes and PRs. It does **not** run Appium, create a trusted manifest, configure branch protection or automatically block merging based on real-device evidence. Set a required GitHub status check separately after confirming the workflow is green.

See [QUALITY_GATES_PILOT.md](QUALITY_GATES_PILOT.md) for seeded defect testing, credential leakage exercises and the rollout decision.
