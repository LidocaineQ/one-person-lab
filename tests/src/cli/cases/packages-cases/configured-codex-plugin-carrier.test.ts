import { pathToFileURL } from 'node:url';

import {
  agentPackageManifest,
  assert,
  formatJsonPayload,
  fs,
  os,
  path,
  removeFixtureTree,
  registryPayload,
  runCli,
  runCliFailure,
  test,
} from './helpers.ts';
import {
  runConfiguredCodexPluginCarrier,
  type CodexPluginCommandRunner,
} from '../../../../../src/modules/connect/agent-package-registry-parts/configured-codex-plugin-carrier.ts';

const packageId = 'third.party.research';
const pluginSelector = 'third-party-research@fixture-carrier';
const descriptor = {
  packageId,
  carrier: {
    kind: 'codex_plugin_manager' as const,
    pluginId: pluginSelector,
    marketplaceSource: null,
  },
  executor: {
    route: 'codex_cli' as const,
    requiredSkillIds: ['third-party-research'],
  },
  publicationRef: 'oci://example.invalid/third-party-research:latest-stable',
};

function configuredManifest(marketplaceSource: string | null = null) {
  const manifest = agentPackageManifest();
  manifest.codex_surface = {
    ...manifest.codex_surface,
    configured_codex_plugin_carrier: {
      kind: 'codex_plugin_manager',
      plugin_selector: pluginSelector,
      executor_route: 'codex_cli',
      publication_ref: descriptor.publicationRef,
      ...(marketplaceSource ? { marketplace_source: marketplaceSource } : {}),
    },
  } as typeof manifest.codex_surface & Record<string, unknown>;
  return manifest;
}

function pluginList(entries: Array<{
  pluginId: string;
  version: string;
  sourcePath: string;
  marketplaceSource: string;
}>) {
  return JSON.stringify({
    installed: entries.map((entry) => ({
      pluginId: entry.pluginId,
      version: entry.version,
      installed: true,
      enabled: true,
      source: { source: 'local', path: entry.sourcePath },
      marketplaceSource: { sourceType: 'local', source: entry.marketplaceSource },
    })),
    available: [],
  });
}

function writePluginSource(root: string, marker: string) {
  fs.mkdirSync(path.join(root, 'skills', 'third-party-research'), { recursive: true });
  fs.writeFileSync(
    path.join(root, 'skills', 'third-party-research', 'SKILL.md'),
    `# Third Party Research\n\n${marker}\n`,
  );
}

