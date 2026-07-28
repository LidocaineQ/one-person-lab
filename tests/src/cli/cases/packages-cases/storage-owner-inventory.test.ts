import { fileURLToPath } from 'node:url';

import type { AgentPackageLockIndex } from '../../../../../src/modules/connect/agent-package-registry-parts/types.ts';
import {
  buildAgentPackageStoreStorageInventory,
  buildWebuiDataVolumeStorageInventory,
  scanStoragePath,
} from '../../../../../src/modules/connect/storage-owner-inventory.ts';
import {
  compactStorageOwnerProjection,
  readStorageOwnerInventorySnapshot,
  STORAGE_OWNER_INVENTORY_MAX_SNAPSHOT_BYTES,
  STORAGE_OWNER_INVENTORY_TTL_MS,
} from '../../../../../src/modules/connect/storage-owner-inventory-snapshot.ts';
import { resolveOplStatePaths } from '../../../../../src/kernel/runtime-state-paths.ts';
import { assert, fs, os, path, spawn, test } from '../../helpers.ts';

const storageInventoryWriterFixture = fileURLToPath(
  new URL('../../../../fixtures/storage-owner-inventory-writer.ts', import.meta.url),
);

function emptyLockIndex(): AgentPackageLockIndex {
  return {
    surface_kind: 'opl_agent_package_lock_index',
    version: 'opl-agent-package-lock-index.v1',
    packages: [],
    last_known_good_transactions: [],
  };
}

function runtimeLock(input: {
  checkoutPath: string;
  preparationRoot?: string | null;
  ownership?: 'package_created' | 'preexisting_adopted';
}) {
  return {
    package_id: 'test.storage-owner',
    managed_runtime_source: {
      status: 'current',
      ownership: input.ownership ?? 'package_created',
      checkout_path: input.checkoutPath,
      preparation_root: input.preparationRoot ?? null,
    },
  } as any;
}

function restoreEnv(name: string, value: string | undefined) {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

function waitForFiles(files: string[], timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  return new Promise<void>((resolve, reject) => {
    const check = () => {
      if (files.every((file) => fs.existsSync(file))) {
        resolve();
      } else if (Date.now() >= deadline) {
        reject(new Error(`Timed out waiting for fixture files: ${files.join(', ')}`));
      } else {
        setTimeout(check, 10);
      }
    };
    check();
  });
}

function spawnStorageInventoryWriter(input: {
  stateDir: string;
  section: 'agent_package_store' | 'webui_data_volume';
  projection: Record<string, unknown>;
  readyFile: string;
  startFile: string;
}) {
  const child = spawn(process.execPath, [
    '--experimental-strip-types',
    storageInventoryWriterFixture,
    input.section,
    JSON.stringify(input.projection),
    input.readyFile,
    input.startFile,
  ], {
    env: { ...process.env, OPL_STATE_DIR: input.stateDir },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  const completed = new Promise<void>((resolve, reject) => {
    let stderr = '';
    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`storage inventory writer exited ${code}: ${stderr}`));
    });
  });
  return { child, completed };
}

