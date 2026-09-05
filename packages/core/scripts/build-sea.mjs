// Builds the collector into one self-contained executable — no Node install required
// to run it — so the macOS app can spawn it directly instead of asking the user to
// run `pnpm collect` themselves. Steps, per Node's own SEA docs:
//   1. esbuild bundles src/cli/collect.ts (all local imports + pricing.json) into one
//      CJS file. node: built-ins stay external — they're resolved by the runtime.
//   2. `node --experimental-sea-config` turns that file into a blob.
//   3. Copy the current `node` binary, strip its signature (required before postject
//      can modify a signed Mach-O), and inject the blob into it.
// The result is unsigned; apps/mac/bundle.sh signs it as part of app bundling.
import { buildSync } from 'esbuild';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync, copyFileSync, chmodSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url))); // packages/core
const dist = join(root, 'dist');
const bundlePath = join(dist, 'collect.cjs');
const blobPath = join(dist, 'collect.blob');
const binPath = join(dist, 'vole-collector');
const configPath = join(dist, 'sea-config.json');

rmSync(dist, { recursive: true, force: true });
mkdirSync(dist, { recursive: true });

console.log('[1/4] bundling collect.ts …');
buildSync({
  entryPoints: [join(root, 'src/cli/collect.ts')],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node22',
  outfile: bundlePath,
  logLevel: 'info',
});

console.log('[2/4] generating the SEA blob …');
writeFileSync(
  configPath,
  JSON.stringify(
    { main: bundlePath, output: blobPath, disableExperimentalSEAWarning: true },
    null,
    2,
  ),
);
execFileSync(process.execPath, ['--experimental-sea-config', configPath], { stdio: 'inherit' });

console.log('[3/4] copying the node binary and stripping its signature …');
copyFileSync(process.execPath, binPath);
chmodSync(binPath, 0o755);
if (process.platform === 'darwin') {
  execFileSync('codesign', ['--remove-signature', binPath]);
}

console.log('[4/4] injecting the blob …');
const postjectCli = fileURLToPath(import.meta.resolve('postject/dist/cli.js'));
const injectArgs = [postjectCli, binPath, 'NODE_SEA_BLOB', blobPath, '--sentinel-fuse', 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2'];
if (process.platform === 'darwin') injectArgs.push('--macho-segment-name', 'NODE_SEA');
execFileSync(process.execPath, injectArgs, { stdio: 'inherit' });

console.log(`built ${binPath} (unsigned — apps/mac/bundle.sh signs it)`);
