// Builds the collector into one self-contained executable — no Node install required
// to run it — so the macOS app can spawn it directly instead of asking the user to
// run `pnpm collect` themselves. Steps, per Node's own SEA docs:
//   1. esbuild bundles src/cli/collect.ts (all local imports + pricing.json) into one
//      CJS file. node: built-ins stay external — they're resolved by the runtime.
//   2. `node --experimental-sea-config` turns that file into a blob.
//   3. Take the PINNED Node binary (scripts/node-sea.lock.json — exact version, SHA256
//      verified against the committed lock), strip its signature (required before
//      postject can modify a signed Mach-O), and inject the blob into it.
//   4. Write dist/node-manifest.json beside the binary, recording exactly which Node
//      is embedded — the SBOM / notarisation-review fact the old build could not state.
//
// The host is never process.execPath: an unpinned, unrecorded "whatever Node the
// builder happened to run" fails on machines that do not resemble the build host,
// and a security questionnaire has no answer for it. `--use-local-node` exists as an
// explicit dev escape hatch and prints what it is doing.
import { buildSync } from 'esbuild';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync, copyFileSync, chmodSync, rmSync, existsSync, createReadStream, renameSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const USE_LOCAL_NODE = process.argv.includes('--use-local-node');

const root = dirname(dirname(fileURLToPath(import.meta.url))); // packages/core
const dist = join(root, 'dist');
const bundlePath = join(dist, 'collect.cjs');
const blobPath = join(dist, 'collect.blob');
const binPath = join(dist, 'vole-collector');
const configPath = join(dist, 'sea-config.json');

const lock = JSON.parse(
  await (await import('node:fs/promises')).readFile(join(root, 'scripts/node-sea.lock.json'), 'utf8'),
);

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
  // `import.meta` does not exist in CJS, so esbuild emits `var import_meta = {}` and
  // every `import.meta.url` in the graph becomes undefined. Five sites do that here,
  // and two of them run at module scope — fileURLToPath(undefined) and
  // createRequire(undefined) both throw — so the SEA died on its first line with
  // ERR_INVALID_ARG_TYPE before any collecting happened. Define it once, for the whole
  // bundle, instead of rewriting each call site.
  define: { 'import.meta.url': '__voleImportMetaUrl' },
  banner: {
    js:
      "const __voleImportMetaUrl = require('node:url').pathToFileURL(" +
      "typeof __filename !== 'undefined' ? __filename : process.execPath).href;",
  },
});

// ── Resolve the SEA host: pinned, or explicitly local (dev only) ─────────────
let seaNode; // absolute path to the node binary that will host the blob
let nodeVersion;
let nodeSha;
let nodeSource;

if (USE_LOCAL_NODE) {
  seaNode = process.execPath;
  nodeVersion = process.version.slice(1);
  nodeSha = null;
  nodeSource = `local --use-local-node (UNPINNED: ${seaNode})`;
  console.log(
    `[!] --use-local-node: embedding ${seaNode} (${process.version}) — UNPINNED, ` +
      'never for a build that leaves this machine.',
  );
} else {
  const platform = `${process.platform}-${process.arch}`;
  const sha = lock.shasums[platform];
  if (!sha) {
    console.error(`node-sea.lock.json has no shasum for ${platform} — add it before building.`);
    process.exit(1);
  }
  const artifact = `node-v${lock.version}-${platform}`;
  const url = lock.url
    .replaceAll('{version}', lock.version)
    .replaceAll('{platform}', platform);
  const cache = join(homedir(), '.vole', 'sea-cache');
  const tarball = join(cache, `${artifact}.tar.gz`);
  const extracted = join(cache, artifact);

  if (!existsSync(tarball)) {
    console.log(`[2/4] downloading pinned Node v${lock.version} (${platform}) …`);
    mkdirSync(cache, { recursive: true });
    execFileSync('curl', ['--fail', '--location', '--silent', '--show-error', '-o', tarball, url], {
      stdio: 'inherit',
    });
  }

  // SHA256 against the committed lock — the pin lives in the repo, not in the download.
  const actual = await new Promise((resolve, reject) => {
    const h = createHash('sha256');
    createReadStream(tarball)
      .on('data', (d) => h.update(d))
      .on('error', reject)
      .on('end', () => resolve(h.digest('hex')));
  });
  if (actual !== sha) {
    console.error(`sha256 mismatch for the pinned Node ${platform} artifact:`);
    console.error(`  lock says ${sha}`);
    console.error(`  got      ${actual}`);
    console.error('Delete the cache and retry; if it persists, the lock is wrong.');
    process.exit(1);
  }

  if (!existsSync(join(extracted, 'bin', 'node'))) {
    const stage = join(tmpdir(), `vole-sea-${Date.now()}`);
    mkdirSync(stage, { recursive: true });
    execFileSync('tar', ['-xzf', tarball, '-C', stage], { stdio: 'inherit' });
    rmSync(extracted, { recursive: true, force: true });
    renameSync(join(stage, artifact), extracted);
    rmSync(stage, { recursive: true, force: true });
  }
  seaNode = join(extracted, 'bin', 'node');
  nodeVersion = lock.version;
  nodeSha = sha;
  nodeSource = url;
  console.log(`[2/4] pinned Node v${lock.version} (${platform}, sha256 ${sha.slice(0, 16)}…) verified ✓`);
}

console.log('[3/4] generating the SEA blob …');
writeFileSync(
  configPath,
  JSON.stringify(
    {
      main: bundlePath,
      output: blobPath,
      disableExperimentalSEAWarning: true,
      // No SEA assets: the only one was the DLP detector pack, and both it and
      // src/dlp/ are gone. A config naming a missing asset makes
      // `node --experimental-sea-config` exit 1, which took bundle.sh down with it
      // (set -euo pipefail, and the collector build runs before any cp into the .app).
    },
    null,
    2,
  ),
);
execFileSync(seaNode, ['--experimental-sea-config', configPath], { stdio: 'inherit' });

console.log('[4/4] injecting the blob into the pinned binary …');
const stagedHost = join(dist, 'node-host');
copyFileSync(seaNode, stagedHost);
chmodSync(stagedHost, 0o755);
if (process.platform === 'darwin') {
  execFileSync('codesign', ['--remove-signature', stagedHost]);
}

const postjectCli = fileURLToPath(import.meta.resolve('postject/dist/cli.js'));
const injectArgs = [postjectCli, stagedHost, 'NODE_SEA_BLOB', blobPath, '--sentinel-fuse', 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2'];
if (process.platform === 'darwin') injectArgs.push('--macho-segment-name', 'NODE_SEA');
execFileSync(seaNode, injectArgs, { stdio: 'inherit' });
// The host becomes the product: rename after injection.
rmSync(binPath, { force: true });
renameSync(stagedHost, binPath);

// The SBOM fact an embedded runtime must be able to state: which Node, from where,
// verified how. A null sha256 marks a --use-local-node build that must not ship.
writeFileSync(
  join(dist, 'node-manifest.json'),
  JSON.stringify(
    {
      runtime: 'node',
      version: nodeVersion,
      sha256: nodeSha,
      source: nodeSource,
      pinned: !USE_LOCAL_NODE,
      built_at: new Date().toISOString(),
    },
    null,
    2,
  ),
);

console.log(`built ${binPath} (unsigned — apps/mac/bundle.sh signs it)`);
console.log(
  `embedded runtime: Node v${nodeVersion}${nodeSha ? ` (sha256 ${nodeSha.slice(0, 16)}…, pinned)` : ' (UNPINNED — dev only)'}`,
);
