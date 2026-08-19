#!/usr/bin/env node
// Guards the one failure mode `npm publish` will not catch on its own: `lib/` is
// gitignored build output, so packing a tree that was never built succeeds with
// exit 0 and produces a tarball containing no source at all. A published version
// number can never be reused, so that mistake is permanent.
//
// Ground truth is `npm pack --dry-run --json` rather than a re-implementation of
// npm's `files` semantics, so this cannot drift from what actually ships.

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const manifest = JSON.parse(
  readFileSync(resolve(packageRoot, 'package.json'), 'utf8'),
);

const packed = JSON.parse(
  execFileSync('npm', ['pack', '--dry-run', '--json'], {
    cwd: packageRoot,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'inherit'],
  }),
);
const shipped = new Set(packed[0].files.map((file) => file.path));

const problems = [];

const requireShipped = (path, why) => {
  if (!shipped.has(path)) problems.push(`${path} is missing from the tarball (${why})`);
};

requireShipped(manifest.main, 'package "main"');
requireShipped(manifest.types, 'package "types"');
for (const target of Object.values(manifest.bin ?? {})) {
  requireShipped(target, 'package "bin"');
}
requireShipped('profile/cordis.yml', 'reference runtime profile');
requireShipped('README.md', 'install and upgrade instructions');
requireShipped('LICENSE', `declared license ${manifest.license}`);

// A build that emitted only the entry point is still broken: every source module
// must ship, otherwise the bridge fails at import time in the user's runtime.
const compiled = [...shipped].filter(
  (path) => path.startsWith('lib/') && path.endsWith('.js'),
);
if (compiled.length < 2) {
  problems.push(
    `only ${compiled.length} compiled module(s) in the tarball; run "npm run build" first`,
  );
}

// The tarball must never carry the fake harness the unit tests run against.
for (const path of shipped) {
  if (path.startsWith('lib/tests/') || path.startsWith('tests/')) {
    problems.push(`${path} is test-only and must not be published`);
  }
}

if (manifest.publishConfig?.access !== 'public') {
  problems.push(
    'publishConfig.access must be "public": scoped packages default to restricted, ' +
      'and npm rejects a restricted publish without a paid plan',
  );
}

if (problems.length > 0) {
  console.error('package verification failed:');
  for (const problem of problems) console.error(`  - ${problem}`);
  process.exit(1);
}

console.log(
  `package ok: ${shipped.size} files, ${compiled.length} compiled modules, ` +
    `${manifest.name}@${manifest.version}`,
);
