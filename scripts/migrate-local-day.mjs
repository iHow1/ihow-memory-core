#!/usr/bin/env -S node --experimental-strip-types
// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 iHow Memory
//
// Thin standalone wrapper around the shipped migration (src/migrate.ts). Installed users should prefer
// the bundled command `ihow-memory migrate-local-day [--apply]`; this script is for running from a repo
// checkout. Without --apply it DRY-RUNS. IHOW_MEMORY_TZ is honored (same as runtime).
//   node scripts/migrate-local-day.mjs --memory-root <dir> [--apply]
//   node scripts/migrate-local-day.mjs --root <dir> --space <id> [--apply]
import { migrateLocalDay } from '../src/migrate.ts';

function arg(name) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main() {
  const apply = process.argv.includes('--apply');
  const options = {
    memoryRoot: arg('--memory-root'),
    root: arg('--root'),
    space: arg('--space'),
    stateRoot: arg('--state-root'),
    cwd: arg('--cwd'),
  };
  if (!options.memoryRoot && !options.root) {
    console.error('usage: migrate-local-day.mjs --memory-root <dir> [--apply]   (or --root <dir> --space <id>)');
    process.exitCode = 1;
    return;
  }
  console.log(apply ? 'migrate-local-day: APPLYING (originals backed up to .premigrate-* per dir)' : 'migrate-local-day: DRY RUN (no changes; pass --apply to write)');
  const { changed } = await migrateLocalDay(options, apply, (m) => console.log(m), Date.now());
  if (!changed) console.log('  nothing to migrate — all journal/event files already use local-day names.');
  else if (!apply) console.log('  re-run with --apply to perform the migration.');
  else console.log('  done.');
}

if (process.argv[1] && import.meta.url === new URL(process.argv[1], 'file://').href) {
  main().catch((e) => { console.error(e instanceof Error ? e.message : String(e)); process.exitCode = 1; });
}
