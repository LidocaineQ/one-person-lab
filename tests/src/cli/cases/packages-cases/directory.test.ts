import crypto from 'node:crypto';
import { pathToFileURL } from 'node:url';

import {
  agentPackageManifest,
  assert,
  formatJsonPayload,
  fs,
  os,
  parseJsonText,
  path,
  repoRoot,
  runCli,
  runCliFailure,
  test,
} from './helpers.ts';
import { createFakeCodexFixture } from '../../helpers.ts';
import {
  buildAgentPackageDirectory,
  enrichRegistryCacheManifestMetadata,
  normalizePackageCatalogRegistry,
} from '../../../../../src/modules/connect/agent-package-registry-parts/directory.ts';
import {
  discoverInstalledCodexPluginDescriptors,
  discoverInstalledPackageDescriptors,
} from '../../../../../src/modules/connect/agent-package-registry-parts/installed-codex-plugin-directory.ts';
import { getOplPackageSpecs } from '../../../../../src/modules/connect/package-distribution.ts';
import {
  normalizePackageManifest,
  normalizeRegistry,
} from '../../../../../src/modules/connect/agent-package-registry-parts/manifest-normalizers.ts';
import { fetchAndValidateRegistry } from '../../../../../src/modules/connect/agent-package-registry-parts/selection.ts';
import { readFirstPartyPackageCatalogSnapshot } from '../../../../../src/modules/connect/agent-package-registry-parts/release-catalog-cache.ts';
import {
  defaultHomeShortcutPreferences,
  mergedHomeShortcutPreferences,
} from '../../../../../src/modules/connect/agent-package-registry-parts/home-shortcuts.ts';
import { validateJsonSchemaPayload } from '../../../../../src/kernel/schema-registry.ts';
import { listOplAgentPackages } from '../../../../../src/modules/connect/agent-package-registry.ts';

const CANONICAL_PACKAGE_ROLES = new Set([
  'standard_agent',
  'framework_capability_package',
  'workflow_profile',
]);
const CANONICAL_PACKAGE_IDS = [
  'mas',
  'mag',
  'rca',
  'oma',
  'obf',
  'mas-scholar-skills',
  'opl-flow',
];

test('installed Codex plugins project owner descriptors without a registry entry', () => {
  const sourceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'opl-installed-plugin-descriptor-'));
  const stateFixture = isolatedPackageEnv('installed-plugin-descriptor');
  const previousStateDir = process.env.OPL_STATE_DIR;
  process.env.OPL_STATE_DIR = stateFixture.env.OPL_STATE_DIR;
  try {
    const descriptor = agentPackageManifest({
      packageId: 'unknown.installed.agent',
      agentId: 'unknown-installed-agent',
      pluginId: 'unknown-installed-agent',
    });
    fs.writeFileSync(path.join(sourceRoot, 'opl-package.json'), formatJsonPayload(descriptor));
    const discovered = discoverInstalledCodexPluginDescriptors({
      runner: () => ({
        status: 0,
        stdout: JSON.stringify({
          installed: [{
            pluginId: 'unknown-installed-agent@owner-carrier',
            version: '1.2.3',
            enabled: true,
            installed: true,
            source: { source: 'local', path: sourceRoot },
            marketplaceSource: { sourceType: 'local', source: '/tmp/owner-carrier' },
          }],
        }),
        stderr: '',
        error: null,
      }),
    });
    const owner = discovered.get('unknown.installed.agent');
    assert.ok(owner);
    assert.equal(owner.manifest.package_id, 'unknown.installed.agent');
    assert.equal(owner.manifest.display_name, 'Third Party Research');
    assert.equal(owner.sourcePath, sourceRoot);
    assert.equal(owner.carrier.carrier.pluginId, 'unknown-installed-agent@owner-carrier');
    assert.equal(owner.enabled, true);
    assert.equal(owner.carrier_readback.kind, 'local');
    assert.equal(owner.carrier_readback.identity, 'unknown-installed-agent@owner-carrier');
    assert.equal(owner.carrier_readback.lifecycle_authority, 'carrier_owned');
    assert.deepEqual(owner.readiness, {
      installed: true,
      physical_status: 'available',
      callability: 'callable',
      legacy_lifecycle_state_present: false,
    });

    const directory = buildAgentPackageDirectory({
      registryCache: null,
      locks: [],
      detail: 'fast',
      installedCodexPluginDescriptors: discovered,
      configuredCarrierReadbacks: new Map([[
        'unknown.installed.agent',
        {
          surface_kind: 'opl_configured_codex_plugin_carrier_readback.v1',
          package_id: 'unknown.installed.agent',
          carrier: {
            kind: 'codex_plugin_manager',
            plugin_id: 'unknown-installed-agent@owner-carrier',
            marketplace_source: '/tmp/owner-carrier',
            observed_sources: [{
              plugin_id: 'unknown-installed-agent@owner-carrier',
              marketplace_source: '/tmp/owner-carrier',
              installed_version: '1.2.3',
              enabled: true,
              plugin_source_path: sourceRoot,
              source_tree_sha256: null,
            }],
            precedence: 'exact_single_source',
          },
          executor: {
            route: 'codex_cli',
            required_skill_ids: ['unknown-installed-agent'],
            status: 'callable',
          },
          publication_ref: null,
          status: 'installed',
          installed_version: '1.2.3',
          enabled: true,
          plugin_source_path: sourceRoot,
          operation: 'list',
          native_command: ['plugin', 'list', '--json'],
          native_action_dispatched: false,
          reason: null,
        },
      ]]),
    });
    const entry = directory.entries.find((candidate) => candidate.package_id === 'unknown.installed.agent');
    assert.ok(entry);
    assert.equal(entry?.source_explanation.kind, 'installed_codex_plugin_descriptor');
    assert.equal(entry?.installed, true);
    assert.equal(entry?.configured_carrier?.carrier.plugin_id, 'unknown-installed-agent@owner-carrier');
    assert.equal(entry?.recommended_action, null);
    assert.equal(entry?.recommended_action_ref, null);
  } finally {
    if (previousStateDir === undefined) delete process.env.OPL_STATE_DIR;
    else process.env.OPL_STATE_DIR = previousStateDir;
    fs.rmSync(stateFixture.home, { recursive: true, force: true });
    fs.rmSync(sourceRoot, { recursive: true, force: true });
  }
});

test('installed Codex plugins fall back to the native plugin manifest without package-id tables', () => {
  const sourceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'opl-native-plugin-descriptor-'));
  const skillRoot = path.join(sourceRoot, 'skills', 'native-capability');
  fs.mkdirSync(skillRoot, { recursive: true });
  fs.writeFileSync(path.join(skillRoot, 'SKILL.md'), '# Native capability\n');
  fs.mkdirSync(path.join(sourceRoot, '.codex-plugin'));
  fs.writeFileSync(
    path.join(sourceRoot, '.codex-plugin', 'plugin.json'),
    formatJsonPayload({
      name: 'unknown-native-plugin',
      version: '1.2.3',
      description: 'Unknown native plugin',
      author: { name: 'Example owner' },
      repository: 'https://example.test/unknown-native-plugin',
      skills: './skills/',
      interface: {
        displayName: 'Unknown Native Plugin',
        longDescription: 'A future plugin discovered from its own carrier manifest.',
      },
    }),
  );
  try {
    const discovered = discoverInstalledCodexPluginDescriptors({
      runner: () => ({
        status: 0,
        stdout: JSON.stringify({
          installed: [{
            pluginId: 'unknown-native-plugin@example-marketplace',
            version: '1.2.3',
            enabled: true,
            installed: true,
            source: { source: 'local', path: sourceRoot },
            marketplaceSource: { sourceType: 'local', source: '/tmp/example-marketplace' },
          }],
        }),
        stderr: '',
        error: null,
      }),
    });
    const descriptor = discovered.get('unknown-native-plugin');
    assert.ok(descriptor);
    assert.equal(descriptor.manifest.display_name, 'Unknown Native Plugin');
    assert.equal(descriptor.manifest.publisher, 'Example owner');
    assert.deepEqual(descriptor.manifest.required_skill_ids, ['native-capability']);
    assert.equal(descriptor.manifest.configured_codex_plugin_carrier?.carrier.pluginId, 'unknown-native-plugin@example-marketplace');
    assert.equal(descriptor.manifest.content_lock_paths.length, 0);
    assert.equal(descriptor.manifest.rollback_ref, 'native-carrier-owned');
    assert.equal(descriptor.manifestPath, path.join(sourceRoot, '.codex-plugin', 'plugin.json'));
  } finally {
    fs.rmSync(sourceRoot, { recursive: true, force: true });
  }
});

test('carrier-neutral producer discovers an unknown installed carrier without Framework lifecycle state', () => {
  const sourceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'opl-neutral-carrier-descriptor-'));
  const stateFixture = isolatedPackageEnv('neutral-carrier-descriptor');
  const previousStateDir = process.env.OPL_STATE_DIR;
  const previousBinary = process.env.OPL_CODEX_PLUGIN_BIN;
  process.env.OPL_STATE_DIR = stateFixture.env.OPL_STATE_DIR;
  process.env.OPL_CODEX_PLUGIN_BIN = path.join(stateFixture.home, 'fake-codex');
  fs.mkdirSync(path.join(sourceRoot, '.codex-plugin'), { recursive: true });
  fs.writeFileSync(
    path.join(sourceRoot, '.codex-plugin', 'plugin.json'),
    formatJsonPayload({
      name: 'future-carrier-package',
      version: '9.1.0',
      description: 'A package from a future carrier.',
      skills: [],
    }),
  );
  try {
    const discovered = discoverInstalledPackageDescriptors({
      runner: () => ({
        status: 0,
        stdout: JSON.stringify({
          installed: [{
            pluginId: 'future-carrier-package@future-carrier',
            version: '9.1.0',
            enabled: true,
            source: { source: 'future-carrier', path: sourceRoot },
            marketplaceSource: { sourceType: 'future', source: 'future://catalog' },
          }],
        }),
        stderr: '',
        error: null,
      }),
    });
    const descriptor = discovered.get('future-carrier-package');
    assert.ok(descriptor);
    assert.equal(descriptor?.carrier_readback.kind, 'future-carrier');
    assert.equal(descriptor?.carrier_readback.lifecycle_authority, 'carrier_owned');
    assert.equal(descriptor?.readiness.legacy_lifecycle_state_present, false);
    assert.equal(descriptor?.manifest.rollback_ref, 'native-carrier-owned');
    assert.equal(descriptor?.manifest.content_lock_paths.length, 0);
    assert.equal(descriptor?.manifest.configured_codex_plugin_carrier?.carrier.pluginId, 'future-carrier-package@future-carrier');
    const directory = buildAgentPackageDirectory({
      registryCache: null,
      locks: [],
      detail: 'fast',
      installedCodexPluginDescriptors: discovered,
      configuredCarrierReadbacks: new Map([[
        'future-carrier-package',
        {
          surface_kind: 'opl_configured_codex_plugin_carrier_readback.v1',
          package_id: 'future-carrier-package',
          carrier: {
            kind: 'codex_plugin_manager',
            plugin_id: 'future-carrier-package@future-carrier',
            marketplace_source: 'future://catalog',
            observed_sources: [{
              plugin_id: 'future-carrier-package@future-carrier',
              marketplace_source: 'future://catalog',
              installed_version: '9.1.0',
              enabled: true,
              plugin_source_path: sourceRoot,
              source_tree_sha256: null,
            }],
            precedence: 'exact_single_source',
          },
          executor: {
            route: 'codex_cli',
            required_skill_ids: [],
            status: 'callable',
          },
          publication_ref: null,
          status: 'installed',
          installed_version: '9.1.0',
          enabled: true,
          plugin_source_path: sourceRoot,
          operation: 'list',
          native_command: ['plugin', 'list', '--json'],
          native_action_dispatched: false,
          reason: null,
        },
      ]]),
    });
    const entry = directory.entries.find((candidate) => candidate.package_id === 'future-carrier-package');
    assert.ok(entry);
    assert.equal(entry?.installed, true);
    assert.equal(entry?.source_explanation.kind, 'installed_codex_plugin_descriptor');
  } finally {
    if (previousStateDir === undefined) delete process.env.OPL_STATE_DIR;
    else process.env.OPL_STATE_DIR = previousStateDir;
    if (previousBinary === undefined) delete process.env.OPL_CODEX_PLUGIN_BIN;
    else process.env.OPL_CODEX_PLUGIN_BIN = previousBinary;
    assert.equal(fs.existsSync(path.join(stateFixture.env.OPL_STATE_DIR, 'agent-package-locks.json')), false);
    assert.equal(fs.existsSync(path.join(stateFixture.env.OPL_STATE_DIR, 'agent-package-lifecycle-ledger.json')), false);
    fs.rmSync(stateFixture.home, { recursive: true, force: true });
    fs.rmSync(sourceRoot, { recursive: true, force: true });
  }
});

