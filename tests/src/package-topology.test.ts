import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { Ajv2020 } from 'ajv/dist/2020.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const scriptPath = path.join(repoRoot, 'scripts/source-package-boundary.mjs');

type BoundarySummary = {
  status: 'ok' | 'failed';
  workspace_package_count: number;
  topology_package_count: number;
  packages: Array<{
    package_id: string;
    version: string | null;
    descriptor_count: number;
    failures: string[];
  }>;
  failures: string[];
};

function runBoundary(root = repoRoot) {
  const result = spawnSync(process.execPath, [scriptPath, '--root', root, '--format', 'json'], {
    cwd: root,
    encoding: 'utf8',
  });
  return {
    ...result,
    summary: JSON.parse(result.stdout) as BoundarySummary,
  };
}

function writeJson(file: string, value: unknown) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function createFixture(options: {
  includeTopologyEntry?: boolean;
  source?: string;
} = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'opl-package-topology-'));
  const packageId = '@one-person-lab/test-contribution';
  const packagePath = 'packages/test-contribution';
  writeJson(path.join(root, 'package.json'), {
    name: 'opl-framework',
    version: '1.0.0',
    private: true,
    type: 'module',
    workspaces: ['packages/*'],
  });
  writeJson(path.join(root, packagePath, 'package.json'), {
    name: packageId,
    version: '0.1.0',
    type: 'module',
    exports: {
      '.': {
        types: './src/index.ts',
        default: './dist/index.js',
      },
    },
    files: ['dist'],
    scripts: {
      build: 'tsc -p tsconfig.json',
      typecheck: 'tsc -p tsconfig.json --noEmit',
    },
  });
  fs.mkdirSync(path.join(root, packagePath, 'src'), { recursive: true });
  fs.writeFileSync(path.join(root, packagePath, 'src/index.ts'), options.source ?? `
const buildCordisPluginDescriptor = (value: unknown) => value;
export const descriptor = buildCordisPluginDescriptor({
  package_ref: {
    package_id: '${packageId}',
    package_version: '0.1.0',
    package_ref: 'npm:${packageId}@0.1.0',
  },
});
`);
  writeJson(path.join(root, 'contracts/opl-framework/package-topology.json'), {
    version: 'package-topology.v1',
    root_package: 'opl-framework',
    packages: options.includeTopologyEntry === false ? [] : [{
      package_id: packageId,
      path: packagePath,
      package_kind: 'cordis_contribution',
      version_policy: 'independent',
      authority_owner: 'opl-framework/test',
      contributions: ['test-plugin'],
      plugin_descriptor_sources: ['src/index.ts'],
    }],
    legacy_paths: {
      physical_root: 'src/modules',
      caller_zero_required: true,
    },
  });
  return root;
}

test('package topology contract validates and matches all independent workspaces', () => {
  const topology = JSON.parse(fs.readFileSync(
    path.join(repoRoot, 'contracts/opl-framework/package-topology.json'),
    'utf8',
  ));
  const schema = JSON.parse(fs.readFileSync(
    path.join(repoRoot, 'contracts/opl-framework/package-topology.schema.json'),
    'utf8',
  ));
  const validate = new Ajv2020({ allErrors: true, strict: false }).compile(schema);
  assert.equal(validate(topology), true, JSON.stringify(validate.errors));

  const result = runBoundary();
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.summary.status, 'ok');
  assert.equal(result.summary.workspace_package_count, 5);
  assert.equal(result.summary.topology_package_count, 5);
  assert.deepEqual(
    result.summary.packages.map((entry) => entry.package_id).sort(),
    [
      '@one-person-lab/connect-discovery',
      '@one-person-lab/cordis-abi',
      '@one-person-lab/foundry-evaluation',
      '@one-person-lab/package-host',
      '@one-person-lab/runway-executor',
    ],
  );
  assert.deepEqual(result.summary.packages.map((entry) => entry.version), Array(5).fill('0.1.0'));
  assert.equal(result.summary.packages.every((entry) => entry.failures.length === 0), true);
  assert.equal(
    result.summary.packages
      .filter((entry) => entry.package_id !== '@one-person-lab/cordis-abi')
      .every((entry) => entry.descriptor_count > 0),
    true,
  );
});

test('package boundary rejects workspace and topology drift', () => {
  const root = createFixture({ includeTopologyEntry: false });
  try {
    const result = runBoundary(root);
    assert.equal(result.status, 1);
    assert.equal(
      result.summary.failures.some((failure) =>
        failure.includes('workspace Package is absent from package topology')),
      true,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('package boundary rejects reverse imports into root authority', () => {
  const root = createFixture({
    source: `
import { authority } from '../../../src/authority/private.ts';
const buildCordisPluginDescriptor = (value: unknown) => value;
export const descriptor = buildCordisPluginDescriptor({
  package_ref: {
    package_id: '@one-person-lab/test-contribution',
    package_version: '0.1.0',
    package_ref: 'npm:@one-person-lab/test-contribution@0.1.0',
  },
});
export { authority };
`,
  });
  try {
    const result = runBoundary(root);
    assert.equal(result.status, 1);
    assert.equal(
      result.summary.failures.some((failure) => failure.includes('may not import root authority')),
      true,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('package boundary rejects runtime plugin descriptors without an immutable package_ref', () => {
  const root = createFixture({
    source: `
const buildCordisPluginDescriptor = (value: unknown) => value;
export const descriptor = buildCordisPluginDescriptor({
  plugin_id: 'missing-package-ref',
});
`,
  });
  try {
    const result = runBoundary(root);
    assert.equal(result.status, 1);
    assert.equal(
      result.summary.failures.some((failure) =>
        failure.includes('runtime plugin descriptor must declare package_ref')),
      true,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