test('configured Codex carrier exposes exact identity and fails closed on duplicate source precedence', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'opl-configured-carrier-identity-'));
  const selectedSource = path.join(root, 'selected');
  const duplicateSource = path.join(root, 'duplicate');
  writePluginSource(selectedSource, 'selected');
  writePluginSource(duplicateSource, 'duplicate');
  const runner: CodexPluginCommandRunner = () => ({
    status: 0,
    stdout: pluginList([
      {
        pluginId: pluginSelector,
        version: '1.0.1',
        sourcePath: selectedSource,
        marketplaceSource: 'fixture-carrier',
      },
      {
        pluginId: 'third-party-research@historical-carrier',
        version: '1.0.1',
        sourcePath: duplicateSource,
        marketplaceSource: 'historical-carrier',
      },
    ]),
    stderr: '',
    error: null,
  });
  try {
    const readback = runConfiguredCodexPluginCarrier({ descriptor, action: 'list', runner });
    assert.equal(readback.status, 'installed');
    assert.equal(readback.carrier.precedence, 'ambiguous_same_plugin_name');
    assert.equal(readback.executor.status, 'attention_needed');
    assert.equal(readback.reason, 'configured_native_carrier_source_ambiguous');
    assert.equal(readback.installed_version, null);
    assert.equal(readback.plugin_source_path, null);
    assert.equal(readback.carrier.observed_sources.length, 2);
    assert.notEqual(
      readback.carrier.observed_sources[0].source_tree_sha256,
      readback.carrier.observed_sources[1].source_tree_sha256,
    );
    assert.equal(readback.native_action_dispatched, true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('configured Codex carrier keeps native failures Package-local and rejects selector injection', () => {
  let calls = 0;
  assert.throws(
    () => runConfiguredCodexPluginCarrier({
      descriptor,
      action: 'update',
      runner: () => {
        calls += 1;
        return {
          status: 1,
          stdout: '',
          stderr: 'fixture failure',
          error: null,
        };
      },
    }),
    (error: any) => error?.details?.failure_code === 'configured_codex_plugin_carrier_action_failed'
      && error?.details?.package_id === packageId,
  );
  assert.equal(calls, 1);
  assert.throws(
    () => runConfiguredCodexPluginCarrier({
      descriptor: {
        ...descriptor,
        carrier: {
          kind: 'codex_plugin_manager',
          pluginId: '--help',
          marketplaceSource: null,
        },
      },
      action: 'install',
      runner: () => {
        calls += 1;
        return { status: 0, stdout: pluginList([]), stderr: '', error: null };
      },
    }),
    (error: any) => error?.details?.failure_code
      === 'configured_codex_plugin_carrier_descriptor_invalid',
  );
  assert.equal(calls, 1);
});

test('configured Codex carrier reports an unexpected same-name source without selecting it', () => {
  const readback = runConfiguredCodexPluginCarrier({
    descriptor,
    action: 'list',
    runner: () => ({
      status: 0,
      stdout: pluginList([{
        pluginId: 'third-party-research@historical-carrier',
        version: '1.0.1',
        sourcePath: '/missing/historical-carrier',
        marketplaceSource: 'historical-carrier',
      }]),
      stderr: '',
      error: null,
    }),
  });
  assert.equal(readback.status, 'not_installed');
  assert.equal(readback.carrier.precedence, 'unexpected_same_plugin_name');
  assert.equal(readback.executor.status, 'attention_needed');
  assert.equal(readback.reason, 'configured_native_carrier_unexpected_source_present');
  assert.equal(readback.carrier.observed_sources.length, 1);
});

test('configured Codex carrier reports a declared selector without a physical source as unavailable', () => {
  const readback = runConfiguredCodexPluginCarrier({
    descriptor,
    action: 'list',
    runner: () => ({
      status: 0,
      stdout: pluginList([]),
      stderr: '',
      error: null,
    }),
  });
  assert.equal(readback.status, 'physical_unavailable');
  assert.equal(readback.carrier.precedence, 'not_present');
  assert.equal(readback.executor.status, 'attention_needed');
  assert.equal(readback.reason, 'native_carrier_reports_not_installed');
  assert.equal(readback.carrier.observed_sources.length, 0);
});

function writeFakeCodex(binary: string) {
  fs.writeFileSync(binary, `#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
const args = process.argv.slice(2);
const stateFile = process.env.FIXTURE_PLUGIN_STATE;
const sourcePath = process.env.FIXTURE_PLUGIN_SOURCE;
let state = fs.existsSync(stateFile) ? JSON.parse(fs.readFileSync(stateFile, 'utf8')) : { installed: false, version: '1.0.0', marketplaceSource: null }; // reuse-first: disposable native CLI fixture owns this transient state.
const configPath = path.join(process.env.CODEX_HOME, 'config.toml');
const enabled = !fs.existsSync(configPath) || !/\\[plugins\\."third-party-research@fixture-carrier"\\][\\s\\S]*?enabled = false/.test(fs.readFileSync(configPath, 'utf8'));
if (args.join(' ') === 'plugin marketplace list --json') {
  process.stdout.write(JSON.stringify({
    marketplaces: state.marketplaceSource ? [{
      marketplaceSource: { sourceType: 'local', source: state.marketplaceSource },
    }] : [],
  }));
} else if (args[0] === 'plugin' && args[1] === 'marketplace' && args[2] === 'add') {
  state = { ...state, marketplaceSource: args[3] };
  fs.writeFileSync(stateFile, JSON.stringify(state));
  process.stdout.write(JSON.stringify({ status: 'ok' }));
} else if (args[0] === 'plugin' && args[1] === 'add') {
  if (!state.marketplaceSource) process.exitCode = 3;
  state = { installed: true, version: state.version === '1.0.0' ? '1.0.1' : state.version };
  fs.writeFileSync(stateFile, JSON.stringify(state));
  process.stdout.write(JSON.stringify({ status: 'ok' }));
} else if (args[0] === 'plugin' && args[1] === 'remove') {
  state = { ...state, installed: false };
  fs.writeFileSync(stateFile, JSON.stringify(state));
  process.stdout.write(JSON.stringify({ status: 'ok' }));
} else if (args.join(' ') === 'plugin list --json') {
  process.stdout.write(JSON.stringify({
    installed: state.installed ? [{
      pluginId: '${pluginSelector}',
      version: state.version,
      installed: true,
      enabled,
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

test('configured Codex carrier toggles only its native plugin table and verifies fresh enabled state', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'opl-configured-carrier-toggle-'));
  const binary = path.join(root, 'fake-codex');
  const configHome = path.join(root, 'codex-home');
  const stateDir = path.join(root, 'opl-state');
  const stateFile = path.join(root, 'plugin-state.json');
  const sourcePath = path.join(root, 'plugin-source');
  const configPath = path.join(configHome, 'config.toml');
  const env = {
    CODEX_HOME: configHome,
    FIXTURE_PLUGIN_SOURCE: sourcePath,
    FIXTURE_PLUGIN_STATE: stateFile,
    OPL_STATE_DIR: stateDir,
  };
  try {
    writePluginSource(sourcePath, 'toggle');
    writeFakeCodex(binary);
    fs.mkdirSync(configHome, { recursive: true });
    fs.writeFileSync(configPath, [
      'model = "user-model"',
      '',
      '[plugins."unrelated@fixture-carrier"]',
      'enabled = true',
      '',
      '[plugins."third-party-research@fixture-carrier"]',
      'enabled = true',
      'custom = "preserved"',
      '',
    ].join('\n'), 'utf8');
    fs.writeFileSync(stateFile, JSON.stringify({
      installed: true,
      version: '1.0.1',
      marketplaceSource: 'fixture-carrier',
    }), 'utf8');

    const disabled = runConfiguredCodexPluginCarrier({
      descriptor,
      action: 'disable',
      binary,
      env,
    });
    assert.equal(disabled.status, 'installed');
    assert.equal(disabled.enabled, false);
    assert.equal(disabled.executor.status, 'attention_needed');
    assert.equal(disabled.native_command.join(' '), 'plugin list --json');
    assert.equal(disabled.native_action_dispatched, false);
    const disabledConfig = fs.readFileSync(configPath, 'utf8');
    assert.match(disabledConfig, /model = "user-model"/);
    assert.match(disabledConfig, /\[plugins\."unrelated@fixture-carrier"\]\nenabled = true/);
    assert.match(disabledConfig, /\[plugins\."third-party-research@fixture-carrier"\]\nenabled = false\ncustom = "preserved"/);

    const enabled = runConfiguredCodexPluginCarrier({
      descriptor,
      action: 'enable',
      binary,
      env,
    });
    assert.equal(enabled.status, 'installed');
    assert.equal(enabled.enabled, true);
    assert.equal(enabled.executor.status, 'callable');
    assert.match(fs.readFileSync(configPath, 'utf8'), /\[plugins\."third-party-research@fixture-carrier"\]\nenabled = true\ncustom = "preserved"/);
    assert.equal(fs.existsSync(stateDir), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('configured Codex carrier refuses to overwrite concurrent native config changes', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'opl-configured-carrier-toggle-conflict-'));
  const binary = path.join(root, 'fake-codex');
  const configHome = path.join(root, 'codex-home');
  const stateFile = path.join(root, 'plugin-state.json');
  const sourcePath = path.join(root, 'plugin-source');
  const configPath = path.join(configHome, 'config.toml');
  const env = {
    CODEX_HOME: configHome,
    FIXTURE_PLUGIN_SOURCE: sourcePath,
    FIXTURE_PLUGIN_STATE: stateFile,
  };
  try {
    writePluginSource(sourcePath, 'toggle-conflict');
    writeFakeCodex(binary);
    fs.mkdirSync(configHome, { recursive: true });
    fs.writeFileSync(configPath, [
      'model = "user-model"',
      '',
      '[plugins."third-party-research@fixture-carrier"]',
      'enabled = true',
      '',
    ].join('\n'), 'utf8');
    fs.writeFileSync(stateFile, JSON.stringify({
      installed: true,
      version: '1.0.1',
      marketplaceSource: 'fixture-carrier',
    }), 'utf8');

    assert.throws(
      () => runConfiguredCodexPluginCarrier({
        descriptor,
        action: 'disable',
        binary,
        env,
        beforeConfigReplace: () => fs.appendFileSync(configPath, 'developer_mode = true\n', 'utf8'),
      }),
      (error: any) => error?.details?.failure_code
        === 'configured_codex_plugin_carrier_config_apply_conflict',
    );
    const config = fs.readFileSync(configPath, 'utf8');
    assert.match(config, /enabled = true/);
    assert.match(config, /developer_mode = true/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('configured Codex carrier ensures a descriptor-owned marketplace before native add', () => {
  const calls: string[][] = [];
  let marketplaceConfigured = false;
  let installed = false;
  const carrier = runConfiguredCodexPluginCarrier({
    descriptor: {
      ...descriptor,
      carrier: {
        ...descriptor.carrier,
        marketplaceSource: 'owner/third-party-marketplace@release',
      },
    },
    action: 'install',
    runner: ({ args }) => {
      calls.push(args);
      if (args.join(' ') === 'plugin marketplace list --json') {
        return {
          status: 0,
          stdout: JSON.stringify({
            marketplaces: marketplaceConfigured ? [{
              marketplaceSource: {
                source: 'owner/third-party-marketplace@release',
              },
            }] : [],
          }),
          stderr: '',
          error: null,
        };
      }
      if (args.join(' ') === 'plugin marketplace add owner/third-party-marketplace@release --json') {
        marketplaceConfigured = true;
        return { status: 0, stdout: JSON.stringify({ status: 'ok' }), stderr: '', error: null };
      }
      if (args.join(' ') === `plugin add ${pluginSelector} --json`) {
        installed = true;
        return { status: 0, stdout: JSON.stringify({ status: 'ok' }), stderr: '', error: null };
      }
      if (args.join(' ') === 'plugin list --json') {
        return {
          status: 0,
          stdout: installed ? pluginList([{
            pluginId: pluginSelector,
            version: '1.0.1',
            sourcePath: '/fixture/source',
            marketplaceSource: 'third-party-marketplace',
          }]) : pluginList([]),
          stderr: '',
          error: null,
        };
      }
      return { status: 1, stdout: '', stderr: `unexpected command: ${args.join(' ')}`, error: null };
    },
  });
  assert.equal(carrier.status, 'installed');
  assert.deepEqual(calls, [
    ['plugin', 'marketplace', 'list', '--json'],
    ['plugin', 'marketplace', 'add', 'owner/third-party-marketplace@release', '--json'],
    ['plugin', 'add', pluginSelector, '--json'],
    ['plugin', 'list', '--json'],
  ]);
});

test('owner descriptor lifecycle and read-model use the native carrier without OPL private state writes', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'opl-configured-carrier-generic-'));
  const stateDir = path.join(root, 'opl-state');
  const manifestPath = path.join(root, 'manifest.json');
  const binary = path.join(root, 'fake-codex.mjs');
  const pluginState = path.join(root, 'plugin-state.json');
  const pluginSource = path.join(root, 'plugin-source');
  const manifestUrl = pathToFileURL(manifestPath).toString();
  writePluginSource(pluginSource, 'callable');
  fs.writeFileSync(
    path.join(pluginSource, 'opl-package.json'),
    // The installed owner descriptor deliberately has no legacy configured
    // carrier block. Subsequent actions must derive the native adapter from
    // the fresh installed carrier, not a Framework discovery cache.
    formatJsonPayload(agentPackageManifest()),
  );
  writeFakeCodex(binary);
  fs.writeFileSync(manifestPath, formatJsonPayload(configuredManifest('fixture-carrier')));
  const env = {
    HOME: root,
    CODEX_HOME: path.join(root, 'codex-home'),
    OPL_STATE_DIR: stateDir,
    OPL_CODEX_PLUGIN_BIN: binary,
    FIXTURE_PLUGIN_STATE: pluginState,
    FIXTURE_PLUGIN_SOURCE: pluginSource,
  };
  const assertNoPrivateState = () => {
    assert.equal(fs.existsSync(path.join(stateDir, 'agent-package-registry-cache.json')), false);
    assert.equal(fs.existsSync(path.join(stateDir, 'agent-package-locks.json')), false);
    assert.equal(fs.existsSync(path.join(stateDir, 'agent-package-lifecycle-ledger.json')), false);
  };
  try {
    const install = runCli([
      'packages', 'install', packageId,
      '--manifest-url', manifestUrl,
      '--trust-tier', 'third_party_verified',
    ], env) as any;
    assert.equal(install.opl_agent_package_install.status, 'installed');
    assert.equal(install.opl_agent_package_install.package_id, packageId);
    assert.equal(install.opl_agent_package_install.package_lock, null);
    assert.equal(install.opl_agent_package_install.lifecycle_receipt, null);
    assert.deepEqual(
      Object.values(install.opl_agent_package_install.opl_private_state_writes),
      [false, false, false, false, false, false],
    );
    assertNoPrivateState();

    const status = runCli(['packages', 'status', '--package-id', packageId], env) as any;
    assert.equal(status.opl_agent_package_status.status, 'available');
    assert.equal(status.opl_agent_package_status.operational_ready, true);
    assert.equal(status.opl_agent_package_status.launch_allowed, true);
    assert.equal(status.opl_agent_package_status.installed_packages.length, 0);
    assert.equal(status.opl_agent_package_status.configured_carrier.status, 'installed');
    assertNoPrivateState();

    const list = runCli(['packages', 'list', '--detail', 'full'], env) as any;
    const entry = list.opl_agent_packages.directory.entries.find(
      (candidate: any) => candidate.package_id === packageId,
    );
    assert.equal(entry.installed, true);
    assert.equal(entry.configured_carrier.carrier.precedence, 'exact_single_source');
    assert.equal(entry.legacy_private_lifecycle_state_present, false);
    assertNoPrivateState();

    for (const action of ['update', 'repair']) {
      const readback = runCli(['packages', action, packageId], env) as any;
      assert.equal(readback[`opl_agent_package_${action}`].package_lock, null);
      assert.equal(readback[`opl_agent_package_${action}`].lifecycle_receipt, null);
      assertNoPrivateState();
    }
    const uninstall = runCli(['packages', 'uninstall', packageId], env) as any;
    assert.equal(uninstall.opl_agent_package_uninstall.status, 'uninstalled');
    assert.equal(
      uninstall.opl_agent_package_uninstall.configured_carrier.status,
      'physical_unavailable',
    );
    const afterRemoval = runCli(['packages', 'status', '--package-id', packageId], env) as any;
    assert.equal(afterRemoval.opl_agent_package_status.status, 'not_installed');
    assert.equal(afterRemoval.opl_agent_package_status.installed_package_count, 0);
    assert.equal(afterRemoval.opl_agent_package_status.operational_ready, false);
    assert.equal(afterRemoval.opl_agent_package_status.launch_allowed, false);
    assert.equal(afterRemoval.opl_agent_package_status.configured_carrier, null);
    assertNoPrivateState();
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function writeNativeMarketplace(root: string, version: string) {
  const pluginRoot = path.join(root, 'plugins', 'third-party-research');
  fs.mkdirSync(path.join(root, '.agents', 'plugins'), { recursive: true });
  fs.mkdirSync(path.join(pluginRoot, '.codex-plugin'), { recursive: true });
  writePluginSource(pluginRoot, 'callable');
  fs.writeFileSync(path.join(root, '.agents', 'plugins', 'marketplace.json'), formatJsonPayload({
    name: 'fixture-carrier',
    plugins: [{
      name: 'third-party-research',
      source: { source: 'local', path: './plugins/third-party-research' },
      policy: { installation: 'AVAILABLE', authentication: 'ON_INSTALL' },
    }],
  }));
  fs.writeFileSync(path.join(pluginRoot, '.codex-plugin', 'plugin.json'), formatJsonPayload({
    name: 'third-party-research',
    version,
    description: 'Unknown Package fixture carried by Codex Plugin Manager.',
    skills: './skills/',
  }));
}

test('configured Codex carrier executes native install/list/update/repair/remove with fresh readback', {
  skip: process.env.OPL_RUN_CODEX_PLUGIN_CARRIER_INTEGRATION === '1'
    ? false
    : 'set OPL_RUN_CODEX_PLUGIN_CARRIER_INTEGRATION=1 to exercise the configured native carrier',
}, () => {
  const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'opl-configured-codex-plugin-carrier-'));
  const marketplaceRoot = path.join(fixtureRoot, 'marketplace');
  const codexHome = path.join(fixtureRoot, 'codex-home');
  const oplStateDir = path.join(fixtureRoot, 'opl-state');
  const binary = process.env.OPL_CODEX_PLUGIN_BIN?.trim() || 'codex';
  fs.mkdirSync(codexHome, { recursive: true });
  const env = { ...process.env, CODEX_HOME: codexHome, OPL_STATE_DIR: oplStateDir };
  const nativeDescriptor = {
    ...descriptor,
    carrier: {
      ...descriptor.carrier,
      marketplaceSource: marketplaceRoot,
    },
  };
  try {
    writeNativeMarketplace(marketplaceRoot, '1.0.0');

    const absent = runConfiguredCodexPluginCarrier({
      descriptor: nativeDescriptor,
      action: 'list',
      binary,
      env,
    });
    assert.equal(absent.status, 'physical_unavailable');

    const installed = runConfiguredCodexPluginCarrier({
      descriptor: nativeDescriptor,
      action: 'install',
      binary,
      env,
    });
    assert.equal(installed.status, 'installed');
    assert.equal(installed.installed_version, '1.0.0');
    assert.equal(installed.executor.status, 'callable');
    assert.equal(installed.native_action_dispatched, true);
    assert.equal(fs.existsSync(oplStateDir), false);

    const requiredSkill = path.join(
      marketplaceRoot,
      'plugins',
      'third-party-research',
      'skills',
      'third-party-research',
      'SKILL.md',
    );
    fs.rmSync(requiredSkill);
    const drifted = runConfiguredCodexPluginCarrier({
      descriptor: nativeDescriptor,
      action: 'list',
      binary,
      env,
    });
    assert.equal(drifted.status, 'installed');
    assert.equal(drifted.executor.status, 'attention_needed');
    assert.match(drifted.reason ?? '', /required_skill_unavailable/);

    writeNativeMarketplace(marketplaceRoot, '1.0.1');
    const updated = runConfiguredCodexPluginCarrier({
      descriptor: nativeDescriptor,
      action: 'update',
      binary,
      env,
    });
    assert.equal(updated.status, 'installed');
    assert.equal(updated.installed_version, '1.0.1');
    assert.equal(fs.existsSync(oplStateDir), false);

    const repaired = runConfiguredCodexPluginCarrier({
      descriptor: nativeDescriptor,
      action: 'repair',
      binary,
      env,
    });
    assert.equal(repaired.status, 'installed');
    assert.equal(repaired.installed_version, '1.0.1');
    assert.equal(fs.existsSync(oplStateDir), false);

    const disabled = runConfiguredCodexPluginCarrier({
      descriptor: nativeDescriptor,
      action: 'disable',
      binary,
      env,
    });
    assert.equal(disabled.status, 'installed');
    assert.equal(disabled.enabled, false);
    assert.equal(disabled.executor.status, 'attention_needed');
    assert.equal(disabled.reason, 'configured_native_carrier_disabled');
    assert.equal(fs.existsSync(oplStateDir), false);

    const enabled = runConfiguredCodexPluginCarrier({
      descriptor: nativeDescriptor,
      action: 'enable',
      binary,
      env,
    });
    assert.equal(enabled.status, 'installed');
    assert.equal(enabled.enabled, true);
    assert.equal(enabled.executor.status, 'callable');
    assert.equal(fs.existsSync(oplStateDir), false);

    const removed = runConfiguredCodexPluginCarrier({
      descriptor: nativeDescriptor,
      action: 'remove',
      binary,
      env,
    });
    assert.equal(removed.status, 'physical_unavailable');
    assert.equal(removed.executor.status, 'attention_needed');
    assert.equal(fs.existsSync(path.join(oplStateDir, 'agent-package-locks.json')), false);
    assert.equal(fs.existsSync(path.join(oplStateDir, 'agent-package-lifecycle-ledger.json')), false);
    assert.equal(fs.existsSync(path.join(oplStateDir, 'agent-package-lifecycle.sqlite')), false);
    assert.equal(fs.existsSync(oplStateDir), false);
  } finally {
    removeFixtureTree(fixtureRoot);
  }
});
