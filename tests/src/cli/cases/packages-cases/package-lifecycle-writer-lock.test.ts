import { pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

import { removeFixtureTree } from '../../helpers.ts';
import {
  agentPackageManifest,
  assert,
  createPluginSourceFixture,
  formatJsonPayload,
  fs,
  os,
  parseJsonText,
  path,
  runCli,
  runCliAsync,
  runCliFailure,
  test,
} from './helpers.ts';
import {
  readLockIndex,
  withAgentPackageLifecycleTransaction,
  writePackageTransaction,
} from '../../../../../src/modules/connect/agent-package-registry-parts/store.ts';
import {
  writeCapabilityCatalog,
  writeCapabilityProvider,
  writeMasConsumer,
} from './capability-fixtures.ts';

async function withProcessEnv<T>(
  overrides: Record<string, string>,
  operation: () => Promise<T>,
) {
  const previous = new Map(Object.keys(overrides).map((key) => [key, process.env[key]]));
  Object.assign(process.env, overrides);
  try {
    return await operation();
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

function lifecycleLockPath(stateDir: string) {
  return path.join(stateDir, 'agent-package-lifecycle.sqlite');
}

function emptyLockIndex() {
  return {
    surface_kind: 'opl_agent_package_lock_index' as const,
    version: 'opl-agent-package-lock-index.v1' as const,
    packages: [],
  };
}

function assertNoScopeTransactionArtifacts(workspace: string) {
  const transactionRoot = path.join(workspace, '.codex', '.opl-package-transactions');
  if (fs.existsSync(transactionRoot)) {
    assert.deepEqual(fs.readdirSync(transactionRoot), []);
  }
}

function bindMasWorkspace(workspace: string, env: Record<string, string>) {
  fs.mkdirSync(workspace, { recursive: true });
  runCli([
    'workspace', 'bind', '--project', 'medautoscience', '--path', workspace,
  ], env);
}

test('package lifecycle SQLite writer mutex times out on live contention and recovers after release or failure', async () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opl-package-writer-lock-state-'));
  const lockPath = lifecycleLockPath(stateDir);
  try {
    await withProcessEnv({ OPL_STATE_DIR: stateDir }, async () => {
      await withAgentPackageLifecycleTransaction(true, async () => 'dry-run');
      assert.equal(fs.existsSync(lockPath), false);

      fs.mkdirSync(stateDir, { recursive: true });
      const liveOwner = new DatabaseSync(lockPath);
      liveOwner.exec('PRAGMA journal_mode = WAL;');
      liveOwner.exec('BEGIN IMMEDIATE;');
      await assert.rejects(
        withAgentPackageLifecycleTransaction(
          false,
          async () => 'must-not-run',
          { timeoutMs: 0 },
        ),
        (error: any) => error?.details?.failure_code === 'agent_package_lifecycle_lock_timeout'
          && error?.details?.owner_pid_alive === null,
      );
      liveOwner.exec('ROLLBACK;');
      liveOwner.close();

      assert.equal(await withAgentPackageLifecycleTransaction(
        false,
        async () => 'recovered',
        { timeoutMs: 100 },
      ), 'recovered');

      await assert.rejects(
        withAgentPackageLifecycleTransaction(false, async () => {
          throw new Error('fixture operation failed');
        }),
        /fixture operation failed/,
      );
      assert.equal(await withAgentPackageLifecycleTransaction(
        false,
        async () => 'successor',
        { timeoutMs: 100 },
      ), 'successor');
      assert.equal(fs.existsSync(lockPath), true);
    });
  } finally {
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
});

test('package lock authority rejects corruption and leaves legacy receipt history untouched', async () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opl-package-authority-corrupt-state-'));
  const lockPath = path.join(stateDir, 'agent-package-locks.json');
  const ledgerPath = path.join(stateDir, 'agent-package-lifecycle-ledger.json');
  try {
    await withProcessEnv({ OPL_STATE_DIR: stateDir }, async () => {
      assert.deepEqual(readLockIndex(), emptyLockIndex());
      assert.equal(fs.existsSync(lockPath), false);
      assert.equal(fs.existsSync(ledgerPath), false);

      const corruptLockBytes = Buffer.from('{"surface_kind":"opl_agent_package_lock_index","packages":[');
      fs.writeFileSync(lockPath, corruptLockBytes);
      assert.throws(
        () => readLockIndex(),
        (error: any) => error?.code === 'contract_json_invalid'
          && error?.details?.failure_code === 'agent_package_lock_authority_corrupt'
          && error?.details?.recovery_required === true
          && error?.details?.write_allowed === false,
      );
      assert.throws(
        () => writePackageTransaction(emptyLockIndex()),
        (error: any) => error?.details?.failure_code === 'agent_package_lock_authority_corrupt',
      );
      assert.deepEqual(fs.readFileSync(lockPath), corruptLockBytes);
      assert.equal(fs.existsSync(ledgerPath), false);

      fs.writeFileSync(lockPath, formatJsonPayload(emptyLockIndex()));
      const legacyLedgerBytes = Buffer.from('{ obsolete receipt history\n');
      fs.writeFileSync(ledgerPath, legacyLedgerBytes);
      const validLockBytes = fs.readFileSync(lockPath);
      writePackageTransaction(emptyLockIndex());
      assert.deepEqual(fs.readFileSync(lockPath), validLockBytes);
      assert.deepEqual(fs.readFileSync(ledgerPath), legacyLedgerBytes);
    });
  } finally {
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
});

test('package lock normalization stops propagating legacy catalog selection policies without mutating on read', async () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opl-package-selection-policy-state-'));
  const lockPath = path.join(stateDir, 'agent-package-locks.json');
  try {
    await withProcessEnv({ OPL_STATE_DIR: stateDir }, async () => {
      const legacyIndex = {
        surface_kind: 'opl_agent_package_lock_index',
        version: 'opl-agent-package-lock-index.v1',
        packages: [{
          surface_kind: 'opl_agent_package_lock',
          package_id: 'example-package',
          agent_id: null,
          lock_ref: 'package-lock-ref:example-package',
          managed_update_source: {
            kind: 'managed_version_catalog',
            transport: 'json_url',
            catalog_ref: 'https://packages.example.test/catalog.json',
            selection_policy: 'highest_stable',
            digest_authority: 'manifest_and_content_digest',
          },
          capability_dependencies: [{
            package_id: 'example-provider',
            dependency_source: {
              kind: 'managed_version_catalog',
              transport: 'json_url',
              catalog_ref: 'https://packages.example.test/provider-catalog.json',
              selection_policy: 'highest_compatible',
              digest_authority: 'manifest_and_content_digest',
            },
          }],
        }],
      };
      const legacyBytes = Buffer.from(formatJsonPayload(legacyIndex));
      fs.mkdirSync(stateDir, { recursive: true });
      fs.writeFileSync(lockPath, legacyBytes);

      const normalized = readLockIndex() as any;
      assert.equal(normalized.packages[0].managed_update_source.selection_policy, undefined);
      assert.equal(
        normalized.packages[0].capability_dependencies[0].dependency_source.selection_policy,
        undefined,
      );
      assert.deepEqual(fs.readFileSync(lockPath), legacyBytes);

      writePackageTransaction(normalized);
      const persisted = parseJsonText(fs.readFileSync(lockPath, 'utf8')) as any;
      assert.equal(persisted.packages[0].managed_update_source.selection_policy, undefined);
      assert.equal(
        persisted.packages[0].capability_dependencies[0].dependency_source.selection_policy,
        undefined,
      );
    });
  } finally {
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
});

test('concurrent package activation preserves distinct workspaces and avoids shared-workspace staging conflicts', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'opl-package-writer-concurrency-'));
  const stateDir = path.join(root, 'state');
  const homeDir = path.join(root, 'home');
  const workspaceA = path.join(root, 'workspace-a');
  const workspaceB = path.join(root, 'workspace-b');
  const sharedWorkspace = path.join(root, 'workspace-shared');
  const provider = writeCapabilityProvider(path.join(root, 'provider'), '0.1.0');
  const consumer = writeMasConsumer(path.join(root, 'consumer'), provider, '0.1.0');
  const releaseSet = writeCapabilityCatalog(path.join(root, 'release-set'), [consumer, provider]);
  const env = {
    HOME: homeDir,
    CODEX_HOME: path.join(homeDir, '.codex'),
    OPL_STATE_DIR: stateDir,
    OPL_MODULE_SOURCE_MODE: 'package_channel',
    ...releaseSet.env,
  };

  try {
    for (const workspace of [workspaceA, workspaceB, sharedWorkspace]) {
      bindMasWorkspace(workspace, env);
    }
    await runCliAsync(['packages', 'install', 'mas'], env);
    await Promise.all([workspaceA, workspaceB].map((workspace) => runCliAsync([
      'packages', 'activate', 'mas',
      '--scope', 'workspace', '--target-workspace', workspace,
    ], env)));

    const lockFile = path.join(stateDir, 'agent-package-locks.json');
    const ledgerFile = path.join(stateDir, 'agent-package-lifecycle-ledger.json');
    const afterDistinct = JSON.parse(fs.readFileSync(lockFile, 'utf8'));
    const mas = afterDistinct.packages.find((entry: any) => entry.package_id === 'mas');
    assert.deepEqual(
      mas.scope_materializations.map((entry: any) => path.resolve(entry.target_root)).sort(),
      [path.resolve(workspaceA), path.resolve(workspaceB)].sort(),
    );
    assert.equal(fs.existsSync(ledgerFile), false);
    assertNoScopeTransactionArtifacts(workspaceA);
    assertNoScopeTransactionArtifacts(workspaceB);

    await Promise.all([0, 1].map(() => runCliAsync([
      'packages', 'activate', 'mas',
      '--scope', 'workspace', '--target-workspace', sharedWorkspace,
    ], env)));
    const afterShared = JSON.parse(fs.readFileSync(lockFile, 'utf8'));
    const sharedMas = afterShared.packages.find((entry: any) => entry.package_id === 'mas');
    assert.equal(
      sharedMas.scope_materializations.filter(
        (entry: any) => path.resolve(entry.target_root) === path.resolve(sharedWorkspace),
      ).length,
      1,
    );
    assertNoScopeTransactionArtifacts(sharedWorkspace);
    assert.equal(fs.existsSync(lifecycleLockPath(stateDir)), true);

    const liveOwner = new DatabaseSync(lifecycleLockPath(stateDir));
    liveOwner.exec('PRAGMA journal_mode = WAL;');
    liveOwner.exec('BEGIN IMMEDIATE;');
    try {
      const contention = runCliFailure([
        'packages', 'activate', 'mas',
        '--scope', 'workspace', '--target-workspace', sharedWorkspace,
      ], env);
      assert.equal(contention.payload.error.code, 'runtime_state_lock_timeout');
      assert.equal(contention.payload.error.details.failure_code, 'agent_package_lifecycle_lock_timeout');
    } finally {
      liveOwner.exec('ROLLBACK;');
      liveOwner.close();
    }
    const recoveredActivation = await runCliAsync([
      'packages', 'activate', 'mas',
      '--scope', 'workspace', '--target-workspace', sharedWorkspace,
    ], env) as any;
    assert.equal(recoveredActivation.opl_agent_package_activation.launch_allowed, true);
    assert.equal(recoveredActivation.opl_agent_package_activation.status, 'already_activated');
  } finally {
    removeFixtureTree(root);
  }
});

