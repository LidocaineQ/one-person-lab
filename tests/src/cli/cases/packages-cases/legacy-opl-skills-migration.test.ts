import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';

import {
  assert,
  fs,
  formatJsonPayload,
  os,
  path,
  removeFixtureTree,
  repoRoot,
  runCli,
  runCliFailure,
  test,
} from './helpers.ts';
import { createFakeCodexPluginManagerFixture } from '../../helpers.ts';
import {
  runConfiguredCodexPluginCarrierWithLegacyOplSkillsMigration,
} from '../../../../../src/modules/connect/agent-package-registry-parts/legacy-opl-skills-migration.ts';
import type { CodexPluginCommandRunner } from '../../../../../src/modules/connect/agent-package-registry-parts/configured-codex-plugin-carrier.ts';

const skillIds = ['develop-and-deliver', 'task-mode-gate', 'recover-codex-tasks'];
const flowSkillIds = [
  'coordinate-concurrent-tasks',
  'develop-and-deliver',
  'github-ssot-patrol',
  'opl-fleet',
  'opl-flow',
  'recover-codex-tasks',
  'task-mode-gate',
];
const flowPayloadPaths = (JSON.parse(fs.readFileSync(
  path.join(repoRoot, 'contracts', 'opl-framework', 'package-payload-allowlists', 'opl-flow.json'),
  'utf8',
)) as { paths: string[] }).paths;
const executableFlowPayloadPaths = new Set([
  'scripts/opl_fleet.py',
  'scripts/worktree_absorption_audit.py',
  'scripts/worktree_lifecycle.py',
]);
const flowPluginSelector = 'opl-flow@opl-flow-local';
const legacySourceUrls: Record<string, string> = {
  'gaofeng21cn/opl-skills': 'https://github.com/gaofeng21cn/opl-skills.git',
  'gaofeng21cn/codex-skills-public': 'https://github.com/gaofeng21cn/codex-skills-public.git',
};
const descriptor = {
  packageId: 'opl-flow',
  carrier: {
    kind: 'codex_plugin_manager' as const,
    pluginId: 'opl-flow@opl-flow-local',
    marketplaceSource: 'opl-flow-local',
  },
  executor: {
    route: 'codex_cli' as const,
    requiredSkillIds: flowSkillIds,
  },
  publicationRef: null,
};

function flowManifest(input: {
  version: string;
  requiredSkillIds: string[];
  marketplaceRoot: string;
}) {
  const manifest = JSON.parse(fs.readFileSync(
    path.join(repoRoot, 'contracts', 'opl-framework', 'packages', 'opl-flow.json'),
    'utf8',
  ));
  manifest.version = input.version;
  manifest.codex_surface.required_skill_ids = input.requiredSkillIds;
  manifest.codex_surface.configured_codex_plugin_carrier = {
    kind: 'codex_plugin_manager',
    plugin_selector: flowPluginSelector,
    executor_route: 'codex_cli',
    marketplace_source: input.marketplaceRoot,
    publication_ref: null,
  };
  return manifest;
}

function writeFlowMarketplace(input: {
  root: string;
  version: string;
  requiredSkillIds: string[];
  configuredMarketplaceRoot?: string;
}) {
  const marketplaceRoot = path.join(input.root, 'marketplace');
  const pluginSource = path.join(marketplaceRoot, 'plugins', 'opl-flow');
  const marketplaceManifest = path.join(marketplaceRoot, '.agents', 'plugins', 'marketplace.json');
  const manifestPath = path.join(input.root, 'flow-manifest.json');
  const manifest = flowManifest({
    version: input.version,
    requiredSkillIds: input.requiredSkillIds,
    marketplaceRoot: input.configuredMarketplaceRoot ?? marketplaceRoot,
  });
  fs.rmSync(pluginSource, { recursive: true, force: true });
  fs.mkdirSync(path.join(pluginSource, '.codex-plugin'), { recursive: true });
  for (const skillId of input.requiredSkillIds) {
    fs.mkdirSync(path.join(pluginSource, 'skills', skillId), { recursive: true });
    fs.writeFileSync(path.join(pluginSource, 'skills', skillId, 'SKILL.md'), `# ${skillId}\n`);
  }
  fs.writeFileSync(path.join(pluginSource, '.codex-plugin', 'plugin.json'), formatJsonPayload({
    name: 'opl-flow',
    version: input.version,
    skills: './skills/',
  }));
  fs.writeFileSync(path.join(pluginSource, 'opl-package.json'), formatJsonPayload(manifest));
  fs.mkdirSync(path.dirname(marketplaceManifest), { recursive: true });
  fs.writeFileSync(marketplaceManifest, formatJsonPayload({
    name: 'opl-flow-local',
    plugins: [{
      name: 'opl-flow',
      source: { source: 'local', path: './plugins/opl-flow' },
    }],
  }));
  fs.writeFileSync(manifestPath, formatJsonPayload(manifest));
  return { marketplaceRoot, pluginSource, manifestPath };
}

function writeFlowOwnerChannelFixture(root: string, manifestPath: string) {
  const blobRoot = path.join(root, 'blobs');
  const fakeBin = path.join(root, 'bin');
  const manifestJson = fs.readFileSync(manifestPath, 'utf8');
  const manifest = JSON.parse(manifestJson);
  const payloadJson = formatJsonPayload({
    surface_kind: 'opl_agent_package_payload_manifest',
    package_id: 'opl-flow',
    package_version: manifest.version,
    source_commit: manifest.codex_surface.carrier_source_commit,
    files: [],
  });
  const manifestDigest = `sha256:${crypto.createHash('sha256').update(manifestJson).digest('hex')}`;
  const payloadDigest = `sha256:${crypto.createHash('sha256').update(payloadJson).digest('hex')}`;
  const sourceDigest = `sha256:${crypto.createHash('sha256').update('flow-source').digest('hex')}`;
  const payloadPath = path.join(blobRoot, 'payload-manifest.json');
  fs.mkdirSync(blobRoot, { recursive: true });
  fs.mkdirSync(fakeBin, { recursive: true });
  fs.writeFileSync(payloadPath, payloadJson);
  const descriptor = {
    schemaVersion: 2,
    layers: [
      { mediaType: 'application/vnd.onepersonlab.package.source.v1+gzip', digest: sourceDigest },
      {
        mediaType: 'application/vnd.onepersonlab.package.manifest.v1+json',
        digest: manifestDigest,
        annotations: { 'org.opencontainers.image.title': 'package-manifest.json' },
      },
      {
        mediaType: 'application/vnd.onepersonlab.package.payload.v1+json',
        digest: payloadDigest,
        annotations: { 'org.opencontainers.image.title': 'payload-manifest.json' },
      },
    ],
  };
  const blobs = { [manifestDigest]: manifestPath, [payloadDigest]: payloadPath };
  fs.writeFileSync(path.join(fakeBin, 'curl'), [
    '#!/usr/bin/env node',
    "const fs = require('node:fs');",
    'const args = process.argv.slice(2);',
    "const url = args.find((arg) => arg.startsWith('http://') || arg.startsWith('https://')) || '';",
    "if (url.includes('/token?')) { process.stdout.write(JSON.stringify({ token: 'fixture' })); process.exit(0); }",
    `const descriptor = ${JSON.stringify(descriptor)};`,
    `const blobs = ${JSON.stringify(blobs)};`,
    "if (url.includes('/manifests/')) { process.stdout.write(JSON.stringify(descriptor)); process.exit(0); }",
    "if (url.includes('/blobs/')) {",
    "  const digest = decodeURIComponent(url.slice(url.lastIndexOf('/') + 1));",
    "  const outIndex = args.indexOf('-o');",
    '  if (!blobs[digest] || outIndex < 0) process.exit(22);',
    '  fs.copyFileSync(blobs[digest], args[outIndex + 1]);',
    '  process.exit(0);',
    '}',
    'process.exit(22);',
  ].join('\n'), { mode: 0o755 });
  return {
    env: {
      OPL_PACKAGES_OWNER: 'fixture',
      OPL_PACKAGE_CHANNEL_TAG: 'stable',
      PATH: `${fakeBin}${path.delimiter}${process.env.PATH ?? ''}`,
    },
  };
}

