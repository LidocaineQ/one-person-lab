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
  repoRoot,
  registryPayload,
  runCli,
  runCliFailure,
  test,
} from './helpers.ts';
import { validateJsonSchemaPayload } from '../../../../../src/kernel/schema-registry.ts';
import {
  runConfiguredCodexPluginCarrier,
  type CodexPluginCommandRunner,
} from '../../../../../src/modules/connect/agent-package-registry-parts/configured-codex-plugin-carrier.ts';
import {
  discoverInstalledPackageDescriptors,
} from '../../../../../src/modules/connect/agent-package-registry-parts/installed-codex-plugin-directory.ts';
import {
  createOplAgentPackageStatusReader,
  ensureOplAgentPackageScopeActivation,
} from '../../../../../src/modules/connect/agent-package-registry.ts';

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

function writePluginManifest(root: string, version = '1.0.1') {
  fs.mkdirSync(path.join(root, '.codex-plugin'), { recursive: true });
  fs.writeFileSync(path.join(root, '.codex-plugin', 'plugin.json'), formatJsonPayload({
    name: 'third-party-research',
    version,
    description: 'Unknown Package fixture carried by Codex Plugin Manager.',
    skills: './skills/',
  }));
}

function installedOwnerDescriptor() {
  return {
    ...agentPackageManifest(),
    presentation: {
      display_name_i18n: { 'en-US': 'Third Party Research' },
      description_i18n: { 'en-US': 'Descriptor-owned Home shortcuts.' },
      session_routing_summary_i18n: { 'en-US': 'Use the native carrier.' },
      home_shortcuts: [{
        shortcut_id: 'research',
        label_i18n: { 'en-US': 'Research' },
        default_visible: true,
        user_configurable: true,
        route: {
          route_kind: 'agent_package_shortcut',
          executor: 'codex_cli',
          codex_visible_entry: 'third-party-research',
        },
      }],
    },
  };
}