test('use boundary never calls a hanging package channel and uses the installed carrier', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'opl-package-use-refresh-budget-'));
  const stateDir = path.join(root, 'state');
  const homeDir = path.join(root, 'home');
  const workspace = path.join(root, 'workspace');
  const hangingBin = path.join(root, 'hanging-bin');
  const curlMarker = path.join(root, 'curl-called');
  const provider = writeCapabilityProvider(path.join(root, 'provider'), '0.1.0');
  const consumer = writeMasConsumer(path.join(root, 'consumer'), provider, '0.1.0');
  const releaseSet = writeCapabilityCatalog(path.join(root, 'release-set'), [consumer, provider]);
  const env = {
    HOME: homeDir,
    CODEX_HOME: path.join(homeDir, '.codex'),
    OPL_STATE_DIR: stateDir,
    OPL_MODULE_SOURCE_MODE: 'package_channel',
    ...releaseSet.env,
  };

  try {
    bindMasWorkspace(workspace, env);
    await runCliAsync(['packages', 'install', 'mas'], env);
    fs.mkdirSync(hangingBin, { recursive: true });
    fs.writeFileSync(
      path.join(hangingBin, 'curl'),
      [
        '#!/bin/sh',
        `touch ${JSON.stringify(curlMarker)}`,
        'while :; do :; done',
        '',
      ].join('\n'),
      { mode: 0o755 },
    );

    const activated = await runCliAsync([
      'packages', 'activate', 'mas',
      '--scope', 'workspace', '--target-workspace', workspace,
    ], {
      ...env,
      PATH: `${hangingBin}:${env.PATH}`,
    }) as any;
    const activation = activated.opl_agent_package_activation;

    assert.equal(activation.launch_allowed, true);
    assert.equal(activation.operational_ready, true);
    assert.equal(activation.package_use_binding.source_selection, 'installed_package_lock');
    assert.equal(activation.package_use_binding.network_accessed, false);
    assert.equal(activation.package_use_binding.remote_dependency_policy, 'forbidden');
    assert.equal(fs.existsSync(curlMarker), false);

    assert.equal(
      fs.existsSync(path.join(stateDir, 'agent-package-lifecycle-ledger.json')),
      false,
    );
  } finally {
    removeFixtureTree(root);
  }
});

