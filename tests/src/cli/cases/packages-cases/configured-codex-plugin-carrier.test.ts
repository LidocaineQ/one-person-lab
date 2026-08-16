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
  runCliAsync,
  runCliFailure,
  test,
  withAgentPackageServer,
} from './helpers.ts';
import { validateJsonSchemaPayload } from '../../../../../src/kernel/schema-registry.ts';
import {
  normalizeAgentPluginName,
  resolveAgentPluginManifest,
} from '../../../../../src/kernel/agent-plugin-manifest.ts';
import {
  createMemoizedCodexPluginListRunner,
  runConfiguredCodexPluginCarrier,
  type CodexPluginCommandRunner,
} from '../../../../../src/adapters/integration/agent-package-registry-parts/configured-codex-plugin-carrier.ts';
import {
  descriptorDependencyReadiness,
} from '../../../../../src/adapters/integration/agent-package-registry-parts/dependency-closure.ts';
import {
  discoverInstalledPackageDescriptors,
} from '../../../../../src/adapters/integration/agent-package-registry-parts/installed-codex-plugin-directory.ts';
import { createOplAgentPackageStatusReader } from '../../../../../src/adapters/integration/agent-package-registry.ts';

const packageId = 'third.party.research';
const pluginSelector = 'third-party-research@fixture-carrier';
const ownerPackageVersion = '1.2.3';
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

test('configured carrier snapshot reuses one Codex plugin list across descriptors', () => {
  let calls = 0;
  const runner = createMemoizedCodexPluginListRunner(() => {
    calls += 1;
    return {
      status: 0,
      stdout: pluginList([]),
      stderr: '',
      error: null,
    };
  });
  runConfiguredCodexPluginCarrier({ descriptor, action: 'list', runner });
  runConfiguredCodexPluginCarrier({
    descriptor: {
      ...descriptor,
      packageId: 'another.package',
      carrier: { ...descriptor.carrier, pluginId: 'another-package@fixture-carrier' },
      executor: { ...descriptor.executor, requiredSkillIds: [] },
    },
    action: 'list',
    runner,
  });
  assert.equal(calls, 1);
});