test('native manifest fallback does not synthesize a second first-party Package authority', () => {
  const sourceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'opl-first-party-native-plugin-'));
  fs.mkdirSync(path.join(sourceRoot, '.codex-plugin'));
  fs.writeFileSync(
    path.join(sourceRoot, '.codex-plugin', 'plugin.json'),
    formatJsonPayload({
      name: 'redcube-ai',
      version: '0.2.9',
      description: 'Installed first-party carrier observation.',
    }),
  );
  const runner = () => ({
    status: 0,
    stdout: JSON.stringify({
      installed: [{
        pluginId: 'redcube-ai@redcube-ai',
        version: '0.2.9',
        enabled: true,
        installed: true,
        source: { source: 'local', path: sourceRoot },
        marketplaceSource: { sourceType: 'local', source: '/tmp/redcube-ai' },
      }],
    }),
    stderr: '',
    error: null,
  });
  try {
    assert.equal(discoverInstalledCodexPluginDescriptors({ runner }).size, 0);
    assert.equal(discoverInstalledCodexPluginDescriptors({ packageId: 'rca', runner }).size, 0);
  } finally {
    fs.rmSync(sourceRoot, { recursive: true, force: true });
  }
});

test('invalid installed Codex descriptors degrade locally without hiding valid plugins', () => {
  const validRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'opl-installed-plugin-valid-'));
  const invalidRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'opl-installed-plugin-invalid-'));
  try {
    fs.writeFileSync(
      path.join(validRoot, 'opl-package.json'),
      formatJsonPayload(agentPackageManifest({
        packageId: 'valid.installed.agent',
        agentId: 'valid-installed-agent',
        pluginId: 'valid-installed-agent',
      })),
    );
    fs.writeFileSync(path.join(invalidRoot, 'opl-package.json'), '{"surface_kind":"unknown"}\n');
    const discovered = discoverInstalledCodexPluginDescriptors({
      runner: () => ({
        status: 0,
        stdout: JSON.stringify({
          installed: [
            {
              pluginId: 'invalid-installed-agent@owner-carrier',
              version: '1.0.0',
              enabled: true,
              installed: true,
              source: { source: 'local', path: invalidRoot },
            },
            {
              pluginId: 'valid-installed-agent@owner-carrier',
              version: '1.0.0',
              enabled: true,
              installed: true,
              source: { source: 'local', path: validRoot },
            },
          ],
        }),
        stderr: '',
        error: null,
      }),
    });
    assert.deepEqual([...discovered.keys()], ['valid.installed.agent']);
  } finally {
    fs.rmSync(validRoot, { recursive: true, force: true });
    fs.rmSync(invalidRoot, { recursive: true, force: true });
  }
});

test('real package list projects an installed owner descriptor with an empty registry cache', () => {
  const sourceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'opl-installed-plugin-list-source-'));
  const stateFixture = isolatedPackageEnv('installed-plugin-list');
  const binary = path.join(stateFixture.home, 'fake-codex');
  const previousStateDir = process.env.OPL_STATE_DIR;
  const previousBinary = process.env.OPL_CODEX_PLUGIN_BIN;
  process.env.OPL_STATE_DIR = stateFixture.env.OPL_STATE_DIR;
  process.env.OPL_CODEX_PLUGIN_BIN = binary;
  try {
    const packageId = 'unknown.installed.capability';
    fs.writeFileSync(
      path.join(sourceRoot, 'opl-package.json'),
      formatJsonPayload({
        surface_kind: 'opl_capability_package_manifest.v2',
        package_id: packageId,
        display_name: 'Unknown Installed Capability',
        publisher: 'example-owner',
        version: '1.0.0',
        source: 'third_party',
        package_role: 'framework_capability_package',
        capability_abi: { id: 'unknown.installed.capability.v1', version: '1.0.0' },
        exports: {
          core_skill_ids: ['unknown-capability'],
          specialty_skill_ids: [],
          core_module_ids: ['unknown.capability.v1'],
          optional_skill_policy_ref: 'opl-package.json#/exports',
          optional_skills_installed_by_default: true,
          default_materialization_policy: 'all_exported_skills',
        },
        content_lock: {
          algorithm: 'sha256',
          canonicalization: 'ordered_path_nul_file_bytes',
          paths: ['skills/unknown-capability/SKILL.md'],
          digest: 'sha256:'
            + '0'.repeat(64),
        },
        codex_surface: {
          plugin_id: 'unknown-capability',
          codex_default_exposure: true,
        },
      }),
    );
    fs.mkdirSync(path.join(sourceRoot, 'skills', 'unknown-capability'), { recursive: true });
    fs.writeFileSync(
      path.join(sourceRoot, 'skills', 'unknown-capability', 'SKILL.md'),
      '# Unknown capability\n',
      { encoding: 'utf8', flag: 'w' },
    );
    fs.writeFileSync(binary, `#!/usr/bin/env node
process.stdout.write(JSON.stringify({
  installed: [{
    pluginId: 'unknown-capability@owner-carrier',
    version: '1.0.0',
    installed: true,
    enabled: true,
    source: { source: 'local', path: ${JSON.stringify(sourceRoot)} },
    marketplaceSource: { sourceType: 'local', source: '/tmp/owner-carrier' }
  }]
}));
`);
    fs.chmodSync(binary, 0o755);
    const readback = listOplAgentPackages({ detail: 'fast' }).opl_agent_packages;
    const entry = readback.directory.entries.find((candidate) => candidate.package_id === packageId);
    assert.ok(entry);
    assert.equal(readback.registry_cache, null);
    assert.equal(entry?.installed, true);
    assert.equal(entry?.source_explanation.kind, 'installed_codex_plugin_descriptor');
    assert.equal(entry?.configured_carrier?.status, 'installed');
    assert.equal(entry?.configured_carrier?.executor.status, 'callable');
    assert.deepEqual(
      entry?.available_actions.map((action) => action.action_id),
      ['agent_package_update', 'agent_package_repair', 'agent_package_preferences_set', 'agent_package_uninstall'],
    );
    assert.equal(fs.existsSync(path.join(stateFixture.env.OPL_STATE_DIR, 'agent-package-locks.json')), false);
    assert.equal(fs.existsSync(path.join(stateFixture.env.OPL_STATE_DIR, 'agent-package-lifecycle-ledger.json')), false);
  } finally {
    if (previousStateDir === undefined) delete process.env.OPL_STATE_DIR;
    else process.env.OPL_STATE_DIR = previousStateDir;
    if (previousBinary === undefined) delete process.env.OPL_CODEX_PLUGIN_BIN;
    else process.env.OPL_CODEX_PLUGIN_BIN = previousBinary;
    fs.rmSync(stateFixture.home, { recursive: true, force: true });
    fs.rmSync(sourceRoot, { recursive: true, force: true });
  }
});

function isolatedPackageEnv(prefix: string) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), `${prefix}-home-`));
  return {
    home,
    env: {
      HOME: home,
      CODEX_HOME: path.join(home, '.codex'),
      OPL_STATE_DIR: path.join(home, 'opl-state'),
    },
  };
}

async function withIsolatedStateDir<T>(prefix: string, run: () => T | Promise<T>): Promise<T> {
  const fixture = isolatedPackageEnv(prefix);
  const previousStateDir = process.env.OPL_STATE_DIR;
  try {
    process.env.OPL_STATE_DIR = fixture.env.OPL_STATE_DIR;
    return await run();
  } finally {
    if (previousStateDir === undefined) delete process.env.OPL_STATE_DIR;
    else process.env.OPL_STATE_DIR = previousStateDir;
    fs.rmSync(fixture.home, { recursive: true, force: true });
  }
}

function registryPayload(manifestUrl: string, packageRole: string | null = 'standard_agent') {
  return {
    registry_id: 'directory-test-registry',
    entries: [{
      package_id: 'third.party.research',
      display_name: 'Third Party Research',
      publisher: 'example-org',
      description: 'Third-party research workflow package.',
      tags: ['research'],
      ...(packageRole ? { package_role: packageRole } : {}),
      source: 'third_party',
      manifest_url: manifestUrl,
      version_source_ref: `${manifestUrl}#/version`,
      trust_tier: 'third_party_verified',
    }],
  };
}

function assertRecommendedActionMatchesAvailable(entry: any) {
  if (entry.recommended_action === null) {
    assert.equal(entry.recommended_action_ref, null);
    return;
  }
  const available = entry.available_actions.find(
    (action: any) => action.action_id === entry.recommended_action,
  );
  assert.deepEqual(entry.recommended_action_ref, available);
  assert.equal(available.action_ref, `app_state.actions#${entry.recommended_action}`);
  assert.equal(typeof available.payload, 'object');
}

const thirdPartyPresentation = {
  display_name_i18n: {
    'zh-CN': '未来研究代理',
    'en-US': 'Future Research Agent',
  },
  description_i18n: {
    'zh-CN': '从所有者清单投影的研究代理。',
    'en-US': 'Research Agent projected from its owner manifest.',
  },
  session_routing_summary_i18n: {
    'zh-CN': '启动新的研究会话。',
    'en-US': 'Start a new research session.',
  },
  home_shortcuts: [{
    shortcut_id: 'future-main',
    label_i18n: {
      'zh-CN': '开始研究',
      'en-US': 'Start Research',
    },
    default_visible: true,
    user_configurable: true,
    route: {
      route_kind: 'agent_package_shortcut',
      executor: 'codex_cli',
      codex_visible_entry: 'future-agent',
    },
  }],
};

const relayAppContributions = {
  schema_version: 'opl-app-contributions.v1',
  navigation: [{
    navigation_id: 'relay.inbox-nav',
    label_i18n: {
      'zh-CN': '收件箱',
      'en-US': 'Inbox',
    },
    view_id: 'relay.inbox',
    icon_id: 'mail',
    sort_order: 100,
  }],
  views: [{
    view_id: 'relay.inbox',
    view_type: 'list_detail',
    title_i18n: {
      'zh-CN': '收件箱',
      'en-US': 'Inbox',
    },
    data_ref: 'communications.mail.v1#inbox',
    command_ids: ['relay.compose'],
    badge_ids: ['relay.unread'],
  }],
  commands: [{
    command_id: 'relay.compose',
    label_i18n: {
      'zh-CN': '新建草稿',
      'en-US': 'New draft',
    },
    action_ref: 'communications.mail.v1#draft-create',
    confirmation_required: false,
  }],
  badges: [{
    badge_id: 'relay.unread',
    label_i18n: {
      'zh-CN': '未读',
      'en-US': 'Unread',
    },
    data_ref: 'communications.mail.v1#unread-count',
    tone: 'info',
  }],
} as const;

const HOME_PRESENTATION_CROSS_FIXTURE_SHA256 = 'b9986890f5af0d0004caad41b8bfd244e2fab7a7aa43ed98c9d5a7644221d8bf';
const homePresentationCrossFixture = `{
  "package_id": "future.agent-lab",
  "package_role": "standard_agent",
  "installed": true,
  "display_name": "Future Agent Lab",
  "description": "Generic directory description.",
  "display_name_i18n": {
    "zh-CN": "未来智能体实验室",
    "en-US": "Future Agent Lab"
  },
  "description_i18n": {
    "zh-CN": "由所有者清单投影的动态智能体。",
    "en-US": "A dynamic Agent projected from its owner manifest."
  },
  "session_routing_summary_i18n": {
    "zh-CN": "启动未来研究会话。",
    "en-US": "Start a future research session."
  },
  "home_shortcuts": [
    {
      "shortcut_id": "future-main",
      "label_i18n": {
        "zh-CN": "开始未来研究",
        "en-US": "Start Future Research"
      },
      "default_visible": true,
      "user_configurable": true,
      "route": {
        "route_kind": "agent_package_shortcut",
        "executor": "codex_cli",
        "codex_visible_entry": "future-agent"
      }
    },
    {
      "shortcut_id": "future-pinned",
      "label_i18n": {
        "zh-CN": "固定未来入口",
        "en-US": "Pinned Future Entry"
      },
      "default_visible": true,
      "user_configurable": false,
      "route": {
        "route_kind": "agent_package_shortcut",
        "executor": "codex_cli",
        "codex_visible_entry": "future-agent-pinned"
      }
    }
  ]
}
`;

test('Framework freezes the Shell Home public directory entry fixture bytes', () => {
  assert.equal(crypto.createHash('sha256').update(homePresentationCrossFixture).digest('hex'), HOME_PRESENTATION_CROSS_FIXTURE_SHA256);
  const entry = parseJsonText(homePresentationCrossFixture) as Record<string, unknown>;
  assert.equal(Object.hasOwn(entry, 'presentation'), false);
  assert.deepEqual(Object.keys(entry).filter((key) => key.endsWith('_i18n') || key === 'home_shortcuts'), [
    'display_name_i18n',
    'description_i18n',
    'session_routing_summary_i18n',
    'home_shortcuts',
  ]);
});

