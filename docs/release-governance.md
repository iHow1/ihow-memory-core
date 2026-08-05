# Engineering Change and Release Governance

This document defines the default engineering governance for iHow Memory. Maintainers and automation agents must follow it unless a pull request records an explicit, reviewed exception.

## State vocabulary

Use precise states instead of saying only “done” or “released”:

1. **Local PR candidate** — bounded local changes with focused verification; not pushed.
2. **PR CI green** — the branch passes its required checks; not merged or released.
3. **Merged to `main`** — the reviewed composition is in the primary branch; not necessarily published.
4. **Integrated release candidate (RC)** — one immutable commit/tree selected for release-wide verification.
5. **Published** — the exact verified artifact is available from its registry or release channel.
6. **Website synchronized** — independently hosted public metadata and documentation were updated and read back.
7. **Local runtime upgraded** — persisted local runtime bytes were upgraded and verified.
8. **Loaded runtime verified** — the currently running host loaded and exercised the intended generation.

These are separate states. PR merge, tag creation, registry publication, website deployment, and local activation never imply one another.

## Layered verification

Do not run the full suite after every edit.

### Development loop

For each behavior or defect:

- create or identify an exact failing test (RED);
- implement the smallest fix;
- run the directly affected tests (GREEN);
- run necessary type, lint, build, secret, or diff checks for the touched surface.

Documentation-only changes run documentation, link, package-manifest, or rendering checks appropriate to their risk. They do not automatically require the full product suite.

### Per-PR CI

Every pull request must be small enough to review and must prove:

- affected unit/integration tests;
- repository baseline checks such as typecheck, lint/build, secret scan, and diff validation;
- package or compatibility contracts when the PR touches those surfaces;
- DCO sign-off and required review.

PR CI makes a branch eligible to merge. It does not make the change released.

Changes to shared storage, upgrade/rollback, security/privacy, test runners, packaging, or cross-module infrastructure may require broader PR checks based on risk.

### Composition safety

Prefer a merge queue that tests the prospective composition against the latest `main` before merge. Where merge queue is unavailable, use a short-lived integration/release branch for a bounded release train.

Do not maintain a long-lived “second main.” Delete or close the integration branch after the train is resolved.

Several individually green PRs may be combined into one integrated RC. Their independent CI does not replace integration verification because interactions and merge order can change behavior.

## Immutable release candidate

Select one exact commit/tree only after:

- all intended PRs are present;
- focused tests and required reviews are closed;
- no unresolved blocker or major finding remains;
- the candidate bytes and version identity are frozen.

Record at least:

- commit SHA and tree/diff identity;
- package version;
- required CI run identities;
- full-gate result;
- artifact name, byte size, and SHA-256;
- supported-platform and fresh-install smoke evidence;
- known limitations.

Run the expensive release-wide gate once against this object: full suite, build, pack, fresh install, and required cross-module/runtime smoke.

If review discovers a real code defect after the gate starts, invalidate or stop that run, fix with focused TDD, freeze a new object, and run one replacement final gate. Do not repeatedly run the full suite until it happens to pass.

A low-risk documentation or assertion-label correction after the product gate is assessed under the repository risk policy and receives affected checks. It does not automatically cause another full product run, but its final bytes must still be reviewed and included in the frozen artifact manifest.

## Build once, promote the same artifact

The artifact tested as the RC must be the artifact promoted toward publication.

Preferred flow:

```text
RC commit/tree
  -> build package artifact once
  -> record SHA-256
  -> fresh-install and smoke that artifact
  -> publish the same bytes, or mechanically prove registry bytes are identical
```

Do not test one build and silently rebuild different bytes for publication. A changed artifact requires a new identity and the appropriate verification.

## Main, release, and activation gates

Recommended train:

```text
small branches
  -> focused PR CI and review
  -> merge queue or bounded integration composition
  -> merge to main
  -> immutable RC commit/tree
  -> one release-wide gate and artifact smoke
  -> tag / registry / GitHub release
  -> website synchronization
  -> separately authorized local runtime upgrade
```

Depending on branch policy, an integrated release PR may be verified before merging to `main`; the final merge result must be shown to contain the reviewed composition. If the merge commit changes bytes, verify that exact object before tagging.

Remote and external actions are permission gates. Do not commit, push, merge, tag, publish, deploy the website, or upgrade a live local runtime unless the current task authorization covers that action.

## Ownership and evidence rules

- Assign one owner to each expensive gate; workers and controllers must not duplicate it.
- Bind every review and test result to exact candidate hashes.
- A watcher exit is not a CI verdict; read the authoritative check conclusion.
- A timed-out or stale review is `NO CONCLUSION`, not PASS or FAIL.
- Do not mix evidence from different commits, trees, artifacts, hosts, or test attempts.
- Keep `main` buildable and use repair PRs rather than editing an already frozen RC in place.
- Record exceptions in the PR with scope, rationale, risk, and compensating evidence.

## Default decision table

| Change stage | Default verification |
| --- | --- |
| Local implementation | Exact RED/GREEN plus affected static checks |
| Small PR | Affected tests plus required baseline CI |
| High-risk PR | Affected tests plus risk-specific integration/security gates |
| Prospective merge | Merge Queue or exact integration composition checks |
| Integrated RC | One full suite, build, pack, fresh install, and required smoke |
| Publication | Promote the verified artifact and read back external state |
| Website/local runtime | Separate authorization and separate live verification |

This policy optimizes for fast feedback during development, reliable composition before merge, and evidence that the bytes released are the bytes actually tested.
