# GitHub launch asset checklist

This checklist separates files prepared in the repository from public GitHub actions that require a maintainer. Checking in an asset does not publish it or change repository settings.

## Repository assets

- [x] English README opens with the continuity promise, one setup command, one isolated proof command, and a compact alpha boundary.
- [x] Simplified Chinese README mirrors the same first-use path and claim boundary.
- [x] Evidence-bound 30–45 second storyboard uses live command output rather than a fabricated transcript.
- [x] Reproducible demo script uses synthetic data and disposable workspaces.
- [x] Editable 1280×640 social-preview source exists at `assets/ihow-memory-social-preview.svg`; it is a diagram, not a product screenshot.
- [x] Bug and feature templates collect recovery context while warning against private memory or credentials.
- [x] Blank public issues are disabled by the repository issue-template config; a private security-report link is provided.
- [x] Eight bounded good-first-issue candidates are documented.
- [ ] Export the SVG to the raster format required by the chosen launch channels and compare the export with the source at full and thumbnail size.
- [ ] Record a fresh demo from the current release candidate; preserve the command and unedited live output with the recording notes.

## Public maintainer actions

- [ ] Upload the approved social preview in GitHub repository settings. Committing the SVG alone does not set it.
- [ ] Set or confirm the short repository description using the continuity promise without widening alpha claims.
- [ ] Set or confirm relevant repository topics such as `ai-agents`, `memory`, `mcp`, `local-first`, `claude-code`, and `codex`.
- [ ] Confirm Issues and private vulnerability reporting are enabled, then exercise both template entry points while logged out or in a non-maintainer account.
- [ ] Create selected starter issues from [good-first-issues.md](./good-first-issues.md); apply labels that actually exist in the repository and assign an owner.
- [ ] Pin the launch or getting-started issue only after its commands are re-run against the publicly available package.
- [ ] Publish the demo and launch copy only after verifying that `ihow-memory@next` resolves to the intended version; do not infer publication from this repository commit.
- [ ] Confirm the GitHub Actions badge and npm badge against public endpoints after launch.

## Final evidence packet

- [ ] Record the source commit SHA and package version separately.
- [ ] Attach command logs for build, isolated proof, example script, link check, secret scan, and package smoke.
- [ ] List runtime coverage exactly as observed; do not convert “configured,” “tools only,” or synthetic proof into ACTIVE.
- [ ] State that default retrieval is lexical FTS5 and that semantic quality is a separate opt-in evidence lane.
- [ ] State which public settings, uploads, issues, labels, posts, and package publication remain undone.