test('Agent Plugins 1.0 manifests win globally and fatal standard errors never fall back to legacy', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'opl-agent-plugin-resolution-'));
  const legacyRoot = path.join(root, 'legacy');
  const portableRoot = path.join(root, 'portable');
  fs.mkdirSync(path.join(legacyRoot, '.codex-plugin'), { recursive: true });
  fs.mkdirSync(path.join(portableRoot, '.codex-plugin'), { recursive: true });
  fs.writeFileSync(path.join(legacyRoot, '.codex-plugin', 'plugin.json'), formatJsonPayload({
    name: 'sample-agent',
    version: '0.9.0',
  }));
  fs.writeFileSync(path.join(portableRoot, '.codex-plugin', 'plugin.json'), formatJsonPayload({
    name: 'sample-agent',
    version: '0.8.0',
  }));
  const portablePath = path.join(portableRoot, 'plugin.json');
  fs.writeFileSync(portablePath, formatJsonPayload({
    $schema: 'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json',
    name: 'sample-agent',
    version: '1.0.0',
    extensions: 'reported-and-ignored',
    future_field: true,
  }));
  try {
    assert.equal(normalizeAgentPluginName('sample_agent'), 'sample-agent');
    const resolved = resolveAgentPluginManifest([legacyRoot, portableRoot], {
      expectedName: 'sample-agent',
    });
    assert.ok(resolved);
    assert.equal(resolved.kind, 'agent_plugins_1_0');
    assert.equal(resolved.manifestPath, portablePath);
    assert.deepEqual(resolved.conformanceErrors, [
      'unknown_top_level_field:future_field',
      'non_object_extensions_ignored',
    ]);

    fs.writeFileSync(portablePath, formatJsonPayload({
      $schema: 'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json',
      name: 'Sample_Agent',
    }));
    assert.throws(
      () => resolveAgentPluginManifest([legacyRoot, portableRoot], { expectedName: 'sample-agent' }),
      /failed its fatal core contract/,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('native descriptor dependency readiness is fail-closed without legacy lock state', () => {
  const dependency = {
    package_id: 'mas-scholar-skills',
    required: true,
    dependency_kind: 'hard_runtime_dependency' as const,
    version_requirement: '>=0.2.0 <0.3.0',
    capability_abi: 'mas-scholar-skills.v1',
    consumer_profile_id: 'mas-medical-paper.v1',
    required_export_ids: ['scholar-core'],
    required_module_ids: ['scholarskills'],
    bootstrap_manifest_url: null,
    dependency_source: null,
  };
  const root = {
    agent_id: 'mas',
    capability_dependencies: [dependency],
  };
  const providerManifest = {
    package_id: 'mas-scholar-skills',
    version: '0.2.24',
    capability_provider: {
      capability_abi: 'mas-scholar-skills.v1',
      exports: [{ export_id: 'scholar-core', skill_id: 'scholar-core', install_mode: 'core_required' as const }],
      module_export_ids: ['scholarskills'],
      consumer_profiles: [{
        profile_id: 'mas-medical-paper.v1',
        consumer_agent_id: 'mas',
        required_export_ids: ['scholar-core'],
        required_module_ids: ['scholarskills'],
      }],
    },
  };
  const provider = {
    manifest: providerManifest,
    manifest_sha256: 'sha256:provider',
    content_digest: 'sha256:content',
    readiness: {
      installed: true,
      physical_status: 'available' as const,
      callability: 'callable' as const,
    },
  };
  const current = descriptorDependencyReadiness({
    root,
    providers: new Map([[providerManifest.package_id, provider]]),
  });
  assert.equal(current.status, 'current');
  assert.equal(current.operational_ready, true);
  assert.equal(current.dependencies[0]?.installed_version, '0.2.24');
  assert.equal(current.dependencies[0]?.manifest_sha256, 'sha256:provider');

  const missing = descriptorDependencyReadiness({ root, providers: new Map() });
  assert.equal(missing.status, 'missing');
  assert.equal(missing.operational_ready, false);
  assert.deepEqual(missing.dependencies[0]?.reasons, ['dependency_not_installed']);

  const disabled = descriptorDependencyReadiness({
    root,
    providers: new Map([[
      providerManifest.package_id,
      { ...provider, readiness: { ...provider.readiness, callability: 'disabled' as const } },
    ]]),
  });
  assert.equal(disabled.status, 'incompatible');
  assert.equal(disabled.operational_ready, false);
  assert.deepEqual(disabled.dependencies[0]?.reasons, ['dependency_disabled']);
});

test('package status projects required closure from installed owner descriptors', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'opl-configured-carrier-dependency-status-'));
  const stateDir = path.join(root, 'opl-state');
  const codexHome = path.join(root, 'codex-home');
  const rootSource = path.join(root, 'mas');
  const providerSource = path.join(root, 'scholar');
  const binary = path.join(root, 'fake-codex.mjs');
  const callsPath = path.join(root, 'codex-calls.txt');
  const writePlugin = (source: string, packageId: string, version: string) => {
    fs.mkdirSync(path.join(source, '.codex-plugin'), { recursive: true });
    fs.mkdirSync(path.join(source, 'skills', packageId), { recursive: true });
    fs.writeFileSync(path.join(source, 'skills', packageId, 'SKILL.md'), `# ${packageId}\n`);
    fs.writeFileSync(path.join(source, '.codex-plugin', 'plugin.json'), formatJsonPayload({
      name: packageId,
      version,
      skills: './skills/',
    }));
  };
  const dependency = {
    package_id: 'mas-scholar-skills',
    required: true,
    dependency_kind: 'hard_runtime_dependency' as const,
    version_requirement: '>=0.2.0 <0.3.0',
    capability_abi: 'mas-scholar-skills.v1',
    consumer_profile_id: 'mas-medical-paper.v1',
    required_export_ids: ['scholar-core'],
    required_module_ids: ['scholarskills'],
    bootstrap_manifest_url: null,
    dependency_source: null,
  };
  const rootManifest = agentPackageManifest({ packageId: 'mas', agentId: 'mas', pluginId: 'med-autoscience' }) as any;
  rootManifest.version = '0.2.25';
  rootManifest.codex_surface.required_skill_ids = ['mas'];
  rootManifest.capability_dependencies = [dependency];
  const providerManifest = agentPackageManifest({
    packageId: 'mas-scholar-skills',
    agentId: 'mas-scholar-skills',
    pluginId: 'mas-scholar-skills',
  }) as any;
  providerManifest.version = '0.2.24';
  providerManifest.codex_surface.required_skill_ids = ['mas-scholar-skills'];
  providerManifest.capability_provider = {
    capability_abi: 'mas-scholar-skills.v1',
    exports: [{ export_id: 'scholar-core', skill_id: 'mas-scholar-skills', install_mode: 'core_required' }],
    module_export_ids: ['scholarskills'],
    consumer_profiles: [{
      profile_id: 'mas-medical-paper.v1',
      consumer_agent_id: 'mas',
      required_export_ids: ['scholar-core'],
      required_module_ids: ['scholarskills'],
    }],
  };
  fs.mkdirSync(rootSource, { recursive: true });
  fs.mkdirSync(providerSource, { recursive: true });
  writePlugin(rootSource, 'mas', '0.2.25');
  writePlugin(providerSource, 'mas-scholar-skills', '0.2.24');
  fs.writeFileSync(path.join(rootSource, 'opl-package.json'), formatJsonPayload(rootManifest));
  fs.writeFileSync(path.join(providerSource, 'opl-package.json'), formatJsonPayload(providerManifest));
  fs.writeFileSync(binary, `#!/usr/bin/env node\nimport fs from 'node:fs';\nfs.appendFileSync(process.env.FIXTURE_CODEX_CALLS, process.argv.slice(2).join(' ') + '\\n');\nprocess.stdout.write(${JSON.stringify(pluginList([
    { pluginId: 'med-autoscience@carrier', version: '0.2.25', sourcePath: rootSource, marketplaceSource: 'fixture' },
    { pluginId: 'mas-scholar-skills@carrier', version: '0.2.24', sourcePath: providerSource, marketplaceSource: 'fixture' },
  ]))});\n`);
  fs.chmodSync(binary, 0o755);
  const env = {
    HOME: root,
    CODEX_HOME: codexHome,
    OPL_STATE_DIR: stateDir,
    OPL_CODEX_PLUGIN_BIN: binary,
    FIXTURE_CODEX_CALLS: callsPath,
  };
  try {
    const status = runCli(['packages', 'status', '--package-id', 'mas'], env).opl_agent_package_status;
    assert.equal(status.package_dependency_readiness?.status, 'current');
    assert.equal(status.package_dependency_readiness?.operational_ready, true);
    assert.equal(status.package_dependency_readiness?.dependencies[0]?.package_id, 'mas-scholar-skills');
    assert.equal(status.operational_ready, true);
    assert.equal(status.launch_allowed, true);
    assert.deepEqual(fs.readFileSync(callsPath, 'utf8').trim().split('\n'), [
      'plugin list --json',
      'plugin list --json',
    ]);
    assert.equal(fs.existsSync(path.join(stateDir, 'agent-package-locks.json')), false);

    const historicalSource = path.join(root, 'historical-mas');
    writePlugin(historicalSource, 'mas', '0.2.25');
    fs.writeFileSync(path.join(historicalSource, 'opl-package.json'), formatJsonPayload({
      ...rootManifest,
      codex_surface: {
        ...rootManifest.codex_surface,
        plugin_source_path: path.relative(historicalSource, rootSource),
        configured_codex_plugin_carrier: {
          kind: 'codex_plugin_manager',
          plugin_selector: 'med-autoscience@carrier',
          executor_route: 'codex_cli',
          marketplace_source: 'fixture',
          publication_ref: null,
        },
      },
    }));
    fs.writeFileSync(binary, `#!/usr/bin/env node\nprocess.stdout.write(${JSON.stringify(pluginList([
      {
        pluginId: 'med-autoscience@historical-carrier',
        version: '0.2.25',
        sourcePath: historicalSource,
        marketplaceSource: 'historical-carrier',
      },
      {
        pluginId: 'mas-scholar-skills@carrier',
        version: '0.2.24',
        sourcePath: providerSource,
        marketplaceSource: 'fixture',
      },
    ]))});\n`);
    const unexpectedSource = runCli(['packages', 'status', '--package-id', 'mas'], env)
      .opl_agent_package_status;
    assert.equal(unexpectedSource.configured_carrier?.status, 'not_installed');
    assert.equal(unexpectedSource.configured_carrier?.carrier.precedence, 'unexpected_same_plugin_name');
    assert.equal(unexpectedSource.installed_readiness?.callability, 'callable');
    assert.equal(unexpectedSource.status, 'not_installed');
    assert.equal(unexpectedSource.installed_package_count, 0);
    assert.equal(unexpectedSource.operational_ready, false);
    assert.equal(unexpectedSource.launch_allowed, false);
    assert.equal(
      unexpectedSource.launch_blocked_reason,
      'configured_native_carrier_unexpected_source_present',
    );
  } finally {
    removeFixtureTree(root);
  }
});

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
  enabled?: boolean;
}>) {
  return JSON.stringify({
    installed: entries.map((entry) => ({
      pluginId: entry.pluginId,
      version: entry.version,
      installed: true,
      enabled: entry.enabled ?? true,
      source: { source: 'local', path: entry.sourcePath },
      marketplaceSource: { sourceType: 'local', source: entry.marketplaceSource },
    })),
    available: [],
  });
}