function writeObservedCodexPluginManager(input: {
  root: string;
  delegate: string;
}) {
  const binary = path.join(input.root, 'observed-codex');
  fs.writeFileSync(binary, `#!/usr/bin/env node
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';

const args = process.argv.slice(2);
const command = args.join(' ');
if (process.env.FIXTURE_COMMAND_LOG) {
  fs.appendFileSync(process.env.FIXTURE_COMMAND_LOG, command + '\\n');
}
if (command === 'plugin add ${flowPluginSelector} --json') {
  const agentsRoot = path.join(process.env.HOME, '.agents');
  const lockPath = path.join(agentsRoot, '.skill-lock.json');
  if (process.env.FIXTURE_REQUIRE_LEGACY_ABSENT === '1') {
    const remaining = ${JSON.stringify(skillIds)}.filter((skillId) =>
      fs.existsSync(path.join(agentsRoot, 'skills', skillId))
    );
    const lock = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
    const declared = ${JSON.stringify(skillIds)}.filter((skillId) =>
      Object.hasOwn(lock.skills, skillId)
    );
    if (remaining.length || declared.length) {
      process.stderr.write('legacy Skills remained discoverable before Flow exposure');
      process.exit(41);
    }
  }
  if (process.env.FIXTURE_FAIL_PLUGIN_ADD === '1') {
    process.stderr.write('fixture plugin add failure');
    process.exit(42);
  }
}
if (command === 'plugin list --json' && process.env.FIXTURE_FAIL_PLUGIN_LIST === '1') {
  process.stderr.write('fixture plugin list failure');
  process.exit(43);
}
const result = spawnSync(${JSON.stringify(input.delegate)}, args, {
  env: process.env,
  encoding: 'utf8',
});
process.stdout.write(result.stdout || '');
process.stderr.write(result.stderr || '');
process.exit(result.status ?? 1);
`, { mode: 0o755 });
  return binary;
}

function publicLifecycleFixture(
  label: string,
  source = 'gaofeng21cn/opl-skills',
  sourceUrl = legacySourceUrls[source],
) {
  const state = fixture(`public-${label}`, source, sourceUrl);
  const codex = createFakeCodexPluginManagerFixture(path.join(state.root, 'fake-codex'));
  const commandLog = path.join(state.root, 'codex-commands.log');
  const observedCodex = writeObservedCodexPluginManager({ root: state.root, delegate: codex.codexPath });
  const env = {
    HOME: state.root,
    CODEX_HOME: path.join(state.root, 'codex-home'),
    OPL_STATE_DIR: path.join(state.root, 'opl-state'),
    OPL_CODEX_PLUGIN_BIN: observedCodex,
    FIXTURE_COMMAND_LOG: commandLog,
  };
  return { ...state, codex, commandLog, env };
}

function seedMarketplace(input: {
  codexPath: string;
  marketplaceRoot: string;
  env: Record<string, string>;
}) {
  execFileSync(input.codexPath, [
    'plugin', 'marketplace', 'add', input.marketplaceRoot, '--json',
  ], { env: { ...process.env, ...input.env }, stdio: 'ignore' });
}

function seedInstalledFlow(input: {
  state: ReturnType<typeof publicLifecycleFixture>;
  oldMarketplaceRoot: string;
}) {
  seedMarketplace({
    codexPath: input.state.codex.codexPath,
    marketplaceRoot: input.oldMarketplaceRoot,
    env: input.state.env,
  });
  execFileSync(input.state.codex.codexPath, [
    'plugin', 'add', flowPluginSelector, '--json',
  ], { env: { ...process.env, ...input.state.env }, stdio: 'ignore' });
  fs.rmSync(input.state.commandLog, { force: true });
}

function writeDeveloperFlowCheckout(
  root: string,
  policySchema:
    | 'opl_flow_workflow_policy.v3'
    | 'opl_flow_workflow_policy.v4' = 'opl_flow_workflow_policy.v3',
) {
  const checkout = path.join(root, 'opl-flow');
  const v4 = policySchema === 'opl_flow_workflow_policy.v4';
  const policy = {
    schema: policySchema,
    package: {
      id: 'opl-flow',
      version: '0.1.30',
      owner: 'opl-flow',
      kind: 'workflow_profile',
    },
    workflow_generation: 'fixture',
    provides: [
      {
        id: 'opl-flow',
        kind: 'codex_plugin',
        online_install_default: true,
        activation: 'always',
      },
      ...flowSkillIds.map((skillId) => ({
        id: skillId,
        kind: 'codex_skill',
        source: 'https://github.com/gaofeng21cn/opl-flow',
        source_path: `skills/${skillId}`,
        online_install_default: true,
        activation: 'task_routed',
      })),
    ],
    requires: [],
    ...(v4 ? { experience_baseline: [], capability_bundles: [] } : { recommends: [] }),
    compatible_optional: [],
    conflicts: [],
    retires: [{
      id: 'fixture-retirement',
      discovery_ids: [
        'fixture-legacy-plugin',
        'fixture-legacy-skill',
        'fixture-legacy-service',
        'fixture-legacy-config',
        'fixture-legacy-prompt',
      ],
      auto_retire_on_optimize: false,
      reason: 'Classify isolated fixture fingerprints.',
    }],
    codex_model_policy: {
      authority: 'opl-flow',
      mode_default: 'auto',
      configured_default: { model: 'gpt-5.6-sol', reasoning_effort: 'max' },
      override_precedence: ['explicit_user_override', 'opl_flow_recommendation'],
      catalog_policy: {},
    },
    migration_policy: {
      trigger: 'explicit_opl_flow_install_update_optimize_or_generic_app_post_update_reconcile',
      default_action: 'backup_disable_and_remove_from_discovery',
      physical_delete: false,
      receipt_owner: 'opl-framework',
      rollback_required: true,
      keep_override_supported: true,
      fresh_discovery_required: true,
    },
    historical_fingerprints: {
      plugin_ids: ['fixture-legacy-plugin'],
      skill_ids: ['fixture-legacy-skill'],
      service_ids: ['fixture-legacy-service'],
      config_markers: ['fixture-legacy-config'],
      legacy_prompt_ids: ['fixture-legacy-prompt'],
    },
  };
  fs.mkdirSync(path.join(checkout, '.codex-plugin'), { recursive: true });
  fs.mkdirSync(path.join(checkout, 'contracts'), { recursive: true });
  fs.mkdirSync(path.join(checkout, 'profile', 'modules'), { recursive: true });
  fs.mkdirSync(path.join(checkout, 'templates'), { recursive: true });
  fs.writeFileSync(path.join(checkout, '.codex-plugin', 'plugin.json'), formatJsonPayload({
    name: 'opl-flow',
    version: '0.1.30',
    skills: './skills/',
  }));
  fs.writeFileSync(path.join(checkout, 'contracts', 'workflow-policy.json'), formatJsonPayload(policy));
  fs.writeFileSync(path.join(checkout, 'contracts', 'workflow-policy.schema.json'), formatJsonPayload({
    type: 'object',
    required: ['schema', 'package'],
    properties: {
      schema: { const: policySchema },
      package: {
        type: 'object',
        required: ['id', 'version', 'owner', 'kind'],
      },
    },
  }));
  fs.writeFileSync(path.join(checkout, 'profile', 'manifest.json'), formatJsonPayload({
    surface_kind: 'fixture_profile',
  }));
  fs.writeFileSync(
    path.join(checkout, 'profile', 'modules', '01-user-preferences.md'),
    '# Fixture preferences\n',
  );
  fs.writeFileSync(path.join(checkout, 'templates', 'AGENTS.md'), '# Fixture AGENTS\n');
  fs.writeFileSync(path.join(checkout, 'templates', 'TASTE.md'), '# Fixture TASTE\n');
  for (const skillId of flowSkillIds) {
    const skillRoot = path.join(checkout, 'skills', skillId);
    fs.mkdirSync(skillRoot, { recursive: true });
    fs.writeFileSync(path.join(skillRoot, 'SKILL.md'), `# ${skillId}\n`);
  }
  fs.writeFileSync(path.join(checkout, 'opl-package.json'), formatJsonPayload(flowManifest({
    version: '0.1.30',
    requiredSkillIds: flowSkillIds,
    marketplaceRoot: checkout,
  })));
  for (const relativePath of flowPayloadPaths) {
    const target = path.join(checkout, relativePath);
    if (fs.existsSync(target)) continue;
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const content = relativePath.endsWith('.json')
      ? formatJsonPayload({ fixture: relativePath })
      : `# Fixture ${relativePath}\n`;
    fs.writeFileSync(target, content, {
      mode: executableFlowPayloadPaths.has(relativePath) ? 0o755 : 0o644,
    });
  }
  fs.writeFileSync(path.join(checkout, 'not-in-flow-payload.txt'), 'must not be copied\n');
  execFileSync('git', ['init', '-q'], { cwd: checkout });
  execFileSync('git', ['add', '.'], { cwd: checkout });
  execFileSync('git', [
    '-c', 'user.name=OPL Fixture',
    '-c', 'user.email=opl-fixture@example.invalid',
    'commit', '-qm', 'fixture Flow 0.1.30',
  ], { cwd: checkout });
  return checkout;
}

