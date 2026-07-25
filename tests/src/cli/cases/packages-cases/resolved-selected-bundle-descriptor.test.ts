import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { resolveSelectedBundleDescriptor } from '../../../../../src/modules/connect/agent-package-registry-parts/resolved-selected-bundle-descriptor.ts';

type PackageFixtureOptions = {
  packageId?: string;
  skillRoots?: string[];
  resources?: Record<string, string>;
};

function writeFile(root: string, relativePath: string, content: string, mode = 0o644) {
  const target = path.join(root, relativePath);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content, 'utf8');
  fs.chmodSync(target, mode);
}

function packageFixture(root: string, options: PackageFixtureOptions = {}) {
  const packageId = options.packageId ?? 'custom-package';
  writeFile(root, 'owner.json', JSON.stringify({ package_id: packageId }) + '\n');
  writeFile(root, '.codex-plugin/plugin.json', JSON.stringify({
    name: `${packageId}-plugin`,
    ...(options.skillRoots === undefined ? { skills: ['skills/example'] } : { skills: options.skillRoots }),
  }) + '\n');
  for (const [relativePath, content] of Object.entries(options.resources ?? {
    'skills/example/SKILL.md': '# Example\n',
    'skills/example/references/guide.md': 'resource closure\n',
  })) {
    writeFile(root, relativePath, content, relativePath.endsWith('.sh') ? 0o755 : 0o644);
  }
  return {
    packageId,
    carrierRoot: root,
    ownerManifestPath: 'owner.json',
    pluginManifestPath: '.codex-plugin/plugin.json',
  };
}

function temporaryRoot(t: test.TestContext) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'opl-selected-bundle-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

test('resolves explicit custom packages with zero owner-declared skills without registry input', (t) => {
  const root = temporaryRoot(t);
  const descriptor = resolveSelectedBundleDescriptor([
    packageFixture(path.join(root, 'custom'), { packageId: 'my-custom', skillRoots: [] }),
  ]);

  assert.deepEqual(descriptor.package_ids, ['my-custom']);
  assert.equal(descriptor.packages[0].skill_roots.length, 0);
  assert.match(descriptor.packages[0].owner_manifest.sha256, /^sha256:[a-f0-9]{64}$/);
  assert.match(descriptor.packages[0].plugin_manifest.sha256, /^sha256:[a-f0-9]{64}$/);
  assert.match(descriptor.packages[0].digest, /^sha256:[a-f0-9]{64}$/);
  assert.match(descriptor.digest, /^sha256:[a-f0-9]{64}$/);
});

test('captures every nested resource with path, digest, executable mode, and stable package ordering', (t) => {
  const root = temporaryRoot(t);
  const first = packageFixture(path.join(root, 'first'), {
    packageId: 'first-custom',
    resources: {
      'skills/example/SKILL.md': '# First\n',
      'skills/example/bin/run.sh': '#!/bin/sh\necho first\n',
      'skills/example/references/nested.md': 'nested\n',
    },
  });
  const second = packageFixture(path.join(root, 'second'), {
    packageId: 'second-custom',
    skillRoots: ['skills/second'],
    resources: {
      'skills/second/SKILL.md': '# Second\n',
    },
  });
  const descriptor = resolveSelectedBundleDescriptor([second, first]);

  assert.deepEqual(descriptor.package_ids, ['second-custom', 'first-custom']);
  const resources = descriptor.packages[1].skill_roots[0].resources;
  assert.deepEqual(resources.map((entry) => entry.relative_path), [
    'skills/example/bin/run.sh',
    'skills/example/references/nested.md',
    'skills/example/SKILL.md',
  ]);
  assert.equal(resources.find((entry) => entry.relative_path.endsWith('run.sh'))?.mode, '100755');
  assert.equal(descriptor.packages[1].skill_roots[0].entry_paths[0], 'skills/example/SKILL.md');
});

