import { pathToFileURL } from 'node:url';

import {
  agentPackageManifest,
  assert,
  formatJsonPayload,
  fs,
  os,
  path,
  parseJsonText,
  removeFixtureTree,
  runCli,
  runCliFailure,
  test,
} from './helpers.ts';
import { writeManagedRuntimeSourceFixture } from './managed-runtime-source-fixture.ts';

const packageId = 'third.party.research';
const pluginSelector = 'third-party-research@fixture-carrier';

function installedOwnerDescriptor() {
  return {
    ...agentPackageManifest(),
    presentation: {
      display_name_i18n: { 'en-US': 'Third Party Research' },
      description_i18n: { 'en-US': 'Native descriptor retirement fixture.' },
      session_routing_summary_i18n: { 'en-US': 'Use the native carrier.' },
      home_shortcuts: [],
    },
  };
}

function writeFakeCodex(binary: string) {
  fs.writeFileSync(binary, `#!/usr/bin/env node
import fs from 'node:fs';
const args = process.argv.slice(2);
const stateFile = process.env.FIXTURE_PLUGIN_STATE;
const sourcePath = process.env.FIXTURE_PLUGIN_SOURCE;
let state = fs.existsSync(stateFile)
  ? JSON.parse(fs.readFileSync(stateFile, 'utf8')) // reuse-first: allow - disposable native CLI fixture reads only its own controlled state file.
  : { installed: false, version: '1.0.1', marketplaceSource: null };
if (args.join(' ') === 'plugin marketplace list --json') {
  process.stdout.write(JSON.stringify({
    marketplaces: state.marketplaceSource ? [{
      marketplaceSource: { sourceType: 'local', source: state.marketplaceSource },
    }] : [],
  }));
} else if (args[0] === 'plugin' && args[1] === 'marketplace' && args[2] === 'add') {
  state.marketplaceSource = args[3];
  fs.writeFileSync(stateFile, JSON.stringify(state));
  process.stdout.write('{}');
} else if (args[0] === 'plugin' && args[1] === 'add') {
  state.installed = true;
  fs.writeFileSync(stateFile, JSON.stringify(state));
  process.stdout.write('{}');
} else if (args.join(' ') === 'plugin list --json') {
  process.stdout.write(JSON.stringify({
    installed: state.installed ? [{
      pluginId: '${pluginSelector}',
      version: state.version,
      installed: true,
      enabled: true,
      source: { source: 'local', path: sourcePath },
      marketplaceSource: { sourceType: 'local', source: 'fixture-carrier' },
    }] : [],
    available: [],
  }));
} else {
  process.exitCode = 2;
}
`);
  fs.chmodSync(binary, 0o755);
}

