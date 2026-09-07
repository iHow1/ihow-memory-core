# Release checklist

How to cut an `ihow-memory` release. Publishing is automated by `.github/workflows/release.yml`
on a pushed `v*` tag — the workflow re-runs the CI gates, **verifies the tag equals
`package.json` version**, and publishes to npm. There is no manual `npm publish` step.

## dist-tags

- **Prereleases** (`-alpha` / `-beta` / `-rc`) publish under the **`next`** dist-tag. A plain
  `npm install ihow-memory` keeps resolving the last stable (`latest`).
- **Stable** (no prerelease suffix) publishes to **`latest`**.

The workflow derives the dist-tag from the version automatically — no manual `--tag`.

## Steps

1. **Bump the version chain together.** Run `npm version <new-version> --no-git-tag-version` — this
   updates BOTH `package.json` and `package-lock.json` and avoids the chain drifting (the release
   workflow's tag↔version check fails if `package.json` doesn't match the tag).
   - Verify: `node -p "[require('./package.json').version, require('./package-lock.json').version]"` —
     both equal, and equal the version you intend to tag.
2. **Prepare and freeze the candidate.** Update `CHANGELOG.md`, bilingual release identity, bundled
   plugin versions and affected release assertions; run affected checks and commit with DCO sign-off.
   Select that clean commit/tree as the integrated RC. Do not tag before its required review/gates pass.
3. **Run the release gates against the frozen RC** (the workflow runs them too):
   - `npm run build && npm run typecheck`, then `node bin/ihow-memory.mjs --version`.
   - `node scripts/release-evidence.mjs --output release-evidence` retains one exact tarball before the expensive gate. Do not rebuild this artifact later.
   - `npm test` uses the repository's parallel and deadline-sensitive phases; do not launch competing full-suite runs.
   - Governed-loop proof: `node scripts/proof.mjs`.
   - Secret scan: `npm run secret-scan` (the same repository policy used by CI).
   - `node scripts/verify-release-artifact.mjs release-evidence/release-evidence.json` verifies commit/tree and tarball hash, performs an offline fresh install, compares all installed file bytes, and exercises CLI version and MCP write/search/read, isolation, empty-lock recovery and restart persistence. It uses synthetic data in a temporary HOME and requires Node, npm and tar on macOS/Linux.
   - Evidence rejects dirty trees, requires package/lockfile version parity and a changelog section, and records legal/source/package hashes. `--allow-dirty` remains development diagnostics only, never release evidence.
4. **Close compatibility and platform gates.** Check exact Core pins in separately versioned adapters,
   and read authoritative CI results for the frozen composition. Local macOS success is not Linux or Windows CI evidence.
5. **Verify the final object.** If product bytes change, invalidate the candidate, fix with affected
   checks, freeze a new object and run one replacement final gate. Keep the accepted artifact immutable.
6. **Push the branch**, then **tag and push the tag**:
   ```bash
   git push origin <branch>
   git tag -a v<new-version> -m "iHow Memory <new-version>"
   git push origin v<new-version>
   ```
   The tag push triggers the release workflow → tag/version verification → build/typecheck → one retained
   tarball/source/legal evidence bundle → tests/proof/secret-scan → exact-artifact offline install/MCP
   verification → checksum verification → `npm publish <that-tarball> --tag <next|latest> --provenance`.
   Compare the workflow artifact hash with the accepted RC artifact; publication or a rebuild never
   substitutes for validation of the actual published bytes.
7. **Verify the publish**: `npm view ihow-memory dist-tags` shows the new version under the expected tag;
   `npm install ihow-memory@<tag>` resolves it.

## Notes

- The package has **zero production dependencies**; the lockfile is a near-empty version holder, so the
  bump in step 1 is essentially a version-string sync.
- Prerelease publishing to `next` does NOT move `latest` — existing `npm install` users are unaffected.
- Do not publish experimental capabilities as `latest` / stable without the corresponding live-dogfood
  evidence (see `projects/iHow Memory/dogfood-alpha4-2026-06.md` in the memory workspace for the floor's
  gate history).
