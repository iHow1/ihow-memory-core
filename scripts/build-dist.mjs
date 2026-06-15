import fs from 'node:fs/promises';
import path from 'node:path';
import { stripTypeScriptTypes } from 'node:module';

const packageDir = path.resolve(new URL('..', import.meta.url).pathname);
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

console.log(`built ${outputDir}`);