function createLegacyThenNativeFixture(label: string, options: { runtimeSource?: boolean } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `opl-descriptor-retirement-${label}-`));
  const stateDir = path.join(root, 'opl-state');
  const codexHome = path.join(root, 'codex-home');
  const pluginSource = path.join(root, 'plugin-source');
  const pluginState = path.join(root, 'plugin-state.json');
  const binary = path.join(root, 'fake-codex.mjs');
  const manifestPath = path.join(root, 'manifest.json');
  fs.mkdirSync(path.join(pluginSource, 'skills', 'third-party-research'), { recursive: true });
  fs.mkdirSync(path.join(pluginSource, '.codex-plugin'), { recursive: true });
  fs.writeFileSync(
    path.join(pluginSource, 'skills', 'third-party-research', 'SKILL.md'),
    '# Third Party Research\n',
  );
  fs.writeFileSync(path.join(pluginSource, '.codex-plugin', 'plugin.json'), formatJsonPayload({
    name: 'third-party-research',
    version: '1.0.1',
    description: 'Descriptor retirement fixture.',
    skills: './skills/',
  }));
  const manifest = agentPackageManifest({
    pluginSourcePath: pluginSource,
    distributionPayload: null,
  });
  fs.writeFileSync(manifestPath, formatJsonPayload({
    ...manifest,
    ...(options.runtimeSource ? {
      runtime_source_carrier: {
        carrier_kind: 'opl_managed_module_source',
        module_id: 'redcube',
      },
    } : {}),
  }));
  writeFakeCodex(binary);
  const modulesRoot = path.join(root, 'modules');
  const runtimeSourceEnv = options.runtimeSource
    ? writeManagedRuntimeSourceFixture({
        root: path.join(root, 'runtime-source'),
        moduleId: 'redcube',
        repoName: 'redcube-ai',
        version: '1.0.1',
        sourceHeadSha: 'descriptor-owned-runtime-source-v1',
      })
    : {};
  const env = {
    HOME: root,
    CODEX_HOME: codexHome,
    OPL_STATE_DIR: stateDir,
    OPL_CODEX_PLUGIN_BIN: binary,
    OPL_MODULES_ROOT: modulesRoot,
    FIXTURE_PLUGIN_STATE: pluginState,
    FIXTURE_PLUGIN_SOURCE: pluginSource,
    ...runtimeSourceEnv,
  };
  const installed = runCli([
    'packages', 'install',
    '--manifest-url', pathToFileURL(manifestPath).toString(),
    '--trust-tier', 'third_party_verified',
  ], env) as any;
  assert.equal(installed.opl_agent_package_install.package_lock.package_id, packageId);
  fs.writeFileSync(
    path.join(pluginSource, 'opl-package.json'),
    formatJsonPayload(installedOwnerDescriptor()),
  );
  fs.writeFileSync(pluginState, JSON.stringify({
    installed: true,
    version: '1.0.1',
    marketplaceSource: 'fixture-carrier',
  }));
  return {
    root,
    stateDir,
    pluginSource,
    modulesRoot,
    env,
    lockPath: path.join(stateDir, 'agent-package-locks.json'),
  };
}

test('native-confirmed repair retires a package-created managed runtime source with its legacy lock', () => {
  const fixture = createLegacyThenNativeFixture('runtime-source', { runtimeSource: true });
  try {
    const originalIndex = parseJsonText(fs.readFileSync(fixture.lockPath, 'utf8')) as any;
    const originalLock = originalIndex.packages.find((entry: any) => entry.package_id === packageId);
    const runtimeSourcePath = originalLock.managed_runtime_source.checkout_path;
    const transactionRoot = path.join(fixture.stateDir, 'agent-package-runtime-transactions');
    assert.equal(originalLock.managed_runtime_source.ownership, 'package_created');
    assert.equal(fs.existsSync(runtimeSourcePath), true);

    runCli(['packages', 'repair', packageId, '--dry-run'], fixture.env);
    assert.equal(fs.existsSync(fixture.lockPath), true);
    assert.equal(fs.existsSync(runtimeSourcePath), true);
    assert.deepEqual(fs.existsSync(transactionRoot) ? fs.readdirSync(transactionRoot) : [], []);

    runCli(['packages', 'repair', packageId], fixture.env);
    assert.equal(fs.existsSync(fixture.lockPath), false);
    assert.equal(fs.existsSync(runtimeSourcePath), false);
    assert.deepEqual(fs.existsSync(transactionRoot) ? fs.readdirSync(transactionRoot) : [], []);
    assert.equal(fs.existsSync(path.join(fixture.pluginSource, 'opl-package.json')), true);
  } finally {
    removeFixtureTree(fixture.root);
  }
});

test('native-confirmed repair retains a preexisting adopted runtime source and its legacy lock', () => {
  const fixture = createLegacyThenNativeFixture('preexisting-runtime-source', { runtimeSource: true });
  try {
    const index = parseJsonText(fs.readFileSync(fixture.lockPath, 'utf8')) as any;
    const lock = index.packages.find((entry: any) => entry.package_id === packageId);
    const runtimeSourcePath = lock.managed_runtime_source.checkout_path;
    lock.managed_runtime_source.ownership = 'preexisting_adopted';
    fs.writeFileSync(fixture.lockPath, formatJsonPayload(index));
    const before = fs.readFileSync(fixture.lockPath);

    runCli(['packages', 'repair', packageId], fixture.env);
    assert.deepEqual(fs.readFileSync(fixture.lockPath), before);
    assert.equal(fs.existsSync(runtimeSourcePath), true);
    assert.equal(fs.existsSync(path.join(fixture.pluginSource, 'opl-package.json')), true);
  } finally {
    removeFixtureTree(fixture.root);
  }
});