test('role-neutral app contributions validate, normalize, and project without executable UI fields', async () => {
  const agentManifest = {
    ...agentPackageManifest(),
    codex_surface: {
      ...agentPackageManifest().codex_surface,
      plugin_id: 'third-party-research',
      carrier_source_commit: 'a'.repeat(40),
      standalone_distribution: 'repo_carrier_source',
    },
    app_contributions: relayAppContributions,
  };
  const capabilityManifest = {
    ...(parseJsonText(fs.readFileSync(
      path.join(repoRoot, 'contracts/opl-framework/packages/mas-scholar-skills.json'),
      'utf8',
    )) as Record<string, unknown>),
    app_contributions: relayAppContributions,
  };
  const workflowManifest = {
    ...(parseJsonText(fs.readFileSync(
      path.join(repoRoot, 'contracts/opl-framework/packages/opl-flow.json'),
      'utf8',
    )) as Record<string, unknown>),
    app_contributions: relayAppContributions,
  };
  const schemaCases = [
    {
      schemaRef: 'contracts/opl-framework/agent-package-manifest.schema.json',
      schemaId: 'opl.agent_package_manifest.app_contributions.v1',
      payload: agentManifest,
    },
    {
      schemaRef: 'contracts/opl-framework/capability-package-manifest.schema.json',
      schemaId: 'opl.capability_package_manifest.app_contributions.v1',
      payload: capabilityManifest,
    },
    {
      schemaRef: 'contracts/opl-framework/workflow-profile-package-manifest.schema.json',
      schemaId: 'opl.workflow_profile_package_manifest.app_contributions.v1',
      payload: workflowManifest,
    },
    {
      schemaRef: 'contracts/opl-framework/app-contributions.schema.json',
      schemaId: 'opl.app_contributions.v1',
      payload: relayAppContributions,
    },
  ];
  for (const entry of schemaCases) {
    const schema = parseJsonText(
      fs.readFileSync(path.join(repoRoot, entry.schemaRef), 'utf8'),
    ) as Parameters<typeof validateJsonSchemaPayload>[0]['schema'];
    assert.equal(validateJsonSchemaPayload({
      schemaId: entry.schemaId,
      schema,
      sourceRef: entry.schemaRef,
    }, entry.payload).ok, true, entry.schemaRef);
    const emptyContributions = { schema_version: 'opl-app-contributions.v1' };
    const emptyPayload = entry.schemaRef.endsWith('/app-contributions.schema.json')
      ? emptyContributions
      : { ...entry.payload, app_contributions: emptyContributions };
    assert.equal(validateJsonSchemaPayload({
      schemaId: `${entry.schemaId}.empty`,
      schema,
      sourceRef: entry.schemaRef,
    }, emptyPayload).ok, false, `${entry.schemaRef} must reject an empty contribution block`);
  }

  for (const [manifest, manifestUrl] of [
    [agentManifest, 'file:///tmp/relay-agent.json'],
    [capabilityManifest, 'file:///tmp/relay-capability.json'],
    [workflowManifest, 'file:///tmp/relay-workflow.json'],
  ] as const) {
    assert.deepEqual(
      normalizePackageManifest(manifest, manifestUrl).app_contributions,
      relayAppContributions,
      manifestUrl,
    );
  }

  const unsafeContributions = {
    ...relayAppContributions,
    views: [{
      ...relayAppContributions.views[0],
      component_path: './RelayInbox.tsx',
    }],
  };
  const appSchema = parseJsonText(fs.readFileSync(
    path.join(repoRoot, 'contracts/opl-framework/app-contributions.schema.json'),
    'utf8',
  )) as Parameters<typeof validateJsonSchemaPayload>[0]['schema'];
  assert.equal(validateJsonSchemaPayload({
    schemaId: 'opl.app_contributions.unsafe.v1',
    schema: appSchema,
    sourceRef: 'contracts/opl-framework/app-contributions.schema.json',
  }, unsafeContributions).ok, false);
  assert.throws(
    () => normalizePackageManifest({
      ...agentManifest,
      app_contributions: unsafeContributions,
    }, 'file:///tmp/unsafe-component.json'),
    (error: unknown) => error instanceof Error
      && error.message.includes('unsupported fields'),
  );
  assert.throws(
    () => normalizePackageManifest({
      ...agentManifest,
      app_contributions: {
        ...relayAppContributions,
        views: [{
          ...relayAppContributions.views[0],
          view_type: 'arbitrary_react_component',
        }],
      },
    }, 'file:///tmp/unsafe-view.json'),
    (error: unknown) => error instanceof Error
      && error.message.includes('view_type is unsupported'),
  );
  assert.throws(
    () => normalizePackageManifest({
      ...agentManifest,
      app_contributions: {
        ...relayAppContributions,
        navigation: [{
          ...relayAppContributions.navigation[0],
          view_id: 'relay.missing',
        }],
      },
    }, 'file:///tmp/unresolved-view.json'),
    (error: unknown) => error instanceof Error
      && error.message.includes('references must resolve'),
  );

  const manifestUrl = 'file:///tmp/relay-agent.json';
  const cache = normalizePackageCatalogRegistry({
    surface_kind: 'opl_package_catalog.v1',
    packages: {
      package_catalog: {
        'third.party.research': {
          package_id: 'third.party.research',
          package_role: 'standard_agent',
          source: 'third_party',
          trust_tier: 'third_party_verified',
          selected_version: '1.2.3',
          versions: [{
            package_version: '1.2.3',
            selection_status: 'selected_for_release_set',
            manifest_url: manifestUrl,
            manifest_json: formatJsonPayload(agentManifest),
          }],
        },
      },
    },
  }, 'file:///tmp/relay-catalog.json', 'catalog-sha');
  const entry = await withIsolatedStateDir('opl-app-contributions', () =>
    buildAgentPackageDirectory({
      registryCache: cache,
      locks: [],
      detail: 'fast',
    }).entries.find((candidate) => candidate.package_id === 'third.party.research'));
  assert.deepEqual(entry?.app_contributions, relayAppContributions);
  assert.equal(entry?.package_role, 'standard_agent');
});

test('ordinary list, status, App, and Home surfaces ignore valid, stale, and poisoned Release Catalog caches', () => {
  const fixture = isolatedPackageEnv('opl-package-directory');
  const codexFixture = createFakeCodexFixture(`
if [[ "$1" == "--version" ]]; then
  echo "codex-cli 0.125.0"
  exit 0
fi
exit 1
`);
  const previousStateDir = process.env.OPL_STATE_DIR;
  const cacheFile = path.join(
    fixture.env.OPL_STATE_DIR,
    'agent-package-release-catalog-cache.json',
  );
  const packageCatalog = Object.fromEntries(getOplPackageSpecs().map((spec) => {
    const manifest = parseJsonText(
      fs.readFileSync(path.join(repoRoot, spec.package_manifest_ref), 'utf8'),
    ) as Record<string, unknown>;
    const version = String(manifest.version);
    const manifestJson = formatJsonPayload({
      ...manifest,
      ...(spec.package_id === 'mas' ? { presentation: thirdPartyPresentation } : {}),
    });
    const sourceArtifactRef =
      `ghcr.io/fixture/one-person-lab-packages/${spec.package_id}:${version}`;
    return [spec.package_id, {
      package_id: spec.package_id,
      package_role: spec.package_role,
      selected_version: version,
      versions: [{
        package_version: version,
        selection_status: 'selected_for_release_set',
        manifest_url: `opl+oci://${sourceArtifactRef}#/package-manifest.json`,
        manifest_sha256: `sha256:${crypto.createHash('sha256').update(manifestJson).digest('hex')}`,
        manifest_json: manifestJson,
        payload_manifest_json: '{}',
        payload_manifest_sha256: `sha256:${'2'.repeat(64)}`,
        content_digest: `sha256:${'3'.repeat(64)}`,
        payload_digest: `sha256:${'4'.repeat(64)}`,
        source_artifact_ref: sourceArtifactRef,
        artifact_digest: `sha256:${'5'.repeat(64)}`,
        artifact_status: 'published_immutable',
        package_content_digest: `sha256:${'6'.repeat(64)}`,
        owner_source_commit: '7'.repeat(40),
        dependency_package_ids: [],
      }],
    }];
  }));
  const catalogPayload = {
    surface_kind: 'opl_package_catalog.v1',
    packages: { package_catalog: packageCatalog },
  };
  const appEnv = {
    ...fixture.env,
    OPL_MODULES_ROOT: path.join(fixture.home, 'opl-state', 'modules'),
    OPL_CODEX_CLI_LATEST_VERSION: '0.125.0',
    OPL_DEVELOPER_MODE_GH_BINARY: path.join(fixture.home, 'missing-gh'),
    PATH: `${codexFixture.fixtureRoot}:/usr/bin:/bin`,
  };
  const homeShortcutPreferenceSnapshot = (preferences: any[]) => preferences.map(
    ({ updated_at: _updatedAt, ...preference }) => preference,
  );
  const readOrdinarySurfaces = () => {
    const list = runCli(['packages', 'list'], fixture.env) as any;
    const status = runCli(
      ['packages', 'status', '--package-id', 'mas'],
      fixture.env,
    ) as any;
    const app = Object.fromEntries((['fast', 'full'] as const).map((profile) => {
      const state = runCli(['app', 'state', '--profile', profile], appEnv) as any;
      const agentPackages = state.app_state.agent_packages;
      return [profile, {
        directory: agentPackages.directory,
        package_home_shortcut_preferences: Object.fromEntries(
          Object.entries(agentPackages.status_index.packages).map(([packageId, entry]: [string, any]) => [
            packageId,
            homeShortcutPreferenceSnapshot(entry.home_shortcut_preferences),
          ]),
        ),
        home_shortcut_preferences: homeShortcutPreferenceSnapshot(
          agentPackages.status_index.home_shortcut_preferences,
        ),
      }];
    }));
    return {
      list_directory: list.opl_agent_packages.directory,
      list_home_shortcut_preferences: homeShortcutPreferenceSnapshot(
        list.opl_agent_packages.home_shortcut_preferences,
      ),
      status_home_shortcut_preferences: homeShortcutPreferenceSnapshot(
        status.opl_agent_package_status.home_shortcut_preferences,
      ),
      app,
    };
  };
  try {
    fs.mkdirSync(fixture.env.OPL_STATE_DIR, { recursive: true });
    process.env.OPL_STATE_DIR = fixture.env.OPL_STATE_DIR;
    const baseline = readOrdinarySurfaces();
    const directory = baseline.list_directory;
    assert.equal(directory.surface_kind, 'opl_agent_package_directory.v1');
    assert.equal(directory.entry_count, 7);
    assert.equal(directory.installed_package_count, 0);
    assert.equal(directory.installable_package_count, 7);
    for (const entry of directory.entries) {
      assert.equal(typeof entry.package_id, 'string');
      assert.equal(typeof entry.description, 'string');
      assert.equal(entry.description.length > 0, true);
      assert.equal(Array.isArray(entry.tags), true);
      assert.equal(entry.tags.length > 0, true);
      assert.equal(CANONICAL_PACKAGE_ROLES.has(entry.package_role), true);
      assert.equal(entry.installed, false);
      assert.equal(entry.activated, false);
      assert.equal(entry.installability.installable, true);
      assert.equal(entry.recommended_action, 'install_from_manifest_url');
      assert.deepEqual(entry.available_actions[0].payload, { package_id: entry.package_id });
      assertRecommendedActionMatchesAvailable(entry);
    }
    const flow = directory.entries.find((entry: any) => entry.package_id === 'opl-flow');
    const scholarSkills = directory.entries.find((entry: any) => entry.package_id === 'mas-scholar-skills');
    const mas = directory.entries.find((entry: any) => entry.package_id === 'mas');
    assert.deepEqual(mas.capability_metadata, {
      source: 'normalized_owner_manifest',
      required_skill_ids: ['med-autoscience'],
      optional_skill_refs: [],
    });
    assert.equal(flow.package_role, 'workflow_profile');
    assert.equal(flow.capability_metadata, null);
    assert.equal(flow.projected_version, '0.1.25');
    assert.equal(flow.selected_version, null);
    assert.equal(flow.stable_version, null);
    assert.equal(flow.source_explanation.kind, 'first_party_framework_projection');
    assert.equal(flow.version_currentness.status, 'framework_projection_only');
    assert.equal(flow.version_currentness.live_verified, false);
    assert.equal(directory.first_party_release_currentness.status, 'unknown');
    assert.equal(scholarSkills.package_role, 'framework_capability_package');
    assert.equal(scholarSkills.capability_metadata, null);
    assert.deepEqual(
      baseline.list_home_shortcut_preferences
        .map((preference: any) => preference.package_id)
        .sort(),
      ['mag', 'mas', 'obf', 'oma', 'rca'],
    );
    assert.deepEqual(baseline.status_home_shortcut_preferences, [{
      shortcut_id: 'research',
      package_id: 'mas',
      visible: true,
      sort_order: 200,
      source: 'default',
      installed: false,
    }]);

    for (const [cacheCase, checkedAt] of [
      ['valid', new Date().toISOString()],
      ['stale', '2000-01-01T00:00:00.000Z'],
      ['poisoned', null],
    ] as const) {
      fs.writeFileSync(cacheFile, cacheCase === 'poisoned'
        ? '{not-json'
        : formatJsonPayload({
          surface_kind: 'opl_agent_package_release_catalog_cache.v1',
          catalog_ref: 'ghcr.io/fixture/one-person-lab-manifest:latest-stable',
          catalog_digest: `sha256:${'a'.repeat(64)}`,
          checked_at: checkedAt,
          catalog_payload: catalogPayload,
        }));
      const snapshot = readFirstPartyPackageCatalogSnapshot();
      if (cacheCase === 'poisoned') {
        assert.equal(snapshot, null);
      } else {
        assert.ok(snapshot);
        assert.equal(
          snapshot.freshness,
          cacheCase === 'valid' ? 'cached' : 'last_known_good',
        );
        assert.equal(
          buildAgentPackageDirectory({
            registryCache: null,
            locks: [],
            detail: 'fast',
            firstPartyCatalog: snapshot,
          }).entries.find((entry) => entry.package_id === 'mas')
            ?.home_shortcuts[0]?.shortcut_id,
          'future-main',
        );
      }

      const actual = readOrdinarySurfaces();
      assert.deepEqual(actual, baseline, `${cacheCase} Release Catalog cache changed ordinary read models`);
      for (const profile of ['fast', 'full'] as const) {
        const projected = actual.app[profile].directory;
        assert.equal(projected.surface_kind, 'opl_agent_package_directory.v1');
        assert.equal(projected.detail, profile);
        assert.equal(projected.entries.length, 7);
        assert.equal(projected.first_party_release_currentness.status, 'unknown');
        assert.equal(projected.entries.every((entry: any) =>
          entry.package_id && entry.package_role && entry.installability && entry.recommended_action), true);
        assert.equal('directory' in projected, false);
        assert.deepEqual(
          Object.values(actual.app[profile].package_home_shortcut_preferences)
            .flatMap((preferences: any) => preferences)
            .map((preference: any) => preference.package_id)
            .sort(),
          ['mag', 'mas', 'obf', 'oma', 'rca'],
        );
        assert.deepEqual(
          actual.app[profile].home_shortcut_preferences
            .map((preference: any) => preference.package_id)
            .sort(),
          ['mag', 'mas', 'obf', 'oma', 'rca'],
        );
      }
    }
  } finally {
    if (previousStateDir === undefined) delete process.env.OPL_STATE_DIR;
    else process.env.OPL_STATE_DIR = previousStateDir;
    fs.rmSync(codexFixture.fixtureRoot, { recursive: true, force: true });
    fs.rmSync(fixture.home, { recursive: true, force: true });
  }
});

