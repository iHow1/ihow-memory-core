// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 iHow Memory
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Resolve a packaged OPTIONAL embedding-provider sidecar script.
//
// The sidecars live under dist/providers/ (copied verbatim from examples/ at build time — see
// scripts/build-dist.mjs — because dist/ is in package.json "files" but examples/ is not, so without
// this copy a published `npm i` could not find them). They are spawned as a SUBPROCESS on explicit
// opt-in only; they are NEVER imported into the default module graph. The default engine therefore
// stays zero-dependency lexical FTS5 with capabilities.semantic = false until a user turns semantic on.
//
// fileURLToPath(new URL('..')) — NOT URL.pathname — so a Windows file URL resolves to a real drive path
// (`C:\…`) instead of `/C:/…` (the same footgun the package-root resolver in cli.ts avoids).
const PACKAGE_ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));

// The provider scripts bundled into the tarball. Keep in sync with the copy list in build-dist.mjs.
export const BUNDLED_PROVIDERS = ['ollama-embedding-provider.mjs'] as const;
export type BundledProvider = (typeof BUNDLED_PROVIDERS)[number];

// Absolute path to a bundled provider sidecar. Does NOT assert existence — callers that intend to spawn
// it (e.g. the opt-in semantic path / doctor) check readability and degrade gracefully when absent.
export function providerScriptPath(name: BundledProvider = 'ollama-embedding-provider.mjs'): string {
  return path.join(PACKAGE_ROOT, 'dist', 'providers', name);
}