test('explicit native-confirmed repair retires descriptor-owned lock and strips legacy LKG state', () => {
  const fixture = createLegacyThenNativeFixture('success');
  try {
    const originalIndex = parseJsonText(fs.readFileSync(fixture.lockPath, 'utf8')) as any;
    const originalLock = originalIndex.packages.find((entry: any) => entry.package_id === packageId);
    originalIndex.last_known_good_transactions = [{
      root_package_id: packageId,
      transaction_id: 'descriptor-owned-only',
      closure_digest: 'descriptor-owned-only',
      package_locks: [originalLock],
    }];
    fs.writeFileSync(fixture.lockPath, formatJsonPayload(originalIndex));
    const originalLockBytes = fs.readFileSync(fixture.lockPath);
    const legacyLedgerPath = path.join(fixture.stateDir, 'agent-package-lifecycle-ledger.json');

    runCli(['packages', 'list'], fixture.env);
    runCli(['packages', 'status', '--package-id', packageId], fixture.env);
    assert.deepEqual(fs.readFileSync(fixture.lockPath), originalLockBytes);
    assert.equal(fs.existsSync(legacyLedgerPath), false);

    const preview = runCli(['packages', 'repair', packageId, '--dry-run'], fixture.env) as any;
    assert.equal(Object.hasOwn(preview.opl_agent_package_repair, 'legacy_state_retirement'), false);
    assert.deepEqual(fs.readFileSync(fixture.lockPath), originalLockBytes);
    assert.equal(fs.existsSync(legacyLedgerPath), false);

    const repaired = runCli(['packages', 'repair', packageId], fixture.env) as any;
    assert.equal(repaired.opl_agent_package_repair.status, 'repaired');
    assert.equal(Object.hasOwn(repaired.opl_agent_package_repair, 'legacy_state_retirement'), false);
    assert.equal(Object.hasOwn(repaired.opl_agent_package_repair, 'opl_private_state_writes'), false);

    assert.equal(fs.existsSync(fixture.lockPath), false);
    assert.equal(fs.existsSync(legacyLedgerPath), false);
    assert.equal(fs.existsSync(path.join(fixture.pluginSource, 'opl-package.json')), true);
  } finally {
    removeFixtureTree(fixture.root);
  }
});

test('legacy LKG bytes are ignored on read and stripped by the next native-confirmed repair', () => {
  const fixture = createLegacyThenNativeFixture('mixed-lkg');
  try {
    const index = parseJsonText(fs.readFileSync(fixture.lockPath, 'utf8')) as any;
    const targetLock = index.packages.find((entry: any) => entry.package_id === packageId);
    const legacyLock = {
      ...targetLock,
      package_id: 'legacy.consumer',
      lock_ref: 'opl-agent-package-lock:legacy.consumer',
      action_receipt_id: 'opl-agent-package-receipt:legacy.consumer',
      resolved_dependencies: [],
    };
    index.packages.push(legacyLock);
    index.last_known_good_transactions = [{
      root_package_id: 'legacy.consumer',
      transaction_id: 'mixed-history',
      closure_digest: 'mixed-history',
      package_locks: [targetLock, legacyLock],
    }];
    fs.writeFileSync(fixture.lockPath, formatJsonPayload(index));

    const repaired = runCli(['packages', 'repair', packageId], fixture.env) as any;
    assert.equal(Object.hasOwn(repaired.opl_agent_package_repair, 'legacy_state_retirement'), false);

    const nextIndex = parseJsonText(fs.readFileSync(fixture.lockPath, 'utf8')) as any;
    assert.equal(nextIndex.packages.some((entry: any) => entry.package_id === packageId), false);
    assert.equal(nextIndex.packages.some((entry: any) => entry.package_id === 'legacy.consumer'), true);
    assert.equal(
      Object.hasOwn(
        nextIndex.packages.find((entry: any) => entry.package_id === 'legacy.consumer'),
        'action_receipt_id',
      ),
      false,
    );
    assert.equal('last_known_good_transactions' in nextIndex, false);
    assert.equal(fs.existsSync(targetLock.physical_surface.codex_plugin_cache_path), true);
  } finally {
    removeFixtureTree(fixture.root);
  }
});

