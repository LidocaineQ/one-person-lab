import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { resolveTemporalClientNamespace } from '../../src/modules/runway/family-runtime-temporal-client.ts';

test('Temporal readback uses the managed worker namespace when the CLI env omits it', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'opl-temporal-client-namespace-'));
  try {
    fs.writeFileSync(path.join(root, 'temporal-worker.json'), `${JSON.stringify({
      provider_kind: 'temporal',
      pid: process.pid,
      address: '127.0.0.1:7233',
      namespace: 'opl-stage-v2',
      task_queue: 'opl-stage-attempts',
      started_at: '2026-08-02T00:00:00.000Z',
      status: 'ready',
    }, null, 2)}\n`);

    assert.equal(resolveTemporalClientNamespace({
      paths: { root },
      addressOverride: '127.0.0.1:7233',
      env: {},
    }), 'opl-stage-v2');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('explicit Temporal namespace remains authoritative over managed worker state', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'opl-temporal-client-namespace-'));
  try {
    fs.writeFileSync(path.join(root, 'temporal-worker.json'), `${JSON.stringify({
      provider_kind: 'temporal',
      pid: process.pid,
      address: '127.0.0.1:7233',
      namespace: 'opl-stage-v2',
      task_queue: 'opl-stage-attempts',
      started_at: '2026-08-02T00:00:00.000Z',
      status: 'ready',
    }, null, 2)}\n`);

    assert.equal(resolveTemporalClientNamespace({
      paths: { root },
      addressOverride: '127.0.0.1:7233',
      env: { OPL_TEMPORAL_NAMESPACE: 'operator-namespace' },
    }), 'operator-namespace');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