function makeTreeWritable(target: string) {
  const stat = fs.lstatSync(target);
  if (stat.isDirectory()) {
    fs.chmodSync(target, 0o755);
    for (const entry of fs.readdirSync(target)) makeTreeWritable(path.join(target, entry));
  } else {
    fs.chmodSync(target, stat.mode & 0o111 ? 0o755 : 0o644);
  }
}

function projectStaleInstalledFlowDescriptor(surface: any) {
  const pluginRoot = surface.marketplace_plugin_path;
  const requiredSkillIds = ['opl-flow', 'coordinate-concurrent-tasks'];
  makeTreeWritable(pluginRoot);
  const pluginManifestPath = path.join(pluginRoot, '.codex-plugin', 'plugin.json');
  const pluginManifest = JSON.parse(fs.readFileSync(pluginManifestPath, 'utf8'));
  pluginManifest.version = '0.1.29';
  fs.writeFileSync(pluginManifestPath, formatJsonPayload(pluginManifest));
  fs.writeFileSync(path.join(pluginRoot, 'opl-package.json'), formatJsonPayload(flowManifest({
    version: '0.1.29',
    requiredSkillIds,
    marketplaceRoot: surface.marketplace_root,
  })));
  for (const skillId of skillIds) {
    fs.rmSync(path.join(pluginRoot, 'skills', skillId), { recursive: true, force: true });
  }
}

function fixture(
  label: string,
  source = 'gaofeng21cn/opl-skills',
  sourceUrl = legacySourceUrls[source],
) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `opl-flow-skill-migration-${label}-`));
  const agentsRoot = path.join(root, '.agents');
  const skillsRoot = path.join(agentsRoot, 'skills');
  const lockPath = path.join(agentsRoot, '.skill-lock.json');
  const pluginSource = path.join(root, 'plugin-source');
  for (const skillId of [...skillIds, 'unrelated-skill']) {
    fs.mkdirSync(path.join(skillsRoot, skillId), { recursive: true });
    fs.writeFileSync(path.join(skillsRoot, skillId, 'SKILL.md'), `# ${skillId}\n`);
  }
  for (const skillId of descriptor.executor.requiredSkillIds) {
    fs.mkdirSync(path.join(pluginSource, 'skills', skillId), { recursive: true });
    fs.writeFileSync(path.join(pluginSource, 'skills', skillId, 'SKILL.md'), `# ${skillId}\n`);
  }
  const skills = Object.fromEntries([...skillIds, 'unrelated-skill'].map((skillId) => [skillId, {
    source: skillId === 'unrelated-skill' ? 'example/unrelated' : source,
    sourceType: 'github',
    sourceUrl: skillId === 'unrelated-skill'
      ? 'https://github.com/example/unrelated.git'
      : sourceUrl,
    skillPath: `skills/${skillId}/SKILL.md`,
  }]));
  fs.mkdirSync(agentsRoot, { recursive: true });
  fs.writeFileSync(lockPath, formatJsonPayload({ version: 3, skills, dismissed: {} }));
  return {
    root,
    agentsRoot,
    skillsRoot,
    lockPath,
    pluginSource,
    env: { HOME: root },
  };
}

function runnerFor(input: {
  pluginSource: string;
  beforeAdd?: () => void;
  addFailure?: boolean;
  omitSkill?: string;
}): CodexPluginCommandRunner {
  let installed = false;
  return ({ args }) => {
    const command = args.join(' ');
    if (command === 'plugin marketplace list --json') {
      return { status: 0, stdout: '{"marketplaces":[]}', stderr: '', error: null };
    }
    if (command === 'plugin marketplace add opl-flow-local --json') {
      return { status: 0, stdout: '{}', stderr: '', error: null };
    }
    if (command === 'plugin add opl-flow@opl-flow-local --json') {
      input.beforeAdd?.();
      if (input.addFailure) return { status: 2, stdout: '', stderr: 'failed', error: null };
      installed = true;
      return { status: 0, stdout: '{}', stderr: '', error: null };
    }
    if (command === 'plugin list --json') {
      if (input.omitSkill) {
        fs.rmSync(path.join(input.pluginSource, 'skills', input.omitSkill), { recursive: true, force: true });
      }
      return {
        status: 0,
        stdout: JSON.stringify({
          installed: installed ? [{
            pluginId: descriptor.carrier.pluginId,
            version: '0.1.30',
            installed: true,
            enabled: true,
            source: { path: input.pluginSource },
            marketplaceSource: { source: descriptor.carrier.marketplaceSource },
          }] : [],
        }),
        stderr: '',
        error: null,
      };
    }
    return { status: 2, stdout: '', stderr: `unexpected:${command}`, error: null };
  };
}

test('OPL Flow migration removes exact legacy OPL Skills projections before native exposure', () => {
  const state = fixture('success');
  try {
    const execution = runConfiguredCodexPluginCarrierWithLegacyOplSkillsMigration({
      descriptor,
      action: 'update',
      env: state.env,
      runner: runnerFor({
        pluginSource: state.pluginSource,
        beforeAdd: () => {
          for (const skillId of skillIds) assert.equal(fs.existsSync(path.join(state.skillsRoot, skillId)), false);
          const lock = JSON.parse(fs.readFileSync(state.lockPath, 'utf8'));
          for (const skillId of skillIds) assert.equal(Object.hasOwn(lock.skills, skillId), false);
        },
      }),
    });
    assert.equal(execution.carrier.executor.status, 'callable');
    assert.equal(execution.legacySkillMigration.status, 'migrated');
    assert.equal(execution.legacySkillMigration.writes_performed, true);
    assert.ok(execution.legacySkillMigration.backup_root);
    for (const skillId of skillIds) {
      assert.equal(fs.existsSync(path.join(state.skillsRoot, skillId)), false);
      assert.equal(fs.existsSync(path.join(execution.legacySkillMigration.backup_root!, 'skills', skillId)), true);
    }
    const lock = JSON.parse(fs.readFileSync(state.lockPath, 'utf8'));
    assert.deepEqual(Object.keys(lock.skills), ['unrelated-skill']);
  } finally {
    removeFixtureTree(state.root);
  }
});

test('OPL Flow migration accepts the exact pre-rename codex-skills-public identity', () => {
  const state = fixture('pre-rename-source', 'gaofeng21cn/codex-skills-public');
  try {
    const execution = runConfiguredCodexPluginCarrierWithLegacyOplSkillsMigration({
      descriptor,
      action: 'update',
      env: state.env,
      runner: runnerFor({ pluginSource: state.pluginSource }),
    });
    assert.equal(execution.legacySkillMigration.status, 'migrated');
    assert.deepEqual(execution.legacySkillMigration.skill_ids, skillIds);
    for (const skillId of skillIds) {
      assert.equal(fs.existsSync(path.join(state.skillsRoot, skillId)), false);
    }
  } finally {
    removeFixtureTree(state.root);
  }
});

test('OPL Flow migration rejects a mixed legacy source identity', () => {
  const state = fixture(
    'mixed-source-identity',
    'gaofeng21cn/codex-skills-public',
    legacySourceUrls['gaofeng21cn/opl-skills'],
  );
  const before = fs.readFileSync(state.lockPath);
  try {
    assert.throws(
      () => runConfiguredCodexPluginCarrierWithLegacyOplSkillsMigration({
        descriptor,
        action: 'update',
        env: state.env,
        runner: runnerFor({ pluginSource: state.pluginSource }),
      }),
      (error: any) => error?.details?.failure_code === 'opl_flow_legacy_skill_source_conflict',
    );
    assert.deepEqual(fs.readFileSync(state.lockPath), before);
    for (const skillId of skillIds) {
      assert.equal(fs.existsSync(path.join(state.skillsRoot, skillId)), true);
    }
  } finally {
    removeFixtureTree(state.root);
  }
});

test('OPL Flow migration restores legacy directories and lock bytes when native exposure fails', () => {
  const state = fixture('rollback');
  const before = fs.readFileSync(state.lockPath);
  try {
    assert.throws(
      () => runConfiguredCodexPluginCarrierWithLegacyOplSkillsMigration({
        descriptor,
        action: 'install',
        env: state.env,
        runner: runnerFor({ pluginSource: state.pluginSource, addFailure: true }),
      }),
      (error: any) => error?.details?.failure_code === 'configured_codex_plugin_carrier_action_failed',
    );
    assert.deepEqual(fs.readFileSync(state.lockPath), before);
    for (const skillId of skillIds) assert.equal(fs.existsSync(path.join(state.skillsRoot, skillId)), true);
  } finally {
    removeFixtureTree(state.root);
  }
});

