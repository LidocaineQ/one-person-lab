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
  test,
} from './helpers.ts';

const packageId = 'third.party.research';
const pluginSelector = 'third-party-research@fixture-carrier';
const ownerPackageVersion = '1.2.3';

function installedOwnerDescriptor() {
  return {
    ...agentPackageManifest(),
    presentation: {
      display_name_i18n: { 'en-US': 'Third Party Research' },
      description_i18n: { 'en-US': 'Native descriptor legacy-state isolation fixture.' },
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
  : { installed: false, version: '${ownerPackageVersion}', marketplaceSource: null };
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
} else if (args[0] === 'plugin' && args[1] === 'marketplace' && args[2] === 'upgrade') {
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
  fs.mkdirSync(path.join(pluginSource, 'skills', 'third-party-research'), { recursive: true });
  fs.mkdirSync(path.join(pluginSource, '.codex-plugin'), { recursive: true });
  fs.writeFileSync(
    path.join(pluginSource, 'skills', 'third-party-research', 'SKILL.md'),
    '# Third Party Research\n',
  );
  fs.writeFileSync(path.join(pluginSource, '.codex-plugin', 'plugin.json'), formatJsonPayload({
    name: 'third-party-research',
    version: ownerPackageVersion,
    description: 'Descriptor retirement fixture.',
    skills: './skills/',
  }));
  writeFakeCodex(binary);
  const modulesRoot = path.join(root, 'modules');
  const runtimeSourcePath = path.join(modulesRoot, 'redcube-ai');
  if (options.runtimeSource) {
    fs.mkdirSync(runtimeSourcePath, { recursive: true });
    fs.writeFileSync(path.join(runtimeSourcePath, 'runtime.txt'), 'legacy runtime bytes\n');
  }
  const env = {
    HOME: root,
    CODEX_HOME: codexHome,
    OPL_STATE_DIR: stateDir,
    OPL_CODEX_PLUGIN_BIN: binary,
    OPL_MODULES_ROOT: modulesRoot,
    FIXTURE_PLUGIN_STATE: pluginState,
    FIXTURE_PLUGIN_SOURCE: pluginSource,
  };
  fs.writeFileSync(
    path.join(pluginSource, 'opl-package.json'),
    formatJsonPayload(installedOwnerDescriptor()),
  );
  fs.writeFileSync(pluginState, JSON.stringify({
    installed: true,
    version: ownerPackageVersion,
    marketplaceSource: 'fixture-carrier',
  }));
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(path.join(stateDir, 'agent-package-locks.json'), formatJsonPayload({
    surface_kind: 'opl_agent_package_lock_index',
    version: 'opl-agent-package-lock-index.v1',
    packages: [{
      package_id: packageId,
      package_version: ownerPackageVersion,
      lock_ref: `opl-agent-package-lock:${packageId}`,
      manifest_url: 'file:///retired/manifest.json',
      manifest_sha256: 'a'.repeat(64),
      content_digest: `sha256:${'b'.repeat(64)}`,
      resolved_dependencies: [],
      physical_surface: {
        plugin_id: 'third-party-research',
        marketplace_id: 'fixture-carrier',
        codex_plugin_cache_path: pluginSource,
      },
      ...(options.runtimeSource ? {
        managed_runtime_source: {
          surface_kind: 'opl_agent_package_managed_runtime_source',
          status: 'current',
          carrier_kind: 'opl_managed_module_source',
          module_id: 'redcube',
          checkout_path: runtimeSourcePath,
          ownership: 'package_created',
          source_mode: 'package_channel',
        },
      } : {}),
    }],
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

test('native-confirmed repair leaves a package-created legacy runtime source and lock inert', () => {
  const fixture = createLegacyThenNativeFixture('runtime-source', { runtimeSource: true });
  try {
    const originalIndex = parseJsonText(fs.readFileSync(fixture.lockPath, 'utf8')) as any;
    const originalLock = originalIndex.packages.find((entry: any) => entry.package_id === packageId);
    const originalLockBytes = fs.readFileSync(fixture.lockPath);
    const runtimeSourcePath = originalLock.managed_runtime_source.checkout_path;
    const transactionRoot = path.join(fixture.stateDir, 'agent-package-runtime-transactions');
    assert.equal(originalLock.managed_runtime_source.ownership, 'package_created');
    assert.equal(fs.existsSync(runtimeSourcePath), true);

    runCli(['packages', 'repair', packageId, '--dry-run'], fixture.env);
    assert.equal(fs.existsSync(fixture.lockPath), true);
    assert.equal(fs.existsSync(runtimeSourcePath), true);
    assert.deepEqual(fs.existsSync(transactionRoot) ? fs.readdirSync(transactionRoot) : [], []);

    runCli(['packages', 'repair', packageId], fixture.env);
    assert.deepEqual(fs.readFileSync(fixture.lockPath), originalLockBytes);
    assert.equal(fs.existsSync(runtimeSourcePath), true);
    assert.deepEqual(fs.existsSync(transactionRoot) ? fs.readdirSync(transactionRoot) : [], []);
    assert.equal(fs.existsSync(path.join(fixture.pluginSource, 'opl-package.json')), true);
  } finally {
    removeFixtureTree(fixture.root);
  }
});

test('explicit native-confirmed repair leaves descriptor-owned lock and legacy LKG state inert', () => {
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

    assert.deepEqual(fs.readFileSync(fixture.lockPath), originalLockBytes);
    assert.equal(fs.existsSync(legacyLedgerPath), false);
    assert.equal(fs.existsSync(path.join(fixture.pluginSource, 'opl-package.json')), true);
  } finally {
    removeFixtureTree(fixture.root);
  }
});

test('corrupt legacy authority cannot block native repair or rewrite compatibility bytes', () => {
  const fixture = createLegacyThenNativeFixture('corrupt');
  try {
    const corruptLockBytes = Buffer.from(
      '{"surface_kind":"opl_agent_package_lock_index","packages":[',
    );
    fs.writeFileSync(fixture.lockPath, corruptLockBytes);

    const repaired = runCli(['packages', 'repair', packageId], fixture.env) as any;
    assert.equal(repaired.opl_agent_package_repair.status, 'repaired');
    assert.equal(Object.hasOwn(repaired.opl_agent_package_repair, 'legacy_state_retirement'), false);
    assert.deepEqual(fs.readFileSync(fixture.lockPath), corruptLockBytes);
    assert.equal(fs.existsSync(path.join(fixture.stateDir, 'agent-package-lifecycle-ledger.json')), false);
    assert.equal(fs.existsSync(path.join(fixture.pluginSource, 'opl-package.json')), true);
  } finally {
    removeFixtureTree(fixture.root);
  }
});
