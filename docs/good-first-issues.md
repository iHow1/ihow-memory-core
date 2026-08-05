# Good first issue candidates

These are issue-ready candidates, not claims that public GitHub issues or labels already exist. Each is intentionally bounded and should use synthetic data only. Before opening one, confirm it is still unclaimed and reproduce the current behavior from the default branch.

## 1. Add a proof-output glossary

**Scope:** Documentation only. Explain `UNVERIFIED`, `GREEN`, `RED`, anchor drift, citation, and audit event beside the existing proof walkthrough.

**Done when:** Every term maps to an observed line from `ihow-memory proof`; the page states what the proof does not establish; all commands run in a temporary directory.

## 2. Document a clean WSL setup observation

**Scope:** Run `setup --dry-run`, `setup`, and `doctor` in a fresh WSL environment using a synthetic repository, then document the observed state transitions and any restart required.

**Done when:** Node, WSL, runtime, and package versions are recorded; paths and usernames are redacted; no native-Windows support claim is added.

## 3. Add fish-shell equivalents to the CLI walkthrough

**Scope:** Translate the shell-variable commands in `examples/01-five-minute-memory.md` into a separate fish-compatible example.

**Done when:** The example uses a fresh `mktemp` root, reaches cited read-back, cleans up, and is run under fish without modifying the default memory root.

## 4. Audit documentation link and anchor portability

**Scope:** Check relative links and heading anchors in both READMEs, `docs/`, and `examples/`, including case sensitivity on Linux.

**Done when:** Broken links are fixed; external links are listed separately from offline-checkable links; no generated or machine-local path is committed.

## 5. Add a synthetic redacted bug-report example

**Scope:** Add one filled example showing how to report a failed runtime connection without exposing memory, prompts, config contents, usernames, or credentials.

**Done when:** The sample follows the bug template, uses fictional paths and names, and passes the repository secret scan.

## 6. Clarify receive-only runtime expectations

**Scope:** Add a short troubleshooting matrix for Cursor, Claude Desktop, and VS Code that separates “can call memory tools” from “can capture its own prior session.”

**Done when:** Each statement agrees with the README runtime table; no unobserved lifecycle state is called ACTIVE; restart and manual-instruction steps are explicit.

## 7. Accessibility review for launch assets

**Scope:** Review the social-preview SVG and README image/link text for contrast, readable fallback text, and screen-reader meaning.

**Done when:** The SVG retains a useful `title` and `desc`, text remains legible at reduced size, and any exported raster is checked at its final dimensions.

## 8. Add a package-tarball documentation smoke

**Scope:** Verify the README quickstart and every linked packaged document against `npm pack` output in a temporary directory.

**Done when:** The report distinguishes repository-only examples from files shipped in the npm tarball, records exact commands, and proposes only documentation or package-file-list changes needed to remove dead ends.

## Opening one publicly

Use the repository's feature or bug template, mention the candidate title, and include the exact environment and reproduction command. A maintainer still needs to create the public issue, apply an available `good first issue` label, and assign ownership; this document does none of those remote actions.