test('OPL Flow migration rolls back when native readback is not callable', () => {
  const state = fixture('readback-rollback');
  const before = fs.readFileSync(state.lockPath);
  try {
    assert.throws(
      () => runConfiguredCodexPluginCarrierWithLegacyOplSkillsMigration({
        descriptor,
        action: 'repair',
        env: state.env,
        runner: runnerFor({ pluginSource: state.pluginSource, omitSkill: 'task-mode-gate' }),
      }),
      (error: any) => error?.details?.failure_code === 'opl_flow_legacy_skill_native_readback_failed',
    );
    assert.deepEqual(fs.readFileSync(state.lockPath), before);
    for (const skillId of skillIds) assert.equal(fs.existsSync(path.join(state.skillsRoot, skillId)), true);
  } finally {
    removeFixtureTree(state.root);
  }
});

test('OPL Flow migration fails closed for a different source owner without dispatching native action', () => {
  const state = fixture('source-conflict', 'example/other-skills');
  const before = fs.readFileSync(state.lockPath);
  let dispatched = false;
  try {
    assert.throws(
      () => runConfiguredCodexPluginCarrierWithLegacyOplSkillsMigration({
        descriptor,
        action: 'update',
        env: state.env,
        runner: (input) => {
          dispatched = true;
          return runnerFor({ pluginSource: state.pluginSource })(input);
        },
      }),
      (error: any) => error?.details?.failure_code === 'opl_flow_legacy_skill_source_conflict',
    );
    assert.equal(dispatched, false);
    assert.deepEqual(fs.readFileSync(state.lockPath), before);
  } finally {
    removeFixtureTree(state.root);
  }
});

test('OPL Flow migration validates without writes in dry-run mode', () => {
  const state = fixture('dry-run');
  const before = fs.readFileSync(state.lockPath);
  try {
    const execution = runConfiguredCodexPluginCarrierWithLegacyOplSkillsMigration({
      descriptor,
      action: 'install',
      dryRun: true,
      env: state.env,
      runner: runnerFor({ pluginSource: state.pluginSource }),
    });
    assert.equal(execution.legacySkillMigration.status, 'validated_no_write');
    assert.equal(execution.legacySkillMigration.writes_performed, false);
    assert.deepEqual(fs.readFileSync(state.lockPath), before);
    for (const skillId of skillIds) assert.equal(fs.existsSync(path.join(state.skillsRoot, skillId)), true);
  } finally {
    removeFixtureTree(state.root);
  }
});

test('fresh Flow-only home skips legacy migration and still exposes the native carrier', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'opl-flow-skill-migration-fresh-'));
  const pluginSource = path.join(root, 'plugin-source');
  try {
    for (const skillId of descriptor.executor.requiredSkillIds) {
      fs.mkdirSync(path.join(pluginSource, 'skills', skillId), { recursive: true });
      fs.writeFileSync(path.join(pluginSource, 'skills', skillId, 'SKILL.md'), `# ${skillId}\n`);
    }
    const execution = runConfiguredCodexPluginCarrierWithLegacyOplSkillsMigration({
      descriptor,
      action: 'install',
      env: { HOME: root },
      runner: runnerFor({ pluginSource }),
    });
    assert.equal(execution.legacySkillMigration.status, 'not_required');
    assert.equal(execution.carrier.executor.status, 'callable');
  } finally {
    removeFixtureTree(root);
  }
});

test('OPL Flow 0.1.29 descriptor does not retire Skills that it does not bundle', () => {
  const state = fixture('old-flow');
  const before = fs.readFileSync(state.lockPath);
  const oldDescriptor = {
    ...descriptor,
    executor: {
      ...descriptor.executor,
      requiredSkillIds: ['opl-flow', 'coordinate-concurrent-tasks'],
    },
  };
  try {
    const execution = runConfiguredCodexPluginCarrierWithLegacyOplSkillsMigration({
      descriptor: oldDescriptor,
      action: 'update',
      env: state.env,
      runner: runnerFor({ pluginSource: state.pluginSource }),
    });
    assert.equal(execution.legacySkillMigration.status, 'not_required');
    assert.deepEqual(fs.readFileSync(state.lockPath), before);
    for (const skillId of skillIds) assert.equal(fs.existsSync(path.join(state.skillsRoot, skillId)), true);
  } finally {
    removeFixtureTree(state.root);
  }
});

test('descriptor-only packages update migrates legacy Skills before exposing the configured seven-Skill Flow target', () => {
  const state = publicLifecycleFixture('update-success');
  try {
    const next = writeFlowMarketplace({
      root: path.join(state.root, 'flow-next'),
      version: '0.1.30',
      requiredSkillIds: flowSkillIds,
    });
    const previous = writeFlowMarketplace({
      root: path.join(state.root, 'flow-previous'),
      version: '0.1.29',
      requiredSkillIds: ['opl-flow', 'coordinate-concurrent-tasks'],
      configuredMarketplaceRoot: next.marketplaceRoot,
    });
    const ownerChannel = writeFlowOwnerChannelFixture(
      path.join(state.root, 'owner-channel'),
      next.manifestPath,
    );
    seedInstalledFlow({ state, oldMarketplaceRoot: previous.marketplaceRoot });

    const update = runCli(['packages', 'update', 'opl-flow'], {
      ...ownerChannel.env,
      ...state.env,
      FIXTURE_REQUIRE_LEGACY_ABSENT: '1',
    }) as any;
    assert.equal(update.opl_agent_package_update.status, 'updated');
    assert.equal(Object.hasOwn(update.opl_agent_package_update, 'legacy_skill_migration'), false);
    assert.deepEqual(
      update.opl_agent_package_update.configured_carrier.executor.required_skill_ids,
      flowSkillIds,
    );
    assert.equal(update.opl_agent_package_update.configured_carrier.installed_version, '0.1.30');
    for (const skillId of skillIds) {
      assert.equal(fs.existsSync(path.join(state.skillsRoot, skillId)), false);
      assert.equal(fs.existsSync(path.join(next.pluginSource, 'skills', skillId, 'SKILL.md')), true);
    }
    assert.match(fs.readFileSync(state.commandLog, 'utf8'), /plugin add opl-flow@opl-flow-local --json/);
  } finally {
    removeFixtureTree(state.root);
  }
});

test('public packages update fails closed on a conflicting legacy source before native add', () => {
  const state = publicLifecycleFixture('update-conflict', 'example/other-skills');
  const before = fs.readFileSync(state.lockPath);
  try {
    const next = writeFlowMarketplace({
      root: path.join(state.root, 'flow-next'),
      version: '0.1.30',
      requiredSkillIds: flowSkillIds,
    });
    const previous = writeFlowMarketplace({
      root: path.join(state.root, 'flow-previous'),
      version: '0.1.29',
      requiredSkillIds: ['opl-flow', 'coordinate-concurrent-tasks'],
      configuredMarketplaceRoot: next.marketplaceRoot,
    });
    const ownerChannel = writeFlowOwnerChannelFixture(
      path.join(state.root, 'owner-channel'),
      next.manifestPath,
    );
    seedInstalledFlow({ state, oldMarketplaceRoot: previous.marketplaceRoot });

    const failure = runCliFailure(['packages', 'update', 'opl-flow'], {
      ...ownerChannel.env,
      ...state.env,
    });
    assert.equal(failure.payload.error.details.failure_code, 'opl_flow_legacy_skill_source_conflict');
    assert.deepEqual(fs.readFileSync(state.lockPath), before);
    for (const skillId of skillIds) assert.equal(fs.existsSync(path.join(state.skillsRoot, skillId)), true);
    assert.doesNotMatch(fs.readFileSync(state.commandLog, 'utf8'), /plugin add opl-flow@opl-flow-local --json/);
  } finally {
    removeFixtureTree(state.root);
  }
});

test('public packages update restores legacy directories and lock bytes after native add failure', () => {
  const state = publicLifecycleFixture('update-rollback');
  const before = fs.readFileSync(state.lockPath);
  try {
    const next = writeFlowMarketplace({
      root: path.join(state.root, 'flow-next'),
      version: '0.1.30',
      requiredSkillIds: flowSkillIds,
    });
    const previous = writeFlowMarketplace({
      root: path.join(state.root, 'flow-previous'),
      version: '0.1.29',
      requiredSkillIds: ['opl-flow', 'coordinate-concurrent-tasks'],
      configuredMarketplaceRoot: next.marketplaceRoot,
    });
    const ownerChannel = writeFlowOwnerChannelFixture(
      path.join(state.root, 'owner-channel'),
      next.manifestPath,
    );
    seedInstalledFlow({ state, oldMarketplaceRoot: previous.marketplaceRoot });

    const failure = runCliFailure(['packages', 'update', 'opl-flow'], {
      ...ownerChannel.env,
      ...state.env,
      FIXTURE_REQUIRE_LEGACY_ABSENT: '1',
      FIXTURE_FAIL_PLUGIN_ADD: '1',
    });
    assert.equal(
      failure.payload.error.details.failure_code,
      'configured_codex_plugin_carrier_action_failed',
    );
    assert.deepEqual(fs.readFileSync(state.lockPath), before);
    for (const skillId of skillIds) assert.equal(fs.existsSync(path.join(state.skillsRoot, skillId)), true);
  } finally {
    removeFixtureTree(state.root);
  }
});