test('Developer Mode selects every available first-party Package checkout', () => {
  const fixture = isolatedPackageEnv('opl-package-directory-developer-policy');
  const workspace = path.join(fixture.home, 'workspace');
  const repoNames = [
    'med-autoscience',
    'med-autogrant',
    'redcube-ai',
    'opl-meta-agent',
    'opl-bookforge',
    'mas-scholar-skills',
    'opl-flow',
  ];
  try {
    fs.mkdirSync(fixture.env.OPL_STATE_DIR, { recursive: true });
    for (const repoName of repoNames) {
      fs.mkdirSync(path.join(workspace, repoName), { recursive: true });
    }
    fs.writeFileSync(path.join(fixture.env.OPL_STATE_DIR, 'developer-supervisor.json'), formatJsonPayload({
      version: 'g1',
      enabled: 'on',
      mode: 'developer_apply_safe',
      auto_enable_github_login: 'gaofeng21cn',
      module_source_preferences: {},
      updated_at: '2026-07-16T00:00:00.000Z',
    }));
    const directory = (runCli(['packages', 'list'], {
      ...fixture.env,
      OPL_WORKSPACE_ROOT: workspace,
    }) as any).opl_agent_packages.directory;
    for (const packageId of CANONICAL_PACKAGE_IDS) {
      const policy = directory.entries.find((entry: any) => entry.package_id === packageId)
        .source_explanation.effective_source_policy;
      assert.equal(policy.desired_source_kind, 'developer_checkout_override');
      assert.equal(policy.developer_checkout_available, true);
      assert.equal(policy.package_channel_auto_update, false);
    }
  } finally {
    fs.rmSync(fixture.home, { recursive: true, force: true });
  }
});

test('first-party Directory versions come only from the managed Release Set selector', () =>
  withIsolatedStateDir('opl-package-directory-release-selector', () => {
  const versions = new Map(getOplPackageSpecs().map((spec) => {
    const packageVersion = spec.package_id === 'opl-flow' ? '0.1.19' : spec.selected_version;
    const sourceArtifactRef = `ghcr.io/fixture/one-person-lab-packages/${spec.package_id}:${packageVersion}`;
    const sourceManifest = parseJsonText(fs.readFileSync(path.join(repoRoot, spec.package_manifest_ref), 'utf8')) as Record<string, unknown>;
    const manifestJson = formatJsonPayload({
      ...sourceManifest,
      version: packageVersion,
      ...(spec.package_id === 'mas' ? { presentation: thirdPartyPresentation } : {}),
    });
    return [spec.package_id, {
      package_id: spec.package_id,
      package_role: spec.package_role,
      selected_version: packageVersion,
      versions: [{
        package_version: packageVersion,
        capability_abi: null,
        manifest_url: `opl+oci://${sourceArtifactRef}#/package-manifest.json`,
        manifest_sha256: `sha256:${crypto.createHash('sha256').update(manifestJson).digest('hex')}`,
        manifest_json: manifestJson,
        payload_manifest_json: '{}',
        payload_manifest_sha256: `sha256:${'2'.repeat(64)}`,
        content_digest: `sha256:${'3'.repeat(64)}`,
        payload_digest: `sha256:${'4'.repeat(64)}`,
        source_artifact_ref: sourceArtifactRef,
        artifact_digest: `sha256:${'5'.repeat(64)}`,
        artifact_status: 'published_immutable',
        package_content_digest: `sha256:${'6'.repeat(64)}`,
        owner_source_commit: '7'.repeat(40),
        dependency_package_ids: [],
        selection_status: 'selected_for_release_set' as const,
      }],
    }];
  }));
  const directory = buildAgentPackageDirectory({
    registryCache: null,
    locks: [],
    detail: 'fast',
    firstPartyCatalog: {
      catalog: versions,
      freshness: 'live',
      catalog_ref: 'ghcr.io/fixture/one-person-lab-manifest:latest-stable',
      release_set_descriptor_digest: `sha256:${'7'.repeat(64)}`,
      channel_manifest_layer_digest: `sha256:${'8'.repeat(64)}`,
      package_catalog_digest: `sha256:${'9'.repeat(64)}`,
      catalog_digest: `sha256:${'8'.repeat(64)}`,
      checked_at: '2026-07-15T00:00:00.000Z',
    },
  });
  const flow = directory.entries.find((entry) => entry.package_id === 'opl-flow')!;
  const mas = directory.entries.find((entry) => entry.package_id === 'mas')!;
  assert.deepEqual(mas.display_name_i18n, thirdPartyPresentation.display_name_i18n);
  assert.deepEqual(mas.description_i18n, thirdPartyPresentation.description_i18n);
  assert.deepEqual(mas.session_routing_summary_i18n, thirdPartyPresentation.session_routing_summary_i18n);
  assert.deepEqual(mas.home_shortcuts, thirdPartyPresentation.home_shortcuts);
  assert.equal(Object.hasOwn(mas, 'presentation'), false);
  assert.equal(flow.projected_version, '0.1.25');
  assert.equal(flow.selected_version, '0.1.19');
  assert.equal(flow.stable_version, '0.1.19');
  assert.equal(flow.version_currentness.status, 'live_release_set');
  assert.equal(flow.version_currentness.live_verified, true);
  assert.equal(flow.version_currentness.source_digest, `sha256:${'8'.repeat(64)}`);
  assert.equal(directory.first_party_release_currentness.status, 'live');
  assert.equal(directory.first_party_release_currentness.release_set_descriptor_digest, `sha256:${'7'.repeat(64)}`);
  assert.equal(directory.first_party_release_currentness.channel_manifest_layer_digest, `sha256:${'8'.repeat(64)}`);
  assert.equal(directory.first_party_release_currentness.package_catalog_digest, `sha256:${'9'.repeat(64)}`);
  assert.equal('catalog_digest' in directory.first_party_release_currentness, false);
  const runtimeOnlyDirectory = buildAgentPackageDirectory({
    registryCache: null,
    locks: [],
    detail: 'fast',
    firstPartyCatalog: {
      catalog: versions,
      freshness: 'live',
      catalog_ref: 'https://fixture.example/packages.json',
      release_set_descriptor_digest: null,
      channel_manifest_layer_digest: `sha256:${'8'.repeat(64)}`,
      package_catalog_digest: `sha256:${'9'.repeat(64)}`,
      catalog_digest: `sha256:${'8'.repeat(64)}`,
      checked_at: '2026-07-15T00:00:00.000Z',
    },
  });
  assert.equal(runtimeOnlyDirectory.first_party_release_currentness.status, 'live');
  assert.equal(runtimeOnlyDirectory.first_party_release_currentness.live_verified, true);
  assert.equal(runtimeOnlyDirectory.first_party_release_currentness.release_set_descriptor_digest, null);
  }));

test('static owner presentation projects only when no selected catalog manifest owns the package', () =>
  withIsolatedStateDir('opl-package-directory-static-owner-presentation', () => {
  const staticDirectory = buildAgentPackageDirectory({
    registryCache: null,
    locks: [],
    detail: 'fast',
  });
  for (const packageId of ['mag', 'rca', 'obf']) {
    const sourceManifest = parseJsonText(fs.readFileSync(
      path.join(repoRoot, `contracts/opl-framework/packages/${packageId}.json`),
      'utf8',
    )) as Record<string, any>;
    const entry = staticDirectory.entries.find((candidate) => candidate.package_id === packageId)!;
    assert.deepEqual(entry.display_name_i18n, sourceManifest.presentation.display_name_i18n);
    assert.deepEqual(entry.description_i18n, sourceManifest.presentation.description_i18n);
    assert.deepEqual(entry.session_routing_summary_i18n, sourceManifest.presentation.session_routing_summary_i18n);
    assert.deepEqual(entry.home_shortcuts, sourceManifest.presentation.home_shortcuts);
    assert.equal(Object.hasOwn(entry, 'presentation'), false);
  }

  const versions = new Map(getOplPackageSpecs().map((spec) => {
    const selectedManifest = parseJsonText(fs.readFileSync(
      path.join(repoRoot, spec.package_manifest_ref),
      'utf8',
    )) as Record<string, unknown>;
    if (spec.package_id === 'mag') delete selectedManifest.presentation;
    const manifestJson = formatJsonPayload(selectedManifest);
    const sourceArtifactRef = `ghcr.io/fixture/one-person-lab-packages/${spec.package_id}:${spec.selected_version}`;
    return [spec.package_id, {
      package_id: spec.package_id,
      package_role: spec.package_role,
      selected_version: spec.selected_version,
      versions: [{
        package_version: spec.selected_version,
        capability_abi: null,
        manifest_url: `opl+oci://${sourceArtifactRef}#/package-manifest.json`,
        manifest_sha256: `sha256:${crypto.createHash('sha256').update(manifestJson).digest('hex')}`,
        manifest_json: manifestJson,
        payload_manifest_json: '{}',
        payload_manifest_sha256: `sha256:${'2'.repeat(64)}`,
        content_digest: `sha256:${'3'.repeat(64)}`,
        payload_digest: `sha256:${'4'.repeat(64)}`,
        source_artifact_ref: sourceArtifactRef,
        artifact_digest: `sha256:${'5'.repeat(64)}`,
        artifact_status: 'published_immutable',
        package_content_digest: `sha256:${'6'.repeat(64)}`,
        owner_source_commit: '7'.repeat(40),
        dependency_package_ids: [],
        selection_status: 'selected_for_release_set' as const,
      }],
    }];
  }));
  const selectedDirectory = buildAgentPackageDirectory({
    registryCache: null,
    locks: [],
    detail: 'fast',
    firstPartyCatalog: {
      catalog: versions,
      freshness: 'live',
      catalog_ref: 'ghcr.io/fixture/one-person-lab-manifest:latest-stable',
      release_set_descriptor_digest: `sha256:${'7'.repeat(64)}`,
      channel_manifest_layer_digest: `sha256:${'8'.repeat(64)}`,
      package_catalog_digest: `sha256:${'9'.repeat(64)}`,
      catalog_digest: `sha256:${'8'.repeat(64)}`,
      checked_at: '2026-07-25T00:00:00.000Z',
    },
  });
  const selectedMag = selectedDirectory.entries.find((entry) => entry.package_id === 'mag')!;
  assert.equal(selectedMag.display_name_i18n, null);
  assert.equal(selectedMag.description_i18n, null);
  assert.equal(selectedMag.session_routing_summary_i18n, null);
  assert.deepEqual(selectedMag.home_shortcuts, []);
  }));

test('legacy v1 Release Set cache remains non-live and never invents a descriptor digest', () => {
  const fixture = isolatedPackageEnv('opl-package-directory-legacy-release-cache');
  const previousStateDir = process.env.OPL_STATE_DIR;
  const packageCatalog = {};
  const catalogPayload = {
    surface_kind: 'opl_package_catalog.v1',
    packages: { package_catalog: packageCatalog },
  };
  const legacyLayerDigest = `sha256:${'a'.repeat(64)}`;
  try {
    process.env.OPL_STATE_DIR = fixture.env.OPL_STATE_DIR;
    fs.mkdirSync(fixture.env.OPL_STATE_DIR, { recursive: true });
    fs.writeFileSync(
      path.join(fixture.env.OPL_STATE_DIR, 'agent-package-release-catalog-cache.json'),
      formatJsonPayload({
        surface_kind: 'opl_agent_package_release_catalog_cache.v1',
        catalog_ref: 'ghcr.io/fixture/one-person-lab-manifest:latest-stable',
        catalog_digest: legacyLayerDigest,
        checked_at: '2000-01-01T00:00:00.000Z',
        catalog_payload: catalogPayload,
      }),
    );
    const snapshot = readFirstPartyPackageCatalogSnapshot();
    assert.ok(snapshot);
    assert.equal(snapshot.freshness, 'last_known_good');
    assert.equal(snapshot.release_set_descriptor_digest, null);
    assert.equal(snapshot.channel_manifest_layer_digest, legacyLayerDigest);
    assert.equal(
      snapshot.package_catalog_digest,
      `sha256:${crypto.createHash('sha256').update(JSON.stringify(packageCatalog)).digest('hex')}`,
    );
    assert.equal(
      listOplAgentPackages().opl_agent_packages.directory.first_party_release_currentness.status,
      'unknown',
    );
  } finally {
    if (previousStateDir === undefined) delete process.env.OPL_STATE_DIR;
    else process.env.OPL_STATE_DIR = previousStateDir;
    fs.rmSync(fixture.home, { recursive: true, force: true });
  }
});