function assertCommandOutputSchema(commandKey: string, payload: unknown) {
  const registry = parseJsonText(fs.readFileSync(
    path.join(repoRoot, 'contracts', 'opl-framework', 'cli-command-registry.json'),
    'utf8',
  )) as any;
  const validation = validateJsonSchemaPayload({
    schemaId: `opl.cli.${commandKey}.configured_carrier`,
    schema: registry.commands[commandKey].output_schema,
    sourceRef: `cli-command-registry.json#/commands/${commandKey}/output_schema`,
  }, payload);
  assert.equal(validation.ok, true, JSON.stringify(validation));
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

test('an absent default Codex carrier does not masquerade as a failed native read', () => {
  const error = Object.assign(new Error('spawnSync codex ENOENT'), { code: 'ENOENT' });
  const discovered = discoverInstalledPackageDescriptors({
    failClosedOnCarrierError: true,
    runner: () => ({
      status: null,
      stdout: '',
      stderr: '',
      error,
    }),
  });
  assert.equal(discovered.size, 0);
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

function writeDiscoveryThenUnavailableCodex(binary: string, counterPath: string) {
  fs.writeFileSync(binary, `#!/usr/bin/env node
import fs from 'node:fs';
const args = process.argv.slice(2);
const counterPath = ${JSON.stringify(counterPath)};
const callCount = fs.existsSync(counterPath)
  ? Number(fs.readFileSync(counterPath, 'utf8'))
  : 0;
fs.writeFileSync(counterPath, String(callCount + 1));
if (callCount > 0 || args.join(' ') !== 'plugin list --json') {
  process.exitCode = 1;
} else {
  process.stdout.write(JSON.stringify({
    installed: [{
      pluginId: ${JSON.stringify(pluginSelector)},
      version: '1.0.1',
      installed: true,
      enabled: true,
      source: { source: 'local', path: process.env.FIXTURE_PLUGIN_SOURCE },
      marketplaceSource: { sourceType: 'local', source: 'fixture-carrier' },
    }],
    available: [],
  }));
}
`);
  fs.chmodSync(binary, 0o755);
}

function writeUnavailableCodex(binary: string) {
  fs.writeFileSync(binary, `#!/usr/bin/env node
if (process.argv.slice(2).join(' ') === 'plugin list --json') {
  process.stderr.write('native list unavailable');
  process.exitCode = 23;
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
    formatJsonPayload(installedOwnerDescriptor()),
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

    const lockPath = path.join(stateDir, 'agent-package-locks.json');
    const invalidLegacyLock = '{ invalid legacy lock\n';
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(lockPath, invalidLegacyLock, 'utf8');
    const status = runCli(['packages', 'status', '--package-id', packageId], env) as any;
    assert.equal(status.opl_agent_package_status.status, 'available');
    assert.equal(status.opl_agent_package_status.operational_ready, true);
    assert.equal(status.opl_agent_package_status.launch_allowed, true);
    assert.equal(status.opl_agent_package_status.installed_packages.length, 0);
    assert.equal(status.opl_agent_package_status.configured_carrier.status, 'installed');
    assert.equal(fs.readFileSync(lockPath, 'utf8'), invalidLegacyLock);

    const previousEnv = new Map(
      Object.keys(env).map((name) => [name, process.env[name]]),
    );
    Object.assign(process.env, env);
    let readinessActivation;
    try {
      readinessActivation = await ensureOplAgentPackageScopeActivation({
        packageId,
        scope: 'workspace',
        targetWorkspace: root,
        useBoundaryId: 'package-use:readiness-port-native-fixture',
      });
    } finally {
      for (const [name, value] of previousEnv) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }
    assert.equal(readinessActivation.status, 'already_activated');
    assert.equal(readinessActivation.writes_performed, false);
    assert.equal(readinessActivation.package_lock, null);
    assert.equal(readinessActivation.lifecycle_receipt, null);
    assert.equal(readinessActivation.package_use_binding, null);
    assert.equal(readinessActivation.use_receipt, null);
    assert.equal(readinessActivation.package_status.launch_allowed, true);
    assert.equal(fs.readFileSync(lockPath, 'utf8'), invalidLegacyLock);
    assert.equal(fs.existsSync(path.join(stateDir, 'agent-package-lifecycle-ledger.json')), false);
    assert.equal(fs.existsSync(path.join(stateDir, 'agent-package-lifecycle.sqlite')), false);

    fs.rmSync(lockPath);
    assertNoPrivateState();

    const workspace = path.join(root, 'workspace');
    fs.mkdirSync(workspace, { recursive: true });
    const activate = runCli([
      'packages', 'activate', packageId,
      '--scope', 'workspace', '--target-workspace', workspace,
    ], env) as any;
    assert.equal(activate.opl_agent_package_activation.status, 'already_activated');
    assert.equal(activate.opl_agent_package_activation.writes_performed, false);
    assert.equal(activate.opl_agent_package_activation.package_lock, null);
    assert.equal(activate.opl_agent_package_activation.lifecycle_receipt, null);
    assert.equal(activate.opl_agent_package_activation.package_use_binding, null);
    assert.equal(activate.opl_agent_package_activation.use_receipt, null);
    assert.equal(activate.opl_agent_package_activation.launch_state, 'ready');
    assertNoPrivateState();

    const activateDryRun = runCli([
      'packages', 'activate', packageId,
      '--scope', 'workspace', '--target-workspace', workspace, '--dry-run',
    ], env) as any;
    assert.equal(activateDryRun.opl_agent_package_activation.status, 'validated_no_write');
    assert.equal(activateDryRun.opl_agent_package_activation.writes_performed, false);
    assert.equal(activateDryRun.opl_agent_package_activation.package_lock, null);
    assert.equal(activateDryRun.opl_agent_package_activation.lifecycle_receipt, null);
    assertNoPrivateState();

    const hideDryRun = runCli(['packages', 'hide', '--package-id', packageId, '--dry-run'], env) as any;
    assert.equal(hideDryRun.opl_agent_package_exposure.status, 'validated_no_write');
    assert.equal(hideDryRun.opl_agent_package_exposure.package_lock, null);
    assert.equal(hideDryRun.opl_agent_package_exposure.lifecycle_receipt, null);
    assert.equal(hideDryRun.opl_agent_package_exposure.home_shortcut_preferences[0].visible, false);
    assertNoPrivateState();

    const hidden = runCli(['packages', 'hide', '--package-id', packageId], env) as any;
    assert.equal(hidden.opl_agent_package_exposure.status, 'hidden');
    assert.equal(hidden.opl_agent_package_exposure.package_lock, null);
    assert.equal(hidden.opl_agent_package_exposure.lifecycle_receipt, null);
    assert.equal(hidden.opl_agent_package_exposure.home_shortcut_preferences[0].visible, false);
    assertNoPrivateState();

    const hiddenPreferences = runCli(['packages', 'list'], env) as any;
    assert.deepEqual(
      hiddenPreferences.opl_agent_packages.home_shortcut_preferences.filter((entry: any) => entry.package_id === packageId),
      [{
        package_id: packageId,
        shortcut_id: 'research',
        visible: false,
        sort_order: null,
        source: 'user_preference',
        updated_at: hiddenPreferences.opl_agent_packages.home_shortcut_preferences.find((entry: any) => entry.package_id === packageId).updated_at,
        installed: true,
      }],
    );
    assert.equal(fs.existsSync(path.join(stateDir, 'agent-package-home-shortcut-preferences.json')), true);
    assertNoPrivateState();

    const unhidden = runCli(['packages', 'unhide', '--package-id', packageId], env) as any;
    assert.equal(unhidden.opl_agent_package_exposure.status, 'visible');
    assert.equal(unhidden.opl_agent_package_exposure.package_lock, null);
    assert.equal(unhidden.opl_agent_package_exposure.lifecycle_receipt, null);
    assert.equal(unhidden.opl_agent_package_exposure.home_shortcut_preferences[0].visible, true);
    assertNoPrivateState();

    const disabled = runCli(['packages', 'disable', packageId], env) as any;
    assert.equal(disabled.opl_agent_package_exposure.status, 'disabled');
    const disabledActivation = runCliFailure([
      'packages', 'activate', packageId,
      '--scope', 'workspace', '--target-workspace', workspace,
    ], env);
    assert.equal(
      disabledActivation.payload.error.details.failure_code,
      'agent_package_scope_activation_blocked',
    );
    assertNoPrivateState();

    const enabled = runCli(['packages', 'enable', packageId], env) as any;
    assert.equal(enabled.opl_agent_package_exposure.status, 'enabled');
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

test('first-party owner descriptor routes a scoped native action without private lifecycle writes', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'opl-first-party-owner-carrier-'));
  const stateDir = path.join(root, 'opl-state');
  const binary = path.join(root, 'fake-codex.mjs');
  const pluginSource = path.join(root, 'plugin-source');
  const skillRoot = path.join(pluginSource, 'skills', 'redcube-ai');
  fs.mkdirSync(skillRoot, { recursive: true });
  fs.writeFileSync(path.join(skillRoot, 'SKILL.md'), '# RedCube AI\n');
  fs.writeFileSync(
    path.join(pluginSource, 'opl-package.json'),
    formatJsonPayload({
      surface_kind: 'opl_agent_package_manifest.v1',
      kind: 'agent',
      agent_id: 'rca',
      package_id: 'rca',
      domain_id: 'redcube_ai',
      display_name: 'RedCube AI',
      publisher: 'one-person-lab',
      version: '0.2.9',
      source: 'first_party_repo_local',
      carrier_source_role: 'codex_plugin_default_carrier_not_package_truth',
      source_repo: 'https://github.com/gaofeng21cn/redcube-ai.git',
      schema_ref: 'one-person-lab/contracts/opl-framework/agent-package-manifest.schema.json',
      domain_descriptor_ref: 'contracts/domain_descriptor.json',
      task_provider_ref: 'contracts/domain_descriptor.json#/standard_agent_interface/stage_catalog',
      action_catalog_ref: 'contracts/action_catalog.json',
      view_refs: [],
      entrypoints: [{
        entrypoint_id: 'codex_primary_skill',
        entrypoint_kind: 'codex_skill',
        source_ref: 'agent/primary_skill/SKILL.md',
        carrier_ref: 'skills/redcube-ai/SKILL.md',
        authority: 'carrier_only_not_domain_truth',
      }],
      codex_surface: {
        plugin_id: 'redcube-ai',
        plugin_source_path: '.',
        required_skill_ids: ['redcube-ai'],
      },
      requires: [],
      capability_dependencies: [],
    }),
  );
  fs.writeFileSync(binary, `#!/usr/bin/env node
const args = process.argv.slice(2);
const installed = {
  pluginId: 'redcube-ai@redcube-ai',
  version: '0.2.9',
  installed: true,
  enabled: true,
  source: { source: 'local', path: process.env.FIXTURE_PLUGIN_SOURCE },
};
if (args.join(' ') === 'plugin list --json') {
  process.stdout.write(JSON.stringify({ installed: [installed], available: [] }));
} else if (args.join(' ') === 'plugin add redcube-ai@redcube-ai --json') {
  process.stdout.write(JSON.stringify({ status: 'ok' }));
} else {
  process.exitCode = 2;
}
`);
  fs.chmodSync(binary, 0o755);
  const env = {
    HOME: root,
    CODEX_HOME: path.join(root, 'codex-home'),
    OPL_STATE_DIR: stateDir,
    OPL_CODEX_PLUGIN_BIN: binary,
    FIXTURE_PLUGIN_SOURCE: pluginSource,
  };
  try {
    const update = runCli(['packages', 'update', 'rca'], env) as any;
    const updateSurface = update.opl_agent_package_update;
    assert.equal(updateSurface.package_id, 'rca');
    assert.equal(updateSurface.status, 'updated');
    assert.equal(updateSurface.package_lock, null);
    assert.equal(updateSurface.lifecycle_receipt, null);
    assert.deepEqual(
      Object.values(updateSurface.opl_private_state_writes),
      [false, false, false, false, false, false],
    );
    assert.equal(updateSurface.configured_carrier.status, 'installed');
    assert.equal(updateSurface.configured_carrier.operation, 'update');
    assert.deepEqual(
      updateSurface.configured_carrier.native_command,
      ['plugin', 'add', 'redcube-ai@redcube-ai', '--json'],
    );
    assert.equal(updateSurface.configured_carrier.native_action_dispatched, true);

    const activation = runCli([
      'packages', 'activate', 'rca',
      '--scope', 'workspace', '--target-workspace', root,
    ], env) as any;
    const surface = activation.opl_agent_package_activation;
    assert.equal(surface.package_id, 'rca');
    assert.equal(surface.status, 'already_activated');
    assert.equal(surface.writes_performed, false);
    assert.equal(surface.package_lock, null);
    assert.equal(surface.lifecycle_receipt, null);
    assert.equal(surface.package_use_binding, null);
    assert.equal(surface.use_receipt, null);
    const status = runCli(['packages', 'status', '--package-id', 'rca'], env) as any;
    assert.equal(status.opl_agent_package_status.configured_carrier.status, 'installed');
    assert.equal(status.opl_agent_package_status.configured_carrier.operation, 'list');
    assert.equal(status.opl_agent_package_status.configured_carrier.native_action_dispatched, true);
    assert.equal(fs.existsSync(path.join(stateDir, 'agent-package-registry-cache.json')), false);
    assert.equal(fs.existsSync(path.join(stateDir, 'agent-package-locks.json')), false);
    assert.equal(fs.existsSync(path.join(stateDir, 'agent-package-lifecycle-ledger.json')), false);
    assert.equal(fs.existsSync(path.join(stateDir, 'agent-package-lifecycle.sqlite')), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('native descriptor visibility leaves an existing legacy lock diagnostic-only', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'opl-configured-carrier-legacy-exposure-'));
  const stateDir = path.join(root, 'opl-state');
  const manifestPath = path.join(root, 'manifest.json');
  const binary = path.join(root, 'fake-codex.mjs');
  const pluginState = path.join(root, 'plugin-state.json');
  const pluginSource = path.join(root, 'plugin-source');
  const workspace = path.join(root, 'workspace');
  const env = {
    HOME: root,
    CODEX_HOME: path.join(root, 'codex-home'),
    OPL_STATE_DIR: stateDir,
    OPL_CODEX_PLUGIN_BIN: binary,
    FIXTURE_PLUGIN_STATE: pluginState,
    FIXTURE_PLUGIN_SOURCE: pluginSource,
  };
  try {
    fs.mkdirSync(workspace, { recursive: true });
    writePluginSource(pluginSource, 'legacy-exposure');
    fs.mkdirSync(path.join(pluginSource, '.codex-plugin'), { recursive: true });
    fs.writeFileSync(path.join(pluginSource, '.codex-plugin', 'plugin.json'), formatJsonPayload({
      name: 'third-party-research',
      version: '1.0.1',
      description: 'Legacy exposure fixture carried by Codex Plugin Manager.',
      skills: './skills/',
    }));
    fs.writeFileSync(manifestPath, formatJsonPayload(agentPackageManifest({
      pluginSourcePath: pluginSource,
      distributionPayload: null,
    })));
    writeFakeCodex(binary);

    const installed = runCli([
      'packages', 'install', '--manifest-url', manifestPath, '--trust-tier', 'third_party_verified',
    ], env) as any;
    assert.equal(installed.opl_agent_package_install.package_lock.package_id, packageId);
    assert.equal(fs.existsSync(path.join(stateDir, 'agent-package-locks.json')), true);
    const legacyLockBytes = fs.readFileSync(path.join(stateDir, 'agent-package-locks.json'), 'utf8');
    const legacyLedgerPath = path.join(stateDir, 'agent-package-lifecycle-ledger.json');
    assert.equal(fs.existsSync(legacyLedgerPath), false);

    fs.writeFileSync(
      path.join(pluginSource, 'opl-package.json'),
      formatJsonPayload(installedOwnerDescriptor()),
    );
    fs.writeFileSync(pluginState, JSON.stringify({
      installed: true,
      version: '1.0.1',
      marketplaceSource: 'fixture-carrier',
    }));

    const descriptorStatus = runCli(['packages', 'status', '--package-id', packageId], env) as any;
    assert.equal(descriptorStatus.opl_agent_package_status.status, 'available');
    assert.equal(descriptorStatus.opl_agent_package_status.operational_ready, true);
    assert.equal(descriptorStatus.opl_agent_package_status.launch_allowed, true);
    assert.equal(descriptorStatus.opl_agent_package_status.installed_package_count, 1);
    assert.deepEqual(descriptorStatus.opl_agent_package_status.installed_packages, []);
    assert.equal(descriptorStatus.opl_agent_package_status.owner_route_readback.package_count, 0);
    assert.deepEqual(descriptorStatus.opl_agent_package_status.owner_route_readback.packages, []);

    const descriptorDirectory = runCli(['packages', 'list', '--detail', 'full'], env) as any;
    const descriptorEntry = descriptorDirectory.opl_agent_packages.directory.entries.find(
      (entry: any) => entry.package_id === packageId,
    );
    assert.equal(Object.hasOwn(descriptorEntry, 'lock_ref'), false);
    assert.equal(descriptorEntry.legacy_private_lifecycle_state_present, true);
    assert.equal(descriptorDirectory.opl_agent_packages.installed_package_count, 1);
    assert.equal(descriptorDirectory.opl_agent_packages.legacy_authority.authority_status, 'stale');
    assert.equal(descriptorDirectory.opl_agent_packages.legacy_authority.status, 'degraded');
    assert.equal(descriptorDirectory.opl_agent_packages.legacy_authority.retained_descriptor_lock_count, 1);
    assert.equal(descriptorDirectory.opl_agent_packages.directory.legacy_authority.authority_status, 'stale');
    assert.equal(Object.hasOwn(descriptorDirectory.opl_agent_packages.legacy_authority, 'authority_file'), false);
    assert.equal(Object.hasOwn(descriptorDirectory.opl_agent_packages.directory.legacy_authority, 'authority_file'), false);
    assert.deepEqual(descriptorDirectory.opl_agent_packages.installed_packages, []);
    assert.equal(descriptorDirectory.opl_agent_packages.owner_route_readback.package_count, 0);
    assert.deepEqual(descriptorDirectory.opl_agent_packages.owner_route_readback.packages, []);
    assert.equal(fs.readFileSync(path.join(stateDir, 'agent-package-locks.json'), 'utf8'), legacyLockBytes);
    assert.equal(fs.existsSync(legacyLedgerPath), false);

    const activated = runCli([
      'packages', 'activate', packageId,
      '--scope', 'workspace', '--target-workspace', workspace,
    ], env) as any;
    assert.equal(activated.opl_agent_package_activation.status, 'already_activated');
    assert.equal(activated.opl_agent_package_activation.writes_performed, false);
    assert.equal(activated.opl_agent_package_activation.package_lock, null);
    assert.equal(activated.opl_agent_package_activation.lifecycle_receipt, null);
    assert.equal(fs.readFileSync(path.join(stateDir, 'agent-package-locks.json'), 'utf8'), legacyLockBytes);
    assert.equal(fs.existsSync(legacyLedgerPath), false);

    const hidden = runCli(['packages', 'hide', '--package-id', packageId], env) as any;
    assert.equal(hidden.opl_agent_package_exposure.status, 'hidden');
    assert.equal(hidden.opl_agent_package_exposure.package_lock, null);
    assert.equal(hidden.opl_agent_package_exposure.lifecycle_receipt, null);
    assert.deepEqual(hidden.opl_agent_package_exposure.home_shortcut_preferences.map((entry: any) => entry.visible), [false]);
    assert.equal(fs.readFileSync(path.join(stateDir, 'agent-package-locks.json'), 'utf8'), legacyLockBytes);
    assert.equal(fs.existsSync(legacyLedgerPath), false);

    const unhidden = runCli(['packages', 'unhide', '--package-id', packageId], env) as any;
    assert.equal(unhidden.opl_agent_package_exposure.status, 'visible');
    assert.equal(unhidden.opl_agent_package_exposure.package_lock, null);
    assert.equal(unhidden.opl_agent_package_exposure.lifecycle_receipt, null);
    assert.deepEqual(unhidden.opl_agent_package_exposure.home_shortcut_preferences.map((entry: any) => entry.visible), [true]);
    assert.equal(fs.readFileSync(path.join(stateDir, 'agent-package-locks.json'), 'utf8'), legacyLockBytes);
    assert.equal(fs.existsSync(legacyLedgerPath), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('preloaded native status reader does not parse or replace a corrupt legacy lock', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'opl-preloaded-native-status-'));
  const stateDir = path.join(root, 'opl-state');
  const binary = path.join(root, 'fake-codex.mjs');
  const pluginState = path.join(root, 'plugin-state.json');
  const pluginSource = path.join(root, 'plugin-source');
  const lockPath = path.join(stateDir, 'agent-package-locks.json');
  const invalidLegacyLock = '{ invalid legacy lock\n';
  const env = {
    HOME: root,
    CODEX_HOME: path.join(root, 'codex-home'),
    OPL_STATE_DIR: stateDir,
    OPL_CODEX_PLUGIN_BIN: binary,
    FIXTURE_PLUGIN_STATE: pluginState,
    FIXTURE_PLUGIN_SOURCE: pluginSource,
  };
  const previous = new Map(
    Object.keys(env).map((name) => [name, process.env[name]]),
  );
  try {
    writePluginSource(pluginSource, 'preloaded-native-status');
    writePluginManifest(pluginSource);
    fs.writeFileSync(
      path.join(pluginSource, 'opl-package.json'),
      formatJsonPayload(installedOwnerDescriptor()),
    );
    writeFakeCodex(binary);
    fs.writeFileSync(pluginState, JSON.stringify({
      installed: true,
      version: '1.0.1',
      marketplaceSource: 'fixture-carrier',
    }));
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(lockPath, invalidLegacyLock, 'utf8');

    const directory = runCli(['packages', 'list', '--detail', 'full'], env) as any;
    const directoryEntry = directory.opl_agent_packages.directory.entries.find(
      (entry: any) => entry.package_id === packageId,
    );
    assert.equal(directory.opl_agent_packages.status, 'attention_needed');
    assert.equal(directory.opl_agent_packages.legacy_authority.status, 'degraded');
    assert.equal(directory.opl_agent_packages.legacy_authority.authority_status, 'corrupt');
    assert.equal(directory.opl_agent_packages.legacy_authority.failure_code, 'agent_package_lock_authority_corrupt');
    assert.equal(Object.hasOwn(directory.opl_agent_packages.legacy_authority, 'authority_file'), false);
    assert.equal(Object.hasOwn(directory.opl_agent_packages.directory.legacy_authority, 'authority_file'), false);
    assert.equal(directory.opl_agent_packages.directory.status, 'attention_required');
    assert.equal(directoryEntry.installed, true);
    assert.equal(directory.opl_agent_packages.installed_package_count, 1);
    assert.equal(fs.readFileSync(lockPath, 'utf8'), invalidLegacyLock);

    const globalStatus = runCli(['packages', 'status'], env) as any;
    assert.equal(globalStatus.opl_agent_package_status.status, 'attention_needed');
    assert.equal(globalStatus.opl_agent_package_status.installed_package_count, 1);
    assert.equal(globalStatus.opl_agent_package_status.legacy_authority.authority_status, 'corrupt');
    assert.equal(Object.hasOwn(globalStatus.opl_agent_package_status.legacy_authority, 'authority_file'), false);
    assert.equal(fs.readFileSync(lockPath, 'utf8'), invalidLegacyLock);

    const appState = runCli(['app', 'state', '--profile', 'fast'], env) as any;
    assert.equal(appState.app_state.agent_packages.directory.entries.some(
      (entry: any) => entry.package_id === packageId,
    ), true);
    assert.equal(appState.app_state.agent_packages.directory.legacy_authority.authority_status, 'corrupt');
    assert.equal(Object.hasOwn(appState.app_state.agent_packages.directory.legacy_authority, 'authority_file'), false);
    assert.equal(appState.app_state.agent_packages.status_index.installed_package_count, 1);
    assert.equal(fs.readFileSync(lockPath, 'utf8'), invalidLegacyLock);

    Object.assign(process.env, env);

    const readStatus = createOplAgentPackageStatusReader();
    for (let index = 0; index < 2; index += 1) {
      const status = readStatus({
        packageId,
        detail: 'fast',
      }).opl_agent_package_status;
      assert.equal(status.status, 'available');
      assert.equal(status.operational_ready, true);
      assert.equal(status.launch_allowed, true);
      assert.equal(status.installed_package_count, 1);
      assert.deepEqual(status.installed_packages, []);
      assert.equal(status.legacy_authority.authority_status, 'corrupt');
      assert.equal(status.legacy_authority.status, 'degraded');
      assert.equal(Object.hasOwn(status.legacy_authority, 'authority_file'), false);
    }
    assert.throws(
      () => readStatus({ packageId: 'legacy.package', detail: 'fast' }),
      (error: any) => error?.details?.failure_code === 'agent_package_lock_authority_corrupt',
    );
    assert.equal(fs.readFileSync(lockPath, 'utf8'), invalidLegacyLock);
  } finally {
    for (const [name, value] of previous) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('native private lifecycle actions stay carrier-owned when legacy authorities are corrupt', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'opl-native-private-actions-'));
  const stateDir = path.join(root, 'opl-state');
  const binary = path.join(root, 'fake-codex.mjs');
  const pluginState = path.join(root, 'plugin-state.json');
  const pluginSource = path.join(root, 'plugin-source');
  const lockPath = path.join(stateDir, 'agent-package-locks.json');
  const ledgerPath = path.join(stateDir, 'agent-package-lifecycle-ledger.json');
  const sqlitePath = path.join(stateDir, 'agent-package-lifecycle.sqlite');
  const invalidLock = '{ invalid native-action lock\n';
  const invalidLedger = '{ invalid native-action ledger\n';
  const env = {
    HOME: root,
    CODEX_HOME: path.join(root, 'codex-home'),
    OPL_STATE_DIR: stateDir,
    OPL_CODEX_PLUGIN_BIN: binary,
    FIXTURE_PLUGIN_STATE: pluginState,
    FIXTURE_PLUGIN_SOURCE: pluginSource,
  };
  try {
    writePluginSource(pluginSource, 'native-private-actions');
    fs.writeFileSync(
      path.join(pluginSource, 'opl-package.json'),
      formatJsonPayload(installedOwnerDescriptor()),
    );
    writeFakeCodex(binary);
    fs.writeFileSync(pluginState, JSON.stringify({
      installed: true,
      version: '1.0.1',
      marketplaceSource: 'fixture-carrier',
    }));
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(lockPath, invalidLock, 'utf8');
    fs.writeFileSync(ledgerPath, invalidLedger, 'utf8');
    const lockBefore = fs.readFileSync(lockPath, 'utf8');
    const ledgerBefore = fs.readFileSync(ledgerPath, 'utf8');

    for (const action of ['optimize', 'rollback', 'profile apply'] as const) { // reuse-first: exception - preserve the public action vocabulary while proving no Framework writer runs.
      const result = action === 'profile apply'
        ? runCli([
            'packages', 'profile', 'apply', packageId,
            '--merged-file', path.join(root, 'missing-merged-file.md'),
          ], env) as any
        : runCli(['packages', action, packageId], env) as any;
      const surfaceKey = action === 'profile apply'
        ? 'opl_agent_package_profile_apply'
        : `opl_agent_package_${action}`;
      const commandKey = action === 'profile apply'
        ? 'packages_profile_apply'
        : `packages_${action}`;
      assertCommandOutputSchema(commandKey, result);
      const surface = result[surfaceKey];
      assert.equal(surface.status, 'carrier_owned');
      assert.equal(surface.lifecycle_authority, 'carrier_owned');
      assert.equal(surface.writes_performed, false);
      assert.equal(surface.package_lock, null);
      assert.equal(surface.lifecycle_receipt, null);
      assert.equal(surface.configured_carrier.status, 'installed');
      assert.equal(surface.configured_carrier.operation, 'list');
      assert.equal(surface.configured_carrier.native_action_dispatched, true);
      assert.equal(fs.readFileSync(lockPath, 'utf8'), lockBefore);
      assert.equal(fs.readFileSync(ledgerPath, 'utf8'), ledgerBefore);
      assert.equal(fs.existsSync(sqlitePath), false);
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('initial native carrier discovery failure does not enter legacy private lifecycle', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'opl-native-private-action-discovery-failure-'));
  const stateDir = path.join(root, 'opl-state');
  const binary = path.join(root, 'unavailable-codex.mjs');
  const lockPath = path.join(stateDir, 'agent-package-locks.json');
  const ledgerPath = path.join(stateDir, 'agent-package-lifecycle-ledger.json');
  const sqlitePath = path.join(stateDir, 'agent-package-lifecycle.sqlite');
  const invalidLock = '{ invalid discovery-failure lock\n';
  const invalidLedger = '{ invalid discovery-failure ledger\n';
  const env = {
    HOME: root,
    CODEX_HOME: path.join(root, 'codex-home'),
    OPL_STATE_DIR: stateDir,
    OPL_CODEX_PLUGIN_BIN: binary,
  };
  try {
    writeUnavailableCodex(binary);
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(lockPath, invalidLock, 'utf8');
    fs.writeFileSync(ledgerPath, invalidLedger, 'utf8');

    for (const action of ['optimize', 'rollback', 'profile apply'] as const) { // reuse-first: allow - exercise the public command vocabulary without implementing a Framework lifecycle writer.
      const failure = action === 'profile apply'
        ? runCliFailure([
            'packages', 'profile', 'apply', packageId,
            '--merged-file', path.join(root, 'missing-merged-file.md'),
          ], env)
        : runCliFailure(['packages', action, packageId], env);
      assert.equal(
        failure.payload.error.details.failure_code,
        'configured_codex_plugin_carrier_action_failed',
      );
      assert.equal(failure.payload.error.details.action, 'list');
      assert.equal(fs.readFileSync(lockPath, 'utf8'), invalidLock);
      assert.equal(fs.readFileSync(ledgerPath, 'utf8'), invalidLedger);
      assert.equal(fs.existsSync(sqlitePath), false);
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('native private action does not fall back to legacy state after carrier readback becomes unavailable', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'opl-native-private-action-unavailable-'));
  const stateDir = path.join(root, 'opl-state');
  const binary = path.join(root, 'flaky-codex.mjs');
  const counterPath = path.join(root, 'list-calls.txt');
  const pluginSource = path.join(root, 'plugin-source');
  const lockPath = path.join(stateDir, 'agent-package-locks.json');
  const ledgerPath = path.join(stateDir, 'agent-package-lifecycle-ledger.json');
  const sqlitePath = path.join(stateDir, 'agent-package-lifecycle.sqlite');
  const env = {
    HOME: root,
    CODEX_HOME: path.join(root, 'codex-home'),
    OPL_STATE_DIR: stateDir,
    OPL_CODEX_PLUGIN_BIN: binary,
    FIXTURE_PLUGIN_SOURCE: pluginSource,
  };
  try {
    writePluginSource(pluginSource, 'native-private-action-unavailable');
    fs.writeFileSync(
      path.join(pluginSource, 'opl-package.json'),
      formatJsonPayload(installedOwnerDescriptor()),
    );
    writeDiscoveryThenUnavailableCodex(binary, counterPath);
    fs.mkdirSync(stateDir, { recursive: true });
    const invalidLock = '{ invalid unavailable-action lock\\n';
    const invalidLedger = '{ invalid unavailable-action ledger\\n';
    fs.writeFileSync(lockPath, invalidLock, 'utf8');
    fs.writeFileSync(ledgerPath, invalidLedger, 'utf8');

    const result = runCli(['packages', 'optimize', packageId], env) as any;
    const surface = result.opl_agent_package_optimize;
    assert.equal(surface.status, 'attention_needed');
    assert.equal(surface.lifecycle_authority, 'carrier_owned');
    assert.equal(surface.writes_performed, false);
    assert.equal(surface.reason, 'configured_native_carrier_unavailable');
    assert.equal(surface.configured_carrier.status, 'physical_unavailable');
    assert.equal(fs.readFileSync(lockPath, 'utf8'), invalidLock);
    assert.equal(fs.readFileSync(ledgerPath, 'utf8'), invalidLedger);
    assert.equal(fs.existsSync(sqlitePath), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('managed-update reader excludes a legacy lock once the native owner descriptor is installed', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'opl-configured-carrier-managed-update-'));
  const stateDir = path.join(root, 'opl-state');
  const manifestPath = path.join(root, 'manifest.json');
  const binary = path.join(root, 'fake-codex.mjs');
  const pluginState = path.join(root, 'plugin-state.json');
  const pluginSource = path.join(root, 'plugin-source');
  const previousStateDir = process.env.OPL_STATE_DIR;
  const previousPluginBin = process.env.OPL_CODEX_PLUGIN_BIN;
  const previousPluginState = process.env.FIXTURE_PLUGIN_STATE;
  const previousPluginSource = process.env.FIXTURE_PLUGIN_SOURCE;
  const env = {
    HOME: root,
    CODEX_HOME: path.join(root, 'codex-home'),
    OPL_STATE_DIR: stateDir,
    OPL_CODEX_PLUGIN_BIN: binary,
    FIXTURE_PLUGIN_STATE: pluginState,
    FIXTURE_PLUGIN_SOURCE: pluginSource,
  };
  try {
    writePluginSource(pluginSource, 'legacy-managed-update');
    writePluginManifest(pluginSource);
    fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
    fs.writeFileSync(manifestPath, formatJsonPayload(agentPackageManifest({
      pluginSourcePath: pluginSource,
      distributionPayload: null,
    })));
    writeFakeCodex(binary);
    const installed = runCli([
      'packages', 'install', '--manifest-url', manifestPath, '--trust-tier', 'third_party_verified',
    ], env) as any;
    assert.equal(installed.opl_agent_package_install.package_lock.package_id, packageId);
    const legacy = await import('../../../../../src/modules/connect/agent-package-registry.ts');
    Object.assign(process.env, env);
    assert.equal(
      legacy.readManagedUpdateOplAgentPackageProjection().packages
        .some((entry: any) => entry.package_id === packageId),
      true,
    );

    fs.writeFileSync(path.join(pluginSource, 'opl-package.json'), formatJsonPayload(installedOwnerDescriptor()));
    fs.writeFileSync(pluginState, JSON.stringify({
      installed: true,
      version: '1.0.1',
      marketplaceSource: 'fixture-carrier',
    }));
    assert.equal(
      legacy.readManagedUpdateOplAgentPackageProjection().packages
        .some((entry: any) => entry.package_id === packageId),
      false,
    );

  } finally {
    if (previousStateDir === undefined) delete process.env.OPL_STATE_DIR;
    else process.env.OPL_STATE_DIR = previousStateDir;
    if (previousPluginBin === undefined) delete process.env.OPL_CODEX_PLUGIN_BIN;
    else process.env.OPL_CODEX_PLUGIN_BIN = previousPluginBin;
    if (previousPluginState === undefined) delete process.env.FIXTURE_PLUGIN_STATE;
    else process.env.FIXTURE_PLUGIN_STATE = previousPluginState;
    if (previousPluginSource === undefined) delete process.env.FIXTURE_PLUGIN_SOURCE;
    else process.env.FIXTURE_PLUGIN_SOURCE = previousPluginSource;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function writeNativeMarketplace(root: string, version: string) {
  const pluginRoot = path.join(root, 'plugins', 'third-party-research');
  fs.mkdirSync(path.join(root, '.agents', 'plugins'), { recursive: true });
  writePluginSource(pluginRoot, 'callable');
  fs.writeFileSync(path.join(root, '.agents', 'plugins', 'marketplace.json'), formatJsonPayload({
    name: 'fixture-carrier',
    plugins: [{
      name: 'third-party-research',
      source: { source: 'local', path: './plugins/third-party-research' },
      policy: { installation: 'AVAILABLE', authentication: 'ON_INSTALL' },
    }],
  }));
  writePluginManifest(pluginRoot, version);
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