test('forged package cleanup paths fail closed without deleting outside or symlink canaries', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'opl-package-persisted-path-canary-'));
  const stateDir = path.join(root, 'state');
  const homeDir = path.join(root, 'home');
  const fixtureDir = path.join(root, 'fixture');
  const outsideRoot = path.join(root, 'outside-canary');
  const pluginSourcePath = createPluginSourceFixture();
  const manifestPath = path.join(fixtureDir, 'manifest.json');
  const lockFile = path.join(stateDir, 'agent-package-locks.json');
  const canaryPath = path.join(outsideRoot, 'canary.txt');
  const env = {
    HOME: homeDir,
    CODEX_HOME: path.join(homeDir, '.codex'),
    OPL_STATE_DIR: stateDir,
  };
  fs.mkdirSync(fixtureDir, { recursive: true });
  fs.mkdirSync(outsideRoot, { recursive: true });
  fs.writeFileSync(canaryPath, 'must remain\n');
  fs.writeFileSync(manifestPath, formatJsonPayload(agentPackageManifest({ pluginSourcePath })));

  try {
    await runCliAsync([
      'packages', 'install',
      '--manifest-url', pathToFileURL(manifestPath).href,
      '--trust-tier', 'third_party_verified',
    ], env);
    const installed = JSON.parse(fs.readFileSync(lockFile, 'utf8'));
    const packageLock = installed.packages.find(
      (entry: any) => entry.package_id === 'third.party.research',
    );
    packageLock.physical_surface.codex_plugin_cache_path = outsideRoot;
    fs.writeFileSync(lockFile, formatJsonPayload(installed));
    const outsideFailure = runCliFailure([
      'packages', 'uninstall', 'third.party.research',
    ], env);
    assert.equal(
      outsideFailure.payload.error.details.failure_code,
      'agent_package_persisted_path_unsafe',
    );
    assert.equal(fs.readFileSync(canaryPath, 'utf8'), 'must remain\n');

    const cacheRoot = path.join(homeDir, '.codex', 'plugins', 'cache');
    const linkedCachePath = path.join(cacheRoot, 'forged-link');
    fs.mkdirSync(cacheRoot, { recursive: true });
    fs.symlinkSync(outsideRoot, linkedCachePath, 'dir');
    packageLock.physical_surface.codex_plugin_cache_path = linkedCachePath;
    fs.writeFileSync(lockFile, formatJsonPayload(installed));
    const symlinkFailure = runCliFailure([
      'packages', 'uninstall', 'third.party.research',
    ], env);
    assert.equal(
      symlinkFailure.payload.error.details.failure_code,
      'agent_package_persisted_path_unsafe',
    );
    assert.equal(fs.lstatSync(linkedCachePath).isSymbolicLink(), true);
    assert.equal(fs.readFileSync(canaryPath, 'utf8'), 'must remain\n');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(pluginSourcePath, { recursive: true, force: true });
  }
});