test('public packages install from a developer checkout retires legacy Skills before exposing seven Flow Skills', () => {
  const state = publicLifecycleFixture('install-developer-checkout');
  try {
    const checkout = writeDeveloperFlowCheckout(path.join(state.root, 'workspace'));
    const installed = runCli(['packages', 'install', 'opl-flow'], {
      ...state.env,
      OPL_MODULE_PATH_OPLFLOW: checkout,
      OPL_MODULE_SOURCE_MODE: 'git_checkout',
    }) as any;
    const surface = installed.opl_agent_package_install;
    assert.equal(surface.status, 'installed');
    assert.equal(surface.package_lock.source_kind, 'developer_checkout_override');
    assert.equal(Object.hasOwn(surface, 'legacy_skill_migration'), false);
    assert.deepEqual(
      surface.physical_surface.materialized_required_skill_ids,
      flowSkillIds,
    );
    assert.equal(surface.physical_surface.workflow_policy_migration.status, 'current');
    const installedPolicy = JSON.parse(fs.readFileSync(
      path.join(surface.physical_surface.codex_plugin_cache_path, 'contracts', 'workflow-policy.json'),
      'utf8',
    ));
    assert.equal(installedPolicy.schema, 'opl_flow_workflow_policy.v3');
    assert.deepEqual(installedPolicy.package, {
      id: 'opl-flow',
      version: '0.1.30',
      owner: 'opl-flow',
      kind: 'workflow_profile',
    });
    for (const skillId of flowSkillIds) {
      assert.equal(
        fs.existsSync(path.join(surface.physical_surface.codex_plugin_cache_path, 'skills', skillId, 'SKILL.md')),
        true,
      );
    }
    for (const skillId of skillIds) {
      assert.equal(fs.existsSync(path.join(state.skillsRoot, skillId)), false);
    }
    const lock = JSON.parse(fs.readFileSync(state.lockPath, 'utf8'));
    assert.deepEqual(Object.keys(lock.skills), ['unrelated-skill']);
    const pluginList = JSON.parse(execFileSync(state.codex.codexPath, ['plugin', 'list', '--json'], {
      env: { ...process.env, ...state.env },
      encoding: 'utf8',
    }));
    assert.equal(pluginList.installed.length, 1);
    assert.equal(
      pluginList.installed[0].pluginId,
      `${surface.physical_surface.plugin_id}@${surface.physical_surface.marketplace_id}`,
    );
    assert.equal(pluginList.installed[0].source.path, surface.physical_surface.marketplace_plugin_path);
  } finally {
    removeFixtureTree(state.root);
  }
});

test('public packages install accepts a v4 Flow developer checkout', () => {
  const state = publicLifecycleFixture('install-developer-checkout-v4');
  try {
    const checkout = writeDeveloperFlowCheckout(
      path.join(state.root, 'workspace'),
      'opl_flow_workflow_policy.v4',
    );
    const installed = runCli(['packages', 'install', 'opl-flow'], {
      ...state.env,
      OPL_MODULE_PATH_OPLFLOW: checkout,
      OPL_MODULE_SOURCE_MODE: 'git_checkout',
    }) as any;
    const surface = installed.opl_agent_package_install;
    assert.equal(surface.status, 'installed');
    assert.equal(surface.package_lock.source_kind, 'developer_checkout_override');
    assert.equal(Object.hasOwn(surface, 'legacy_skill_migration'), false);
    assert.deepEqual(surface.physical_surface.materialized_required_skill_ids, flowSkillIds);
    assert.equal(surface.physical_surface.workflow_policy_migration.status, 'current');
    const installedPolicy = JSON.parse(fs.readFileSync(
      path.join(surface.physical_surface.codex_plugin_cache_path, 'contracts', 'workflow-policy.json'),
      'utf8',
    ));
    assert.equal(installedPolicy.schema, 'opl_flow_workflow_policy.v4');
    assert.deepEqual(
      surface.package_lock.developer_checkout_source.copy_paths,
      [...flowPayloadPaths].sort(),
    );
    for (const requiredPath of [
      'scripts/opl_workflow.py',
      'scripts/opl_fleet.py',
      'contracts/fleet-telemetry-protocol.json',
      'contracts/fleet-telemetry-protocol.schema.json',
    ]) {
      assert.equal(
        fs.existsSync(path.join(surface.physical_surface.codex_plugin_cache_path, requiredPath)),
        true,
        requiredPath,
      );
    }
    assert.equal(
      fs.existsSync(path.join(surface.physical_surface.codex_plugin_cache_path, 'not-in-flow-payload.txt')),
      false,
    );
  } finally {
    removeFixtureTree(state.root);
  }
});

test('Flow developer checkout fails closed when its shared payload allowlist is incomplete', () => {
  const state = publicLifecycleFixture('install-developer-checkout-missing-allowlisted-file');
  try {
    const checkout = writeDeveloperFlowCheckout(
      path.join(state.root, 'workspace'),
      'opl_flow_workflow_policy.v4',
    );
    fs.rmSync(path.join(checkout, 'contracts', 'fleet-telemetry-protocol.json'));
    const failure = runCliFailure(['packages', 'install', 'opl-flow'], {
      ...state.env,
      OPL_MODULE_PATH_OPLFLOW: checkout,
      OPL_MODULE_SOURCE_MODE: 'git_checkout',
    });
    assert.equal(
      failure.payload.error.details.failure_code,
      'agent_package_developer_checkout_source_invalid',
    );
    assert.match(failure.payload.error.message, /missing an allowlisted payload file/);
  } finally {
    removeFixtureTree(state.root);
  }
});

test('managed Flow update keeps the managed owner when an installed descriptor is also present', () => {
  const state = publicLifecycleFixture('managed-update');
  try {
    const previousCheckout = writeDeveloperFlowCheckout(path.join(state.root, 'workspace-previous'));
    const legacyAgentsRoot = path.join(state.root, 'legacy-agents');
    fs.renameSync(state.agentsRoot, legacyAgentsRoot);
    const previous = runCli(['packages', 'install', 'opl-flow'], {
      ...state.env,
      OPL_MODULE_PATH_OPLFLOW: previousCheckout,
      OPL_MODULE_SOURCE_MODE: 'git_checkout',
    }) as any;
    fs.renameSync(legacyAgentsRoot, state.agentsRoot);
    assert.equal(previous.opl_agent_package_install.package_lock.package_version, '0.1.30');
    for (const skillId of skillIds) {
      assert.equal(fs.existsSync(path.join(state.skillsRoot, skillId)), true);
    }
    projectStaleInstalledFlowDescriptor(previous.opl_agent_package_install.physical_surface);

    const nextCheckout = writeDeveloperFlowCheckout(path.join(state.root, 'workspace-next'));
    const update = runCli(['packages', 'update', 'opl-flow'], {
      ...state.env,
      OPL_MODULE_PATH_OPLFLOW: nextCheckout,
      OPL_MODULE_SOURCE_MODE: 'git_checkout',
    }) as any;
    const surface = update.opl_agent_package_update;
    assert.equal(surface.status, 'updated');
    assert.equal(surface.reconciliation_action, 'source_reconcile');
    assert.equal(surface.package_lock.package_version, '0.1.30');
    assert.equal(surface.package_lock.source_kind, 'developer_checkout_override');
    assert.equal(Object.hasOwn(surface, 'legacy_skill_migration'), false);
    assert.equal(Object.hasOwn(surface, 'configured_carrier'), false);
    assert.deepEqual(surface.physical_surface.materialized_required_skill_ids, flowSkillIds);
    for (const skillId of skillIds) {
      assert.equal(fs.existsSync(path.join(state.skillsRoot, skillId)), false);
    }
    const pluginList = JSON.parse(execFileSync(state.codex.codexPath, ['plugin', 'list', '--json'], {
      env: { ...process.env, ...state.env },
      encoding: 'utf8',
    }));
    assert.equal(pluginList.installed.length, 1);
    assert.equal(pluginList.installed[0].version, '0.1.30');
  } finally {
    removeFixtureTree(state.root);
  }
});