test('storage scanner is bounded, excludes requested roots, and never follows symlinks', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'opl-storage-scan-'));
  const dataRoot = path.join(root, 'data');
  const projectsRoot = path.join(dataRoot, 'projects');
  const outsideFile = path.join(root, 'outside.bin');
  try {
    fs.mkdirSync(projectsRoot, { recursive: true });
    fs.writeFileSync(path.join(dataRoot, 'small.txt'), 'small');
    fs.writeFileSync(path.join(projectsRoot, 'project.bin'), Buffer.alloc(32_768));
    fs.writeFileSync(outsideFile, Buffer.alloc(32_768));
    fs.symlinkSync(outsideFile, path.join(dataRoot, 'outside-link'));

    const usage = scanStoragePath(dataRoot, {
      excludedRoots: [projectsRoot],
      maxEntries: 64,
      deadlineMs: 1_000,
    });
    assert.equal(usage.complete, true);
    assert.equal(usage.reason_code, null);
    assert.equal(usage.excluded_root_count, 1);
    assert.equal((usage.bytes ?? Number.POSITIVE_INFINITY) < 32_768, true);

    assert.equal(scanStoragePath(dataRoot, { maxEntries: 1 }).reason_code, 'entry_limit_exceeded');
    assert.equal(scanStoragePath(path.join(root, 'missing')).reason_code, 'path_missing');
    assert.equal(scanStoragePath(path.join(dataRoot, 'outside-link')).reason_code, 'path_symlink');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('Agent Package storage inventory measures only typed current/LKG package-created safe roots', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'opl-package-storage-'));
  const stateDir = path.join(root, 'state');
  const codexHome = path.join(root, 'codex-home');
  const checkoutPath = path.join(stateDir, 'agent-package-runtime-generations', 'test.storage-owner');
  const preparationRoot = path.join(stateDir, 'agent-package-runtime-envs', 'test.storage-owner');
  const previousStateDir = process.env.OPL_STATE_DIR;
  const previousCodexHome = process.env.CODEX_HOME;
  process.env.OPL_STATE_DIR = stateDir;
  process.env.CODEX_HOME = codexHome;
  try {
    fs.mkdirSync(checkoutPath, { recursive: true });
    fs.mkdirSync(preparationRoot, { recursive: true });
    fs.mkdirSync(path.join(codexHome, 'plugins', 'cache'), { recursive: true });
    const lock = runtimeLock({ checkoutPath, preparationRoot });
    const index = {
      ...emptyLockIndex(),
      packages: [lock],
      last_known_good_transactions: [{
        root_package_id: 'test.storage-owner',
        transaction_id: 'tx-storage-owner',
        closure_digest: 'sha256:storage-owner',
        package_locks: [lock],
      }],
    } as AgentPackageLockIndex;
    const scannedRoots: string[] = [];
    const projection = buildAgentPackageStoreStorageInventory({
      lockIndex: index,
      persist: false,
      scan: (candidate) => {
        scannedRoots.push(candidate);
        return {
          complete: true,
          reason_code: null,
          bytes: 100,
          entry_count: 1,
          excluded_root_count: 0,
        };
      },
    });

    assert.deepEqual(scannedRoots.sort(), [checkoutPath, preparationRoot].sort());
    assert.equal(projection.status, 'available');
    assert.equal(projection.bytes, 200);
    assert.equal(projection.reclaimable_bytes, null);
    assert.equal(projection.owner_route, '/settings/agents');
    assert.deepEqual(projection.projected_action, {
      kind: 'navigate',
      status: 'available',
      action_id: null,
      route: '/settings/agents',
      dry_run_required: false,
    });

    const adopted = buildAgentPackageStoreStorageInventory({
      lockIndex: {
        ...emptyLockIndex(),
        packages: [runtimeLock({ checkoutPath, ownership: 'preexisting_adopted' })],
      },
      persist: false,
    });
    assert.equal(adopted.status, 'attention_required');
    assert.equal(adopted.bytes, null);
    assert.equal(adopted.reason_code, 'runtime_source_unmeasured');

    const outside = buildAgentPackageStoreStorageInventory({
      lockIndex: {
        ...emptyLockIndex(),
        packages: [runtimeLock({ checkoutPath: path.join(root, 'outside-managed-root') })],
      },
      persist: false,
    });
    assert.equal(outside.status, 'attention_required');
    assert.equal(outside.bytes, null);
    assert.equal(outside.reason_code, 'path_unsafe');

    const capped = buildAgentPackageStoreStorageInventory({
      lockIndex: {
        ...emptyLockIndex(),
        packages: Array.from({ length: 257 }, () => ({} as any)),
      },
      persist: false,
    });
    assert.equal(capped.status, 'attention_required');
    assert.equal(capped.bytes, null);
    assert.equal(capped.reason_code, 'entry_limit_exceeded');
  } finally {
    restoreEnv('OPL_STATE_DIR', previousStateDir);
    restoreEnv('CODEX_HOME', previousCodexHome);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('Agent Package storage inventory excludes retained lock roots for descriptor-owned carriers', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'opl-package-storage-descriptor-'));
  const stateDir = path.join(root, 'state');
  const codexHome = path.join(root, 'codex-home');
  const checkoutPath = path.join(stateDir, 'agent-package-runtime-generations', 'opl-flow');
  const preparationRoot = path.join(stateDir, 'agent-package-runtime-envs', 'opl-flow');
  const previousStateDir = process.env.OPL_STATE_DIR;
  const previousCodexHome = process.env.CODEX_HOME;
  process.env.OPL_STATE_DIR = stateDir;
  process.env.CODEX_HOME = codexHome;
  try {
    fs.mkdirSync(checkoutPath, { recursive: true });
    fs.mkdirSync(preparationRoot, { recursive: true });
    const lock = runtimeLock({ checkoutPath, preparationRoot });
    const scannedRoots: string[] = [];
    const projection = buildAgentPackageStoreStorageInventory({
      lockIndex: {
        ...emptyLockIndex(),
        packages: [lock],
        last_known_good_transactions: [{
          root_package_id: 'opl-flow',
          transaction_id: 'tx-opl-flow',
          closure_digest: 'sha256:opl-flow',
          package_locks: [lock],
        }],
      } as AgentPackageLockIndex,
      installedPackageIds: new Set(['test.storage-owner']),
      persist: false,
      scan: (candidate) => {
        scannedRoots.push(candidate);
        return {
          complete: true,
          reason_code: null,
          bytes: 100,
          entry_count: 1,
          excluded_root_count: 0,
        };
      },
    });

    assert.deepEqual(scannedRoots, []);
    assert.equal(projection.status, 'available');
    assert.equal(projection.bytes, 0);
    assert.equal(projection.reclaimable_bytes, null);
    assert.equal(projection.reason_code, null);
  } finally {
    restoreEnv('OPL_STATE_DIR', previousStateDir);
    restoreEnv('CODEX_HOME', previousCodexHome);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('Agent Package storage inventory defaults to the legacy lock projection', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'opl-package-storage-legacy-projection-'));
  const stateDir = path.join(root, 'state');
  const codexHome = path.join(root, 'codex-home');
  const previousStateDir = process.env.OPL_STATE_DIR;
  const previousCodexHome = process.env.CODEX_HOME;
  process.env.OPL_STATE_DIR = stateDir;
  process.env.CODEX_HOME = codexHome;
  try {
    const projection = buildAgentPackageStoreStorageInventory({
      persist: false,
      scan: () => ({
        complete: true,
        reason_code: null,
        bytes: 0,
        entry_count: 0,
        excluded_root_count: 0,
      }),
    });
    assert.equal(projection.status, 'available');
    assert.equal(projection.bytes, 0);
    assert.equal(projection.reclaimable_bytes, 0);
  } finally {
    restoreEnv('OPL_STATE_DIR', previousStateDir);
    restoreEnv('CODEX_HOME', previousCodexHome);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('WebUI inventory excludes Projects and exposes only carrier-host destructive authority', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'opl-webui-storage-'));
  const dataDir = path.join(root, 'data');
  const previousOplDataDir = process.env.OPL_DATA_DIR;
  const previousAionDataDir = process.env.AIONUI_DATA_DIR;
  delete process.env.OPL_DATA_DIR;
  delete process.env.AIONUI_DATA_DIR;
  try {
    fs.mkdirSync(path.join(dataDir, 'projects'), { recursive: true });
    fs.mkdirSync(path.join(dataDir, 'logs'), { recursive: true });
    fs.writeFileSync(path.join(dataDir, 'projects', 'private-project.bin'), Buffer.alloc(65_536));
    fs.writeFileSync(path.join(dataDir, 'logs', 'app.log'), 'small-log');

    const projection = buildWebuiDataVolumeStorageInventory({ dataDir, persist: false });
    assert.equal(projection.status, 'available');
    assert.equal((projection.bytes ?? Number.POSITIVE_INFINITY) < 65_536, true);
    assert.equal(projection.reclaimable_bytes, null);
    assert.equal(projection.owner_route, '/settings/storage#webui-data');
    assert.equal(projection.projected_action.kind, 'host_action_required');
    assert.equal(projection.projected_action.execution_owner, 'carrier_host');
    assert.equal(
      projection.projected_action.host_action_abi?.capability_id,
      'carrier_host.storage.webui_data_volume.lifecycle',
    );
    assert.equal(projection.projected_action.host_action_abi?.execute_action_id, null);

    const missing = buildWebuiDataVolumeStorageInventory({ dataDir: null, persist: false });
    assert.equal(missing.status, 'not_configured');
    assert.equal(missing.bytes, null);
    assert.equal(missing.reason_code, 'webui_data_root_not_configured');

    const namedVolume = buildWebuiDataVolumeStorageInventory({ dataDir: 'OnePersonLab/data', persist: false });
    assert.equal(namedVolume.status, 'unavailable');
    assert.equal(namedVolume.reason_code, 'named_volume_not_directly_observable');
  } finally {
    restoreEnv('OPL_DATA_DIR', previousOplDataDir);
    restoreEnv('AIONUI_DATA_DIR', previousAionDataDir);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('storage snapshot is bounded and stale, future, symlink, or oversized data fails open', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'opl-storage-snapshot-'));
  const stateDir = path.join(root, 'state');
  const previousStateDir = process.env.OPL_STATE_DIR;
  process.env.OPL_STATE_DIR = stateDir;
  try {
    const observedAt = new Date();
    const projection = buildAgentPackageStoreStorageInventory({
      lockIndex: emptyLockIndex(),
      now: observedAt,
      persist: true,
    });
    assert.equal(projection.status, 'available');
    assert.equal(projection.bytes, 0);
    assert.equal(projection.reclaimable_bytes, 0);

    const current = readStorageOwnerInventorySnapshot({ now: observedAt });
    assert.equal(current.agent_package_store.status, 'available');
    assert.equal(current.agent_package_store.bytes, 0);
    assert.equal(current.webui_data_volume.status, 'unavailable');

    buildWebuiDataVolumeStorageInventory({
      dataDir: null,
      now: observedAt,
      persist: true,
    });
    const afterBothOwners = readStorageOwnerInventorySnapshot({ now: observedAt });
    assert.equal(afterBothOwners.agent_package_store.status, 'available');
    assert.equal(afterBothOwners.webui_data_volume.status, 'not_configured');
    const stateFiles = fs.readdirSync(stateDir).sort();
    assert.equal(stateFiles.includes('storage-owner-inventory-snapshot.json'), true);
    assert.equal(stateFiles.includes('storage-owner-inventory.sqlite'), true);
    assert.equal(stateFiles.includes('agent-package-lifecycle.sqlite'), false);
    assert.equal(stateFiles.includes('agent-package-locks.json'), false);
    assert.equal(stateFiles.includes('agent-package-lifecycle-ledger.json'), false);
    assert.equal(stateFiles.some((file) => file.endsWith('.tmp')), false);

    const stale = readStorageOwnerInventorySnapshot({
      now: new Date(observedAt.getTime() + STORAGE_OWNER_INVENTORY_TTL_MS + 1),
    });
    assert.equal(stale.agent_package_store.status, 'attention_required');
    assert.equal(stale.agent_package_store.stale, true);
    assert.equal(stale.agent_package_store.reason_code, 'inventory_cache_stale');

    const future = compactStorageOwnerProjection({
      status: 'available',
      observed_at: new Date(Date.now() + 60_000).toISOString(),
      bytes: 123,
      reclaimable_bytes: 0,
    }, 'agent_package_store');
    assert.equal(future.status, 'unavailable');
    assert.equal(future.bytes, null);

    const snapshotPath = resolveOplStatePaths().storage_owner_inventory_snapshot_file;
    const externalSnapshot = path.join(root, 'external-snapshot.json');
    fs.writeFileSync(externalSnapshot, JSON.stringify({ surface_kind: 'opl_storage_owner_inventory_snapshot.v1', version: 1 }));
    fs.rmSync(snapshotPath, { force: true });
    fs.symlinkSync(externalSnapshot, snapshotPath);
    assert.equal(readStorageOwnerInventorySnapshot().agent_package_store.status, 'unavailable');

    fs.rmSync(snapshotPath, { force: true });
    fs.writeFileSync(snapshotPath, Buffer.alloc(STORAGE_OWNER_INVENTORY_MAX_SNAPSHOT_BYTES + 1, 0x20));
    assert.equal(readStorageOwnerInventorySnapshot().agent_package_store.status, 'unavailable');
  } finally {
    restoreEnv('OPL_STATE_DIR', previousStateDir);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('storage snapshot serializes independent owner projections without Package lifecycle state', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'opl-storage-snapshot-concurrent-'));
  const stateDir = path.join(root, 'state');
  const startFile = path.join(root, 'start');
  const readyAgent = path.join(root, 'ready-agent');
  const readyWebui = path.join(root, 'ready-webui');
  const observedAt = new Date().toISOString();
  const previousStateDir = process.env.OPL_STATE_DIR;
  process.env.OPL_STATE_DIR = stateDir;
  const agent = spawnStorageInventoryWriter({
    stateDir,
    section: 'agent_package_store',
    projection: {
      status: 'available',
      observed_at: observedAt,
      stale: false,
      bytes: 111,
      reclaimable_bytes: 11,
    },
    readyFile: readyAgent,
    startFile,
  });
  const webui = spawnStorageInventoryWriter({
    stateDir,
    section: 'webui_data_volume',
    projection: {
      status: 'available',
      observed_at: observedAt,
      stale: false,
      bytes: 222,
      reclaimable_bytes: 22,
    },
    readyFile: readyWebui,
    startFile,
  });
  try {
    await waitForFiles([readyAgent, readyWebui]);
    fs.writeFileSync(startFile, 'start\n');
    await Promise.all([agent.completed, webui.completed]);

    const snapshot = readStorageOwnerInventorySnapshot();
    assert.equal(snapshot.agent_package_store.bytes, 111);
    assert.equal(snapshot.webui_data_volume.bytes, 222);
    const stateFiles = fs.readdirSync(stateDir).sort();
    assert.equal(stateFiles.includes('agent-package-lifecycle.sqlite'), false);
    assert.equal(stateFiles.includes('agent-package-locks.json'), false);
    assert.equal(stateFiles.includes('agent-package-lifecycle-ledger.json'), false);
    assert.equal(stateFiles.some((file) => file.endsWith('.tmp')), false);
  } finally {
    agent.child.kill();
    webui.child.kill();
    restoreEnv('OPL_STATE_DIR', previousStateDir);
    fs.rmSync(root, { recursive: true, force: true });
  }
});
