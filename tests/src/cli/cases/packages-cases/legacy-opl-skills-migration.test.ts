import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';

import {
  assert,
  fs,
  formatJsonPayload,
  os,
  path,
  parseJsonText,
  removeFixtureTree,
  repoRoot,
  runCli,
  runCliFailure,
  test,
} from './helpers.ts';
import { createFakeCodexPluginManagerFixture } from '../../helpers.ts';
import {
  commitDeveloperCheckout,
  scholarSkillsCoreSkillIds,
  writeCapabilityProvider,
  writeDeveloperCapabilityCheckoutClosure,
  writeMasConsumer,
} from './capability-fixtures.ts';

const skillIds = ['develop-and-deliver', 'task-mode-gate', 'recover-codex-tasks'];
const flowSkillIds = [
  'coordinate-concurrent-tasks',
  'codex-app-owner-migration',
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
if (command.startsWith('plugin remove ') && process.env.FIXTURE_NOOP_PLUGIN_REMOVE === '1') {
  process.stdout.write(JSON.stringify({ status: 'ok' }));
  process.exit(0);
}
const result = spawnSync(${JSON.stringify(input.delegate)}, args, {
  env: process.env,
  encoding: 'utf8',
});
if (command === 'plugin add ${flowPluginSelector} --json'
  && process.env.FIXTURE_MUTATE_CHECKOUT_AFTER_ADD) {
  fs.appendFileSync(process.env.FIXTURE_MUTATE_CHECKOUT_AFTER_ADD, '\\npost-dispatch drift\\n');
}
let stdout = result.stdout || '';
if (command === 'plugin list --json' && process.env.FIXTURE_FORCE_PLUGIN_ENABLED) {
  const payload = JSON.parse(stdout);
  for (const entry of payload.installed || []) {
    entry.enabled = process.env.FIXTURE_FORCE_PLUGIN_ENABLED === 'true';
  }
  stdout = JSON.stringify(payload);
}
process.stdout.write(stdout);
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
  const ownerDescriptor = flowManifest({
    version: '0.1.30',
    requiredSkillIds: flowSkillIds,
    marketplaceRoot: 'gaofeng21cn/opl-flow',
  });
  ownerDescriptor.codex_surface.configured_codex_plugin_carrier.publication_ref =
    'ghcr.io/gaofeng21cn/one-person-lab-packages/opl-flow:latest-stable';
  fs.writeFileSync(path.join(checkout, 'opl-package.json'), formatJsonPayload(ownerDescriptor));
  fs.mkdirSync(path.join(checkout, '.agents', 'plugins'), { recursive: true });
  fs.writeFileSync(
    path.join(checkout, '.agents', 'plugins', 'marketplace.json'),
    formatJsonPayload({
      name: 'opl-flow-local',
      plugins: [{
        name: 'opl-flow',
        source: { source: 'local', path: './' },
      }],
    }),
  );
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

function writeDeveloperMasCarrierClosure(root: string) {
  const sourceRoot = path.join(root, 'source');
  const providerRoot = path.join(sourceRoot, 'provider');
  const masRoot = path.join(sourceRoot, 'mas');
  const providerManifestPath = writeCapabilityProvider(providerRoot, '0.2.23');
  const providerManifest = JSON.parse(fs.readFileSync(providerManifestPath, 'utf8'));
  providerManifest.codex_surface.configured_codex_plugin_carrier = {
    kind: 'codex_plugin_manager',
    plugin_selector: 'mas-scholar-skills@mas-scholar-skills-local',
    executor_route: 'codex_cli',
    marketplace_source: providerRoot,
    publication_ref: 'ghcr.io/fixture/one-person-lab-packages/mas-scholar-skills:latest-stable',
  };
  fs.writeFileSync(providerManifestPath, formatJsonPayload(providerManifest));
  const masManifestPath = writeMasConsumer(masRoot, providerManifestPath, '0.2.24', {
    configuredCarrier: true,
  });
  const masCheckout = path.join(root, 'workspace', 'med-autoscience');
  const scholarCheckout = path.join(root, 'workspace', 'mas-scholar-skills');
  writeDeveloperCapabilityCheckoutClosure({
    masCheckout,
    scholarCheckout,
    masManifestPath,
    providerManifestPath,
  });
  const masSkillRoot = path.join(masCheckout, 'plugins', 'med-autoscience', 'skills', 'med-autoscience');
  fs.mkdirSync(masSkillRoot, { recursive: true });
  fs.writeFileSync(path.join(masSkillRoot, 'SKILL.md'), '# med-autoscience\n');
  const scholarPluginManifestPath = path.join(scholarCheckout, '.codex-plugin', 'plugin.json');
  const scholarPluginManifest = JSON.parse(fs.readFileSync(scholarPluginManifestPath, 'utf8'));
  fs.writeFileSync(
    scholarPluginManifestPath,
    formatJsonPayload({ ...scholarPluginManifest, skills: './skills/' }),
  );
  const masPluginManifestPath = path.join(
    masCheckout,
    'plugins',
    'med-autoscience',
    '.codex-plugin',
    'plugin.json',
  );
  const masPluginManifest = JSON.parse(fs.readFileSync(masPluginManifestPath, 'utf8'));
  fs.writeFileSync(
    masPluginManifestPath,
    formatJsonPayload({ ...masPluginManifest, skills: './skills/' }),
  );
  for (const skillId of scholarSkillsCoreSkillIds) {
    const skillRoot = path.join(scholarCheckout, 'skills', skillId);
    fs.mkdirSync(skillRoot, { recursive: true });
    fs.writeFileSync(path.join(skillRoot, 'SKILL.md'), `# ${skillId}\n`);
  }
  const masMarketplacePath = path.join(masCheckout, '.agents', 'plugins', 'marketplace.json');
  fs.mkdirSync(path.dirname(masMarketplacePath), { recursive: true });
  fs.writeFileSync(masMarketplacePath, formatJsonPayload({
    name: 'med-autoscience-local',
    plugins: [{
      name: 'med-autoscience',
      source: { source: 'local', path: './plugins/med-autoscience' },
    }],
  }));
  fs.writeFileSync(path.join(scholarCheckout, 'opl-package.json'), formatJsonPayload(providerManifest));
  const scholarMarketplacePath = path.join(scholarCheckout, '.agents', 'plugins', 'marketplace.json');
  fs.mkdirSync(path.dirname(scholarMarketplacePath), { recursive: true });
  fs.writeFileSync(scholarMarketplacePath, formatJsonPayload({
    name: 'mas-scholar-skills-local',
    plugins: [{
      name: 'mas-scholar-skills',
      source: { source: 'local', path: './' },
    }],
  }));
  commitDeveloperCheckout(masCheckout, 'add native developer carrier');
  commitDeveloperCheckout(scholarCheckout, 'add native developer carrier');
  return { masCheckout, scholarCheckout };
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
  for (const skillId of flowSkillIds) {
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

test('descriptor-only packages update leaves legacy Skills inert while exposing the configured eight-Skill Flow target', () => {
  const state = publicLifecycleFixture('update-success');
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

    const update = runCli(['packages', 'update', 'opl-flow'], {
      ...ownerChannel.env,
      ...state.env,
    }) as any;
    assert.equal(update.opl_agent_package_update.status, 'updated');
    assert.equal(Object.hasOwn(update.opl_agent_package_update, 'legacy_skill_migration'), false);
    assert.deepEqual(
      update.opl_agent_package_update.configured_carrier.executor.required_skill_ids,
      flowSkillIds,
    );
    assert.equal(update.opl_agent_package_update.configured_carrier.installed_version, '0.1.30');
    for (const skillId of skillIds) {
      assert.equal(fs.existsSync(path.join(state.skillsRoot, skillId)), true);
      assert.equal(fs.existsSync(path.join(next.pluginSource, 'skills', skillId, 'SKILL.md')), true);
    }
    assert.deepEqual(fs.readFileSync(state.lockPath), before);
    assert.match(fs.readFileSync(state.commandLog, 'utf8'), /plugin add opl-flow@opl-flow-local --json/);
  } finally {
    removeFixtureTree(state.root);
  }
});

test('public packages update ignores a conflicting legacy source and uses the native owner', () => {
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

    const update = runCli(['packages', 'update', 'opl-flow'], {
      ...ownerChannel.env,
      ...state.env,
    }) as any;
    assert.equal(update.opl_agent_package_update.status, 'updated');
    assert.deepEqual(fs.readFileSync(state.lockPath), before);
    for (const skillId of skillIds) assert.equal(fs.existsSync(path.join(state.skillsRoot, skillId)), true);
    assert.match(fs.readFileSync(state.commandLog, 'utf8'), /plugin add opl-flow@opl-flow-local --json/);
  } finally {
    removeFixtureTree(state.root);
  }
});

test('public packages update leaves legacy directories and lock bytes inert after native add failure', () => {
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

test('public packages install from a developer checkout leaves legacy Skills inert while exposing eight Flow Skills', () => {
  const state = publicLifecycleFixture('install-developer-checkout');
  try {
    const skillLockBefore = fs.readFileSync(state.lockPath);
    const checkout = writeDeveloperFlowCheckout(path.join(state.root, 'workspace'));
    const installed = runCli(['packages', 'install', 'opl-flow'], {
      ...state.env,
      OPL_MODULE_PATH_OPLFLOW: checkout,
      OPL_MODULE_SOURCE_MODE: 'git_checkout',
    }) as any;
    const surface = installed.opl_agent_package_install;
    assert.equal(surface.status, 'installed');
    assert.equal(surface.configured_carrier.executor.status, 'callable');
    assert.equal(surface.configured_carrier.installed_version, '0.1.30');
    assert.equal(fs.realpathSync(surface.configured_carrier.plugin_source_path), fs.realpathSync(checkout));
    assert.equal(fs.realpathSync(surface.configured_carrier.carrier.marketplace_source), fs.realpathSync(checkout));
    assert.deepEqual(surface.configured_carrier.executor.required_skill_ids, flowSkillIds);
    assert.equal(Object.hasOwn(surface, 'package_lock'), false);
    assert.equal(Object.hasOwn(surface, 'physical_surface'), false);
    assert.equal(fs.existsSync(path.join(state.env.OPL_STATE_DIR, 'agent-package-locks.json')), false);
    assert.equal(fs.existsSync(path.join(state.env.OPL_STATE_DIR, 'agent-package-lifecycle-ledger.json')), false);
    for (const skillId of flowSkillIds) {
      assert.equal(
        fs.existsSync(path.join(checkout, 'skills', skillId, 'SKILL.md')),
        true,
      );
    }
    for (const skillId of skillIds) {
      assert.equal(fs.existsSync(path.join(state.skillsRoot, skillId)), true);
    }
    assert.deepEqual(fs.readFileSync(state.lockPath), skillLockBefore);
    const pluginList = JSON.parse(execFileSync(state.codex.codexPath, ['plugin', 'list', '--json'], {
      env: { ...process.env, ...state.env },
      encoding: 'utf8',
    }));
    assert.equal(pluginList.installed.length, 1);
    assert.equal(pluginList.installed[0].pluginId, flowPluginSelector);
    assert.equal(fs.realpathSync(pluginList.installed[0].source.path), fs.realpathSync(checkout));
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
    assert.equal(surface.configured_carrier.executor.status, 'callable');
    assert.equal(surface.configured_carrier.installed_version, '0.1.30');
    assert.equal(fs.realpathSync(surface.configured_carrier.plugin_source_path), fs.realpathSync(checkout));
    assert.equal(Object.hasOwn(surface, 'package_lock'), false);
    assert.equal(fs.existsSync(path.join(state.env.OPL_STATE_DIR, 'agent-package-locks.json')), false);
    for (const requiredPath of [
      'scripts/opl_workflow.py',
      'scripts/opl_fleet.py',
      'contracts/fleet-telemetry-protocol.json',
      'contracts/fleet-telemetry-protocol.schema.json',
    ]) {
      assert.equal(
        fs.existsSync(path.join(checkout, requiredPath)),
        true,
        requiredPath,
      );
    }
    assert.equal(fs.existsSync(path.join(checkout, 'not-in-flow-payload.txt')), true);
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

test('developer Flow update switches the native carrier without Framework private lifecycle state', () => {
  const state = publicLifecycleFixture('managed-update');
  try {
    const previousCheckout = writeDeveloperFlowCheckout(path.join(state.root, 'workspace-previous'));
    const legacyAgentsRoot = path.join(state.root, 'legacy-agents');
    fs.renameSync(state.agentsRoot, legacyAgentsRoot);
    const previous = runCli([
      'packages', 'install', 'opl-flow',
      '--source-kind', 'developer_checkout_override',
      '--agent-root', previousCheckout,
    ], state.env) as any;
    fs.renameSync(legacyAgentsRoot, state.agentsRoot);
    assert.equal(
      fs.realpathSync(previous.opl_agent_package_install.configured_carrier.plugin_source_path),
      fs.realpathSync(previousCheckout),
    );
    assert.equal(Object.hasOwn(previous.opl_agent_package_install, 'package_lock'), false);
    for (const skillId of skillIds) {
      assert.equal(fs.existsSync(path.join(state.skillsRoot, skillId)), true);
    }

    const nextCheckout = writeDeveloperFlowCheckout(path.join(state.root, 'workspace-next'));
    const developerSelection = [
      '--source-kind', 'developer_checkout_override',
      '--agent-root', nextCheckout,
    ];
    const update = runCli(['packages', 'update', 'opl-flow', ...developerSelection], state.env) as any;
    const surface = update.opl_agent_package_update;
    assert.equal(surface.status, 'updated');
    assert.equal(fs.realpathSync(surface.configured_carrier.plugin_source_path), fs.realpathSync(nextCheckout));
    assert.equal(
      fs.realpathSync(surface.configured_carrier.carrier.marketplace_source),
      fs.realpathSync(nextCheckout),
    );
    assert.equal(surface.configured_carrier.executor.status, 'callable');
    assert.equal(Object.hasOwn(surface, 'package_lock'), false);
    assert.equal(Object.hasOwn(surface, 'physical_surface'), false);
    assert.equal(fs.existsSync(path.join(state.env.OPL_STATE_DIR, 'agent-package-locks.json')), false);
    assert.equal(fs.existsSync(path.join(state.env.OPL_STATE_DIR, 'agent-package-lifecycle.sqlite')), false);
    for (const skillId of skillIds) {
      assert.equal(fs.existsSync(path.join(state.skillsRoot, skillId)), true);
    }
    const pluginList = JSON.parse(execFileSync(state.codex.codexPath, ['plugin', 'list', '--json'], {
      env: { ...process.env, ...state.env },
      encoding: 'utf8',
    }));
    assert.equal(pluginList.installed.length, 1);
    assert.equal(pluginList.installed[0].version, '0.1.30');
    assert.equal(fs.realpathSync(pluginList.installed[0].source.path), fs.realpathSync(nextCheckout));

    const workspace = path.join(state.root, 'workspace-target');
    fs.mkdirSync(workspace, { recursive: true });
    const activation = runCli([
      'packages', 'activate', 'opl-flow', '--scope', 'workspace', '--target-workspace', workspace,
    ], state.env) as any;
    assert.equal(activation.opl_agent_package_activation.status, 'already_activated');
    assert.equal(activation.opl_agent_package_activation.writes_performed, false);

    const repair = runCli(['packages', 'repair', 'opl-flow', ...developerSelection], state.env) as any;
    assert.equal(repair.opl_agent_package_repair.status, 'repaired');
    assert.equal(
      fs.realpathSync(repair.opl_agent_package_repair.configured_carrier.plugin_source_path),
      fs.realpathSync(nextCheckout),
    );
    const disabled = runCli(['packages', 'disable', 'opl-flow'], state.env) as any;
    assert.equal(
      disabled.opl_agent_package_exposure.status,
      'disabled',
      JSON.stringify(disabled.opl_agent_package_exposure.configured_carrier, null, 2),
    );
    const enabled = runCli(['packages', 'enable', 'opl-flow'], state.env) as any;
    assert.equal(enabled.opl_agent_package_exposure.status, 'enabled');
    const removed = runCli(['packages', 'uninstall', 'opl-flow'], state.env) as any;
    assert.equal(removed.opl_agent_package_uninstall.status, 'uninstalled');
    assert.equal(removed.opl_agent_package_uninstall.configured_carrier.status, 'physical_unavailable');
    assert.equal(fs.existsSync(path.join(state.env.OPL_STATE_DIR, 'agent-package-locks.json')), false);
    assert.equal(fs.existsSync(path.join(state.env.OPL_STATE_DIR, 'agent-package-lifecycle-ledger.json')), false);
    assert.equal(fs.existsSync(path.join(state.env.OPL_STATE_DIR, 'agent-package-lifecycle.sqlite')), false);
  } finally {
    removeFixtureTree(state.root);
  }
});

test('developer Flow selection is explicit and complete before native mutation', () => {
  const state = publicLifecycleFixture('developer-selection-required');
  try {
    const checkout = writeDeveloperFlowCheckout(path.join(state.root, 'workspace'));
    for (const [args, failureCode] of [
      [
        ['packages', 'install', 'opl-flow', '--agent-root', checkout],
        'agent_package_developer_checkout_source_kind_required',
      ],
      [
        ['packages', 'install', 'opl-flow', '--source-kind', 'developer_checkout_override'],
        'agent_package_developer_checkout_path_required',
      ],
    ] as const) {
      const failure = runCliFailure([...args], state.env);
      assert.equal(failure.payload.error.details.failure_code, failureCode);
      const commands = fs.existsSync(state.commandLog)
        ? fs.readFileSync(state.commandLog, 'utf8').trim().split('\n').filter(Boolean)
        : [];
      assert.equal(commands.some((command) => command.includes('plugin marketplace add')), false);
      assert.equal(commands.some((command) => /^plugin (add|remove) /.test(command)), false);
      assert.equal(fs.existsSync(path.join(state.env.OPL_STATE_DIR, 'agent-package-locks.json')), false);
    }
  } finally {
    removeFixtureTree(state.root);
  }
});

test('developer Flow native lifecycle fails closed when carrier actions report success without target state', () => {
  for (const action of ['disable', 'enable', 'uninstall'] as const) {
    const state = publicLifecycleFixture(`developer-${action}-readback-noop`);
    try {
      const checkout = writeDeveloperFlowCheckout(path.join(state.root, 'workspace'));
      runCli([
        'packages', 'install', 'opl-flow',
        '--source-kind', 'developer_checkout_override',
        '--agent-root', checkout,
      ], state.env);
      if (action === 'enable') {
        runCli(['packages', 'disable', 'opl-flow'], state.env);
      }
      const failure = runCliFailure(
        ['packages', action, 'opl-flow'],
        {
          ...state.env,
          ...(action === 'uninstall'
            ? { FIXTURE_NOOP_PLUGIN_REMOVE: '1' }
            : { FIXTURE_FORCE_PLUGIN_ENABLED: action === 'enable' ? 'false' : 'true' }),
        },
      );
      assert.equal(
        failure.payload.error.details.failure_code,
        'configured_codex_plugin_carrier_target_currentness_mismatch',
      );
      assert.equal(fs.existsSync(path.join(state.env.OPL_STATE_DIR, 'agent-package-locks.json')), false);
    } finally {
      removeFixtureTree(state.root);
    }
  }
});

test('developer Flow install rejects checkout drift after native dispatch', () => {
  const state = publicLifecycleFixture('developer-post-dispatch-drift');
  try {
    const checkout = writeDeveloperFlowCheckout(path.join(state.root, 'workspace'));
    const driftTarget = path.join(checkout, 'templates', 'AGENTS.md');
    const failure = runCliFailure([
      'packages', 'install', 'opl-flow',
      '--source-kind', 'developer_checkout_override',
      '--agent-root', checkout,
    ], {
      ...state.env,
      FIXTURE_MUTATE_CHECKOUT_AFTER_ADD: driftTarget,
    });
    assert.equal(
      failure.payload.error.details.failure_code,
      'configured_codex_plugin_carrier_target_currentness_mismatch',
    );
    assert.equal(fs.existsSync(path.join(state.env.OPL_STATE_DIR, 'agent-package-locks.json')), false);
  } finally {
    removeFixtureTree(state.root);
  }
});

test('developer MAS install resolves its required ScholarSkills native closure before root mutation', () => {
  const state = publicLifecycleFixture('developer-mas-required-closure');
  try {
    const { masCheckout, scholarCheckout } = writeDeveloperMasCarrierClosure(state.root);
    const args = [
      'packages', 'install', 'mas',
      '--source-kind', 'developer_checkout_override',
      '--agent-root', masCheckout,
    ];
    const missing = runCliFailure(args, {
      ...state.env,
      OPL_MODULE_SOURCE_MODE: 'package_channel',
      OPL_MODULE_PATH_MEDAUTOSCIENCE: '',
      OPL_MODULE_PATH_SCHOLARSKILLS: '',
    });
    assert.equal(
      missing.payload.error.details.failure_code,
      'configured_codex_plugin_carrier_developer_dependency_checkout_missing',
    );
    const commandsBefore = fs.existsSync(state.commandLog)
      ? fs.readFileSync(state.commandLog, 'utf8').trim().split('\n').filter(Boolean)
      : [];
    assert.equal(commandsBefore.some((command) => command.includes('plugin marketplace add')), false);
    assert.equal(commandsBefore.some((command) => /^plugin add /.test(command)), false);

    const installed = runCli(args, {
      ...state.env,
      OPL_MODULE_SOURCE_MODE: 'git_checkout',
      OPL_MODULE_PATH_MEDAUTOSCIENCE: masCheckout,
      OPL_MODULE_PATH_SCHOLARSKILLS: scholarCheckout,
    }) as any;
    assert.equal(installed.opl_agent_package_install.status, 'installed');
    assert.deepEqual(
      installed.opl_agent_package_install.required_dependency_packages.map(
        (entry: any) => `${entry.package_id}@${entry.observed_version}:${entry.status}`,
      ),
      ['mas-scholar-skills@0.2.23:installed'],
    );
    assert.equal(installed.opl_agent_package_install.configured_carrier.installed_version, '0.2.24');
    assert.equal(installed.opl_agent_package_install.configured_carrier.executor.status, 'callable');
    const commands = fs.readFileSync(state.commandLog, 'utf8').trim().split('\n').filter(Boolean);
    const scholarAdd = commands.indexOf('plugin add mas-scholar-skills@mas-scholar-skills-local --json');
    const masAdd = commands.indexOf('plugin add med-autoscience@med-autoscience-local --json');
    assert.ok(scholarAdd >= 0 && masAdd > scholarAdd, JSON.stringify(commands, null, 2));
    assert.equal(fs.existsSync(path.join(state.env.OPL_STATE_DIR, 'agent-package-locks.json')), false);

    const uninstallFailure = runCliFailure([
      'packages', 'uninstall', 'mas-scholar-skills',
    ], state.env);
    assert.equal(
      uninstallFailure.payload.error.details.failure_code,
      'agent_package_required_by_installed_dependents',
    );
    assert.deepEqual(uninstallFailure.payload.error.details.dependent_package_ids, ['mas']);
    const commandsAfterFailure = fs.readFileSync(state.commandLog, 'utf8')
      .trim()
      .split('\n')
      .filter(Boolean);
    assert.equal(
      commandsAfterFailure.includes('plugin remove mas-scholar-skills@mas-scholar-skills-local --json'),
      false,
    );
    for (const packageId of ['mas', 'mas-scholar-skills']) {
      const status = runCli(['packages', 'status', '--package-id', packageId], state.env) as any;
      assert.equal(status.opl_agent_package_status.operational_ready, true);
      assert.equal(status.opl_agent_package_status.configured_carrier.status, 'installed');
      assert.equal(status.opl_agent_package_status.configured_carrier.enabled, true);
      assert.equal(status.opl_agent_package_status.configured_carrier.executor.status, 'callable');
    }
  } finally {
    removeFixtureTree(state.root);
  }
});

test('developer Flow checkout rejects mismatched local marketplace and plugin identity before native mutation', () => {
  for (const mismatch of ['marketplace', 'path', 'plugin-version'] as const) {
    const state = publicLifecycleFixture(`developer-${mismatch}-mismatch`);
    try {
      const checkout = writeDeveloperFlowCheckout(path.join(state.root, 'workspace'));
      const marketplacePath = path.join(checkout, '.agents', 'plugins', 'marketplace.json');
      if (mismatch === 'marketplace') {
        const marketplace = JSON.parse(fs.readFileSync(marketplacePath, 'utf8'));
        marketplace.name = 'different-marketplace';
        fs.writeFileSync(marketplacePath, formatJsonPayload(marketplace));
      } else if (mismatch === 'path') {
        const marketplace = JSON.parse(fs.readFileSync(marketplacePath, 'utf8'));
        marketplace.plugins[0].source.path = '../';
        fs.writeFileSync(marketplacePath, formatJsonPayload(marketplace));
      } else {
        const pluginPath = path.join(checkout, '.codex-plugin', 'plugin.json');
        const plugin = JSON.parse(fs.readFileSync(pluginPath, 'utf8'));
        plugin.version = '9.9.9';
        fs.writeFileSync(pluginPath, formatJsonPayload(plugin));
      }
      const failure = runCliFailure(['packages', 'install', 'opl-flow'], {
        ...state.env,
        OPL_MODULE_PATH_OPLFLOW: checkout,
        OPL_MODULE_SOURCE_MODE: 'git_checkout',
      });
      assert.equal(failure.payload.error.details.failure_code, 'agent_package_developer_checkout_source_invalid');
      const commands = fs.existsSync(state.commandLog)
        ? fs.readFileSync(state.commandLog, 'utf8').trim().split('\n').filter(Boolean)
        : [];
      assert.equal(commands.some((command) => command.includes('plugin marketplace add')), false);
      assert.equal(commands.some((command) => /^plugin (add|remove) /.test(command)), false);
      assert.equal(fs.existsSync(path.join(state.env.OPL_STATE_DIR, 'agent-package-locks.json')), false);
    } finally {
      removeFixtureTree(state.root);
    }
  }
});

test('developer Flow update fails closed on native readback without writing Framework lifecycle state', () => {
  const state = publicLifecycleFixture('managed-update-readback-rollback');
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
    const skillLockBefore = fs.readFileSync(state.lockPath);

    const nextCheckout = writeDeveloperFlowCheckout(path.join(state.root, 'workspace-next'));
    const failure = runCliFailure(['packages', 'update', 'opl-flow'], {
      ...state.env,
      OPL_MODULE_PATH_OPLFLOW: nextCheckout,
      OPL_MODULE_SOURCE_MODE: 'git_checkout',
      FIXTURE_FAIL_PLUGIN_LIST: '1',
    });
    assert.equal(
      failure.payload.error.details.failure_code,
      'configured_codex_plugin_carrier_action_failed',
    );
    assert.deepEqual(fs.readFileSync(state.lockPath), skillLockBefore);
    assert.equal(fs.existsSync(path.join(state.env.OPL_STATE_DIR, 'agent-package-locks.json')), false);
    assert.equal(fs.existsSync(path.join(state.env.OPL_STATE_DIR, 'agent-package-lifecycle-ledger.json')), false);
    assert.equal(fs.existsSync(path.join(state.env.OPL_STATE_DIR, 'agent-package-lifecycle.sqlite')), false);
    for (const skillId of skillIds) {
      assert.equal(fs.existsSync(path.join(state.skillsRoot, skillId)), true);
    }
  } finally {
    removeFixtureTree(state.root);
  }
});
