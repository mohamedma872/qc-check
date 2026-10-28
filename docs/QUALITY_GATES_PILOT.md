# QC quality-gate validation pilot

This pilot evaluates the existing QC workflow before treating AI-generated results as mandatory release gates. It does **not** claim device or security validation has passed.

## Four required evaluations

| Evaluation | Procedure | Acceptance gate |
|---|---|---|
| False-pass detection | Inject known UI, backend and locale defects into a controlled test app; compare the agent verdict with ground truth | Zero false PASS on critical seeded defects; report all other false passes |
| Evidence integrity | For each claimed PASS, verify device identity, environment, build SHA, timestamp, steps and screenshot/API trace | No PASS without verifiable observed evidence |
| Credential isolation | Use synthetic secrets and scan agent prompts, logs, reports, screenshots and committed artifacts; test redaction failures | Zero exposed synthetic secrets |
| PR enforcement | Simulate failing checks, missing devices, unavailable backend, interrupted jobs and skipped steps | Every mandatory failure blocks the PR; no skipped/blocked run labeled PASS |

## Reproducible pilot

1. Select a nonproduction Flutter or React Native app and an isolated backend with test accounts.
2. Record the tested commit SHA, app version, device model/OS, locale, environment and agent version.
3. Run `qc-check doctor`, then `qc-check run <ticket>` with human approval enabled.
4. Seed defects: incorrect backend response, missing confirmation, RTL layout issue, stale accessibility selector and interrupted device run.
5. Independently review screenshots, API traces, generated report and tracker verdict against observed behavior.
6. Repeat each case three times to measure verdict consistency and flaky outcomes.
7. Repeat on Android and iOS; include English and Arabic locales where supported.
8. Publish a decision log and retain raw evidence with restricted access.

## Metrics

- False-pass rate = incorrect PASS verdicts / seeded failing scenarios.
- Critical defect detection = detected critical seeded defects / all critical seeded defects.
- Evidence completeness = PASS cases with all required evidence / total PASS cases.
- Flake rate = inconsistent outcomes across identical reruns / rerun scenarios.
- Runtime and cost per ticket; manual review minutes; escaped defects after release.

## Governance

- Default to human-approved test plans; headless mode requires explicit project-level authorization.
- Treat BLOCKED, SKIPPED and INCONCLUSIVE as nonpassing, never as success.
- Protect production and customer data; use least-privilege test credentials.
- Enforce CI required status checks and branch protection **outside** the AI verdict.
- Use a separate reviewer to validate evidence and approve the pilot before enabling required PR checks.

## Proposed rollout

Week 1: baseline and instrument evidence. Week 2: seeded-defect and leak tests. Week 3: Android/iOS and locale reruns. Week 4: evaluate metrics and decide whether to make checks mandatory.

**Exit decision:** promote to required PR gate only after all four acceptance gates pass on a representative sample, with explicit owners for exceptions and rollback.