function writePluginSource(root: string, marker: string, skillsRoot = './skills/') {
  fs.mkdirSync(path.resolve(root, skillsRoot, 'third-party-research'), { recursive: true });
  fs.writeFileSync(
    path.resolve(root, skillsRoot, 'third-party-research', 'SKILL.md'),
    `# Third Party Research\n\n${marker}\n`,
  );
  writePluginManifest(root, '1.0.1', skillsRoot);
}

function writePluginManifest(root: string, version = '1.0.1', skills = './skills/') {
  fs.mkdirSync(path.join(root, '.codex-plugin'), { recursive: true });
  fs.writeFileSync(path.join(root, '.codex-plugin', 'plugin.json'), formatJsonPayload({
    name: 'third-party-research',
    version,
    description: 'Unknown Package fixture carried by Codex Plugin Manager.',
    skills,
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

test('configured Codex carrier ignores a disabled duplicate source for launch precedence', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'opl-configured-carrier-disabled-duplicate-'));
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
        enabled: false,
      },
    ]),
    stderr: '',
    error: null,
  });
  try {
    const readback = runConfiguredCodexPluginCarrier({ descriptor, action: 'list', runner });
    assert.equal(readback.status, 'installed');
    assert.equal(readback.carrier.precedence, 'exact_single_source');
    assert.equal(readback.executor.status, 'callable');
    assert.equal(readback.reason, null);
    assert.equal(readback.installed_version, '1.0.1');
    assert.equal(readback.plugin_source_path, selectedSource);
    assert.equal(readback.carrier.observed_sources.length, 2);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('standard Agent carrier accepts its single canonical local wrapper selector', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'opl-standard-carrier-wrapper-'));
  const source = path.join(root, 'wrapper');
  const skillRoot = path.join(source, 'skills', 'med-autoscience');
  fs.mkdirSync(path.join(source, '.codex-plugin'), { recursive: true });
  fs.mkdirSync(skillRoot, { recursive: true });
  fs.writeFileSync(path.join(skillRoot, 'SKILL.md'), '# MedAutoScience\n', 'utf8');
  fs.writeFileSync(path.join(source, '.codex-plugin', 'plugin.json'), formatJsonPayload({
    name: 'med-autoscience',
    version: '0.2.26',
    skills: './skills/',
  }));
  try {
    const readback = runConfiguredCodexPluginCarrier({
      descriptor: {
        packageId: 'mas',
        carrier: {
          kind: 'codex_plugin_manager',
          pluginId: 'med-autoscience@med-autoscience',
          marketplaceSource: null,
        },
        executor: {
          route: 'codex_cli',
          requiredSkillIds: ['med-autoscience'],
        },
        publicationRef: null,
      },
      action: 'list',
      runner: () => ({
        status: 0,
        stdout: pluginList([{
          pluginId: 'med-autoscience@med-autoscience-local',
          version: '0.2.26',
          sourcePath: source,
          marketplaceSource: path.join(root, 'med-autoscience-local'),
        }]),
        stderr: '',
        error: null,
      }),
    });
    assert.equal(readback.status, 'installed');
    assert.equal(readback.installed_version, '0.2.26');
    assert.equal(readback.carrier.precedence, 'exact_single_source');
    assert.equal(readback.executor.status, 'callable');
    assert.equal(readback.reason, null);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('configured Codex carrier resolves the plugin-declared Skill root and rejects unsafe roots', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'opl-configured-carrier-skill-root-'));
  const sourcePath = path.join(root, 'source');
  const nestedSkillsRoot = './plugins/med-autoscience/skills/';
  const readback = () => runConfiguredCodexPluginCarrier({
    descriptor,
    action: 'list',
    runner: () => ({
      status: 0,
      stdout: pluginList([{
        pluginId: pluginSelector,
        version: '1.0.1',
        sourcePath,
        marketplaceSource: 'fixture-carrier',
      }]),
      stderr: '',
      error: null,
    }),
  });
  try {
    writePluginSource(sourcePath, 'nested owner Skill root', nestedSkillsRoot);
    assert.equal(readback().executor.status, 'callable');

    const outsideSkillsRoot = path.join(root, 'outside-skills');
    fs.mkdirSync(path.join(outsideSkillsRoot, 'third-party-research'), { recursive: true });
    fs.writeFileSync(
      path.join(outsideSkillsRoot, 'third-party-research', 'SKILL.md'),
      '# Escaped Skill\n',
    );
    writePluginManifest(sourcePath, '1.0.1', '../outside-skills');
    assert.equal(readback().reason, 'required_skill_unavailable:third-party-research');

    writePluginManifest(sourcePath, '1.0.1', nestedSkillsRoot);
    const nestedRoot = path.resolve(sourcePath, nestedSkillsRoot);
    const displacedRoot = path.join(root, 'displaced-skills');
    fs.renameSync(nestedRoot, displacedRoot);
    fs.symlinkSync(displacedRoot, nestedRoot, 'dir');
    assert.equal(readback().reason, 'required_skill_unavailable:third-party-research');

    fs.rmSync(nestedRoot);
    writePluginManifest(sourcePath, '1.0.1', './missing-skills/');
    assert.equal(readback().reason, 'required_skill_unavailable:third-party-research');
  } finally {
    removeFixtureTree(root);
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

test('configured Codex carrier refreshes an existing Git marketplace before update or repair', () => {
  for (const action of ['update', 'repair'] as const) {
    const calls: string[] = [];
    const readback = runConfiguredCodexPluginCarrier({
      descriptor: {
        ...descriptor,
        carrier: { ...descriptor.carrier, marketplaceSource: 'gaofeng21cn/example' },
      },
      action,
      runner: ({ args }) => {
        calls.push(args.join(' '));
        if (args.join(' ') === 'plugin marketplace list --json') {
          return {
            status: 0,
            stdout: JSON.stringify({
              marketplaces: [{
                name: 'fixture-carrier',
                marketplaceSource: {
                  sourceType: 'git',
                  source: 'https://github.com/gaofeng21cn/example.git',
                },
              }],
            }),
            stderr: '',
            error: null,
          };
        }
        if (args.join(' ') === 'plugin list --json') {
          return { status: 0, stdout: pluginList([]), stderr: '', error: null };
        }
        return { status: 0, stdout: JSON.stringify({ status: 'ok' }), stderr: '', error: null };
      },
    });
    assert.equal(readback.operation, action);
    assert.deepEqual(calls, [
      'plugin marketplace list --json',
      'plugin marketplace upgrade fixture-carrier --json',
      `plugin add ${pluginSelector} --json`,
      'plugin list --json',
    ]);
  }
});

test('configured Codex carrier adds a missing marketplace and dry-run never refreshes it', () => {
  const calls: string[] = [];
  const configured = {
    ...descriptor,
    carrier: { ...descriptor.carrier, marketplaceSource: 'gaofeng21cn/example' },
  };
  const runner: CodexPluginCommandRunner = ({ args }) => {
    calls.push(args.join(' '));
    if (args.join(' ') === 'plugin marketplace list --json') {
      return {
        status: 0,
        stdout: JSON.stringify({ marketplaces: [] }),
        stderr: '',
        error: null,
      };
    }
    if (args.join(' ') === 'plugin list --json') {
      return { status: 0, stdout: pluginList([]), stderr: '', error: null };
    }
    return { status: 0, stdout: JSON.stringify({ status: 'ok' }), stderr: '', error: null };
  };
  runConfiguredCodexPluginCarrier({ descriptor: configured, action: 'install', runner });
  assert.deepEqual(calls.slice(0, 3), [
    'plugin marketplace list --json',
    'plugin marketplace add gaofeng21cn/example --json',
    `plugin add ${pluginSelector} --json`,
  ]);

  calls.length = 0;
  runConfiguredCodexPluginCarrier({ descriptor: configured, action: 'update', dryRun: true, runner });
  assert.deepEqual(calls, ['plugin list --json']);
});

test('configured Codex carrier replaces a same-name marketplace when developer update changes its source', () => {
  const calls: string[] = [];
  const localSource = '/tmp/fixture-carrier';
  runConfiguredCodexPluginCarrier({
    descriptor: {
      ...descriptor,
      carrier: { ...descriptor.carrier, marketplaceSource: localSource },
    },
    action: 'update',
    runner: ({ args }) => {
      calls.push(args.join(' '));
      if (args.join(' ') === 'plugin marketplace list --json') {
        return {
          status: 0,
          stdout: JSON.stringify({
            marketplaces: [{
              name: 'fixture-carrier',
              marketplaceSource: {
                sourceType: 'git',
                source: 'https://github.com/gaofeng21cn/fixture-carrier.git',
              },
            }],
          }),
          stderr: '',
          error: null,
        };
      }
      if (args.join(' ') === 'plugin list --json') {
        return { status: 0, stdout: pluginList([]), stderr: '', error: null };
      }
      return { status: 0, stdout: JSON.stringify({ status: 'ok' }), stderr: '', error: null };
    },
  });
  assert.deepEqual(calls, [
    'plugin marketplace list --json',
    'plugin marketplace remove fixture-carrier --json',
    `plugin marketplace add ${localSource} --json`,
    `plugin add ${pluginSelector} --json`,
    'plugin list --json',
  ]);
});

test('configured Codex carrier restores the prior marketplace when a source transition cannot be added', () => {
  const calls: string[] = [];
  const priorSource = 'https://github.com/gaofeng21cn/fixture-carrier.git';
  const localSource = '/tmp/fixture-carrier';
  assert.throws(
    () => runConfiguredCodexPluginCarrier({
      descriptor: {
        ...descriptor,
        carrier: { ...descriptor.carrier, marketplaceSource: localSource },
      },
      action: 'update',
      runner: ({ args }) => {
        const command = args.join(' ');
        calls.push(command);
        if (command === 'plugin marketplace list --json') {
          return {
            status: 0,
            stdout: JSON.stringify({
              marketplaces: [{
                name: 'fixture-carrier',
                marketplaceSource: { sourceType: 'git', source: priorSource },
              }],
            }),
            stderr: '',
            error: null,
          };
        }
        if (command === `plugin marketplace add ${localSource} --json`) {
          return { status: 1, stdout: '', stderr: 'fixture failure', error: null };
        }
        return { status: 0, stdout: JSON.stringify({ status: 'ok' }), stderr: '', error: null };
      },
    }),
    (error: any) => error?.details?.failure_code === 'configured_codex_plugin_carrier_action_failed',
  );
  assert.deepEqual(calls, [
    'plugin marketplace list --json',
    'plugin marketplace remove fixture-carrier --json',
    `plugin marketplace add ${localSource} --json`,
    `plugin marketplace add ${priorSource} --json`,
  ]);
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

test('configured Codex carrier repair replaces a stale same-name source after the target is ready', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'opl-configured-carrier-replace-source-'));
  const targetSource = path.join(root, 'target');
  const staleSource = path.join(root, 'stale');
  const calls: string[] = [];
  let targetInstalled = false;
  let staleInstalled = true;
  writePluginSource(targetSource, 'target');
  writePluginSource(staleSource, 'stale');
  const configured = {
    ...descriptor,
    carrier: { ...descriptor.carrier, marketplaceSource: root },
  };
  try {
    const readback = runConfiguredCodexPluginCarrier({
      descriptor: configured,
      action: 'repair',
      runner: ({ args }) => {
        const command = args.join(' ');
        calls.push(command);
        if (command === 'plugin marketplace list --json') {
          return {
            status: 0,
            stdout: JSON.stringify({
              marketplaces: [{
                name: 'fixture-carrier',
                marketplaceSource: { sourceType: 'local', source: root },
              }],
            }),
            stderr: '',
            error: null,
          };
        }
        if (command === `plugin add ${pluginSelector} --json`) {
          targetInstalled = true;
          return { status: 0, stdout: JSON.stringify({ status: 'ok' }), stderr: '', error: null };
        }
        if (command === 'plugin remove third-party-research@historical-carrier --json') {
          assert.equal(targetInstalled, true);
          staleInstalled = false;
          return { status: 0, stdout: JSON.stringify({ status: 'ok' }), stderr: '', error: null };
        }
        if (command === 'plugin list --json') {
          return {
            status: 0,
            stdout: pluginList([
              ...(targetInstalled ? [{
                pluginId: pluginSelector,
                version: '1.0.1',
                sourcePath: targetSource,
                marketplaceSource: root,
              }] : []),
              ...(staleInstalled ? [{
                pluginId: 'third-party-research@historical-carrier',
                version: '1.0.1',
                sourcePath: staleSource,
                marketplaceSource: 'historical-carrier',
              }] : []),
            ]),
            stderr: '',
            error: null,
          };
        }
        return { status: 0, stdout: JSON.stringify({ status: 'ok' }), stderr: '', error: null };
      },
    });
    assert.equal(readback.carrier.precedence, 'exact_single_source');
    assert.equal(readback.executor.status, 'callable');
    assert.deepEqual(calls, [
      'plugin marketplace list --json',
      `plugin add ${pluginSelector} --json`,
      'plugin list --json',
      'plugin remove third-party-research@historical-carrier --json',
      'plugin list --json',
    ]);
  } finally {
    removeFixtureTree(root);
  }
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
  const previousBinary = process.env.OPL_CODEX_PLUGIN_BIN;
  const error = Object.assign(new Error('spawnSync codex ENOENT'), { code: 'ENOENT' });
  delete process.env.OPL_CODEX_PLUGIN_BIN;
  try {
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
  } finally {
    if (previousBinary === undefined) delete process.env.OPL_CODEX_PLUGIN_BIN;
    else process.env.OPL_CODEX_PLUGIN_BIN = previousBinary;
  }
});