test('external package catalogs preserve third-party selection and reject first-party identity collisions', () =>
  withIsolatedStateDir('opl-package-directory-external-catalog', () => {
  const manifestJson = formatJsonPayload(agentPackageManifest());
  const manifestUrl = 'file:///tmp/third-party-research.json';
  const catalog = {
    surface_kind: 'opl_package_catalog.v1',
    packages: {
      package_catalog: {
        'third.party.research': {
          package_id: 'third.party.research',
          package_role: 'standard_agent',
          source: 'third_party',
          trust_tier: 'third_party_verified',
          selected_version: '1.2.3',
          versions: [{
            package_version: '1.2.3',
            selection_status: 'selected_for_release_set',
            manifest_url: manifestUrl,
            manifest_json: manifestJson,
          }],
        },
      },
    },
  };
  const cache = normalizePackageCatalogRegistry(catalog, 'file:///tmp/opl-catalog.json', 'catalog-sha');
  assert.equal(cache.entry_count, 1);
  assert.equal(cache.entries[0].package_role, 'standard_agent');
  assert.equal(cache.entries[0].selected_version, '1.2.3');
  assert.equal(cache.entries[0].stable_version, '1.2.3');
  assert.equal(cache.entries[0].manifest_validation, 'catalog_inline_manifest');
  assert.deepEqual(cache.entries[0].required_skill_ids, ['third-party-research']);
  assert.deepEqual(cache.entries[0].optional_skill_ids, ['officecli-docx']);
  assert.equal(cache.entries[0].source, 'third_party');
  assert.equal(cache.entries[0].trust_tier, 'third_party_verified');
  assert.deepEqual(buildAgentPackageDirectory({
    registryCache: cache,
    locks: [],
    detail: 'fast',
  }).entries.find((entry) => entry.package_id === 'third.party.research')?.capability_metadata, {
    source: 'validated_registry_manifest',
    required_skill_ids: ['third-party-research'],
    optional_skill_refs: ['officecli-docx'],
  });

  for (const [source, trustTier] of [
    ['organization_registry', 'organization_verified'],
    ['user_registry', 'third_party_unverified'],
  ]) {
    const entry = {
      ...catalog.packages.package_catalog['third.party.research'],
      source,
      trust_tier: trustTier,
    };
    const preserved = normalizePackageCatalogRegistry({
      ...catalog,
      packages: { package_catalog: { 'third.party.research': entry } },
    }, `file:///tmp/${source}-catalog.json`, 'catalog-sha');
    assert.equal(preserved.entries[0].source, source);
    assert.equal(preserved.entries[0].trust_tier, trustTier);
  }

  const reservedFirstPartyClaimVariants = [
    'first_party',
    'first-party-managed',
    'first party',
    'first.party',
    'firstParty',
    'firstPartyReleaseCatalog',
  ];
  for (const trustTier of [undefined, ...reservedFirstPartyClaimVariants]) {
    const entry = {
      ...catalog.packages.package_catalog['third.party.research'],
      ...(trustTier ? { trust_tier: trustTier } : {}),
    };
    if (!trustTier) delete (entry as Record<string, unknown>).trust_tier;
    assert.throws(
      () => normalizePackageCatalogRegistry({
        ...catalog,
        packages: { package_catalog: { 'third.party.research': entry } },
      }, 'file:///tmp/untrusted-catalog.json', 'catalog-sha'),
      (error: any) => error?.details?.failure_code === 'agent_package_directory_catalog_trust_tier_invalid',
    );
  }

  for (const source of [
    undefined,
    ...reservedFirstPartyClaimVariants,
  ]) {
    const entry = {
      ...catalog.packages.package_catalog['third.party.research'],
      ...(source ? { source } : {}),
    };
    if (!source) delete (entry as Record<string, unknown>).source;
    assert.throws(
      () => normalizePackageCatalogRegistry({
        ...catalog,
        packages: { package_catalog: { 'third.party.research': entry } },
      }, 'file:///tmp/invalid-source-catalog.json', 'catalog-sha'),
      (error: any) => error?.details?.failure_code === 'agent_package_directory_catalog_source_invalid',
    );
  }

  assert.throws(
    () => normalizePackageCatalogRegistry({
      ...catalog,
      packages: {
        package_catalog: {
          'third.party.research': {
            ...catalog.packages.package_catalog['third.party.research'],
            package_role: 'workflow_profile',
          },
        },
      },
    }, 'file:///tmp/invalid-catalog.json', 'catalog-sha'),
    (error: any) => error?.details?.failure_code === 'agent_package_directory_catalog_role_invalid',
  );

  const collisionEntries = Object.fromEntries(['mas', 'oma'].map((packageId) => [packageId, {
    package_id: packageId,
    package_role: 'standard_agent',
    selected_version: '9.9.9',
    versions: [{
      package_version: '9.9.9',
      selection_status: 'selected_for_release_set',
      manifest_url: `https://attacker.invalid/${packageId}.json`,
      manifest_json: formatJsonPayload(agentPackageManifest({
        packageId,
        agentId: packageId,
        pluginId: `attacker-${packageId}`,
      })),
    }],
  }]));
  assert.throws(
    () => normalizePackageCatalogRegistry({
      surface_kind: 'opl_package_catalog.v1',
      packages: { package_catalog: collisionEntries },
    }, 'file:///tmp/malicious-catalog.json', 'malicious-sha'),
    (error: any) => error?.details?.failure_code === 'agent_package_registry_first_party_identity_collision',
  );

  const baseline = buildAgentPackageDirectory({ registryCache: null, locks: [], detail: 'fast' });
  const staleCollisionCache = {
    surface_kind: 'opl_agent_package_registry_cache',
    version: 'opl-agent-package-registry-cache.v1',
    refreshed_at: new Date().toISOString(),
    registry_url: 'file:///tmp/malicious-catalog.json',
    registry_sha256: 'malicious-sha',
    entry_count: 2,
    entries: ['mas', 'oma'].map((packageId) => ({
      package_id: packageId,
      display_name: `Hijacked ${packageId}`,
      publisher: 'attacker',
      description: 'Malicious first-party identity collision.',
      tags: ['attacker'],
      package_role: 'standard_agent',
      source: 'first_party_release_catalog',
      manifest_url: `https://attacker.invalid/${packageId}.json`,
      version_source_ref: `https://attacker.invalid/${packageId}.json#/version`,
      selected_version: '9.9.9',
      stable_version: '9.9.9',
      manifest_validation: 'catalog_inline_manifest',
      trust_tier: 'first_party',
    })),
  } as any;
  const defended = buildAgentPackageDirectory({
    registryCache: staleCollisionCache,
    locks: [],
    detail: 'fast',
  });
  for (const packageId of ['mas', 'oma']) {
    const expected = baseline.entries.find((entry) => entry.package_id === packageId)!;
    const actual = defended.entries.find((entry) => entry.package_id === packageId)!;
    assert.deepEqual({
      display_name: actual.display_name,
      publisher: actual.publisher,
      manifest_url: actual.manifest_url,
      selected_version: actual.selected_version,
      stable_version: actual.stable_version,
      trust_tier: actual.trust_tier,
      source_explanation: actual.source_explanation,
    }, {
      display_name: expected.display_name,
      publisher: expected.publisher,
      manifest_url: expected.manifest_url,
      selected_version: expected.selected_version,
      stable_version: expected.stable_version,
      trust_tier: expected.trust_tier,
      source_explanation: expected.source_explanation,
    });
    assert.deepEqual(actual.recommended_action_ref?.payload, { package_id: packageId });
    assert.deepEqual(actual.recommended_action_ref?.required_payload_fields, ['package_id']);
    assert.equal(Object.hasOwn(actual.recommended_action_ref?.payload ?? {}, 'registry_url'), false);
    assert.equal(Object.hasOwn(actual.recommended_action_ref?.payload ?? {}, 'manifest_url'), false);
    assert.equal(Object.hasOwn(actual.recommended_action_ref?.payload ?? {}, 'trust_tier'), false);
  }
}));

test('owner presentation projects through an unknown package directory without becoming preference authority', () =>
  withIsolatedStateDir('opl-package-directory-owner-presentation', () => {
  const manifest = {
    ...agentPackageManifest(),
    codex_surface: {
      ...agentPackageManifest().codex_surface,
      plugin_id: 'third-party-research',
      carrier_source_commit: 'a'.repeat(40),
      standalone_distribution: 'repo_carrier_source',
    },
    presentation: thirdPartyPresentation,
  };
  const schema = parseJsonText(fs.readFileSync(
    path.join(repoRoot, 'contracts/opl-framework/agent-package-manifest.schema.json'),
    'utf8',
  )) as Record<string, unknown>;
  assert.equal(validateJsonSchemaPayload({
    schemaId: 'opl.agent_package_manifest.v1',
    schema,
    sourceRef: 'contracts/opl-framework/agent-package-manifest.schema.json',
  }, manifest).ok, true);
  assert.equal(validateJsonSchemaPayload({
    schemaId: 'opl.agent_package_manifest.v1',
    schema,
    sourceRef: 'contracts/opl-framework/agent-package-manifest.schema.json',
  }, { ...manifest, presentation: undefined }).ok, true);

  const manifestUrl = 'file:///tmp/future-research.json';
  const catalog = {
    surface_kind: 'opl_package_catalog.v1',
    packages: {
      package_catalog: {
        'third.party.research': {
          package_id: 'third.party.research',
          package_role: 'standard_agent',
          source: 'third_party',
          trust_tier: 'third_party_verified',
          selected_version: '1.2.3',
          versions: [{
            package_version: '1.2.3',
            selection_status: 'selected_for_release_set',
            manifest_url: manifestUrl,
            manifest_json: formatJsonPayload(manifest),
          }],
        },
      },
    },
  };
  const cache = normalizePackageCatalogRegistry(catalog, 'file:///tmp/future-catalog.json', 'catalog-sha');
  const directory = buildAgentPackageDirectory({ registryCache: cache, locks: [], detail: 'fast' });
  const entry = directory.entries.find((candidate) => candidate.package_id === 'third.party.research')!;
  assert.deepEqual(entry.display_name_i18n, thirdPartyPresentation.display_name_i18n);
  assert.deepEqual(entry.description_i18n, thirdPartyPresentation.description_i18n);
  assert.deepEqual(entry.session_routing_summary_i18n, thirdPartyPresentation.session_routing_summary_i18n);
  assert.deepEqual(entry.home_shortcuts, thirdPartyPresentation.home_shortcuts);
  assert.equal(Object.hasOwn(entry, 'presentation'), false);
  assert.equal(entry.installed, false);
  assert.equal(entry.installability.installable, true);
  assert.equal(entry.recommended_action, 'install_from_manifest_url');

  const defaults = defaultHomeShortcutPreferences(directory, {
    surface_kind: 'opl_agent_package_lock_index',
    version: 'opl-agent-package-lock-index.v1',
    packages: [],
  });
  assert.deepEqual(defaults
    .filter((preference) => preference.package_id === 'third.party.research')
    .map((preference) => ({
    shortcut_id: preference.shortcut_id,
    package_id: preference.package_id,
    visible: preference.visible,
    sort_order: preference.sort_order,
    source: preference.source,
    installed: preference.installed,
  })), [{
    shortcut_id: 'future-main',
    package_id: 'third.party.research',
    visible: true,
    sort_order: 700,
    source: 'default',
    installed: false,
  }]);

  fs.mkdirSync(process.env.OPL_STATE_DIR!, { recursive: true });
  fs.writeFileSync(path.join(process.env.OPL_STATE_DIR!, 'agent-package-home-shortcut-preferences.json'), formatJsonPayload({
    surface_kind: 'opl_agent_package_home_shortcut_preferences',
    version: 'g1',
    updated_at: '2026-07-25T00:00:00.000Z',
    preferences: [{
      shortcut_id: 'future-main',
      package_id: 'third.party.research',
      visible: false,
      sort_order: 4,
      source: 'user_preference',
      updated_at: '2026-07-25T00:00:00.000Z',
      installed: true,
      label_i18n: { 'en-US': 'Attacker label' },
      route: { route_kind: 'unknown' },
    }],
  }));
  const merged = mergedHomeShortcutPreferences(directory, {
    surface_kind: 'opl_agent_package_lock_index',
    version: 'opl-agent-package-lock-index.v1',
    packages: [],
  });
  assert.deepEqual(merged
    .filter((preference) => preference.package_id === 'third.party.research')
    .map((preference) => ({
    shortcut_id: preference.shortcut_id,
    package_id: preference.package_id,
    visible: preference.visible,
    sort_order: preference.sort_order,
    source: preference.source,
    installed: preference.installed,
  })), [{
    shortcut_id: 'future-main',
    package_id: 'third.party.research',
    visible: false,
    sort_order: 4,
    source: 'user_preference',
    installed: false,
  }]);
  const installedProjection = mergedHomeShortcutPreferences(directory, {
    surface_kind: 'opl_agent_package_lock_index',
    version: 'opl-agent-package-lock-index.v1',
    packages: [{ package_id: 'third.party.research' } as any],
  });
  assert.equal(
    installedProjection.find((preference) => preference.package_id === 'third.party.research')?.installed,
    true,
  );
  assert.deepEqual(entry.display_name_i18n, thirdPartyPresentation.display_name_i18n);
  assert.deepEqual(entry.description_i18n, thirdPartyPresentation.description_i18n);
  assert.deepEqual(entry.session_routing_summary_i18n, thirdPartyPresentation.session_routing_summary_i18n);
  assert.deepEqual(entry.home_shortcuts, thirdPartyPresentation.home_shortcuts);
  }));

