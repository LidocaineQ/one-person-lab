import { spawnSync } from 'node:child_process';

import { assert, fs, os, path, repoRoot, test } from './cli/helpers.ts';

const helper = path.join(repoRoot, 'scripts/native-helper.mjs');

test('Node standard-library helper preserves the artifact and JSON index protocol', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'opl-node-helper-'));
  try {
    fs.mkdirSync(path.join(root, 'artifacts'), { recursive: true });
    fs.writeFileSync(path.join(root, 'artifacts', 'valid.json'), '{"ok":true}\n');
    fs.writeFileSync(path.join(root, 'artifacts', 'invalid.json'), '{\n');
    fs.writeFileSync(path.join(root, 'artifacts', 'ignored.txt'), 'ignored\n');

    const artifact = run('opl-artifact-indexer', {
      request_id: 'node-helper-artifact',
      workspace_root: root,
      artifact_roots: [path.join(root, 'artifacts')],
      artifact_extensions: ['json'],
    });
    assert.equal(artifact.ok, true);
    assert.equal(artifact.result.surface_kind, 'native_artifact_manifest');
    assert.equal(artifact.result.summary.total_files_count, 2);

    const state = run('opl-state-indexer', {
      request_id: 'node-helper-state',
      workspace_root: root,
      max_depth: 2,
    });
    assert.equal(state.ok, true);
    assert.equal(state.result.json_validation.checked_files_count, 2);
    assert.equal(state.result.json_validation.invalid_files_count, 1);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('Node standard-library helper never follows symlinked directories', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'opl-node-helper-links-'));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'opl-node-helper-outside-'));
  try {
    fs.writeFileSync(path.join(outside, 'secret.json'), '{}\n');
    fs.symlinkSync(outside, path.join(root, 'linked'), 'dir');
    const result = run('opl-state-indexer', { workspace_root: root, max_depth: 3 });
    assert.equal(result.ok, true);
    assert.equal(result.result.json_validation.checked_files_count, 0);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  }
});

test('Node standard-library helper reports typed protocol errors', () => {
  const result = spawnSync(process.execPath, [helper, 'opl-state-indexer'], {
    cwd: repoRoot,
    input: JSON.stringify({ workspace_root: repoRoot, max_files: 0 }),
    encoding: 'utf8',
  });
  assert.equal(result.status, 1);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.protocol_version, 'opl_native_helper.v1');
  assert.equal(payload.ok, false);
  assert.equal(payload.errors[0].code, 'invalid_limit');
});

function run(helperId: string, input: Record<string, unknown>) {
  const result = spawnSync(process.execPath, [helper, helperId], {
    cwd: repoRoot,
    input: JSON.stringify(input),
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout) as any;
}