test('exposure actions without an installed native owner fail closed before legacy state access', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'opl-native-exposure-owner-required-'));
  const stateDir = path.join(root, 'opl-state');
  const binary = path.join(root, 'empty-codex.mjs');
  const lockPath = path.join(stateDir, 'agent-package-locks.json');
  const ledgerPath = path.join(stateDir, 'agent-package-lifecycle-ledger.json');
  const sqlitePath = path.join(stateDir, 'agent-package-lifecycle.sqlite');
  const invalidLock = '{ invalid native-exposure lock\n';
  const invalidLedger = '{ invalid native-exposure ledger\n';
  const env = {
    HOME: root,
    CODEX_HOME: path.join(root, 'codex-home'),
    OPL_STATE_DIR: stateDir,
    OPL_CODEX_PLUGIN_BIN: binary,
  };
  try {
    fs.writeFileSync(binary, `#!/usr/bin/env node
if (process.argv.slice(2).join(' ') === 'plugin list --json') {
  process.stdout.write(JSON.stringify({ installed: [], available: [] }));
} else {
  process.exitCode = 2;
}
`);
    fs.chmodSync(binary, 0o755);
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(lockPath, invalidLock, 'utf8');
    fs.writeFileSync(ledgerPath, invalidLedger, 'utf8');

    for (const action of ['hide', 'unhide', 'enable', 'disable']) {
      const failure = runCliFailure(['packages', action, '--package-id', 'legacy.package'], env);
      assert.equal(
        failure.payload.error.details.failure_code,
        'agent_package_exposure_native_owner_required',
      );
      assert.equal(failure.payload.error.details.action, action);
      assert.equal(fs.readFileSync(lockPath, 'utf8'), invalidLock);
      assert.equal(fs.readFileSync(ledgerPath, 'utf8'), invalidLedger);
      assert.equal(fs.existsSync(sqlitePath), false);
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('ordinary remote manifests without a native carrier fail closed before legacy state writes', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'opl-native-owner-required-'));
  const stateDir = path.join(root, 'opl-state');
  const homeDir = path.join(root, 'home');
  const pluginSource = path.join(root, 'plugin-source');
  writePluginSource(pluginSource, 'legacy fallback must remain unused');
  try {
    await withAgentPackageServer(async (baseUrl) => {
      await assert.rejects(
        () => runCliAsync([
          'packages', 'install', '--manifest-url', `${baseUrl}/manifest.json`,
          '--package-id', packageId, '--trust-tier', 'third_party_verified',
        ], {
          HOME: homeDir,
          CODEX_HOME: path.join(homeDir, '.codex'),
          OPL_STATE_DIR: stateDir,
        }),
        /agent_package_lifecycle_native_owner_required/,
      );
    }, agentPackageManifest({ pluginSourcePath: pluginSource }));
    assert.equal(fs.existsSync(path.join(stateDir, 'agent-package-locks.json')), false);
    assert.equal(fs.existsSync(path.join(stateDir, 'agent-package-lifecycle-ledger.json')), false);
    assert.equal(fs.existsSync(path.join(stateDir, 'agent-package-lifecycle.sqlite')), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function writeFakeCodex(binary: string, installedVersion = '1.0.1') {
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
  state = { installed: true, version: state.version === '1.0.0' ? ${JSON.stringify(installedVersion)} : state.version };
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
  writeFakeCodex(binary, ownerPackageVersion);
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
    assert.equal(Object.hasOwn(install.opl_agent_package_install, 'package_lock'), false);
    assert.equal(Object.hasOwn(install.opl_agent_package_install, 'lifecycle_receipt'), false);
    assert.equal(Object.hasOwn(install.opl_agent_package_install, 'opl_private_state_writes'), false);
    assert.equal(Object.hasOwn(install.opl_agent_package_install, 'registry_entry'), false);
    assertNoPrivateState();

    const lockPath = path.join(stateDir, 'agent-package-locks.json');
    const invalidLegacyLock = '{ invalid legacy lock\n';
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(lockPath, invalidLegacyLock, 'utf8');
    const status = runCli(['packages', 'status', '--package-id', packageId], env) as any;
    assert.equal(status.opl_agent_package_status.status, 'available');
    assert.equal(status.opl_agent_package_status.operational_ready, true);
    assert.equal(status.opl_agent_package_status.launch_allowed, true);
    assert.equal(Object.hasOwn(status.opl_agent_package_status, 'installed_packages'), false);
    assert.equal(status.opl_agent_package_status.configured_carrier.status, 'installed');
    assert.equal(fs.readFileSync(lockPath, 'utf8'), invalidLegacyLock);

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
    assert.equal(Object.hasOwn(activate.opl_agent_package_activation, 'package_lock'), false);
    assert.equal(Object.hasOwn(activate.opl_agent_package_activation, 'lifecycle_receipt'), false);
    assert.equal(Object.hasOwn(activate.opl_agent_package_activation, 'scope_materializations'), false);
    assert.equal(Object.hasOwn(activate.opl_agent_package_activation, 'package_dependency_readiness'), false);
    assert.equal(Object.hasOwn(activate.opl_agent_package_activation, 'materialization_readiness'), false);
    assert.equal(Object.hasOwn(activate.opl_agent_package_activation, 'package_use_binding'), false);
    assert.equal(Object.hasOwn(activate.opl_agent_package_activation, 'use_receipt'), false);
    assert.equal(Object.hasOwn(activate.opl_agent_package_activation, 'use_receipt_ref'), false);
    assert.equal(activate.opl_agent_package_activation.launch_state, 'ready');
    assertNoPrivateState();

    const activateDryRun = runCli([
      'packages', 'activate', packageId,
      '--scope', 'workspace', '--target-workspace', workspace, '--dry-run',
    ], env) as any;
    assert.equal(activateDryRun.opl_agent_package_activation.status, 'validated_no_write');
    assert.equal(activateDryRun.opl_agent_package_activation.writes_performed, false);
    assert.equal(Object.hasOwn(activateDryRun.opl_agent_package_activation, 'package_lock'), false);
    assert.equal(Object.hasOwn(activateDryRun.opl_agent_package_activation, 'lifecycle_receipt'), false);
    assert.equal(Object.hasOwn(activateDryRun.opl_agent_package_activation, 'materialization_readiness'), false);
    assertNoPrivateState();

    const hideDryRun = runCli(['packages', 'hide', '--package-id', packageId, '--dry-run'], env) as any;
    assert.equal(hideDryRun.opl_agent_package_exposure.status, 'validated_no_write');
    assert.equal(Object.hasOwn(hideDryRun.opl_agent_package_exposure, 'package_lock'), false);
    assert.equal(Object.hasOwn(hideDryRun.opl_agent_package_exposure, 'lifecycle_receipt'), false);
    assert.equal(hideDryRun.opl_agent_package_exposure.home_shortcut_preferences[0].visible, false);
    assertNoPrivateState();

    const hidden = runCli(['packages', 'hide', '--package-id', packageId], env) as any;
    assert.equal(hidden.opl_agent_package_exposure.status, 'hidden');
    assert.equal(Object.hasOwn(hidden.opl_agent_package_exposure, 'package_lock'), false);
    assert.equal(Object.hasOwn(hidden.opl_agent_package_exposure, 'lifecycle_receipt'), false);
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
    assert.equal(Object.hasOwn(unhidden.opl_agent_package_exposure, 'package_lock'), false);
    assert.equal(Object.hasOwn(unhidden.opl_agent_package_exposure, 'lifecycle_receipt'), false);
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
    assert.equal(Object.hasOwn(entry, 'legacy_private_lifecycle_state_present'), false);
    assertNoPrivateState();

    for (const action of ['update', 'repair']) {
      const readback = runCli(['packages', action, packageId], env) as any;
      assert.equal(Object.hasOwn(readback[`opl_agent_package_${action}`], 'package_lock'), false);
      assert.equal(Object.hasOwn(readback[`opl_agent_package_${action}`], 'lifecycle_receipt'), false);
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

test('published first-party owner descriptor routes a scoped native action without private lifecycle writes', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'opl-first-party-owner-carrier-'));
  const stateDir = path.join(root, 'opl-state');
  const binary = path.join(root, 'fake-codex.mjs');
  const pluginSource = path.join(root, 'plugin-source');
  const skillRoot = path.join(pluginSource, 'skills', 'opl-relay');
  fs.mkdirSync(skillRoot, { recursive: true });
  fs.writeFileSync(path.join(skillRoot, 'SKILL.md'), '# OPL Relay\n');
  fs.mkdirSync(path.join(pluginSource, '.codex-plugin'), { recursive: true });
  fs.writeFileSync(path.join(pluginSource, '.codex-plugin', 'plugin.json'), formatJsonPayload({
    name: 'opl-relay',
    version: '0.5.3',
    description: 'OPL Relay native carrier fixture.',
    skills: './skills/',
  }));
  fs.writeFileSync(
    path.join(pluginSource, 'opl-package.json'),
    formatJsonPayload({
      surface_kind: 'opl_agent_package_manifest.v1',
      kind: 'agent',
      agent_id: 'opl-relay',
      package_id: 'opl-relay',
      domain_id: 'communications_mail',
      display_name: 'OPL Relay',
      publisher: 'one-person-lab',
      version: '0.5.2',
      source: 'first_party_repo_local',
      carrier_source_role: 'codex_plugin_default_carrier_not_package_truth',
      source_repo: 'https://github.com/gaofeng21cn/opl-relay.git',
      schema_ref: 'one-person-lab/contracts/opl-framework/agent-package-manifest.schema.json',
      domain_descriptor_ref: 'contracts/domain_descriptor.json',
      task_provider_ref: 'contracts/domain_descriptor.json#/standard_agent_interface/stage_catalog',
      action_catalog_ref: 'contracts/action_catalog.json',
      view_refs: [],
      entrypoints: [{
        entrypoint_id: 'codex_primary_skill',
        entrypoint_kind: 'codex_skill',
        source_ref: 'skills/opl-relay/SKILL.md',
        carrier_ref: 'skills/opl-relay/SKILL.md',
        authority: 'carrier_only_not_domain_truth',
      }],
      codex_surface: {
        plugin_id: 'opl-relay',
        plugin_source_path: '.',
        required_skill_ids: ['opl-relay'],
      },
      requires: [],
      capability_dependencies: [],
    }),
  );
  fs.writeFileSync(binary, `#!/usr/bin/env node
const args = process.argv.slice(2);
const installed = {
  pluginId: 'opl-relay@opl-relay',
  version: '0.5.3',
  installed: true,
  enabled: true,
  source: { source: 'local', path: process.env.FIXTURE_PLUGIN_SOURCE },
  marketplaceSource: { sourceType: 'github', source: 'gaofeng21cn/opl-relay' },
};
if (args.join(' ') === 'plugin list --json') {
  process.stdout.write(JSON.stringify({ installed: [installed], available: [] }));
} else if (args.join(' ') === 'plugin marketplace add gaofeng21cn/opl-relay --json') {
  process.stdout.write(JSON.stringify({ status: 'ok' }));
} else if (args.join(' ') === 'plugin add opl-relay@opl-relay --json') {
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
    const update = runCli(['packages', 'update', 'opl-relay'], env) as any;
    const updateSurface = update.opl_agent_package_update;
    assert.equal(updateSurface.package_id, 'opl-relay');
    assert.equal(updateSurface.status, 'updated');
    assert.equal(Object.hasOwn(updateSurface, 'package_lock'), false);
    assert.equal(Object.hasOwn(updateSurface, 'lifecycle_receipt'), false);
    assert.equal(Object.hasOwn(updateSurface, 'opl_private_state_writes'), false);
    assert.equal(Object.hasOwn(updateSurface, 'registry_entry'), false);
    assert.equal(updateSurface.configured_carrier.status, 'installed');
    assert.equal(updateSurface.configured_carrier.operation, 'update');
    assert.deepEqual(
      updateSurface.configured_carrier.native_command,
      ['plugin', 'add', 'opl-relay@opl-relay', '--json'],
    );
    assert.equal(updateSurface.configured_carrier.native_action_dispatched, true);

    const activation = runCli([
      'packages', 'activate', 'opl-relay',
      '--scope', 'workspace', '--target-workspace', root,
    ], env) as any;
    const surface = activation.opl_agent_package_activation;
    assert.equal(surface.package_id, 'opl-relay');
    assert.equal(surface.status, 'already_activated');
    assert.equal(surface.writes_performed, false);
    assert.equal(Object.hasOwn(surface, 'package_lock'), false);
    assert.equal(Object.hasOwn(surface, 'lifecycle_receipt'), false);
    assert.equal(Object.hasOwn(surface, 'scope_materializations'), false);
    assert.equal(Object.hasOwn(surface, 'package_dependency_readiness'), false);
    assert.equal(Object.hasOwn(surface, 'materialization_readiness'), false);
    assert.equal(Object.hasOwn(surface, 'package_use_binding'), false);
    assert.equal(Object.hasOwn(surface, 'use_receipt'), false);
    assert.equal(Object.hasOwn(surface, 'use_receipt_ref'), false);
    const status = runCli(['packages', 'status', '--package-id', 'opl-relay'], env) as any;
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

    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(
      path.join(stateDir, 'agent-package-locks.json'),
      formatJsonPayload({
        surface_kind: 'opl_agent_package_lock_index',
        version: 'opl-agent-package-lock-index.v1',
        packages: [],
      }),
    );
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
    assert.equal(Object.hasOwn(descriptorStatus.opl_agent_package_status, 'installed_packages'), false);
    assert.equal(Object.hasOwn(descriptorStatus.opl_agent_package_status, 'owner_route_readback'), false);

    const descriptorDirectory = runCli(['packages', 'list', '--detail', 'full'], env) as any;
    const descriptorEntry = descriptorDirectory.opl_agent_packages.directory.entries.find(
      (entry: any) => entry.package_id === packageId,
    );
    assert.equal(Object.hasOwn(descriptorEntry, 'lock_ref'), false);
    assert.equal(Object.hasOwn(descriptorEntry, 'legacy_private_lifecycle_state_present'), false);
    assert.equal(descriptorDirectory.opl_agent_packages.installed_package_count, 1);
    assert.equal(descriptorDirectory.opl_agent_packages.status, 'available');
    assert.equal(descriptorDirectory.opl_agent_packages.directory.status, 'available');
    assert.equal(Object.hasOwn(descriptorDirectory.opl_agent_packages, 'legacy_authority'), false);
    assert.equal(Object.hasOwn(descriptorDirectory.opl_agent_packages.directory, 'legacy_authority'), false);
    assert.equal(Object.hasOwn(descriptorDirectory.opl_agent_packages, 'installed_packages'), false);
    assert.equal(Object.hasOwn(descriptorDirectory.opl_agent_packages, 'owner_route_readback'), false);
    assert.equal(fs.readFileSync(path.join(stateDir, 'agent-package-locks.json'), 'utf8'), legacyLockBytes);
    assert.equal(fs.existsSync(legacyLedgerPath), false);

    const activated = runCli([
      'packages', 'activate', packageId,
      '--scope', 'workspace', '--target-workspace', workspace,
    ], env) as any;
    assert.equal(activated.opl_agent_package_activation.status, 'already_activated');
    assert.equal(activated.opl_agent_package_activation.writes_performed, false);
    assert.equal(Object.hasOwn(activated.opl_agent_package_activation, 'package_lock'), false);
    assert.equal(Object.hasOwn(activated.opl_agent_package_activation, 'lifecycle_receipt'), false);
    assert.equal(fs.readFileSync(path.join(stateDir, 'agent-package-locks.json'), 'utf8'), legacyLockBytes);
    assert.equal(fs.existsSync(legacyLedgerPath), false);

    const hidden = runCli(['packages', 'hide', '--package-id', packageId], env) as any;
    assert.equal(hidden.opl_agent_package_exposure.status, 'hidden');
    assert.equal(Object.hasOwn(hidden.opl_agent_package_exposure, 'package_lock'), false);
    assert.equal(Object.hasOwn(hidden.opl_agent_package_exposure, 'lifecycle_receipt'), false);
    assert.deepEqual(hidden.opl_agent_package_exposure.home_shortcut_preferences.map((entry: any) => entry.visible), [false]);
    assert.equal(fs.readFileSync(path.join(stateDir, 'agent-package-locks.json'), 'utf8'), legacyLockBytes);
    assert.equal(fs.existsSync(legacyLedgerPath), false);

    const unhidden = runCli(['packages', 'unhide', '--package-id', packageId], env) as any;
    assert.equal(unhidden.opl_agent_package_exposure.status, 'visible');
    assert.equal(Object.hasOwn(unhidden.opl_agent_package_exposure, 'package_lock'), false);
    assert.equal(Object.hasOwn(unhidden.opl_agent_package_exposure, 'lifecycle_receipt'), false);
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
    assert.equal(directory.opl_agent_packages.status, 'available');
    assert.equal(Object.hasOwn(directory.opl_agent_packages, 'legacy_authority'), false);
    assert.equal(Object.hasOwn(directory.opl_agent_packages.directory, 'legacy_authority'), false);
    assert.equal(directory.opl_agent_packages.directory.status, 'available');
    assert.equal(directoryEntry.installed, true);
    assert.equal(directory.opl_agent_packages.installed_package_count, 1);
    assert.equal(fs.readFileSync(lockPath, 'utf8'), invalidLegacyLock);

    const globalStatus = runCli(['packages', 'status'], env) as any;
    assert.equal(globalStatus.opl_agent_package_status.status, 'available');
    assert.equal(globalStatus.opl_agent_package_status.installed_package_count, 1);
    assert.equal(Object.hasOwn(globalStatus.opl_agent_package_status, 'legacy_authority'), false);
    assert.equal(fs.readFileSync(lockPath, 'utf8'), invalidLegacyLock);

    const appState = runCli(['app', 'state', '--profile', 'fast'], env) as any;
    assert.equal(appState.app_state.agent_packages.directory.entries.some(
      (entry: any) => entry.package_id === packageId,
    ), true);
    assert.equal(appState.app_state.agent_packages.directory.status, 'available');
    assert.equal(Object.hasOwn(appState.app_state.agent_packages.directory, 'legacy_authority'), false);
    assert.equal(appState.app_state.agent_packages.status_index.installed_package_count, 1);
    assert.equal(fs.readFileSync(lockPath, 'utf8'), invalidLegacyLock);

    Object.assign(process.env, env);
    const readStatus = createOplAgentPackageStatusReader();
    const preloadedGlobalStatus = readStatus({
      detail: 'fast',
    }).opl_agent_package_status;
    assert.equal(preloadedGlobalStatus.status, 'available');
    assert.equal(preloadedGlobalStatus.installed_package_count, 1);
    assert.equal(fs.readFileSync(lockPath, 'utf8'), invalidLegacyLock);

    const invalidLegacyShape = formatJsonPayload({
      surface_kind: 'opl_agent_package_lock_index',
      version: 'opl-agent-package-lock-index.v1',
      packages: [{
        package_id: 'NONCANONICAL.PACKAGE',
      }],
    });
    fs.writeFileSync(lockPath, invalidLegacyShape, 'utf8');

    for (let index = 0; index < 2; index += 1) {
      const status = readStatus({
        packageId,
        detail: 'fast',
      }).opl_agent_package_status;
      assert.equal(status.status, 'available');
      assert.equal(status.operational_ready, true);
      assert.equal(status.launch_allowed, true);
      assert.equal(status.installed_package_count, 1);
      assert.equal(Object.hasOwn(status, 'installed_packages'), false);
      assert.equal(Object.hasOwn(status, 'legacy_authority'), false);
    }
    const legacyOnly = readStatus({ packageId: 'legacy.package', detail: 'fast' })
      .opl_agent_package_status;
    assert.equal(legacyOnly.status, 'not_installed');
    assert.equal(legacyOnly.installed_package_count, 0);
      assert.equal(Object.hasOwn(legacyOnly, 'installed_packages'), false);
    assert.equal(fs.readFileSync(lockPath, 'utf8'), invalidLegacyShape);
  } finally {
    for (const [name, value] of previous) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
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

function unavailableCodexRunner(): CodexPluginCommandRunner {
  return () => ({
    status: null,
    stdout: '',
    stderr: '',
    error: Object.assign(new Error('spawnSync codex ENOENT'), { code: 'ENOENT' }),
  });
}

test('configured Codex carrier validates a local readback when the CLI is unavailable without extending the fallback to writes', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'opl-configured-carrier-local-readback-'));
  const marketplaceRoot = path.join(root, 'marketplace');
  const codexHome = path.join(root, 'codex-home');
  const configPath = path.join(codexHome, 'config.toml');
  const nativeDescriptor = {
    ...descriptor,
    carrier: {
      ...descriptor.carrier,
      marketplaceSource: marketplaceRoot,
    },
  };
  const env = { CODEX_HOME: codexHome };
  try {
    writeNativeMarketplace(marketplaceRoot, '1.0.7');
    fs.mkdirSync(codexHome, { recursive: true });
    fs.writeFileSync(configPath, [
      '[marketplaces.fixture-carrier]',
      'source_type = "local"',
      `source = ${JSON.stringify(marketplaceRoot)}`,
      '',
      '[plugins."third-party-research@fixture-carrier"]',
      'enabled = true',
      '',
    ].join('\n'), 'utf8');

    const readback = runConfiguredCodexPluginCarrier({
      descriptor: nativeDescriptor,
      action: 'list',
      env,
      runner: unavailableCodexRunner(),
    });
    assert.equal(readback.status, 'installed');
    assert.equal(readback.installed_version, '1.0.7');
    assert.equal(readback.enabled, true);
    assert.equal(readback.executor.status, 'callable');
    assert.equal(readback.carrier.precedence, 'exact_single_source');
    assert.equal(readback.carrier.marketplace_source, marketplaceRoot);
    assert.equal(
      readback.plugin_source_path,
      path.join(marketplaceRoot, 'plugins', 'third-party-research'),
    );
    assert.equal(readback.native_action_dispatched, false);

    assert.throws(
      () => runConfiguredCodexPluginCarrier({
        descriptor: nativeDescriptor,
        action: 'update',
        env,
        runner: unavailableCodexRunner(),
      }),
      (error: any) => error?.details?.failure_code
        === 'configured_codex_plugin_carrier_unavailable',
    );

    fs.appendFileSync(configPath, [
      '[plugins."third-party-research@other-marketplace"]',
      'enabled = true',
      '',
    ].join('\n'), 'utf8');
    const ambiguous = runConfiguredCodexPluginCarrier({
      descriptor: nativeDescriptor,
      action: 'list',
      env,
      runner: unavailableCodexRunner(),
    });
    assert.equal(ambiguous.status, 'physical_unavailable');
    assert.equal(ambiguous.reason, 'configured_codex_plugin_carrier_local_config_ambiguous');
  } finally {
    removeFixtureTree(root);
  }
});

test('configured Codex carrier local readback rejects marketplace path escape and symlink sources', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'opl-configured-carrier-local-readback-safety-'));
  const marketplaceRoot = path.join(root, 'marketplace');
  const codexHome = path.join(root, 'codex-home');
  const configPath = path.join(codexHome, 'config.toml');
  const marketplacePath = path.join(marketplaceRoot, '.agents', 'plugins', 'marketplace.json');
  const nativeDescriptor = {
    ...descriptor,
    carrier: {
      ...descriptor.carrier,
      marketplaceSource: marketplaceRoot,
    },
  };
  const env = { CODEX_HOME: codexHome };
  const readback = () => runConfiguredCodexPluginCarrier({
    descriptor: nativeDescriptor,
    action: 'list',
    env,
    runner: unavailableCodexRunner(),
  });
  try {
    writeNativeMarketplace(marketplaceRoot, '1.0.7');
    fs.mkdirSync(codexHome, { recursive: true });
    fs.writeFileSync(configPath, [
      '[marketplaces.fixture-carrier]',
      'source_type = "local"',
      `source = ${JSON.stringify(marketplaceRoot)}`,
      '',
      '[plugins."third-party-research@fixture-carrier"]',
      'enabled = true',
      '',
    ].join('\n'), 'utf8');

    const manifest = parseJsonText(fs.readFileSync(marketplacePath, 'utf8')) as any;
    manifest.plugins[0].source.path = '../../outside';
    fs.writeFileSync(marketplacePath, formatJsonPayload(manifest));
    assert.equal(
      readback().reason,
      'configured_codex_plugin_carrier_local_source_unsafe',
    );

    writeNativeMarketplace(marketplaceRoot, '1.0.7');
    const pluginRoot = path.join(marketplaceRoot, 'plugins', 'third-party-research');
    const displaced = path.join(root, 'displaced-plugin');
    fs.renameSync(pluginRoot, displaced);
    fs.symlinkSync(displaced, pluginRoot, 'dir');
    assert.equal(
      readback().reason,
      'configured_codex_plugin_carrier_local_source_unsafe',
    );
  } finally {
    removeFixtureTree(root);
  }
});

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