test('invalid owner presentation fails closed while legacy manifests remain compatible', () => {
  const base = agentPackageManifest();
  assert.equal(normalizePackageCatalogRegistry({
    surface_kind: 'opl_package_catalog.v1',
    packages: {
      package_catalog: {
        'third.party.research': {
          package_id: 'third.party.research',
          package_role: 'standard_agent',
          source: 'third_party',
          trust_tier: 'third_party_verified',
          selected_version: '1.2.3',
          versions: [{
            package_version: '1.2.3',
            selection_status: 'selected_for_release_set',
            manifest_url: 'file:///tmp/legacy.json',
            manifest_json: formatJsonPayload(base),
          }],
        },
      },
    },
  }, 'file:///tmp/legacy-catalog.json', 'catalog-sha').entries[0].presentation, null);

  assert.throws(() => normalizePackageCatalogRegistry({
    surface_kind: 'opl_package_catalog.v1',
    packages: {
      package_catalog: {
        'third.party.research': {
          package_id: 'third.party.research',
          package_role: 'standard_agent',
          source: 'third_party',
          trust_tier: 'third_party_verified',
          selected_version: '1.2.3',
          versions: [{
            package_version: '1.2.3',
            selection_status: 'selected_for_release_set',
            manifest_url: 'file:///tmp/invalid-presentation.json',
            manifest_json: formatJsonPayload({
              ...base,
              presentation: {
                ...thirdPartyPresentation,
                home_shortcuts: [
                  ...thirdPartyPresentation.home_shortcuts,
                  thirdPartyPresentation.home_shortcuts[0],
                ],
              },
            }),
          }],
        },
      },
    },
  }, 'file:///tmp/invalid-presentation-catalog.json', 'catalog-sha'),
  (error: any) => error?.details?.failure_code === 'agent_package_presentation_invalid');
});

test('invalid first-party owner presentation omits only that Package presentation', () =>
  withIsolatedStateDir('opl-package-directory-invalid-owner-presentation', () => {
  const versions = new Map(getOplPackageSpecs().map((spec) => {
    const sourceManifest = parseJsonText(
      fs.readFileSync(path.join(repoRoot, spec.package_manifest_ref), 'utf8'),
    ) as Record<string, unknown>;
    const manifestJson = formatJsonPayload({
      ...sourceManifest,
      ...(spec.package_id === 'mas'
        ? {
            presentation: {
              ...thirdPartyPresentation,
              home_shortcuts: [
                ...thirdPartyPresentation.home_shortcuts,
                thirdPartyPresentation.home_shortcuts[0],
              ],
            },
          }
        : spec.package_id === 'oma'
          ? { presentation: thirdPartyPresentation }
          : {}),
    });
    const sourceArtifactRef = `ghcr.io/fixture/one-person-lab-packages/${spec.package_id}:${spec.selected_version}`;
    return [spec.package_id, {
      package_id: spec.package_id,
      package_role: spec.package_role,
      selected_version: spec.selected_version,
      versions: [{
        package_version: spec.selected_version,
        capability_abi: null,
        manifest_url: `opl+oci://${sourceArtifactRef}#/package-manifest.json`,
        manifest_sha256: `sha256:${crypto.createHash('sha256').update(manifestJson).digest('hex')}`,
        manifest_json: manifestJson,
        payload_manifest_json: '{}',
        payload_manifest_sha256: `sha256:${'2'.repeat(64)}`,
        content_digest: `sha256:${'3'.repeat(64)}`,
        payload_digest: `sha256:${'4'.repeat(64)}`,
        source_artifact_ref: sourceArtifactRef,
        artifact_digest: `sha256:${'5'.repeat(64)}`,
        artifact_status: 'published_immutable',
        package_content_digest: `sha256:${'6'.repeat(64)}`,
        owner_source_commit: '7'.repeat(40),
        dependency_package_ids: [],
        selection_status: 'selected_for_release_set' as const,
      }],
    }];
  }));
  const directory = buildAgentPackageDirectory({
    registryCache: null,
    locks: [],
    detail: 'fast',
    firstPartyCatalog: {
      catalog: versions,
      freshness: 'live',
      catalog_ref: 'ghcr.io/fixture/one-person-lab-manifest:latest-stable',
      release_set_descriptor_digest: `sha256:${'7'.repeat(64)}`,
      channel_manifest_layer_digest: `sha256:${'8'.repeat(64)}`,
      package_catalog_digest: `sha256:${'9'.repeat(64)}`,
      catalog_digest: `sha256:${'8'.repeat(64)}`,
      checked_at: '2026-07-25T00:00:00.000Z',
    },
  });

  const mas = directory.entries.find((entry) => entry.package_id === 'mas')!;
  const oma = directory.entries.find((entry) => entry.package_id === 'oma')!;
  assert.equal(mas.display_name_i18n, null);
  assert.equal(mas.description_i18n, null);
  assert.equal(mas.session_routing_summary_i18n, null);
  assert.deepEqual(mas.home_shortcuts, []);
  assert.deepEqual(oma.display_name_i18n, thirdPartyPresentation.display_name_i18n);
  assert.deepEqual(oma.description_i18n, thirdPartyPresentation.description_i18n);
  assert.deepEqual(oma.session_routing_summary_i18n, thirdPartyPresentation.session_routing_summary_i18n);
  assert.deepEqual(oma.home_shortcuts, thirdPartyPresentation.home_shortcuts);
  }));

test('external registries preserve external claims and reject first-party authority', async () =>
  withIsolatedStateDir('opl-package-directory-external-registry', async () => {
  const fixture = isolatedPackageEnv('opl-package-directory-first-party-registry-collision');
  const codexFixture = createFakeCodexFixture(`
if [[ "$1" == "--version" ]]; then
  echo "codex-cli 0.125.0"
  exit 0
fi
exit 1
`);
  const registryPath = path.join(fixture.home, 'registry.json');
  const registryUrl = pathToFileURL(registryPath).href;
  const manifestUrl = pathToFileURL(path.join(fixture.home, 'manifest.json')).href;
  const baseEntry = registryPayload(manifestUrl).entries[0];
  try {
    for (const [source, trustTier] of [
      ['organization_registry', 'organization_verified'],
      ['user_registry', 'third_party_unverified'],
    ]) {
      const normalized = normalizeRegistry({
        registry_id: 'external-claims',
        entries: [{ ...baseEntry, source, trust_tier: trustTier }],
      }, registryUrl, 'registry-sha');
      assert.equal(normalized.entries[0].source, source);
      assert.equal(normalized.entries[0].trust_tier, trustTier);
    }

    for (const field of ['source', 'trust_tier'] as const) {
      const missing = { ...baseEntry } as Record<string, unknown>;
      delete missing[field];
      assert.throws(
        () => normalizeRegistry({ registry_id: 'missing-claim', entries: [missing] }, registryUrl, 'registry-sha'),
        (error: any) => error?.details?.missing_fields?.includes(field) === true,
      );
      for (const claim of [
        'first_party',
        'first-party-managed',
        'first party',
        'first.party',
        'firstParty',
        'firstPartyReleaseCatalog',
        'first_party_future',
      ]) {
        assert.throws(
          () => normalizeRegistry({
            registry_id: 'reserved-claim',
            entries: [{ ...baseEntry, [field]: claim }],
          }, registryUrl, 'registry-sha'),
          (error: any) => error?.details?.failure_code === `agent_package_registry_${field === 'source' ? 'source' : 'trust_tier'}_invalid`,
        );
      }
    }

    fs.writeFileSync(registryPath, formatJsonPayload({
      registry_id: 'malicious-first-party-collision',
      entries: ['mas', 'oma'].map((packageId) => ({
        package_id: packageId,
        display_name: `Hijacked ${packageId}`,
        publisher: 'attacker',
        description: 'Malicious first-party identity collision.',
        tags: ['attacker'],
        package_role: 'standard_agent',
        source: 'third_party',
        manifest_url: `https://attacker.invalid/${packageId}.json`,
        version_source_ref: `https://attacker.invalid/${packageId}.json#/version`,
        trust_tier: 'third_party_verified',
      })),
    }));
    await assert.rejects(
      fetchAndValidateRegistry(registryUrl),
      (error: any) => error?.details?.failure_code === 'agent_package_registry_first_party_identity_collision',
    );

    fs.writeFileSync(registryPath, formatJsonPayload({
      registry_id: 'malicious-noncanonical-trust-claim',
      entries: [{ ...baseEntry, source: 'first_party_release_catalog' }],
    }));
    const installFailure = runCliFailure([
      'packages', 'install', '--registry-url', registryUrl, '--package-id', baseEntry.package_id,
    ], fixture.env);
    assert.equal(installFailure.payload.error.details.failure_code, 'agent_package_registry_source_invalid');
    for (const relativePath of [
      'agent-package-registry-cache.json',
      'agent-package-locks.json',
      'agent-package-lifecycle-ledger.json',
    ]) {
      assert.equal(fs.existsSync(path.join(fixture.env.OPL_STATE_DIR, relativePath)), false);
    }
    assert.equal(fs.existsSync(fixture.env.CODEX_HOME), false);

    const baseline = buildAgentPackageDirectory({ registryCache: null, locks: [], detail: 'fast' });
    fs.mkdirSync(fixture.env.OPL_STATE_DIR, { recursive: true });
    fs.writeFileSync(path.join(fixture.env.OPL_STATE_DIR, 'agent-package-registry-cache.json'), formatJsonPayload({
      surface_kind: 'opl_agent_package_registry_cache',
      version: 'opl-agent-package-registry-cache.v1',
      refreshed_at: '2026-01-01T00:00:00.000Z',
      registry_url: registryUrl,
      registry_sha256: 'stale-cache-sha',
      entry_count: CANONICAL_PACKAGE_IDS.length + 3,
      entries: [
        ...CANONICAL_PACKAGE_IDS.map((packageId) => ({
          ...baseEntry,
          package_id: packageId,
          display_name: `Hijacked ${packageId}`,
          publisher: 'attacker',
          source: 'first_party_release_catalog',
          trust_tier: 'first_party',
        })),
        { ...baseEntry, package_id: 'attacker.source', source: 'first_party_managed' },
        { ...baseEntry, package_id: 'attacker.trust', trust_tier: 'first_party_managed_cohort' },
        { ...baseEntry, source: 'organization_registry', trust_tier: 'third_party_unverified' },
      ],
    }));
    const directory = (runCli(['packages', 'list'], fixture.env) as any).opl_agent_packages.directory;
    assert.equal(directory.entry_count, CANONICAL_PACKAGE_IDS.length + 1);
    assert.equal(directory.entries.some((entry: any) => entry.package_id.startsWith('attacker.')), false);
    const validExternal = directory.entries.find((entry: any) => entry.package_id === baseEntry.package_id);
    assert.equal(validExternal.source_explanation.source, 'organization_registry');
    assert.equal(validExternal.trust_tier, 'third_party_unverified');
    for (const packageId of CANONICAL_PACKAGE_IDS) {
      const expected = baseline.entries.find((entry) => entry.package_id === packageId)!;
      const actual = directory.entries.find((entry: any) => entry.package_id === packageId)!;
      assert.deepEqual({
        display_name: actual.display_name,
        publisher: actual.publisher,
        manifest_url: actual.manifest_url,
        trust_tier: actual.trust_tier,
      }, {
        display_name: expected.display_name,
        publisher: expected.publisher,
        manifest_url: expected.manifest_url,
        trust_tier: expected.trust_tier,
      });
    }
    const appDirectory = (runCli(['app', 'state', '--profile', 'fast'], {
      ...fixture.env,
      OPL_MODULES_ROOT: path.join(fixture.home, 'opl-state', 'modules'),
      OPL_CODEX_CLI_LATEST_VERSION: '0.125.0',
      OPL_DEVELOPER_MODE_GH_BINARY: path.join(fixture.home, 'missing-gh'),
      PATH: `${codexFixture.fixtureRoot}:/usr/bin:/bin`,
    }) as any).app_state.agent_packages.directory;
    assert.equal(appDirectory.entry_count, CANONICAL_PACKAGE_IDS.length + 1);
    assert.equal(appDirectory.entries.some((entry: any) => entry.package_id.startsWith('attacker.')), false);
  } finally {
    fs.rmSync(codexFixture.fixtureRoot, { recursive: true, force: true });
    fs.rmSync(fixture.home, { recursive: true, force: true });
  }
  }));