test('dependent locks and native source overlap retain legacy state without deletion', () => {
  const fixture = createLegacyThenNativeFixture('retained');
  try {
    const index = parseJsonText(fs.readFileSync(fixture.lockPath, 'utf8')) as any;
    const targetLock = index.packages.find((entry: any) => entry.package_id === packageId);
    index.packages.push({
      ...targetLock,
      package_id: 'legacy.consumer',
      lock_ref: 'opl-agent-package-lock:legacy.consumer',
      action_receipt_id: 'opl-agent-package-receipt:legacy.consumer',
      resolved_dependencies: [{
        package_id: packageId,
        required: true,
        dependency_kind: 'hard_runtime_dependency',
        version_requirement: '>=1.0.0',
        capability_abi: 'fixture.v1',
        required_export_ids: [],
        required_module_ids: [],
        installed_version: '1.0.1',
        manifest_url: targetLock.manifest_url,
        manifest_sha256: targetLock.manifest_sha256,
        content_digest: targetLock.content_digest,
        package_lock_ref: targetLock.lock_ref,
      }],
    });
    fs.writeFileSync(fixture.lockPath, formatJsonPayload(index));
    const before = fs.readFileSync(fixture.lockPath);

    const dependent = runCli(['packages', 'repair', packageId], fixture.env) as any;
    assert.equal(Object.hasOwn(dependent.opl_agent_package_repair, 'legacy_state_retirement'), false);
    assert.deepEqual(fs.readFileSync(fixture.lockPath), before);

    const sourceProtectedIndex = parseJsonText(before.toString()) as any;
    sourceProtectedIndex.packages = [targetLock];
    sourceProtectedIndex.packages[0].physical_surface.codex_plugin_cache_path = fixture.pluginSource;
    fs.writeFileSync(fixture.lockPath, formatJsonPayload(sourceProtectedIndex));
    const sourceProtectedBytes = fs.readFileSync(fixture.lockPath);
    const sourceProtected = runCli(['packages', 'repair', packageId], fixture.env) as any;
    assert.equal(Object.hasOwn(sourceProtected.opl_agent_package_repair, 'legacy_state_retirement'), false);
    assert.deepEqual(fs.readFileSync(fixture.lockPath), sourceProtectedBytes);
    assert.equal(fs.existsSync(path.join(fixture.pluginSource, 'opl-package.json')), true);
  } finally {
    removeFixtureTree(fixture.root);
  }
});

test('corrupt legacy authority fails closed after native readback without rewriting bytes', () => {
  const fixture = createLegacyThenNativeFixture('corrupt');
  try {
    const corruptLockBytes = Buffer.from(
      '{"surface_kind":"opl_agent_package_lock_index","packages":[',
    );
    fs.writeFileSync(fixture.lockPath, corruptLockBytes);

    const failure = runCliFailure(['packages', 'repair', packageId], fixture.env);
    assert.equal(
      failure.payload.error.details.failure_code,
      'agent_package_lock_authority_corrupt',
    );
    assert.deepEqual(fs.readFileSync(fixture.lockPath), corruptLockBytes);
    assert.equal(fs.existsSync(path.join(fixture.stateDir, 'agent-package-lifecycle-ledger.json')), false);
    assert.equal(fs.existsSync(path.join(fixture.pluginSource, 'opl-package.json')), true);
  } finally {
    removeFixtureTree(fixture.root);
  }
});
