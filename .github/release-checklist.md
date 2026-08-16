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
2. **Sanity-build + test locally.**
   - `npm run build` (strips types into `dist/`).
   - `node --test "tests/**/*.test.mjs"` — all green.
   - `node bin/ihow-memory.mjs --version` — prints the new version.
3. **Run the release gates locally** (the workflow runs them too; catching failures here is faster):
   - Governed-loop proof: `node scripts/proof.mjs`.
   - Secret scan: `npm run secret-scan` (the same repository policy used by CI).
   - License and release evidence: from the committed release-candidate tree, run `npm run release:evidence:check`. It rejects dirty trees, requires `package.json` / `package-lock.json` version parity and a matching changelog section, verifies Apache-2.0 legal files in the package, and binds source/package hashes to the candidate commit and tree.
   - To retain a local evidence bundle before tagging, run `npm run release:evidence`; it writes the ignored `release-evidence/` directory containing the tarball, `release-evidence.json`, and `checksums.txt`. `--allow-dirty` is development diagnostics only and produces `DEVELOPMENT_ONLY`, never release evidence.
4. **Update `CHANGELOG.md`** with the new version's notes.
5. **Commit** the version bump + changelog.
6. **Push the branch**, then **tag and push the tag**:
   ```bash
   git push origin <branch>
   git tag -a v<new-version> -m "iHow Memory <new-version>"
   git push origin v<new-version>
   ```
   The tag push triggers the release workflow → annotated-tag/version verification → build/typecheck/tests/proof/secret-scan → clean-tree source/legal evidence + one retained tarball/SHA-256 bundle →
   checksum verification → `npm publish <that-tarball> --tag <next|latest> --provenance`.
7. **Verify the publish**: `npm view ihow-memory dist-tags` shows the new version under the expected tag;
   `npm install ihow-memory@<tag>` resolves it.

## Notes

- The package has **zero production dependencies**; the lockfile is a near-empty version holder, so the
  bump in step 1 is essentially a version-string sync.
- Prerelease publishing to `next` does NOT move `latest` — existing `npm install` users are unaffected.
- Do not publish experimental capabilities as `latest` / stable without the corresponding live-dogfood
  evidence (see `projects/iHow Memory/dogfood-alpha4-2026-06.md` in the memory workspace for the floor's
  gate history).