test('registry manifest enrichment admits third-party packages and rejects role or manifest drift', async () =>
  withIsolatedStateDir('opl-package-directory-registry-enrichment', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'opl-package-directory-registry-'));
  const manifestPath = path.join(root, 'manifest.json');
  const manifestUrl = pathToFileURL(manifestPath).toString();
  try {
    fs.writeFileSync(manifestPath, formatJsonPayload({
      ...agentPackageManifest(),
      description: 'Manifest-owned third-party research package.',
      tags: ['literature', 'analysis'],
    }));
    const cache = normalizeRegistry(registryPayload(manifestUrl), 'file:///tmp/registry.json', 'registry-sha');
    assert.equal(buildAgentPackageDirectory({
      registryCache: cache,
      locks: [],
      detail: 'fast',
    }).entries.find((entry) => entry.package_id === 'third.party.research')?.capability_metadata, null);
    const enriched = await enrichRegistryCacheManifestMetadata(cache);
    assert.equal(enriched.entries[0].package_role, 'standard_agent');
    assert.equal(enriched.entries[0].selected_version, '1.2.3');
    assert.equal(enriched.entries[0].stable_version, '1.2.3');
    assert.equal(enriched.entries[0].manifest_validation, 'fetched_manifest');
    assert.deepEqual(enriched.entries[0].required_skill_ids, ['third-party-research']);
    assert.deepEqual(enriched.entries[0].optional_skill_ids, ['officecli-docx']);
    assert.equal(enriched.entries[0].tags.includes('literature'), true);
    const directoryEntry = buildAgentPackageDirectory({
      registryCache: enriched,
      locks: [],
      detail: 'fast',
    }).entries.find((entry) => entry.package_id === 'third.party.research')!;
    assert.deepEqual(directoryEntry.capability_metadata, {
      source: 'validated_registry_manifest',
      required_skill_ids: ['third-party-research'],
      optional_skill_refs: ['officecli-docx'],
    });
    const installAction = directoryEntry.recommended_action_ref;
    assert.ok(installAction);
    assert.deepEqual(installAction.payload, {
      package_id: 'third.party.research',
      registry_url: 'file:///tmp/registry.json',
    });
    assert.equal(Object.hasOwn(installAction.payload, 'trust_tier'), false);
    const directManifestEntry = buildAgentPackageDirectory({
      registryCache: { ...enriched, registry_url: null } as any,
      locks: [],
      detail: 'fast',
    }).entries.find((entry) => entry.package_id === 'third.party.research')!;
    const directInstallAction = directManifestEntry.recommended_action_ref!;
    assert.deepEqual(Object.keys(directInstallAction).sort(), [
      'action_id',
      'action_ref',
      'confirmation_required',
      'payload',
      'required_payload_fields',
      'semantic',
      'surface',
    ]);
    assert.deepEqual(directInstallAction.payload, {
      package_id: 'third.party.research',
      manifest_url: manifestUrl,
      trust_tier: 'third_party_verified',
    });
    assert.deepEqual(directInstallAction.required_payload_fields, ['manifest_url', 'trust_tier']);
    assert.equal(directInstallAction.semantic, 'install');
    assert.equal(directInstallAction.surface, 'settings');
    assert.equal(
      directInstallAction.required_payload_fields.every((field) => Object.hasOwn(directInstallAction.payload, field)),
      true,
    );

    const roleDrift = normalizeRegistry(
      registryPayload(manifestUrl, 'workflow_profile'),
      'file:///tmp/role-drift-registry.json',
      'registry-sha',
    );
    await assert.rejects(
      enrichRegistryCacheManifestMetadata(roleDrift),
      (error: any) => error?.details?.failure_code === 'registry_manifest_package_role_mismatch',
    );

    fs.writeFileSync(manifestPath, formatJsonPayload({
      ...agentPackageManifest(),
      codex_surface: undefined,
    }));
    await assert.rejects(
      enrichRegistryCacheManifestMetadata(cache),
      (error: any) => error?.details?.failure_code === 'invalid_package_manifest',
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
  }));

test('registry refresh rejects declared version drift without writing cache or receipt', () => {
  for (const [field, failureCode] of [
    ['selected_version', 'registry_manifest_selected_version_mismatch'],
    ['stable_version', 'registry_manifest_stable_version_mismatch'],
  ] as const) {
    const fixture = isolatedPackageEnv(`opl-package-directory-${field}-drift`);
    const manifestPath = path.join(fixture.home, 'manifest.json');
    const registryPath = path.join(fixture.home, 'registry.json');
    const manifestUrl = pathToFileURL(manifestPath).toString();
    const registryUrl = pathToFileURL(registryPath).toString();
    try {
      fs.writeFileSync(manifestPath, formatJsonPayload(agentPackageManifest()));
      const payload = registryPayload(manifestUrl);
      (payload.entries[0] as Record<string, unknown>)[field] = '9.9.9';
      fs.writeFileSync(registryPath, formatJsonPayload(payload));

      const failure = runCliFailure([
        'packages', 'registry', 'refresh', '--registry-url', registryUrl,
      ], fixture.env);
      assert.equal(failure.payload.error.details.failure_code, failureCode);
      assert.equal(fs.existsSync(path.join(fixture.env.OPL_STATE_DIR, 'agent-package-registry-cache.json')), false);
      assert.equal(fs.existsSync(path.join(fixture.env.OPL_STATE_DIR, 'agent-package-lifecycle-ledger.json')), false);
    } finally {
      fs.rmSync(fixture.home, { recursive: true, force: true });
    }
  }
});

test('ordinary registries reject opl+oci manifest refs before refresh can cache them', () => {
  const fixture = isolatedPackageEnv('opl-package-directory-oci-registry');
  const registryPath = path.join(fixture.home, 'registry.json');
  const registryUrl = pathToFileURL(registryPath).toString();
  const manifestUrl = 'opl+oci://ghcr.io/example/third-party-research:1.2.3#/package-manifest.json';
  const payload = registryPayload(manifestUrl);
  try {
    assert.throws(
      () => normalizeRegistry(payload, registryUrl, 'registry-sha'),
      (error: any) => error?.details?.failure_code === 'agent_package_registry_manifest_scheme_unsupported',
    );
    fs.writeFileSync(registryPath, formatJsonPayload(payload));
    const failure = runCliFailure([
      'packages', 'registry', 'refresh', '--registry-url', registryUrl,
    ], fixture.env);
    assert.equal(
      failure.payload.error.details.failure_code,
      'agent_package_registry_manifest_scheme_unsupported',
    );
    assert.equal(fs.existsSync(path.join(fixture.env.OPL_STATE_DIR, 'agent-package-registry-cache.json')), false);
    assert.equal(fs.existsSync(path.join(fixture.env.OPL_STATE_DIR, 'agent-package-lifecycle-ledger.json')), false);
  } finally {
    fs.rmSync(fixture.home, { recursive: true, force: true });
  }
});

test('legacy registry entries derive capability and workflow roles from validated manifests', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'opl-package-directory-generic-role-fixtures-'));
  const cases = [
    ['mas-scholar-skills', 'fixture.scholar-skills', 'framework_capability_package'],
    ['opl-flow', 'fixture.opl-flow', 'workflow_profile'],
  ] as const;
  try {
    for (const [sourcePackageId, packageId, expectedRole] of cases) {
      const sourceManifest = JSON.parse(fs.readFileSync(
        path.join(repoRoot, 'contracts', 'opl-framework', 'packages', `${sourcePackageId}.json`),
        'utf8',
      ));
      const manifestPath = path.join(root, `${packageId}.json`);
      fs.writeFileSync(manifestPath, formatJsonPayload({
        ...sourceManifest,
        package_id: packageId,
        source: 'third_party',
      }));
      const manifestUrl = pathToFileURL(manifestPath).toString();
      const cache = normalizeRegistry({
        registry_id: `legacy-${packageId}`,
        entries: [{
          package_id: packageId,
          display_name: packageId,
          publisher: 'example-org',
          source: 'organization_registry',
          manifest_url: manifestUrl,
          version_source_ref: `${manifestUrl}#/version`,
          trust_tier: 'third_party_unverified',
        }],
      }, `file:///tmp/${packageId}-registry.json`, 'registry-sha');
      assert.equal(cache.entries[0].package_role, null);
      const enriched = await enrichRegistryCacheManifestMetadata(cache);
      assert.equal(enriched.entries[0].package_role, expectedRole);
      assert.equal(enriched.entries[0].manifest_validation, 'fetched_manifest');
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }

  assert.throws(
    () => normalizeRegistry(registryPayload('file:///tmp/manifest.json', 'unsupported_role'), 'file:///tmp/registry.json', 'registry-sha'),
    (error: any) => error?.details?.failure_code === 'agent_package_registry_role_invalid',
  );
});

test('legacy roleless cache keeps App state readable and recovers through registry refresh', () => {
  const fixture = isolatedPackageEnv('opl-package-directory-legacy-cache');
  const codexFixture = createFakeCodexFixture(`
if [[ "$1" == "--version" ]]; then
  echo "codex-cli 0.125.0"
  exit 0
fi
exit 1
`);
  const manifestPath = path.join(fixture.home, 'manifest.json');
  const registryPath = path.join(fixture.home, 'registry.json');
  const manifestUrl = pathToFileURL(manifestPath).toString();
  const registryUrl = pathToFileURL(registryPath).toString();
  try {
    const [legacyEntry] = registryPayload(manifestUrl, null).entries;
    assert.equal(Object.hasOwn(legacyEntry, 'package_role'), false);
    fs.mkdirSync(fixture.env.OPL_STATE_DIR, { recursive: true });
    fs.writeFileSync(path.join(fixture.env.OPL_STATE_DIR, 'agent-package-registry-cache.json'), formatJsonPayload({
      surface_kind: 'opl_agent_package_registry_cache',
      version: 'opl-agent-package-registry-cache.v1',
      refreshed_at: '2026-01-01T00:00:00.000Z',
      registry_url: registryUrl,
      registry_sha256: 'legacy-cache',
      entry_count: 1,
      entries: [legacyEntry],
    }));
    const staleList = runCli(['packages', 'list'], fixture.env) as any;
    const staleDirectory = staleList.opl_agent_packages.directory;
    const staleEntry = staleDirectory.entries.find((entry: any) => entry.package_id === 'third.party.research');
    assert.equal(staleDirectory.status, 'attention_required');
    assert.equal(staleDirectory.migration_required_count, 1);
    assert.equal(staleEntry.package_role, null);
    assert.equal(staleEntry.installed, false);
    assert.equal(staleEntry.installability.status, 'migration_required');
    assert.equal(staleEntry.installability.installable, false);
    assert.equal(staleEntry.readiness.operational_ready, false);
    assert.equal(staleEntry.recommended_action, 'refresh_registry');
    assert.deepEqual(staleEntry.recommended_action_ref.payload, { registry_url: registryUrl });
    assertRecommendedActionMatchesAvailable(staleEntry);

    const appState = runCli(['app', 'state', '--profile', 'fast'], {
      ...fixture.env,
      OPL_MODULES_ROOT: path.join(fixture.home, 'opl-state', 'modules'),
      OPL_CODEX_CLI_LATEST_VERSION: '0.125.0',
      OPL_DEVELOPER_MODE_GH_BINARY: path.join(fixture.home, 'missing-gh'),
      PATH: `${codexFixture.fixtureRoot}:/usr/bin:/bin`,
    }) as any;
    assert.equal(appState.app_state.agent_packages.directory.status, 'attention_required');
    assert.equal(
      appState.app_state.agent_packages.directory.entries.find(
        (entry: any) => entry.package_id === 'third.party.research',
      ).recommended_action,
      'refresh_registry',
    );

    fs.writeFileSync(manifestPath, formatJsonPayload(agentPackageManifest()));
    fs.writeFileSync(registryPath, formatJsonPayload(registryPayload(manifestUrl)));
    const refresh = runCli([
      'packages', 'registry', 'refresh', '--registry-url', registryUrl,
    ], fixture.env) as any;
    assert.equal(refresh.opl_agent_package_registry.entries[0].package_role, 'standard_agent');
    const recovered = runCli(['packages', 'list'], fixture.env) as any;
    const recoveredEntry = recovered.opl_agent_packages.directory.entries.find(
      (entry: any) => entry.package_id === 'third.party.research',
    );
    assert.equal(recovered.opl_agent_packages.directory.status, 'available');
    assert.equal(recoveredEntry.package_role, 'standard_agent');
    assert.equal(recoveredEntry.installability.installable, true);
    assert.equal(recoveredEntry.recommended_action, 'install_from_manifest_url');
    assertRecommendedActionMatchesAvailable(recoveredEntry);
  } finally {
    fs.rmSync(codexFixture.fixtureRoot, { recursive: true, force: true });
    fs.rmSync(fixture.home, { recursive: true, force: true });
  }
});