test('rejects unsafe roots, missing entry points, duplicate targets, and symlinks fail closed', (t) => {
  const root = temporaryRoot(t);
  const missing = packageFixture(path.join(root, 'missing'), { skillRoots: ['skills/missing'], resources: {} });
  assert.throws(() => resolveSelectedBundleDescriptor([missing]), /skill root is missing/);

  const noEntry = packageFixture(path.join(root, 'no-entry'), {
    skillRoots: ['skills/example'],
    resources: { 'skills/example/guide.md': 'no entry\n' },
  });
  assert.throws(() => resolveSelectedBundleDescriptor([noEntry]), /contain a SKILL\.md/);

  const duplicate = packageFixture(path.join(root, 'duplicate'), {
    skillRoots: ['skills', 'skills/example'],
  });
  assert.throws(() => resolveSelectedBundleDescriptor([duplicate]), /duplicate target path/);

  const escaped = packageFixture(path.join(root, 'escaped'), { skillRoots: ['../outside'] });
  assert.throws(() => resolveSelectedBundleDescriptor([escaped]), /remain inside/);

  const linked = packageFixture(path.join(root, 'linked'));
  fs.symlinkSync(path.join(linked.carrierRoot, 'skills', 'example', 'references'), path.join(linked.carrierRoot, 'skills', 'example', 'linked'));
  assert.throws(() => resolveSelectedBundleDescriptor([linked]), /does not admit symbolic links/);

  const intermediate = packageFixture(path.join(root, 'intermediate'), { skillRoots: [] });
  const outsideRoot = path.join(root, 'outside');
  writeFile(outsideRoot, 'skills/escaped/SKILL.md', '# Escaped\n');
  fs.symlinkSync(outsideRoot, path.join(intermediate.carrierRoot, 'bridge'), 'dir');
  writeFile(intermediate.carrierRoot, '.codex-plugin/plugin.json', JSON.stringify({
    name: 'custom-package-plugin',
    skills: ['bridge/skills/escaped'],
  }) + '\n');
  assert.throws(
    () => resolveSelectedBundleDescriptor([intermediate]),
    /intermediate symbolic link/,
  );
});

test('rejects duplicate package ids and resources whose bytes or mode drift while captured', (t) => {
  const root = temporaryRoot(t);
  const first = packageFixture(path.join(root, 'first'), { packageId: 'duplicate-id' });
  const second = packageFixture(path.join(root, 'second'), { packageId: 'duplicate-id' });
  assert.throws(() => resolveSelectedBundleDescriptor([first, second]), /package ids must be unique/);

  const duplicateTargetFirst = packageFixture(path.join(root, 'target-first'), {
    packageId: 'target-first',
  });
  const duplicateTargetSecond = packageFixture(path.join(root, 'target-second'), {
    packageId: 'target-second',
  });
  assert.throws(
    () => resolveSelectedBundleDescriptor([duplicateTargetFirst, duplicateTargetSecond]),
    /materialization targets must be unique/,
  );

  const drifting = packageFixture(path.join(root, 'drifting'));
  const resourcePath = path.join(drifting.carrierRoot, 'skills', 'example', 'references', 'guide.md');
  const originalReadFileSync = fs.readFileSync;
  let mutated = false;
  fs.readFileSync = ((target: fs.PathOrFileDescriptor, options?: any) => {
    const result = originalReadFileSync(target, options);
    if (!mutated && String(target).endsWith(path.join('references', 'guide.md'))) {
      mutated = true;
      fs.writeFileSync(resourcePath, 'drifted bytes\n', 'utf8');
      fs.chmodSync(resourcePath, 0o755);
    }
    return result;
  }) as typeof fs.readFileSync;
  try {
    assert.throws(() => resolveSelectedBundleDescriptor([drifting]), /changed (while|after) its closure was captured/);
  } finally {
    fs.readFileSync = originalReadFileSync;
  }
  assert.equal(mutated, true);
});