test('native Flow repair retires a disjoint same-home managed lock before ordinary updates', () => {
  const state = publicLifecycleFixture('native-repair-owner-transfer');
  try {
    const previousCheckout = writeDeveloperFlowCheckout(path.join(state.root, 'workspace-previous'));
    const legacyAgentsRoot = path.join(state.root, 'legacy-agents');
    fs.renameSync(state.agentsRoot, legacyAgentsRoot);
    const previous = runCli(['packages', 'install', 'opl-flow'], {
      ...state.env,
      OPL_MODULE_PATH_OPLFLOW: previousCheckout,
      OPL_MODULE_SOURCE_MODE: 'git_checkout',
    }) as any;
    fs.renameSync(legacyAgentsRoot, state.agentsRoot);
    const previousSurface = previous.opl_agent_package_install.physical_surface;
    const packageLockPath = path.join(state.env.OPL_STATE_DIR, 'agent-package-locks.json');
    assert.equal(fs.existsSync(packageLockPath), true);

    fs.writeFileSync(path.join(state.env.CODEX_HOME, 'config.toml'), '', 'utf8');
    const nativeMarketplace = writeFlowMarketplace({
      root: path.join(state.root, 'native-owner'),
      version: '0.1.30',
      requiredSkillIds: flowSkillIds,
    });
    seedInstalledFlow({
      state,
      oldMarketplaceRoot: nativeMarketplace.marketplaceRoot,
    });

    const repaired = runCli(['packages', 'repair', '--package-id', 'opl-flow'], state.env) as any;
    const surface = repaired.opl_agent_package_repair;
    assert.equal(surface.status, 'repaired');
    assert.equal(surface.configured_carrier.status, 'installed');
    assert.equal(surface.configured_carrier.executor.status, 'callable');
    assert.equal(surface.configured_carrier.plugin_source_path, nativeMarketplace.pluginSource);
    assert.equal(Object.hasOwn(surface, 'package_lock'), false);
    assert.equal(Object.hasOwn(surface, 'lifecycle_receipt'), false);
    assert.equal(fs.existsSync(packageLockPath), false);
    assert.equal(fs.existsSync(previousSurface.marketplace_root), false);
    assert.equal(fs.existsSync(nativeMarketplace.pluginSource), true);

    const nativePlugin = JSON.parse(execFileSync(state.codex.codexPath, ['plugin', 'list', '--json'], {
      env: { ...process.env, ...state.env },
      encoding: 'utf8',
    }));
    assert.equal(nativePlugin.installed.length, 1);
    assert.equal(nativePlugin.installed[0].pluginId, flowPluginSelector);
    assert.equal(nativePlugin.installed[0].source.path, nativeMarketplace.pluginSource);
  } finally {
    removeFixtureTree(state.root);
  }
});

test('native Flow update retires only a disjoint managed owner before ordinary currentness', () => {
  const state = publicLifecycleFixture('native-update-owner-transfer');
  try {
    const previousCheckout = writeDeveloperFlowCheckout(path.join(state.root, 'workspace-previous'));
    const legacyAgentsRoot = path.join(state.root, 'legacy-agents');
    fs.renameSync(state.agentsRoot, legacyAgentsRoot);
    const previous = runCli(['packages', 'install', 'opl-flow'], {
      ...state.env,
      OPL_MODULE_PATH_OPLFLOW: previousCheckout,
      OPL_MODULE_SOURCE_MODE: 'git_checkout',
    }) as any;
    fs.renameSync(legacyAgentsRoot, state.agentsRoot);
    const previousSurface = previous.opl_agent_package_install.physical_surface;
    const packageLockPath = path.join(state.env.OPL_STATE_DIR, 'agent-package-locks.json');

    fs.writeFileSync(path.join(state.env.CODEX_HOME, 'config.toml'), '', 'utf8');
    const nativeMarketplace = writeFlowMarketplace({
      root: path.join(state.root, 'native-owner'),
      version: '0.1.30',
      requiredSkillIds: flowSkillIds,
    });
    seedInstalledFlow({
      state,
      oldMarketplaceRoot: nativeMarketplace.marketplaceRoot,
    });

    const updated = runCli(['packages', 'update', 'opl-flow'], state.env) as any;
    const surface = updated.opl_agent_package_update;
    assert.equal(surface.status, 'updated');
    assert.equal(surface.configured_carrier.status, 'installed');
    assert.equal(surface.configured_carrier.executor.status, 'callable');
    assert.equal(surface.configured_carrier.plugin_source_path, nativeMarketplace.pluginSource);
    assert.equal(Object.hasOwn(surface, 'package_lock'), false);
    assert.equal(Object.hasOwn(surface, 'lifecycle_receipt'), false);
    assert.equal(fs.existsSync(packageLockPath), false);
    assert.equal(fs.existsSync(previousSurface.marketplace_root), false);
    assert.equal(fs.existsSync(nativeMarketplace.pluginSource), true);
  } finally {
    removeFixtureTree(state.root);
  }
});

test('Flow uninstall removes a disjoint native carrier and its managed legacy owner in one transaction', () => {
  const state = publicLifecycleFixture('native-uninstall-owner-transfer');
  try {
    const previousCheckout = writeDeveloperFlowCheckout(path.join(state.root, 'workspace-previous'));
    const legacyAgentsRoot = path.join(state.root, 'legacy-agents');
    fs.renameSync(state.agentsRoot, legacyAgentsRoot);
    const previous = runCli(['packages', 'install', 'opl-flow'], {
      ...state.env,
      OPL_MODULE_PATH_OPLFLOW: previousCheckout,
      OPL_MODULE_SOURCE_MODE: 'git_checkout',
    }) as any;
    fs.renameSync(legacyAgentsRoot, state.agentsRoot);
    const previousSurface = previous.opl_agent_package_install.physical_surface;
    const packageLockPath = path.join(state.env.OPL_STATE_DIR, 'agent-package-locks.json');

    fs.writeFileSync(path.join(state.env.CODEX_HOME, 'config.toml'), '', 'utf8');
    const nativeMarketplace = writeFlowMarketplace({
      root: path.join(state.root, 'native-owner'),
      version: '0.1.30',
      requiredSkillIds: flowSkillIds,
    });
    seedInstalledFlow({
      state,
      oldMarketplaceRoot: nativeMarketplace.marketplaceRoot,
    });

    const dryRun = runCli(['packages', 'uninstall', 'opl-flow', '--dry-run'], state.env) as any;
    assert.equal(dryRun.opl_agent_package_uninstall.status, 'validated_no_write');
    assert.equal(dryRun.opl_agent_package_uninstall.configured_carrier.native_action_dispatched, false);
    assert.equal(fs.existsSync(packageLockPath), true);
    assert.equal(fs.existsSync(previousSurface.marketplace_root), true);
    assert.doesNotMatch(fs.readFileSync(state.commandLog, 'utf8'), /plugin remove /);

    const uninstalled = runCli(['packages', 'uninstall', 'opl-flow'], state.env) as any;
    const surface = uninstalled.opl_agent_package_uninstall;
    assert.equal(surface.status, 'uninstalled');
    assert.ok(['not_installed', 'physical_unavailable'].includes(surface.configured_carrier.status));
    assert.equal(surface.configured_carrier.carrier.precedence, 'not_present');
    const packageLocks = JSON.parse(fs.readFileSync(packageLockPath, 'utf8'));
    assert.equal(packageLocks.packages.some((entry: any) => entry.package_id === 'opl-flow'), false);
    assert.equal(fs.existsSync(previousSurface.marketplace_root), false);
    assert.equal(fs.existsSync(nativeMarketplace.pluginSource), true);

    const nativePlugin = JSON.parse(execFileSync(state.codex.codexPath, ['plugin', 'list', '--json'], {
      env: { ...process.env, ...state.env },
      encoding: 'utf8',
    }));
    assert.equal(nativePlugin.installed.length, 0);
    const commandLog = fs.readFileSync(state.commandLog, 'utf8');
    assert.equal((commandLog.match(/plugin remove opl-flow@opl-flow-local --json/g) ?? []).length, 1);

    const status = runCli(['packages', 'status', '--package-id', 'opl-flow'], state.env) as any;
    assert.equal(status.opl_agent_package_status.status, 'not_installed');
  } finally {
    removeFixtureTree(state.root);
  }
});