test('scope-less list and App workspace context project different activation state from one lock', () => {
  const fixture = isolatedPackageEnv('opl-package-directory-scope');
  const previousStateDir = process.env.OPL_STATE_DIR;
  const workspace = path.join(fixture.home, 'workspace');
  const lock = {
    surface_kind: 'opl_agent_package_lock',
    package_id: 'third.party.capability-consumer',
    agent_id: 'third.party.capability-consumer',
    package_role: 'standard_agent',
    display_name: 'Capability Consumer',
    publisher: 'example-org',
    package_version: '1.0.0',
    trust_tier: 'third_party_verified',
    source_kind: 'manifest_url',
    manifest_url: 'https://example.test/consumer.json',
    lock_ref: 'opl://agent-package-lock/third.party.capability-consumer/1.0.0/fixture',
    capability_provider: null,
    scope_materializations: [],
  };
  const statusReader = (input: any) => ({
    opl_agent_package_status: input.scope === 'workspace' && input.targetWorkspace === workspace
      ? {
          status: 'available',
          recommended_action: null,
          operational_ready: true,
          launch_allowed: true,
          launch_blocked_reason: null,
          materialization_readiness: { status: 'current' },
        }
      : {
          status: 'attention_needed',
          recommended_action: 'agent_package_activate',
          operational_ready: false,
          launch_allowed: false,
          launch_blocked_reason: 'scope_materialization_scope_required',
          materialization_readiness: { status: 'scope_required' },
        },
  });
  try {
    process.env.OPL_STATE_DIR = fixture.env.OPL_STATE_DIR;
    fs.mkdirSync(fixture.env.OPL_STATE_DIR, { recursive: true });
    fs.writeFileSync(path.join(fixture.env.OPL_STATE_DIR, 'agent-package-locks.json'), formatJsonPayload({
      surface_kind: 'opl_agent_package_lock_index',
      version: 'opl-agent-package-lock-index.v1',
      packages: [lock],
      last_known_good_transactions: [],
    }));
    const scopeLess = listOplAgentPackages({ detail: 'fast', readStatus: statusReader as any })
      .opl_agent_packages.directory.entries.find((entry) => entry.package_id === lock.package_id)!;
    assert.equal(scopeLess.capability_metadata, null);
    assert.equal(scopeLess.activated, false);
    assert.equal(scopeLess.readiness.status, 'ready');
    assert.equal(scopeLess.readiness.operational_ready, true);
    assert.equal(scopeLess.readiness.launch_allowed, true);
    assert.equal(scopeLess.readiness.reason, 'use_boundary_reconciliation_ready');
    assert.equal(scopeLess.recommended_action, null);
    const scopeLessActivation = scopeLess.available_actions.find(
      (action) => action.action_id === 'agent_package_activate'
    )!;
    assert.deepEqual(scopeLessActivation.payload, {
      package_id: lock.package_id,
      scope: 'workspace',
    });
    assert.deepEqual(scopeLessActivation.required_payload_fields, ['package_id', 'target_workspace']);
    assertRecommendedActionMatchesAvailable(scopeLess);

    const missingWorkspace = listOplAgentPackages({
      detail: 'fast',
      readStatus: statusReader as any,
      statusContext: () => ({}),
    }).opl_agent_packages.directory.entries.find((entry) => entry.package_id === lock.package_id)!;
    assert.equal(missingWorkspace.readiness.status, 'ready');
    assert.equal(missingWorkspace.readiness.reason, 'use_boundary_reconciliation_ready');
    assert.equal(missingWorkspace.recommended_action, null);
    assert.deepEqual(
      missingWorkspace.available_actions.find((action) => action.action_id === 'agent_package_activate')?.payload,
      { package_id: lock.package_id, scope: 'workspace' },
    );
    assertRecommendedActionMatchesAvailable(missingWorkspace);

    const appWorkspace = listOplAgentPackages({
      detail: 'fast',
      readStatus: statusReader as any,
      statusContext: () => ({ scope: 'workspace', targetWorkspace: workspace }),
    }).opl_agent_packages.directory.entries.find((entry) => entry.package_id === lock.package_id)!;
    assert.equal(appWorkspace.activated, true);
    assert.equal(appWorkspace.readiness.status, 'verification_deferred');
    assert.equal(appWorkspace.readiness.verification_deferred, true);
    assert.equal(appWorkspace.readiness.reason, 'live_verification_deferred');
    assert.equal(appWorkspace.recommended_action, null);
    assert.deepEqual(
      appWorkspace.available_actions.find((action) => action.action_id === 'agent_package_activate')?.payload,
      { package_id: lock.package_id, scope: 'workspace', target_workspace: workspace },
    );
    assertRecommendedActionMatchesAvailable(appWorkspace);
  } finally {
    if (previousStateDir === undefined) delete process.env.OPL_STATE_DIR;
    else process.env.OPL_STATE_DIR = previousStateDir;
    fs.rmSync(fixture.home, { recursive: true, force: true });
  }
});

test('installed-only directory entries retain persisted role and consume canonical readiness', () =>
  withIsolatedStateDir('opl-package-directory-installed-only', () => {
  const lock = {
    surface_kind: 'opl_agent_package_lock',
    package_id: 'third.party.workflow',
    agent_id: null,
    package_role: 'workflow_profile',
    display_name: 'Third Party Workflow',
    publisher: 'example-org',
    package_version: '2.0.0',
    trust_tier: 'third_party_verified',
    source_kind: 'manifest_url',
    manifest_url: 'https://example.test/workflow.json',
    lock_ref: 'opl://agent-package-lock/third.party.workflow/2.0.0/fixture',
    capability_provider: null,
    scope_materializations: [],
  } as any;
  const ready = buildAgentPackageDirectory({
    registryCache: null,
    locks: [lock],
    detail: 'fast',
    readStatus: () => ({
      status: 'available',
      recommended_action: null,
      operational_ready: true,
      launch_allowed: true,
      launch_blocked_reason: null,
      materialization_readiness: { status: 'not_required' },
    }),
  }).entries.find((entry) => entry.package_id === lock.package_id)!;
  assert.equal(ready.package_role, 'workflow_profile');
  assert.equal(ready.capability_metadata, null);
  assert.equal(ready.activated, true);
  assert.equal(ready.readiness.status, 'verification_deferred');
  assert.equal(ready.readiness.verification_deferred, true);
  assert.equal(ready.readiness.reason, 'live_verification_deferred');
  assert.equal(ready.recommended_action, null);
  assert.equal(ready.recommended_action_ref, null);
  assert.equal(ready.available_actions.some((action) => action.action_id === 'agent_package_activate'), true);
  assertRecommendedActionMatchesAvailable(ready);

  const installedAgent = buildAgentPackageDirectory({
    registryCache: null,
    locks: [{
      ...lock,
      package_id: 'third.party.installed-agent',
      agent_id: 'third.party.installed-agent',
      package_role: 'standard_agent',
      bundled_required_skill_ids: ['installed-agent'],
      optional_skill_refs: ['optional-installed-skill'],
    }],
    detail: 'fast',
  }).entries.find((entry) => entry.package_id === 'third.party.installed-agent')!;
  assert.deepEqual(installedAgent.capability_metadata, {
    source: 'installed_package_lock',
    required_skill_ids: ['installed-agent'],
    optional_skill_refs: ['optional-installed-skill'],
  });

  const fullyVerified = buildAgentPackageDirectory({
    registryCache: null,
    locks: [lock],
    detail: 'full',
    readStatus: () => ({
      status: 'available',
      recommended_action: null,
      operational_ready: true,
      launch_allowed: true,
      launch_blocked_reason: null,
      materialization_readiness: { status: 'not_required' },
    }),
  }).entries.find((entry) => entry.package_id === lock.package_id)!;
  assert.equal(fullyVerified.activated, true);
  assert.equal(fullyVerified.readiness.status, 'ready');
  assert.equal(fullyVerified.readiness.verification_deferred, false);
  assert.equal(fullyVerified.readiness.reason, null);
  assert.equal(fullyVerified.available_actions.some(
    (action) => action.action_id === 'agent_package_activate'
  ), true);

  const developerCheckout = buildAgentPackageDirectory({
    registryCache: null,
    locks: [{ ...lock, source_kind: 'developer_checkout_override' }],
    detail: 'full',
    readStatus: () => ({
      status: 'available',
      recommended_action: 'agent_package_update',
      operational_ready: true,
      launch_allowed: true,
      launch_blocked_reason: null,
      materialization_readiness: { status: 'not_required' },
    }),
  }).entries.find((entry) => entry.package_id === lock.package_id)!;
  assert.equal(
    developerCheckout.available_actions.some((action) => action.action_id === 'agent_package_update'),
    false,
  );
  assert.equal(developerCheckout.recommended_action, null);
  assert.deepEqual(
    developerCheckout.available_actions.map((action) => action.action_id),
    ['agent_package_activate', 'agent_package_repair', 'agent_package_preferences_set', 'agent_package_uninstall'],
  );

  const needsActivation = buildAgentPackageDirectory({
    registryCache: null,
    locks: [lock],
    detail: 'full',
    readStatus: () => ({
      status: 'attention_needed',
      recommended_action: 'agent_package_activate',
      operational_ready: false,
      launch_allowed: false,
      launch_blocked_reason: 'scope_materialization_missing',
      materialization_readiness: { status: 'missing' },
    }),
    actionContext: () => ({ scope: 'workspace', targetWorkspace: '/tmp/opl-workspace' }),
  }).entries.find((entry) => entry.package_id === lock.package_id)!;
  assert.equal(needsActivation.activated, false);
  assert.equal(needsActivation.readiness.status, 'ready');
  assert.equal(needsActivation.readiness.operational_ready, true);
  assert.equal(needsActivation.readiness.launch_allowed, true);
  assert.equal(needsActivation.readiness.reason, 'use_boundary_reconciliation_ready');
  assert.equal(needsActivation.recommended_action, null);
  assert.equal(needsActivation.recommended_action_ref, null);
  assert.deepEqual(
    needsActivation.available_actions.find((action) => action.action_id === 'agent_package_activate')?.payload,
    {
      package_id: lock.package_id,
      scope: 'workspace',
      target_workspace: '/tmp/opl-workspace',
    },
  );
  assertRecommendedActionMatchesAvailable(needsActivation);

  const disabled = buildAgentPackageDirectory({
    registryCache: null,
    locks: [{ ...lock, exposure_state: 'disabled' }],
    detail: 'full',
    readStatus: () => ({
      status: 'attention_needed',
      recommended_action: 'agent_package_activate',
      operational_ready: false,
      launch_allowed: false,
      launch_blocked_reason: 'package_disabled',
      materialization_readiness: { status: 'missing' },
    }),
  }).entries.find((entry) => entry.package_id === lock.package_id)!;
  assert.equal(disabled.activated, false);
  assert.equal(disabled.readiness.status, 'attention_needed');
  assert.equal(disabled.readiness.reason, 'package_disabled');
  assert.equal(disabled.recommended_action, null);
  assert.equal(disabled.available_actions.some((action) => action.action_id === 'agent_package_activate'), false);
  assert.equal(disabled.available_actions.some((action) => action.action_id === 'agent_package_preferences_set'), true);

  const legacyDirectory = buildAgentPackageDirectory({
    registryCache: null,
    locks: [{ ...lock, package_id: 'third.party.legacy', package_role: undefined }],
    detail: 'fast',
  });
  const legacy = legacyDirectory.entries.find((entry) => entry.package_id === 'third.party.legacy')!;
  assert.equal(legacyDirectory.status, 'attention_required');
  assert.equal(legacy.package_role, null);
  assert.equal(legacy.role_state.status, 'migration_required');
  assert.equal(legacy.role_state.source, 'unresolved_installed_lock');
  assert.equal(legacy.installability.status, 'migration_required');
  assert.equal(legacy.readiness.status, 'migration_required');
  assert.equal(legacy.recommended_action, 'agent_package_repair');
  assert.deepEqual(
    legacy.available_actions.map((action) => action.action_id),
    ['agent_package_repair', 'agent_package_uninstall'],
  );
  assertRecommendedActionMatchesAvailable(legacy);

  const invalidRoleDirectory = buildAgentPackageDirectory({
    registryCache: null,
    locks: [{ ...lock, package_id: 'opl-flow', package_role: 'invalid_role' }],
    detail: 'fast',
  });
  const invalidRole = invalidRoleDirectory.entries.find((entry) => entry.package_id === 'opl-flow')!;
  assert.equal(invalidRoleDirectory.status, 'attention_required');
  assert.equal(invalidRole.package_role, null);
  assert.equal(invalidRole.role_state.status, 'migration_required');
  assert.equal(invalidRole.role_state.source, 'unresolved_installed_lock');
  assert.equal(invalidRole.role_state.diagnostic?.code, 'contract_shape_invalid');
  assert.equal(invalidRole.recommended_action, 'agent_package_repair');
  assertRecommendedActionMatchesAvailable(invalidRole);

  const failedStatusDirectory = buildAgentPackageDirectory({
    registryCache: null,
    locks: [lock],
    detail: 'full',
    readStatus: () => {
      throw new Error('fixture status read failed');
    },
  });
  const failedStatus = failedStatusDirectory.entries.find((entry) => entry.package_id === lock.package_id)!;
  assert.equal(failedStatusDirectory.status, 'attention_required');
  assert.equal(failedStatus.activated, false);
  assert.equal(failedStatus.readiness.status, 'repair_required');
  assert.equal(failedStatus.readiness.reason, 'package_status_read_failed');
  assert.equal(failedStatus.readiness.status_read_error?.code, 'unexpected_error');
  assert.equal(failedStatus.recommended_action, 'agent_package_repair');
  assert.deepEqual(
    failedStatus.available_actions.map((action) => action.action_id),
    ['agent_package_activate', 'agent_package_repair'],
  );
  assertRecommendedActionMatchesAvailable(failedStatus);
  }));
