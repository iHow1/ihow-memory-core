import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { stripTypeScriptTypes } from 'node:module';

// fileURLToPath, not URL.pathname: on Windows .pathname yields '/C:/...' which path.resolve mangles.
const packageDir = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const sourceDir = path.join(packageDir, 'src');
const outputDir = path.join(packageDir, 'dist');

async function sourceFiles(dir) {
  const files = [];
  for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
    const absolute = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...(await sourceFiles(absolute)));
    else if (entry.isFile() && entry.name.endsWith('.ts')) files.push(absolute);
  }
  return files;
}

await fs.rm(outputDir, { recursive: true, force: true });

for (const sourcePath of await sourceFiles(sourceDir)) {
  const relative = path.relative(sourceDir, sourcePath);
  const outputPath = path.join(outputDir, relative.replace(/\.ts$/, '.js'));
  const source = await fs.readFile(sourcePath, 'utf8');
  const rawShebang = source.match(/^#!.*\n/)?.[0] || '';
  const withoutShebang = source.slice(rawShebang.length);
  // dist is plain JS (types already stripped) — emit a plain `node` shebang so executable artifacts
  // (e.g. the MCP server bin) don't carry --experimental-strip-types and trigger an ExperimentalWarning.
  const shebang = rawShebang ? '#!/usr/bin/env node\n' : '';
  const transformed = stripTypeScriptTypes(withoutShebang, {
    mode: 'transform',
    sourceMap: false,
    sourceUrl: relative,
  }).replace(/(from\s+['"]|import\s*\(\s*['"])([^'"]+)\.ts(['"]\s*\)?)/g, '$1$2.js$3');
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await fs.writeFile(outputPath, `${shebang}${transformed}`, 'utf8');
  if (shebang) await fs.chmod(outputPath, 0o755);
}

// Optional embedding-provider sidecars: copied VERBATIM (already .mjs — no type-strip) from examples/
// into dist/providers/ so they ship in the tarball (dist/ is in package.json "files", examples/ is not).
// They are spawned as a SUBPROCESS on explicit opt-in only, never imported into the default graph — the
// default engine stays zero-dependency FTS5. Keep this list in sync with BUNDLED_PROVIDERS in
// src/provider-path.ts and the resolver there. Made executable so they can be run directly if desired.
const providerScripts = ['ollama-embedding-provider.mjs'];
const providersOut = path.join(outputDir, 'providers');
await fs.mkdir(providersOut, { recursive: true });
for (const name of providerScripts) {
  const dest = path.join(providersOut, name);
  await fs.copyFile(path.join(packageDir, 'examples', name), dest);
  await fs.chmod(dest, 0o755);
}

console.error(`built ${outputDir}`);