test('same-selector native Flow uninstall stays on the managed cleanup path', () => {
  const state = publicLifecycleFixture('native-uninstall-same-selector-retained');
  try {
    const previousCheckout = writeDeveloperFlowCheckout(path.join(state.root, 'workspace-previous'));
    const legacyAgentsRoot = path.join(state.root, 'legacy-agents');
    fs.renameSync(state.agentsRoot, legacyAgentsRoot);
    runCli(['packages', 'install', 'opl-flow'], {
      ...state.env,
      OPL_MODULE_PATH_OPLFLOW: previousCheckout,
      OPL_MODULE_SOURCE_MODE: 'git_checkout',
    });
    fs.renameSync(legacyAgentsRoot, state.agentsRoot);
    const packageLockPath = path.join(state.env.OPL_STATE_DIR, 'agent-package-locks.json');
    const lockIndex = JSON.parse(fs.readFileSync(packageLockPath, 'utf8'));
    const managedLock = lockIndex.packages.find((entry: any) => entry.package_id === 'opl-flow');
    managedLock.physical_surface.marketplace_id = 'opl-flow-local';
    fs.writeFileSync(packageLockPath, formatJsonPayload(lockIndex));

    fs.writeFileSync(path.join(state.env.CODEX_HOME, 'config.toml'), '', 'utf8');
    const nativeMarketplace = writeFlowMarketplace({
      root: path.join(state.root, 'native-owner'),
      version: '0.1.30',
      requiredSkillIds: flowSkillIds,
    });
    seedInstalledFlow({
      state,
      oldMarketplaceRoot: nativeMarketplace.marketplaceRoot,
    });

    const dryRun = runCli(['packages', 'uninstall', 'opl-flow', '--dry-run'], state.env) as any;
    assert.equal(dryRun.opl_agent_package_uninstall.status, 'validated_no_write');
    assert.equal(Object.hasOwn(dryRun.opl_agent_package_uninstall, 'configured_carrier'), false);
    assert.doesNotMatch(fs.readFileSync(state.commandLog, 'utf8'), /plugin remove /);
    assert.equal(fs.existsSync(packageLockPath), true);
  } finally {
    removeFixtureTree(state.root);
  }
});

test('Flow uninstall restores the native carrier when legacy cleanup fails', () => {
  const state = publicLifecycleFixture('native-uninstall-compensation');
  try {
    const previousCheckout = writeDeveloperFlowCheckout(path.join(state.root, 'workspace-previous'));
    const legacyAgentsRoot = path.join(state.root, 'legacy-agents');
    fs.renameSync(state.agentsRoot, legacyAgentsRoot);
    runCli(['packages', 'install', 'opl-flow'], {
      ...state.env,
      OPL_MODULE_PATH_OPLFLOW: previousCheckout,
      OPL_MODULE_SOURCE_MODE: 'git_checkout',
    });
    fs.renameSync(legacyAgentsRoot, state.agentsRoot);

    fs.writeFileSync(path.join(state.env.CODEX_HOME, 'config.toml'), '', 'utf8');
    const nativeMarketplace = writeFlowMarketplace({
      root: path.join(state.root, 'native-owner'),
      version: '0.1.30',
      requiredSkillIds: flowSkillIds,
    });
    seedInstalledFlow({
      state,
      oldMarketplaceRoot: nativeMarketplace.marketplaceRoot,
    });

    const failure = runCliFailure(['packages', 'uninstall', 'opl-flow'], {
      ...state.env,
      OPL_TEST_RUNTIME_SOURCE_FAULTS_ENABLED: '1',
      OPL_TEST_RUNTIME_SOURCE_INTERRUPT_AFTER_STAGE_UNINSTALL: '1',
    });
    assert.equal(
      failure.payload.error.details.failure_code,
      'test_runtime_source_interrupted_after_stage_uninstall',
    );
    const nativePlugin = JSON.parse(execFileSync(state.codex.codexPath, ['plugin', 'list', '--json'], {
      env: { ...process.env, ...state.env },
      encoding: 'utf8',
    }));
    assert.equal(nativePlugin.installed.length, 1);
    assert.equal(nativePlugin.installed[0].pluginId, flowPluginSelector);
    assert.equal(nativePlugin.installed[0].source.path, nativeMarketplace.pluginSource);
    const commandLog = fs.readFileSync(state.commandLog, 'utf8');
    assert.equal((commandLog.match(/plugin remove opl-flow@opl-flow-local --json/g) ?? []).length, 1);
    assert.equal((commandLog.match(/plugin add opl-flow@opl-flow-local --json/g) ?? []).length, 1);
  } finally {
    removeFixtureTree(state.root);
  }
});

test('same-selector native Flow source cannot retire a disjoint managed owner', () => {
  const state = publicLifecycleFixture('native-update-same-selector-retained');
  try {
    const previousCheckout = writeDeveloperFlowCheckout(path.join(state.root, 'workspace-previous'));
    const legacyAgentsRoot = path.join(state.root, 'legacy-agents');
    fs.renameSync(state.agentsRoot, legacyAgentsRoot);
    runCli(['packages', 'install', 'opl-flow'], {
      ...state.env,
      OPL_MODULE_PATH_OPLFLOW: previousCheckout,
      OPL_MODULE_SOURCE_MODE: 'git_checkout',
    });
    fs.renameSync(legacyAgentsRoot, state.agentsRoot);
    const packageLockPath = path.join(state.env.OPL_STATE_DIR, 'agent-package-locks.json');
    const lockIndex = JSON.parse(fs.readFileSync(packageLockPath, 'utf8'));
    const managedLock = lockIndex.packages.find((entry: any) => entry.package_id === 'opl-flow');
    managedLock.physical_surface.marketplace_id = 'opl-flow-local';
    fs.writeFileSync(packageLockPath, formatJsonPayload(lockIndex));
    const packageLockBefore = fs.readFileSync(packageLockPath);

    fs.writeFileSync(path.join(state.env.CODEX_HOME, 'config.toml'), '', 'utf8');
    const nativeMarketplace = writeFlowMarketplace({
      root: path.join(state.root, 'native-owner'),
      version: '0.1.30',
      requiredSkillIds: flowSkillIds,
    });
    seedInstalledFlow({
      state,
      oldMarketplaceRoot: nativeMarketplace.marketplaceRoot,
    });

    const failure = runCliFailure(['packages', 'update', 'opl-flow'], state.env);
    assert.equal(failure.status, 3);
    assert.equal(failure.payload.error.code, 'contract_shape_invalid');
    const commandLog = fs.readFileSync(state.commandLog, 'utf8');
    assert.equal((commandLog.match(/plugin add /g) ?? []).length, 0);
    assert.deepEqual(fs.readFileSync(packageLockPath), packageLockBefore);
    assert.equal(fs.existsSync(packageLockPath), true);
    assert.equal(fs.existsSync(nativeMarketplace.pluginSource), true);
  } finally {
    removeFixtureTree(state.root);
  }
});

test('foreign managed Flow lock does not override the current Codex home native owner', () => {
  const state = publicLifecycleFixture('foreign-managed-update');
  try {
    const foreignCodexHome = path.join(state.root, 'foreign-codex-home');
    const previousCheckout = writeDeveloperFlowCheckout(path.join(state.root, 'workspace-foreign'));
    const legacyAgentsRoot = path.join(state.root, 'legacy-agents');
    fs.renameSync(state.agentsRoot, legacyAgentsRoot);
    const foreign = runCli(['packages', 'install', 'opl-flow'], {
      ...state.env,
      CODEX_HOME: foreignCodexHome,
      OPL_MODULE_PATH_OPLFLOW: previousCheckout,
      OPL_MODULE_SOURCE_MODE: 'git_checkout',
    }) as any;
    fs.renameSync(legacyAgentsRoot, state.agentsRoot);
    assert.equal(foreign.opl_agent_package_install.physical_surface.codex_home, foreignCodexHome);

    const marketplaceRoot = path.join(state.root, 'current-marketplace-source');
    const previous = writeFlowMarketplace({
      root: marketplaceRoot,
      version: '0.1.29',
      requiredSkillIds: ['opl-flow', 'coordinate-concurrent-tasks'],
    });
    seedInstalledFlow({
      state,
      oldMarketplaceRoot: previous.marketplaceRoot,
    });
    writeFlowMarketplace({
      root: marketplaceRoot,
      version: '0.1.30',
      requiredSkillIds: flowSkillIds,
    });

    const packageLockPath = path.join(state.env.OPL_STATE_DIR, 'agent-package-locks.json');
    const packageLockBefore = fs.readFileSync(packageLockPath);
    const update = runCli(['packages', 'update', 'opl-flow'], state.env) as any;
    const surface = update.opl_agent_package_update;
    assert.equal(surface.status, 'updated');
    assert.equal(surface.configured_carrier.installed_version, '0.1.30');
    assert.equal(surface.configured_carrier.plugin_source_path, previous.pluginSource);
    assert.equal(Object.hasOwn(surface, 'legacy_skill_migration'), false);
    assert.deepEqual(fs.readFileSync(packageLockPath), packageLockBefore);
    for (const skillId of skillIds) {
      assert.equal(fs.existsSync(path.join(state.skillsRoot, skillId)), false);
    }
    const currentPlugin = JSON.parse(execFileSync(state.codex.codexPath, ['plugin', 'list', '--json'], {
      env: { ...process.env, ...state.env },
      encoding: 'utf8',
    }));
    assert.equal(currentPlugin.installed.length, 1);
    assert.equal(currentPlugin.installed[0].version, '0.1.30');
    assert.deepEqual(
      flowSkillIds.filter((skillId) =>
        fs.existsSync(path.join(currentPlugin.installed[0].source.path, 'skills', skillId, 'SKILL.md'))),
      flowSkillIds,
    );
  } finally {
    removeFixtureTree(state.root);
  }
});

test('managed Flow update restores the managed owner and legacy projections when native readback fails', () => {
  const state = publicLifecycleFixture('managed-update-readback-rollback');
  try {
    const previousCheckout = writeDeveloperFlowCheckout(path.join(state.root, 'workspace-previous'));
    const legacyAgentsRoot = path.join(state.root, 'legacy-agents');
    fs.renameSync(state.agentsRoot, legacyAgentsRoot);
    const previous = runCli(['packages', 'install', 'opl-flow'], {
      ...state.env,
      OPL_MODULE_PATH_OPLFLOW: previousCheckout,
      OPL_MODULE_SOURCE_MODE: 'git_checkout',
    }) as any;
    fs.renameSync(legacyAgentsRoot, state.agentsRoot);
    const previousSurface = previous.opl_agent_package_install.physical_surface;
    const packageLockPath = path.join(state.env.OPL_STATE_DIR, 'agent-package-locks.json');
    projectStaleInstalledFlowDescriptor(previousSurface);
    const packageLockBefore = fs.readFileSync(packageLockPath);
    const skillLockBefore = fs.readFileSync(state.lockPath);
    const pluginBefore = JSON.parse(execFileSync(state.codex.codexPath, ['plugin', 'list', '--json'], {
      env: { ...process.env, ...state.env },
      encoding: 'utf8',
    }));
    assert.equal(pluginBefore.installed.length, 1);
    assert.equal(pluginBefore.installed[0].version, '0.1.29');
    assert.equal(pluginBefore.installed[0].source.path, previousSurface.marketplace_plugin_path);

    const nextCheckout = writeDeveloperFlowCheckout(path.join(state.root, 'workspace-next'));
    const failure = runCliFailure(['packages', 'update', 'opl-flow'], {
      ...state.env,
      OPL_MODULE_PATH_OPLFLOW: nextCheckout,
      OPL_MODULE_SOURCE_MODE: 'git_checkout',
      FIXTURE_FAIL_PLUGIN_LIST: '1',
    });
    assert.equal(
      failure.payload.error.details.failure_code,
      'opl_flow_legacy_skill_native_readback_failed',
    );
    assert.deepEqual(fs.readFileSync(packageLockPath), packageLockBefore);
    assert.deepEqual(fs.readFileSync(state.lockPath), skillLockBefore);
    for (const skillId of skillIds) {
      assert.equal(fs.existsSync(path.join(state.skillsRoot, skillId)), true);
    }
    assert.equal(fs.existsSync(previousSurface.codex_plugin_cache_path), true);
    assert.equal(fs.existsSync(previousSurface.marketplace_plugin_path), true);

    const pluginAfter = JSON.parse(execFileSync(state.codex.codexPath, ['plugin', 'list', '--json'], {
      env: { ...process.env, ...state.env },
      encoding: 'utf8',
    }));
    assert.equal(pluginAfter.installed.length, 1);
    assert.equal(pluginAfter.installed[0].version, '0.1.30');
    assert.equal(pluginAfter.installed[0].source.path, previousSurface.marketplace_plugin_path);
    assert.deepEqual(
      flowSkillIds.filter((skillId) =>
        fs.existsSync(path.join(pluginAfter.installed[0].source.path, 'skills', skillId, 'SKILL.md'))),
      flowSkillIds,
    );
  } finally {
    removeFixtureTree(state.root);
  }
});

test('managed Flow update uses validated local carrier readback when the previous cache and Codex CLI are unavailable', () => {
  const state = publicLifecycleFixture('managed-update-local-readback');
  try {
    const previousCheckout = writeDeveloperFlowCheckout(path.join(state.root, 'workspace-previous'));
    const legacyAgentsRoot = path.join(state.root, 'legacy-agents');
    fs.renameSync(state.agentsRoot, legacyAgentsRoot);
    const previous = runCli(['packages', 'install', 'opl-flow'], {
      ...state.env,
      OPL_MODULE_PATH_OPLFLOW: previousCheckout,
      OPL_MODULE_SOURCE_MODE: 'git_checkout',
    }) as any;
    fs.renameSync(legacyAgentsRoot, state.agentsRoot);
    const previousSurface = previous.opl_agent_package_install.physical_surface;
    makeTreeWritable(previousSurface.codex_plugin_cache_path);
    fs.rmSync(previousSurface.codex_plugin_cache_path, { recursive: true, force: true });

    const nextCheckout = writeDeveloperFlowCheckout(path.join(state.root, 'workspace-next'));
    fs.appendFileSync(
      path.join(nextCheckout, 'scripts', 'opl_workflow.py'),
      '# local carrier readback fixture revision\n',
      'utf8',
    );
    const update = runCli(['packages', 'update', 'opl-flow'], {
      ...state.env,
      OPL_CODEX_PLUGIN_BIN: path.join(state.root, 'missing-codex-cli'),
      OPL_MODULE_PATH_OPLFLOW: nextCheckout,
      OPL_MODULE_SOURCE_MODE: 'git_checkout',
    }) as any;
    const surface = update.opl_agent_package_update;
    assert.equal(surface.status, 'updated');
    assert.equal(surface.package_lock.package_version, '0.1.30');
    assert.equal(surface.package_lock.source_kind, 'developer_checkout_override');
    assert.equal(fs.existsSync(previousSurface.codex_plugin_cache_path), false);
    assert.equal(fs.existsSync(surface.physical_surface.codex_plugin_cache_path), true);
    assert.deepEqual(surface.physical_surface.materialized_required_skill_ids, flowSkillIds);
    for (const skillId of flowSkillIds) {
      assert.equal(
        fs.existsSync(path.join(surface.physical_surface.codex_plugin_cache_path, 'skills', skillId, 'SKILL.md')),
        true,
      );
    }
    for (const skillId of skillIds) {
      assert.equal(fs.existsSync(path.join(state.skillsRoot, skillId)), false);
    }
  } finally {
    removeFixtureTree(state.root);
  }
});

test('managed Flow update preserves a missing previous cache and reports the primary native readback failure', () => { // reuse-first: allow owner-routed package transaction rollback regression.
  const state = publicLifecycleFixture('managed-update-missing-previous-cache-restore');
  try {
    const previousCheckout = writeDeveloperFlowCheckout(path.join(state.root, 'workspace-previous'));
    const legacyAgentsRoot = path.join(state.root, 'legacy-agents');
    fs.renameSync(state.agentsRoot, legacyAgentsRoot);
    const previous = runCli(['packages', 'install', 'opl-flow'], {
      ...state.env,
      OPL_MODULE_PATH_OPLFLOW: previousCheckout,
      OPL_MODULE_SOURCE_MODE: 'git_checkout',
    }) as any;
    fs.renameSync(legacyAgentsRoot, state.agentsRoot);
    const previousSurface = previous.opl_agent_package_install.physical_surface;
    const packageLockPath = path.join(state.env.OPL_STATE_DIR, 'agent-package-locks.json');
    const packageLockBefore = fs.readFileSync(packageLockPath);
    const skillLockBefore = fs.readFileSync(state.lockPath);
    makeTreeWritable(previousSurface.codex_plugin_cache_path);
    fs.rmSync(previousSurface.codex_plugin_cache_path, { recursive: true, force: true });
    assert.equal(fs.existsSync(previousSurface.codex_plugin_cache_path), false);

    const nextCheckout = writeDeveloperFlowCheckout(path.join(state.root, 'workspace-next'));
    const failure = runCliFailure(['packages', 'update', 'opl-flow'], {
      ...state.env,
      OPL_MODULE_PATH_OPLFLOW: nextCheckout,
      OPL_MODULE_SOURCE_MODE: 'git_checkout',
      FIXTURE_FAIL_PLUGIN_LIST: '1',
    });
    assert.equal(
      failure.payload.error.details.failure_code,
      'opl_flow_legacy_skill_native_readback_failed',
    );
    assert.deepEqual(fs.readFileSync(packageLockPath), packageLockBefore);
    assert.deepEqual(fs.readFileSync(state.lockPath), skillLockBefore);
    assert.equal(fs.existsSync(previousSurface.codex_plugin_cache_path), false);
    for (const skillId of skillIds) {
      assert.equal(fs.existsSync(path.join(state.skillsRoot, skillId)), true);
    }
  } finally {
    removeFixtureTree(state.root);
  }
});
