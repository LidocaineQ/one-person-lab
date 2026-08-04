import { execFileSync } from 'node:child_process';
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
  removeFixtureTree,
  runCli,
  runCliFailure,
  test,
} from './helpers.ts';
import { createFakeCodexPluginManagerFixture } from '../../helpers.ts';
import { resolveFirstPartyPackageCatalog } from '../../../../../src/modules/connect/agent-package-first-party.ts';
import { refreshFirstPartyPackageCatalogSnapshot } from '../../../../../src/modules/connect/agent-package-registry-parts/first-party-release-catalog.ts';
import { normalizeManifest } from '../../../../../src/modules/connect/agent-package-registry-parts/manifest-normalizers.ts';
import { materializeAgentPackageSkillProjection } from '../../../../../src/modules/connect/agent-package-registry-parts/skill-projection.ts';
import { assertFirstPartyPackageUpdateSelection } from '../../../../../src/modules/connect/agent-package-registry-parts/update-reconciliation.ts';
import {
  normalizeOplReleaseChannelTag,
  resolveOplReleaseManifestRef,
} from '../../../../../src/modules/connect/system-installation/release-channel.ts';
import { computePackageChannelTreeSha256 } from '../../../../../src/modules/connect/system-installation/module-package-channel.ts';
import {
  commitDeveloperCheckout,
  updateDeveloperCapabilityCheckoutClosure,
  writeCapabilityCatalog,
  writeDeveloperCapabilityCheckoutClosure,
  writeCapabilityProvider,
  writeMasConsumer,
} from './capability-fixtures.ts';

const PACKAGE_LAYER_MEDIA_TYPE = 'application/vnd.onepersonlab.package.source.v1+gzip';
const PACKAGE_MANIFEST_LAYER_MEDIA_TYPE = 'application/vnd.onepersonlab.package.manifest.v1+json';
const PACKAGE_PAYLOAD_LAYER_MEDIA_TYPE = 'application/vnd.onepersonlab.package.payload.v1+json';
const FLOW_SKILL_IDS = [
  'coordinate-concurrent-tasks',
  'develop-and-deliver',
  'github-ssot-patrol',
  'opl-fleet',
  'opl-flow',
  'recover-codex-tasks',
  'task-mode-gate',
];

function writeMasOwnerGateFixture(checkoutPath: string, binRoot: string) {
  const packageRoot = path.join(checkoutPath, 'src', 'med_autoscience', 'authority_handlers');
  const uvToolDir = path.join(path.dirname(binRoot), 'uv-tools');
  const ownerGateBin = path.join(
    uvToolDir,
    'med-autoscience',
    'bin',
    'mas-foundry-owner-gate',
  );
  fs.mkdirSync(packageRoot, { recursive: true });
  fs.writeFileSync(path.join(checkoutPath, 'pyproject.toml'), [
    '[build-system]',
    'requires = ["setuptools>=69"]',
    'build-backend = "setuptools.build_meta"',
    '',
    '[project]',
    'name = "med-autoscience"',
    'version = "0.1.0"',
    '',
    '[project.scripts]',
    'mas-foundry-owner-gate = "med_autoscience.authority_handlers.foundry_owner_gate:main"',
    '',
  ].join('\n'));
  fs.writeFileSync(path.join(checkoutPath, 'README.md'), '# MAS developer fixture\n');
  fs.writeFileSync(path.join(checkoutPath, 'src', 'med_autoscience', '__init__.py'), '');
  fs.writeFileSync(path.join(packageRoot, '__init__.py'), '');
  fs.writeFileSync(path.join(packageRoot, 'foundry_owner_gate.py'), 'def main():\n    raise SystemExit(0)\n');
  fs.mkdirSync(path.dirname(ownerGateBin), { recursive: true });
  fs.writeFileSync(ownerGateBin, '#!/usr/bin/env bash\nexit 0\n', { mode: 0o755 });
  fs.mkdirSync(binRoot, { recursive: true });
  fs.writeFileSync(path.join(binRoot, 'uv'), [
    '#!/usr/bin/env node',
    "const fs = require('node:fs');",
    "const path = require('node:path');",
    "const target = path.join(process.env.UV_TOOL_DIR, 'med-autoscience', 'bin', 'mas-foundry-owner-gate');",
    'fs.mkdirSync(path.dirname(target), { recursive: true });',
    "fs.writeFileSync(target, '#!/usr/bin/env bash\\nexit 0\\n', { mode: 0o755 });",
  ].join('\n'), { mode: 0o755 });
  return { UV_TOOL_DIR: uvToolDir };
}

function withMasOwnerGateFixturePath(
  releaseEnv: Record<string, string>,
  binRoot: string,
) {
  return {
    ...releaseEnv,
    PATH: `${binRoot}${path.delimiter}${releaseEnv.PATH ?? process.env.PATH ?? ''}`,
  };
}

function writePackageOwnerChannelFixture(input: {
  root: string;
  binRoot: string;
  catalogPath: string;
  packageIds: string[];
}) {
  const catalog = parseJsonText(fs.readFileSync(input.catalogPath, 'utf8')) as any;
  const packageCatalog = catalog.packages.package_catalog;
  const blobRoot = path.join(input.root, 'owner-channel-blobs');
  const manifests: Record<string, unknown> = {};
  const blobs: Record<string, string> = {};
  fs.mkdirSync(blobRoot, { recursive: true });
  fs.mkdirSync(input.binRoot, { recursive: true });
  for (const packageId of input.packageIds) {
    const version = packageCatalog[packageId]?.versions?.[0];
    assert.ok(version, `missing fixture catalog entry for ${packageId}`);
    const manifestPath = path.join(blobRoot, `${packageId}-manifest.json`);
    const payloadPath = path.join(blobRoot, `${packageId}-payload.json`);
    fs.writeFileSync(manifestPath, version.manifest_json);
    fs.writeFileSync(payloadPath, version.payload_manifest_json);
    const payload = parseJsonText(version.payload_manifest_json) as any;
    const sourcePath = path.join(
      path.dirname(input.catalogPath),
      'release-set-artifacts',
      `${payload.package_source.archive_root}.tar.gz`,
    );
    assert.equal(fs.existsSync(sourcePath), true, sourcePath);
    manifests[`fixture/one-person-lab-packages/${packageId}`] = {
      schemaVersion: 2,
      layers: [
        { mediaType: PACKAGE_LAYER_MEDIA_TYPE, digest: version.package_content_digest },
        {
          mediaType: PACKAGE_MANIFEST_LAYER_MEDIA_TYPE,
          digest: version.manifest_sha256,
          annotations: { 'org.opencontainers.image.title': 'package-manifest.json' },
        },
        {
          mediaType: PACKAGE_PAYLOAD_LAYER_MEDIA_TYPE,
          digest: version.payload_manifest_sha256,
          annotations: { 'org.opencontainers.image.title': 'payload-manifest.json' },
        },
      ],
    };
    blobs[version.package_content_digest] = sourcePath;
    blobs[version.manifest_sha256] = manifestPath;
    blobs[version.payload_manifest_sha256] = payloadPath;
  }
  const curlLogPath = path.join(input.root, 'owner-channel-curl.jsonl');
  fs.writeFileSync(path.join(input.binRoot, 'curl'), [
    '#!/usr/bin/env node',
    "const fs = require('node:fs');",
    'const args = process.argv.slice(2);',
    `fs.appendFileSync(${JSON.stringify(curlLogPath)}, JSON.stringify(args) + '\\n');`,
    "const url = args.find((arg) => arg.startsWith('http://') || arg.startsWith('https://')) || '';",
    "if (url.includes('/token?')) { process.stdout.write(JSON.stringify({ token: 'fixture' })); process.exit(0); }",
    `const manifests = ${JSON.stringify(manifests)};`,
    `const blobs = ${JSON.stringify(blobs)};`,
    "if (url.includes('/manifests/')) {",
    "  const match = url.match(/\\/v2\\/(.+)\\/manifests\\//);",
    '  const payload = match ? manifests[match[1]] : null;',
    '  if (!payload) process.exit(22);',
    '  process.stdout.write(JSON.stringify(payload));',
    '  process.exit(0);',
    '}',
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
      PATH: `${input.binRoot}${path.delimiter}${process.env.PATH ?? ''}`,
    },
    curlLogPath,
  };
}

function writeOmaOwnerReleaseFixture(input: {
  root: string;
  generation: string;
  completeRuntime?: boolean;
}) {
  const sourceRoot = path.join(input.root, 'oma-source');
  const manifestPath = path.join(sourceRoot, 'oma.json');
  const requiredRuntimeFiles = [
    'contracts/action_catalog.json',
    'contracts/domain_descriptor.json',
    ...(input.completeRuntime === false ? [] : ['contracts/foundry_provider.json']),
    'contracts/pack_compiler_input.json',
    'agent/stages/manifest.json',
    'agent/primary_skill/SKILL.md',
  ];
  fs.mkdirSync(path.join(sourceRoot, '.codex-plugin'), { recursive: true });
  fs.mkdirSync(path.join(sourceRoot, 'skills', 'opl-meta-agent'), { recursive: true });
  fs.writeFileSync(path.join(sourceRoot, '.codex-plugin', 'plugin.json'), formatJsonPayload({
    name: 'opl-meta-agent',
    version: '0.4.3',
  }));
  fs.writeFileSync(
    path.join(sourceRoot, 'skills', 'opl-meta-agent', 'SKILL.md'),
    '# OPL Meta Agent fixture\n',
  );
  fs.writeFileSync(path.join(sourceRoot, 'fixture-generation.txt'), `${input.generation}\n`);
  for (const relativePath of requiredRuntimeFiles) {
    const targetPath = path.join(sourceRoot, relativePath);
    fs.mkdirSync(path.dirname(targetPath), { recursive: true });
    fs.writeFileSync(
      targetPath,
      relativePath.endsWith('.md')
        ? `# ${input.generation}\n`
        : formatJsonPayload({ fixture_generation: input.generation }),
    );
  }
  fs.writeFileSync(manifestPath, formatJsonPayload({
    ...agentPackageManifest({
      packageId: 'oma',
      agentId: 'oma',
      pluginId: 'opl-meta-agent',
      distributionPayload: null,
    }),
    display_name: 'OPL Meta Agent fixture',
    publisher: 'one-person-lab',
    version: '0.4.3',
    source: 'first_party',
    codex_surface: {
      plugin_id: 'opl-meta-agent',
      required_skill_ids: ['opl-meta-agent'],
    },
    runtime_source_carrier: {
      carrier_kind: 'opl_managed_module_source',
      module_id: 'oplmetaagent',
    },
    capability_dependencies: [],
  }));
  const releaseSet = writeCapabilityCatalog(
    path.join(input.root, 'release-set'),
    [manifestPath],
  );
  const ownerChannel = writePackageOwnerChannelFixture({
    root: input.root,
    binRoot: path.join(input.root, 'bin'),
    catalogPath: releaseSet.catalogPath,
    packageIds: ['oma'],
  });
  return { releaseSet, ownerChannel };
}

function writeFirstPartyCatalogFixture(
  version: string,
  ownerSourceCommit: string,
  options: {
    manifestCarrierSourceCommit?: string | null;
    requiredSkillIds?: string[];
    configuredCarrier?: boolean;
  } = {},
) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `opl-first-party-catalog-${version}-`));
  const sourceParent = path.join(root, 'source');
  const sourceRoot = path.join(sourceParent, 'opl-flow');
  const blobRoot = path.join(root, 'blobs');
  const fakeBin = path.join(root, 'bin');
  const pluginJson = formatJsonPayload({
    name: 'opl-flow',
    version,
    displayName: 'OPL Flow',
    description: 'First-party catalog fixture.',
  });
  const requiredSkillIds = options.requiredSkillIds ?? FLOW_SKILL_IDS;
  const skillMarkdown = (skillId: string) =>
    `# ${skillId === 'opl-flow' ? 'OPL Flow' : skillId}\n\nFirst-party catalog fixture.\n`;
  const agentsMarkdown = '# OPL Flow fixture profile\n';
  const tasteMarkdown = '# OPL Flow fixture authoring source\n';
  const workflowPolicy = formatJsonPayload({
    schema: 'opl_flow_workflow_policy.v1',
    package: { id: 'opl-flow', version, owner: 'opl-flow', kind: 'workflow_profile' },
    workflow_generation: 'fixture',
    requires: [],
    recommends: [],
    compatible_optional: [],
    conflicts: [],
    retires: [],
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
      plugin_ids: ['opl-flow'],
      skill_ids: ['opl-flow'],
      service_ids: ['opl-flow'],
      config_markers: ['opl-flow'],
      legacy_prompt_ids: ['opl-flow'],
    },
    codex_model_policy: {
      authority: 'opl-flow',
      mode_default: 'auto',
      configured_default: {
        model: 'gpt-5.6-sol',
        reasoning_effort: 'max',
      },
      override_precedence: [
        'explicit_user_override',
        'opl_flow_recommendation',
        'fresh_codex_model_catalog',
        'app_fallback_when_flow_unavailable',
      ],
      catalog_policy: {
        source: 'codex_cli_model_list',
        prefer_live_default_when_user_has_not_pinned: true,
        unknown_model_reasoning_effort: 'highest_supported',
        preserve_unavailable_fixed_selection_until_user_changes_it: true,
      },
    },
  });
  const workflowPolicySchema = formatJsonPayload({ type: 'object' });
  fs.mkdirSync(path.join(sourceRoot, '.codex-plugin'), { recursive: true });
  fs.mkdirSync(path.join(sourceRoot, '.agents', 'plugins'), { recursive: true });
  for (const skillId of requiredSkillIds) {
    fs.mkdirSync(path.join(sourceRoot, 'skills', skillId), { recursive: true });
  }
  fs.mkdirSync(path.join(sourceRoot, 'templates'), { recursive: true });
  fs.mkdirSync(path.join(sourceRoot, 'contracts'), { recursive: true });
  fs.mkdirSync(blobRoot, { recursive: true });
  fs.mkdirSync(fakeBin, { recursive: true });
  fs.writeFileSync(path.join(sourceRoot, '.codex-plugin', 'plugin.json'), pluginJson);
  fs.writeFileSync(
    path.join(sourceRoot, '.agents', 'plugins', 'marketplace.json'),
    formatJsonPayload({
      name: 'opl-flow-local',
      plugins: [{
        name: 'opl-flow',
        source: { source: 'local', path: './' },
      }],
    }),
  );
  for (const skillId of requiredSkillIds) {
    fs.writeFileSync(path.join(sourceRoot, 'skills', skillId, 'SKILL.md'), skillMarkdown(skillId));
  }
  fs.writeFileSync(path.join(sourceRoot, 'templates', 'AGENTS.md'), agentsMarkdown);
  fs.writeFileSync(path.join(sourceRoot, 'templates', 'TASTE.md'), tasteMarkdown);
  fs.writeFileSync(path.join(sourceRoot, 'contracts', 'workflow-policy.json'), workflowPolicy);
  fs.writeFileSync(path.join(sourceRoot, 'contracts', 'workflow-policy.schema.json'), workflowPolicySchema);
  const sourceArtifactRef = `ghcr.io/fixture/one-person-lab-packages/opl-flow:${version}`;
  const manifest = {
    surface_kind: 'opl_workflow_profile_package_manifest.v1',
    package_id: 'opl-flow',
    display_name: 'OPL Flow',
    publisher: 'one-person-lab',
    version,
    source: 'first_party',
    package_role: 'workflow_profile',
    carrier_source_role: 'codex_plugin_default_carrier_not_package_truth',
    codex_surface: {
      plugin_id: 'opl-flow',
      plugin_payload_manifest_url: 'payload.json',
      ...(options.manifestCarrierSourceCommit === null ? {} : {
        carrier_source_commit: options.manifestCarrierSourceCommit ?? ownerSourceCommit,
      }),
      ...(options.configuredCarrier === false ? {} : {
        configured_codex_plugin_carrier: {
          kind: 'codex_plugin_manager',
          plugin_selector: 'opl-flow@opl-flow-local',
          executor_route: 'codex_cli',
          marketplace_source: sourceRoot,
          publication_ref: 'ghcr.io/fixture/one-person-lab-packages/opl-flow:latest-stable',
        },
      }),
      required_skill_ids: requiredSkillIds,
    },
    profile_surface: {
      runtime_profile: { source_path: 'templates/AGENTS.md', target_id: 'user_agents_profile' },
      authoring_sources: [{ source_path: 'templates/TASTE.md', target_id: 'user_taste_source' }],
      merge_context_paths: [],
      existing_profile_policy: 'semantic_merge_required',
    },
    managed_policy_surface: {
      policy_kind: 'opl_flow_workflow_policy',
      source_path: 'contracts/workflow-policy.json',
      schema_path: 'contracts/workflow-policy.schema.json',
    },
    capability_dependencies: [],
  };
  const manifestJson = formatJsonPayload(manifest);
  fs.writeFileSync(path.join(sourceRoot, 'opl-package.json'), manifestJson);
  const archivePath = path.join(root, `opl-flow-${version}.tar.gz`);
  execFileSync('tar', ['-czf', archivePath, 'opl-flow'], { cwd: sourceParent });
  const archiveSha256 = crypto.createHash('sha256').update(fs.readFileSync(archivePath)).digest('hex');
  const payload = {
    surface_kind: 'opl_agent_package_payload_manifest',
    package_id: 'opl-flow',
    package_version: version,
    source_commit: ownerSourceCommit,
    package_source: {
      transport: 'same_oci_artifact_source_archive',
      artifact_ref: sourceArtifactRef,
      archive_sha256: `sha256:${archiveSha256}`,
      archive_root: 'opl-flow',
    },
    files: [
      {
        path: '.codex-plugin/plugin.json',
        source_path: '.codex-plugin/plugin.json',
        source_artifact_ref: sourceArtifactRef,
        migration_source_url: `https://raw.githubusercontent.com/fixture/opl-flow/${ownerSourceCommit}/.codex-plugin/plugin.json`,
        sha256: `sha256:${crypto.createHash('sha256').update(pluginJson).digest('hex')}`,
      },
      ...requiredSkillIds.map((skillId) => ({
        path: `skills/${skillId}/SKILL.md`,
        source_path: `skills/${skillId}/SKILL.md`,
        source_artifact_ref: sourceArtifactRef,
        migration_source_url: `https://raw.githubusercontent.com/fixture/opl-flow/${ownerSourceCommit}/skills/${skillId}/SKILL.md`,
        sha256: `sha256:${crypto.createHash('sha256').update(skillMarkdown(skillId)).digest('hex')}`,
      })),
      ...[
        ['opl-package.json', manifestJson],
        ['templates/AGENTS.md', agentsMarkdown],
        ['templates/TASTE.md', tasteMarkdown],
        ['contracts/workflow-policy.json', workflowPolicy],
        ['contracts/workflow-policy.schema.json', workflowPolicySchema],
      ].map(([filePath, content]) => ({
        path: filePath,
        source_path: filePath,
        source_artifact_ref: sourceArtifactRef,
        migration_source_url: `https://raw.githubusercontent.com/fixture/opl-flow/${ownerSourceCommit}/${filePath}`,
        sha256: `sha256:${crypto.createHash('sha256').update(content).digest('hex')}`,
      })),
    ],
  };
  const payloadManifestJson = formatJsonPayload(payload);
  const manifestSha256 = `sha256:${crypto.createHash('sha256').update(manifestJson).digest('hex')}`;
  const payloadManifestSha256 = `sha256:${crypto.createHash('sha256').update(payloadManifestJson).digest('hex')}`;
  const manifestPath = path.join(blobRoot, 'package-manifest.json');
  const payloadManifestPath = path.join(blobRoot, 'payload-manifest.json');
  fs.writeFileSync(manifestPath, manifestJson);
  fs.writeFileSync(payloadManifestPath, payloadManifestJson);
  const packageArtifactManifest = {
    schemaVersion: 2,
    layers: [
      { mediaType: PACKAGE_LAYER_MEDIA_TYPE, digest: `sha256:${archiveSha256}` },
      {
        mediaType: PACKAGE_MANIFEST_LAYER_MEDIA_TYPE,
        digest: manifestSha256,
        annotations: { 'org.opencontainers.image.title': 'package-manifest.json' },
      },
      {
        mediaType: PACKAGE_PAYLOAD_LAYER_MEDIA_TYPE,
        digest: payloadManifestSha256,
        annotations: { 'org.opencontainers.image.title': 'payload-manifest.json' },
      },
    ],
  };
  const packageArtifactManifestJson = JSON.stringify(packageArtifactManifest);
  const artifactDigest = `sha256:${crypto.createHash('sha256').update(packageArtifactManifestJson).digest('hex')}`;
  const curlLogPath = path.join(root, 'curl.jsonl');
  const manifests = {
    'fixture/one-person-lab-packages/opl-flow': packageArtifactManifest,
  };
  const blobs = {
    [`sha256:${archiveSha256}`]: archivePath,
    [manifestSha256]: manifestPath,
    [payloadManifestSha256]: payloadManifestPath,
  };
  fs.writeFileSync(path.join(fakeBin, 'curl'), [
    '#!/usr/bin/env node',
    "const fs = require('node:fs');",
    'const args = process.argv.slice(2);',
    `fs.appendFileSync(${JSON.stringify(curlLogPath)}, JSON.stringify(args) + '\\n');`,
    "const url = args.find((arg) => arg.startsWith('http://') || arg.startsWith('https://')) || '';",
    "if (url.includes('/token?')) { process.stdout.write(JSON.stringify({ token: 'fixture' })); process.exit(0); }",
    `const manifests = ${JSON.stringify(manifests)};`,
    `const blobs = ${JSON.stringify(blobs)};`,
    "if (url.includes('/manifests/')) {",
    "  const match = url.match(/\\/v2\\/(.+)\\/manifests\\//);",
    '  const payload = match ? manifests[match[1]] : null;',
    '  if (!payload) process.exit(22);',
    '  process.stdout.write(JSON.stringify(payload));',
    '  process.exit(0);',
    '}',
    "if (url.includes('/blobs/')) {",
    "  const digest = decodeURIComponent(url.slice(url.lastIndexOf('/') + 1));",
    "  const outIndex = args.indexOf('-o');",
    '  if (!blobs[digest] || outIndex < 0) process.exit(22);',
    '  fs.copyFileSync(blobs[digest], args[outIndex + 1]);',
    '  process.exit(0);',
    '}',
    'process.exit(22);',
  ].join('\n'), { mode: 0o755 });
  const codex = createFakeCodexPluginManagerFixture(path.join(root, 'fake-codex'));
  return {
    root,
    sourceRoot,
    env: {
      OPL_PACKAGES_OWNER: 'fixture',
      OPL_PACKAGE_CHANNEL_TAG: 'stable',
      OPL_CODEX_PLUGIN_BIN: codex.codexPath,
      PATH: `${fakeBin}${path.delimiter}${process.env.PATH ?? ''}`,
    },
    artifactDigest,
    manifestSha256,
    sourceArtifactRef,
    curlLogPath,
  };
}

function writeDescriptorOwnedFlowCarrier(input: {
  root: string;
  version: string;
}) {
  const marketplaceId = 'opl-agent-opl-flow-local';
  const marketplaceRoot = path.join(input.root, 'marketplace');
  const pluginRoot = path.join(marketplaceRoot, 'plugins', 'opl-flow');
  const selector = `opl-flow@${marketplaceId}`;
  const manifest = JSON.parse(fs.readFileSync(
    path.join(repoRoot, 'contracts', 'opl-framework', 'packages', 'opl-flow.json'),
    'utf8',
  ));
  manifest.version = input.version;
  manifest.codex_surface.required_skill_ids = FLOW_SKILL_IDS;
  manifest.codex_surface.configured_codex_plugin_carrier = {
    kind: 'codex_plugin_manager',
    plugin_selector: selector,
    executor_route: 'codex_cli',
    marketplace_source: marketplaceRoot,
    publication_ref: null,
  };
  fs.mkdirSync(path.join(pluginRoot, '.codex-plugin'), { recursive: true });
  for (const skillId of FLOW_SKILL_IDS) {
    fs.mkdirSync(path.join(pluginRoot, 'skills', skillId), { recursive: true });
    fs.writeFileSync(path.join(pluginRoot, 'skills', skillId, 'SKILL.md'), `# ${skillId}\n`);
  }
  fs.writeFileSync(path.join(pluginRoot, '.codex-plugin', 'plugin.json'), formatJsonPayload({
    name: 'opl-flow',
    version: input.version,
    skills: './skills/',
  }));
  fs.writeFileSync(path.join(pluginRoot, 'opl-package.json'), formatJsonPayload(manifest));
  fs.mkdirSync(path.join(marketplaceRoot, '.agents', 'plugins'), { recursive: true });
  fs.writeFileSync(
    path.join(marketplaceRoot, '.agents', 'plugins', 'marketplace.json'),
    formatJsonPayload({
      name: marketplaceId,
      plugins: [{
        name: 'opl-flow',
        source: { source: 'local', path: './plugins/opl-flow' },
      }],
    }),
  );
  return { marketplaceRoot, pluginRoot, selector };
}

function seedDescriptorOwnedFlowCarrier(input: {
  codexPath: string;
  carrier: ReturnType<typeof writeDescriptorOwnedFlowCarrier>;
  env: Record<string, string>;
}) {
  execFileSync(input.codexPath, [
    'plugin', 'marketplace', 'add', input.carrier.marketplaceRoot, '--json',
  ], { env: { ...process.env, ...input.env }, stdio: 'ignore' });
  execFileSync(input.codexPath, [
    'plugin', 'add', input.carrier.selector, '--json',
  ], { env: { ...process.env, ...input.env }, stdio: 'ignore' });
}

function writeNoopPluginAddWrapper(root: string, delegate: string) {
  const binary = path.join(root, 'noop-plugin-add-codex');
  fs.writeFileSync(binary, `#!/usr/bin/env node
import { spawnSync } from 'node:child_process';

const args = process.argv.slice(2);
if (process.env.FIXTURE_PLUGIN_ADD_NOOP === '1'
  && args[0] === 'plugin'
  && args[1] === 'add') {
  process.stdout.write(JSON.stringify({ status: 'ok' }));
  process.exit(0);
}
const result = spawnSync(${JSON.stringify(delegate)}, args, {
  env: process.env,
  encoding: 'utf8',
});
process.stdout.write(result.stdout || '');
process.stderr.write(result.stderr || '');
process.exit(result.status ?? 1);
`, { mode: 0o755 });
  return binary;
}

function writeCarrierReadbackOverrideWrapper(root: string, delegate: string) {
  const binary = path.join(root, 'carrier-readback-override-codex');
  fs.writeFileSync(binary, `#!/usr/bin/env node
import { spawnSync } from 'node:child_process';

const args = process.argv.slice(2);
const result = spawnSync(${JSON.stringify(delegate)}, args, {
  env: process.env,
  encoding: 'utf8',
});
if (result.status === 0
  && args.join(' ') === 'plugin list --json'
  && process.env.FIXTURE_CARRIER_SOURCE_CONTAINS) {
  const payload = JSON.parse(result.stdout || '{}');
  for (const entry of payload.installed || []) {
    if (!entry?.source?.path?.includes(process.env.FIXTURE_CARRIER_SOURCE_CONTAINS)) continue;
    if (process.env.FIXTURE_CARRIER_CLEAR_VERSION === '1') entry.version = null;
    else if (process.env.FIXTURE_CARRIER_VERSION) entry.version = process.env.FIXTURE_CARRIER_VERSION;
    if (process.env.FIXTURE_CARRIER_SOURCE_PATH) entry.source.path = process.env.FIXTURE_CARRIER_SOURCE_PATH;
  }
  process.stdout.write(JSON.stringify(payload));
  process.exit(0);
}
process.stdout.write(result.stdout || '');
process.stderr.write(result.stderr || '');
process.exit(result.status ?? 1);
`, { mode: 0o755 });
  return binary;
}

function writeRelayOwnerFixture(root: string) {
  const ownerRoot = path.join(root, 'relay-owner');
  const manifest = parseJsonText(fs.readFileSync(
    path.join(repoRoot, 'contracts/opl-framework/packages/opl-relay.json'),
    'utf8',
  )) as Record<string, any>;
  const manifestPath = path.join(ownerRoot, 'package-manifest.json');
  fs.mkdirSync(path.join(ownerRoot, '.codex-plugin'), { recursive: true });
  fs.mkdirSync(path.join(ownerRoot, 'skills', 'opl-relay'), { recursive: true });
  fs.writeFileSync(manifestPath, formatJsonPayload(manifest));
  fs.writeFileSync(path.join(ownerRoot, 'opl-package.json'), formatJsonPayload(manifest));
  fs.writeFileSync(path.join(ownerRoot, '.codex-plugin', 'plugin.json'), formatJsonPayload({
    name: 'opl-relay',
    version: manifest.version,
  }));
  fs.writeFileSync(path.join(ownerRoot, 'skills', 'opl-relay', 'SKILL.md'), '# OPL Relay fixture\n');
  return {
    ownerRoot,
    manifest,
    releaseSet: writeCapabilityCatalog(path.join(root, 'relay-release-set'), [manifestPath]),
  };
}

function writeRelayCodexFixture(binary: string, stateFile: string, sourcePath: string) {
  fs.writeFileSync(binary, `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
const statePath = ${JSON.stringify(stateFile)};
const sourcePath = ${JSON.stringify(sourcePath)};
const state = fs.existsSync(statePath)
  ? JSON.parse(fs.readFileSync(statePath, 'utf8'))
  : { installed: false, marketplace: null };
const command = args.join(' ');
if (command === 'plugin marketplace list --json') {
  process.stdout.write(JSON.stringify({
    marketplaces: state.marketplace ? [{ marketplaceSource: { source: state.marketplace } }] : [],
  }));
} else if (args[0] === 'plugin' && args[1] === 'marketplace' && args[2] === 'add') {
  state.marketplace = args[3];
  fs.writeFileSync(statePath, JSON.stringify(state));
  process.stdout.write('{}');
} else if (args[0] === 'plugin' && args[1] === 'add') {
  state.installed = true;
  fs.writeFileSync(statePath, JSON.stringify(state));
  process.stdout.write('{}');
} else if (command === 'plugin list --json') {
  process.stdout.write(JSON.stringify({
    installed: state.installed ? [{
      pluginId: 'opl-relay@opl-relay',
      version: state.version || '0.5.2',
      installed: true,
      enabled: true,
      source: { source: 'local', path: sourcePath },
      marketplaceSource: { sourceType: 'local', source: state.marketplace },
    }] : [],
    available: [],
  }));
} else {
  process.exitCode = 2;
}
`, { mode: 0o755 });
}

test('first-party package selection resolves its independent owner latest-stable channel', () => {
  const previousOwner = process.env.OPL_PACKAGES_OWNER;
  const previousTag = process.env.OPL_PACKAGE_CHANNEL_TAG;
  const previousVersion = process.env.OPL_PACKAGE_CHANNEL_VERSION;
  const previousManifestRef = process.env.OPL_PACKAGE_CHANNEL_MANIFEST_REF;
  delete process.env.OPL_PACKAGES_OWNER;
  delete process.env.OPL_PACKAGE_CHANNEL_TAG;
  delete process.env.OPL_PACKAGE_CHANNEL_VERSION;
  process.env.OPL_PACKAGE_CHANNEL_MANIFEST_REF = 'ghcr.io/stale/one-person-lab-manifest:latest-stable';
  try {
    const selection = resolveFirstPartyPackageCatalog('opl-flow');

    assert.deepEqual(selection, {
      canonicalId: 'opl-flow',
      trustTier: 'first_party',
      sourceKind: 'first_party_managed_cohort',
      catalogSource: {
        kind: 'managed_version_catalog',
        transport: 'opl_oci_channel',
        catalog_ref: 'ghcr.io/gaofeng21cn/one-person-lab-packages/opl-flow:latest-stable',
        digest_authority: 'manifest_and_content_digest',
      },
    });
    assert.equal(resolveFirstPartyPackageCatalog('unknown-package'), null);
  } finally {
    for (const [key, value] of Object.entries({
      OPL_PACKAGES_OWNER: previousOwner,
      OPL_PACKAGE_CHANNEL_TAG: previousTag,
      OPL_PACKAGE_CHANNEL_VERSION: previousVersion,
      OPL_PACKAGE_CHANNEL_MANIFEST_REF: previousManifestRef,
    })) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test('Relay carrier projection is explicit in the Framework manifest and capability schema', () => {
  const manifest = parseJsonText(fs.readFileSync(
    path.join(repoRoot, 'contracts/opl-framework/packages/opl-relay.json'),
    'utf8',
  )) as any;
  const schema = parseJsonText(fs.readFileSync(
    path.join(repoRoot, 'contracts/opl-framework/capability-package-manifest.schema.json'),
    'utf8',
  )) as any;
  const carrier = manifest.codex_surface.configured_codex_plugin_carrier;
  const carrierSchema = schema.properties.codex_surface.properties.configured_codex_plugin_carrier;
  assert.deepEqual(carrier, {
    kind: 'codex_plugin_manager',
    plugin_selector: 'opl-relay@opl-relay',
    executor_route: 'codex_cli',
    marketplace_source: 'gaofeng21cn/opl-relay',
    publication_ref: 'ghcr.io/gaofeng21cn/one-person-lab-packages/opl-relay:latest-stable',
  });
  assert.deepEqual(carrierSchema.required, [
    'kind',
    'plugin_selector',
    'executor_route',
    'marketplace_source',
    'publication_ref',
  ]);
  assert.equal(carrierSchema.properties.kind.const, 'codex_plugin_manager');
  assert.equal(carrierSchema.properties.executor_route.const, 'codex_cli');
  assert.equal(carrierSchema.additionalProperties, false);
});

test('legacy catalog selection policy is accepted as input but omitted from normalized manifests', () => {
  const manifestUrl = 'https://packages.example.test/third-party-research/manifest.json';
  const manifest = normalizeManifest({
    ...agentPackageManifest(),
    managed_update_source: {
      kind: 'managed_version_catalog',
      transport: 'json_url',
      catalog_ref: './catalog.json',
      selection_policy: 'highest_stable',
      digest_authority: 'manifest_and_content_digest',
    },
  }, manifestUrl);

  assert.deepEqual(manifest.managed_update_source, {
    kind: 'managed_version_catalog',
    transport: 'json_url',
    catalog_ref: 'https://packages.example.test/third-party-research/catalog.json',
    digest_authority: 'manifest_and_content_digest',
  });
  assert.equal('selection_policy' in manifest.managed_update_source!, false);
});

test('release channels normalize stable and preview aliases and reject bare latest', () => {
  assert.equal(normalizeOplReleaseChannelTag(undefined), 'latest-stable');
  assert.equal(normalizeOplReleaseChannelTag('stable'), 'latest-stable');
  assert.equal(normalizeOplReleaseChannelTag('preview'), 'candidate');
  assert.equal(normalizeOplReleaseChannelTag('26.7.13-r4'), '26.7.13-r4');
  assert.throws(
    () => normalizeOplReleaseChannelTag('latest'),
    (error: any) => error?.details?.failure_code === 'opl_release_channel_latest_retired',
  );

  const previousManifestRef = process.env.OPL_PACKAGE_CHANNEL_MANIFEST_REF;
  try {
    delete process.env.OPL_PACKAGE_CHANNEL_MANIFEST_REF;
    assert.equal(
      resolveOplReleaseManifestRef('ghcr.io/fixture/one-person-lab-manifest:preview'),
      'ghcr.io/fixture/one-person-lab-manifest:candidate',
    );
  } finally {
    if (previousManifestRef === undefined) delete process.env.OPL_PACKAGE_CHANNEL_MANIFEST_REF;
    else process.env.OPL_PACKAGE_CHANNEL_MANIFEST_REF = previousManifestRef;
  }
});

test('live owner refresh stays ephemeral and does not request the shared manifest', async () => {
  const fixture = writeFirstPartyCatalogFixture('0.2.0', '1'.repeat(40));
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opl-first-party-release-cache-'));
  const environment = {
    ...fixture.env,
    OPL_STATE_DIR: stateDir,
  };
  const previous = Object.fromEntries(
    Object.keys(environment).map((key) => [key, process.env[key]]),
  );
  try {
    Object.assign(process.env, environment);
    const snapshot = await refreshFirstPartyPackageCatalogSnapshot('opl-flow');
    assert.equal(snapshot.freshness, 'live');
    assert.equal(snapshot.catalog_ref, 'ghcr.io/fixture/one-person-lab-packages/opl-flow:latest-stable');
    assert.equal(snapshot.catalog_digest, fixture.artifactDigest);
    assert.equal(Object.hasOwn(snapshot, 'release_set_descriptor_digest'), false);
    assert.equal(Object.hasOwn(snapshot, 'channel_manifest_layer_digest'), false);
    assert.equal(Object.hasOwn(snapshot, 'package_catalog_digest'), false);
    assert.equal(fs.existsSync(
      path.join(stateDir, 'agent-package-release-catalog-cache.json'),
    ), false);
    const reads = fs.readFileSync(fixture.curlLogPath, 'utf8').trim().split('\n');
    assert.equal(
      reads.filter((line) =>
        line.includes('/one-person-lab-packages/opl-flow/manifests/latest-stable')).length,
      1,
    );
    assert.equal(reads.filter((line) => line.includes('/one-person-lab-manifest/')).length, 0);
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    fs.rmSync(stateDir, { recursive: true, force: true });
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('bare Relay install resolves its carrier from the live owner artifact', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'opl-relay-bare-owner-'));
  const fixture = writeRelayOwnerFixture(root);
  const binary = path.join(root, 'fake-codex');
  const stateFile = path.join(root, 'plugin-state.json');
  const stateDir = path.join(root, 'opl-state');
  writeRelayCodexFixture(binary, stateFile, fixture.ownerRoot);
  const env = {
    ...fixture.releaseSet.env,
    HOME: root,
    CODEX_HOME: path.join(root, 'codex-home'),
    OPL_STATE_DIR: stateDir,
    OPL_CODEX_PLUGIN_BIN: binary,
  };
  try {
    const installed = runCli(['packages', 'install', 'opl-relay'], env) as any;
    const surface = installed.opl_agent_package_install;
    assert.equal(surface.status, 'installed');
    assert.equal(surface.package_id, 'opl-relay');
    assert.equal(surface.configured_carrier.carrier.plugin_id, 'opl-relay@opl-relay');
    assert.equal(
      surface.configured_carrier.publication_ref,
      'ghcr.io/gaofeng21cn/one-person-lab-packages/opl-relay:latest-stable',
    );
    assert.equal(Object.hasOwn(surface, 'package_lock'), false);
    assert.equal(Object.hasOwn(surface, 'lifecycle_receipt'), false);
    assert.equal(fs.existsSync(path.join(stateDir, 'agent-package-locks.json')), false);
  } finally {
    removeFixtureTree(root);
  }
});

test('Relay owner source failure is typed and does not enter Framework lifecycle', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'opl-relay-owner-failure-'));
  const fixture = writeRelayOwnerFixture(root);
  const binary = path.join(root, 'fake-codex');
  const stateFile = path.join(root, 'plugin-state.json');
  const stateDir = path.join(root, 'opl-state');
  writeRelayCodexFixture(binary, stateFile, fixture.ownerRoot);
  const env = {
    ...fixture.releaseSet.env,
    HOME: root,
    CODEX_HOME: path.join(root, 'codex-home'),
    OPL_STATE_DIR: stateDir,
    OPL_CODEX_PLUGIN_BIN: binary,
    OPL_PACKAGES_OWNER: 'missing',
    OPL_PACKAGE_CHANNEL_MANIFEST_REF: 'ghcr.io/missing/one-person-lab-manifest:latest-stable',
  };
  try {
    const failure = runCliFailure(['packages', 'install', 'opl-relay'], env);
    assert.equal(
      failure.payload.error.details.failure_code,
      'agent_package_capability_channel_unavailable',
    );
    assert.equal(
      failure.payload.error.details.command.some((part: string) => part.includes(
        'one-person-lab-packages/opl-relay',
      )),
      true,
    );
    assert.equal(fs.existsSync(path.join(stateDir, 'agent-package-locks.json')), false);
  } finally {
    removeFixtureTree(root);
  }
});

test('first-party identities reject explicit registries and unowned manifest bodies without state writes', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'opl-first-party-source-collision-'));
  const stateDir = path.join(root, 'opl-state');
  const homeDir = path.join(root, 'home');
  const registryPath = path.join(root, 'malicious-catalog.json');
  const manifestPath = path.join(root, 'mas-manifest.json');
  const registryUrl = pathToFileURL(registryPath).href;
  const manifestUrl = pathToFileURL(manifestPath).href;
  const env = {
    HOME: homeDir,
    CODEX_HOME: path.join(homeDir, '.codex'),
    OPL_STATE_DIR: stateDir,
  };
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
  try {
    fs.writeFileSync(registryPath, formatJsonPayload({
      surface_kind: 'opl_package_catalog.v1',
      packages: { package_catalog: collisionEntries },
    }));
    fs.writeFileSync(manifestPath, formatJsonPayload(agentPackageManifest({
      packageId: 'mas',
      agentId: 'mas',
      pluginId: 'attacker-mas',
    })));

    const registryInstall = runCliFailure([
      'packages', 'install', '--registry-url', registryUrl, '--package-id', 'mas',
    ], env);
    assert.equal(
      registryInstall.payload.error.details.failure_code,
      'first_party_package_explicit_source_forbidden',
    );
    assert.match(registryInstall.payload.error.message, /per-Package owner OCI latest-stable channel/);
    assert.doesNotMatch(registryInstall.payload.error.message, /Release Set/);

    const masOwner = resolveFirstPartyPackageCatalog('mas');
    assert.ok(masOwner);
    assert.throws(
      () => assertFirstPartyPackageUpdateSelection(
        { packageId: 'mas', registryUrl },
        masOwner,
        {
          package_id: 'mas',
          module_id: 'medautoscience',
          desired_source_kind: 'first_party_managed_cohort',
          effective_install_update_source: 'package_channel',
          configured_by: 'package_distribution',
          reason: 'package_distribution',
          developer_checkout_path: null,
          developer_checkout_available: false,
          package_channel_auto_update: true,
        },
      ),
      (error: any) => {
        assert.equal(error?.details?.failure_code, 'first_party_package_explicit_source_forbidden');
        assert.match(error.message, /per-Package owner OCI latest-stable channel/);
        assert.doesNotMatch(error.message, /Release Set/);
        return true;
      },
    );

    const registryAction = runCliFailure([
      'app', 'action', 'execute',
      '--action', 'install_from_manifest_url',
      '--payload', JSON.stringify({ registry_url: registryUrl, package_id: 'oma' }),
    ], env);
    assert.equal(
      registryAction.payload.error.details.failure_code,
      'first_party_package_explicit_source_forbidden',
    );
    assert.match(registryAction.payload.error.message, /per-Package owner OCI latest-stable channel/);
    assert.doesNotMatch(registryAction.payload.error.message, /Release Set/);

    const manifestAction = runCliFailure([
      'app', 'action', 'execute',
      '--action', 'install_from_manifest_url',
      '--payload', JSON.stringify({ manifest_url: manifestUrl, trust_tier: 'first_party' }),
    ], env);
    assert.equal(
      manifestAction.payload.error.details.failure_code,
      'first_party_package_external_manifest_forbidden',
    );
    assert.match(manifestAction.payload.error.message, /per-Package owner OCI latest-stable channel/);
    assert.doesNotMatch(manifestAction.payload.error.message, /Release Set/);
    for (const fileName of [
      'agent-package-locks.json',
      'agent-package-lifecycle-ledger.json',
      'agent-package-registry-cache.json',
    ]) {
      assert.equal(fs.existsSync(path.join(stateDir, fileName)), false, `${fileName} must not be written`);
    }
    assert.equal(fs.existsSync(path.join(homeDir, '.codex')), false);
  } finally {
    removeFixtureTree(root);
  }
});

test('first-party install and update read one owner channel without shared-manifest currentness', () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opl-first-party-catalog-state-'));
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opl-first-party-catalog-home-'));
  const codex = createFakeCodexPluginManagerFixture(path.join(stateDir, 'fake-codex'));
  const first = writeFirstPartyCatalogFixture('0.2.0', '1'.repeat(40));
  const second = writeFirstPartyCatalogFixture('0.2.1', '2'.repeat(40));
  const commonEnv = {
    HOME: homeDir,
    CODEX_HOME: path.join(homeDir, '.codex'),
    OPL_STATE_DIR: stateDir,
    OPL_CODEX_PLUGIN_BIN: codex.codexPath,
    OPL_CLI_TEST_TIMEOUT_MS: '90000',
  };
  try {
    const installedAction = runCli([
      'app', 'action', 'execute',
      '--action', 'install_from_manifest_url',
      '--payload', JSON.stringify({ package_id: 'opl-flow' }),
    ], {
      ...first.env,
      ...commonEnv,
    }) as any;
    assert.equal(
      installedAction.app_action_execution.delegated_surface,
      'opl packages install --manifest-url <manifest_url>',
    );
    const installed = installedAction.app_action_execution.result;
    const installedSurface = installed.opl_agent_package_install;
    assert.equal(installedSurface.status, 'installed');
    assert.equal(installedSurface.package_id, 'opl-flow');
    assert.equal(installedSurface.configured_carrier.installed_version, '0.2.0');
    assert.equal(installedSurface.configured_carrier.executor.status, 'callable');
    assert.equal(installedSurface.configured_carrier.plugin_source_path, first.sourceRoot);
    const firstOwnerReads = fs.readFileSync(first.curlLogPath, 'utf8')
      .split('\n')
      .filter((line) => line.includes('/one-person-lab-packages/opl-flow/manifests/latest-stable'));
    assert.equal(firstOwnerReads.length, 1);
    assert.equal(
      fs.readFileSync(first.curlLogPath, 'utf8').includes('/one-person-lab-manifest/'),
      false,
    );

    const updated = runCli(['packages', 'update', 'opl-flow'], {
      ...second.env,
      ...commonEnv,
    }) as any;
    const updatedSurface = updated.opl_agent_package_update;
    assert.equal(updatedSurface.status, 'updated');
    assert.equal(updatedSurface.target_version, '0.2.1');
    assert.equal(updatedSurface.observed_version, '0.2.1');
    assert.equal(updatedSurface.currentness.status, 'update_available');
    assert.equal(updatedSurface.target_source_artifact_ref, second.sourceArtifactRef);
    assert.equal(updatedSurface.configured_carrier.plugin_source_path, second.sourceRoot);
    const secondOwnerReads = fs.readFileSync(second.curlLogPath, 'utf8')
      .split('\n')
      .filter((line) => line.includes('/one-person-lab-packages/opl-flow/manifests/latest-stable'));
    assert.equal(secondOwnerReads.length, 1);
    assert.equal(fs.readFileSync(second.curlLogPath, 'utf8').includes('/one-person-lab-manifest/'), false);
    for (const fileName of [
      'agent-package-locks.json',
      'agent-package-lifecycle-ledger.json',
      'agent-package-registry-cache.json',
    ]) {
      assert.equal(fs.existsSync(path.join(stateDir, fileName)), false, fileName);
    }
  } finally {
    removeFixtureTree(stateDir);
    fs.rmSync(homeDir, { recursive: true, force: true });
    fs.rmSync(first.root, { recursive: true, force: true });
    fs.rmSync(second.root, { recursive: true, force: true });
  }
});

test('descriptor-owned Flow update adopts the exact live owner target and becomes a current no-op', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'opl-flow-descriptor-adoption-'));
  const stateDir = path.join(root, 'state');
  const homeDir = path.join(root, 'home');
  const codexHome = path.join(homeDir, '.codex');
  const codex = createFakeCodexPluginManagerFixture(path.join(root, 'fake-codex'));
  const currentOwner = writeFirstPartyCatalogFixture('0.1.31', '1'.repeat(40), {
    requiredSkillIds: FLOW_SKILL_IDS,
  });
  const nextOwner = writeFirstPartyCatalogFixture('0.1.32', '2'.repeat(40), {
    requiredSkillIds: FLOW_SKILL_IDS,
  });
  const carrier = writeDescriptorOwnedFlowCarrier({ root, version: '0.1.31' });
  const commonEnv = {
    HOME: homeDir,
    CODEX_HOME: codexHome,
    OPL_STATE_DIR: stateDir,
    OPL_CODEX_PLUGIN_BIN: codex.codexPath,
    OPL_CLI_TEST_TIMEOUT_MS: '90000',
  };
  try {
    seedDescriptorOwnedFlowCarrier({ codexPath: codex.codexPath, carrier, env: commonEnv });

    const adopted = runCli(['packages', 'update', 'opl-flow'], {
      ...currentOwner.env,
      ...commonEnv,
    }) as any;
    const adoptedSurface = adopted.opl_agent_package_update;
    assert.equal(adoptedSurface.status, 'updated');
    assert.equal(adoptedSurface.currentness.status, 'update_available');
    assert.ok(adoptedSurface.currentness.reasons.includes('configured_carrier_route_changed'));
    assert.equal(adoptedSurface.configured_carrier.plugin_source_path, currentOwner.sourceRoot);

    const current = runCli(['packages', 'update', 'opl-flow'], {
      ...currentOwner.env,
      ...commonEnv,
    }) as any;
    const currentSurface = current.opl_agent_package_update;
    assert.equal(currentSurface.status, 'current_noop');
    assert.equal(currentSurface.currentness.status, 'current');
    assert.equal(currentSurface.target_version, '0.1.31');
    assert.equal(currentSurface.observed_version, '0.1.31');
    assert.equal(fs.existsSync(path.join(stateDir, 'agent-package-locks.json')), false);

    const repaired = runCli(['packages', 'repair', '--package-id', 'opl-flow'], {
      ...currentOwner.env,
      ...commonEnv,
    }) as any;
    const repairedSurface = repaired.opl_agent_package_repair;
    assert.equal(repairedSurface.status, 'repaired');
    assert.equal(repairedSurface.currentness.status, 'current');
    assert.equal(repairedSurface.target_version, '0.1.31');
    assert.equal(repairedSurface.observed_version, '0.1.31');
    assert.equal(fs.existsSync(path.join(stateDir, 'agent-package-locks.json')), false);

    const updated = runCli(['packages', 'update', 'opl-flow'], {
      ...nextOwner.env,
      ...commonEnv,
    }) as any;
    const updatedSurface = updated.opl_agent_package_update;
    assert.equal(updatedSurface.status, 'updated');
    assert.equal(updatedSurface.currentness.status, 'update_available');
    assert.ok(updatedSurface.currentness.reasons.includes('package_version_changed'));
    assert.equal(updatedSurface.target_version, '0.1.32');
    assert.equal(updatedSurface.configured_carrier.installed_version, '0.1.32');
    assert.equal(updatedSurface.configured_carrier.plugin_source_path, nextOwner.sourceRoot);
    assert.equal(updatedSurface.target_source_artifact_ref, nextOwner.sourceArtifactRef);
    assert.equal(fs.existsSync(path.join(stateDir, 'agent-package-locks.json')), false);

    const status = runCli(['packages', 'status', '--package-id', 'opl-flow'], commonEnv) as any;
    assert.equal(status.opl_agent_package_status.installed_package_count, 1);
    assert.equal(status.opl_agent_package_status.installed_packages.length, 0);
    assert.equal(status.opl_agent_package_status.configured_carrier.installed_version, '0.1.32');
  } finally {
    removeFixtureTree(root);
    fs.rmSync(currentOwner.root, { recursive: true, force: true });
    fs.rmSync(nextOwner.root, { recursive: true, force: true });
  }
});

test('descriptor-owned Flow accepts only the exact content-qualified carrier generation and source path', () => {
  function runCase(input: {
    versionSuffix: 'matching' | 'missing' | string;
    wrongSourcePath?: boolean;
    expectSuccess: boolean;
  }) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'opl-flow-content-qualified-carrier-'));
    const stateDir = path.join(root, 'state');
    const homeDir = path.join(root, 'home');
    const codex = createFakeCodexPluginManagerFixture(path.join(root, 'fake-codex'));
    const overrideCodex = writeCarrierReadbackOverrideWrapper(root, codex.codexPath);
    const nextOwner = writeFirstPartyCatalogFixture('0.1.32', '2'.repeat(40), {
      requiredSkillIds: FLOW_SKILL_IDS,
    });
    const carrier = writeDescriptorOwnedFlowCarrier({ root, version: '0.1.31' });
    const baseEnv = {
      HOME: homeDir,
      CODEX_HOME: path.join(homeDir, '.codex'),
      OPL_STATE_DIR: stateDir,
      OPL_CODEX_PLUGIN_BIN: overrideCodex,
      OPL_CLI_TEST_TIMEOUT_MS: '90000',
      FIXTURE_CARRIER_SOURCE_CONTAINS: nextOwner.sourceRoot,
    };
    try {
      seedDescriptorOwnedFlowCarrier({ codexPath: codex.codexPath, carrier, env: baseEnv });
      const expectedGeneration = computePackageChannelTreeSha256(nextOwner.sourceRoot);
      const expectedContentQualifiedVersion = `0.1.32-${expectedGeneration}`;
      const observedGeneration = input.versionSuffix === 'matching'
        ? expectedGeneration
        : input.versionSuffix;
      const overrideSourcePath = input.wrongSourcePath
        ? path.join(root, 'wrong-carrier-source')
        : null;
      if (overrideSourcePath) {
        fs.cpSync(nextOwner.sourceRoot, overrideSourcePath, { recursive: true });
        fs.writeFileSync(path.join(overrideSourcePath, 'wrong-source-marker.txt'), 'wrong\n');
      }
      const commonEnv = {
        ...baseEnv,
        ...(input.versionSuffix === 'missing'
          ? { FIXTURE_CARRIER_CLEAR_VERSION: '1' }
          : { FIXTURE_CARRIER_VERSION: `0.1.32-${observedGeneration}` }),
        ...(overrideSourcePath ? { FIXTURE_CARRIER_SOURCE_PATH: overrideSourcePath } : {}),
      };
      if (input.expectSuccess) {
        const updated = runCli(['packages', 'update', 'opl-flow'], {
          ...nextOwner.env,
          ...commonEnv,
        }) as any;
        assert.equal(updated.opl_agent_package_update.status, 'updated');
        assert.equal(
          updated.opl_agent_package_update.configured_carrier.installed_version,
          expectedContentQualifiedVersion,
        );
        assert.equal(updated.opl_agent_package_update.configured_carrier.executor.status, 'callable');
        const pluginRoot = updated.opl_agent_package_update.configured_carrier.plugin_source_path;
        assert.equal(pluginRoot, nextOwner.sourceRoot);
        for (const skillId of FLOW_SKILL_IDS) {
          assert.equal(
            fs.existsSync(path.join(pluginRoot, 'skills', skillId, 'SKILL.md')),
            true,
            skillId,
          );
        }
        return;
      }
      const failure = runCliFailure(['packages', 'update', 'opl-flow'], {
        ...nextOwner.env,
        ...commonEnv,
      });
      assert.equal(
        failure.payload.error.details.failure_code,
        'configured_codex_plugin_carrier_target_currentness_mismatch',
      );
      assert.equal(failure.payload.error.details.target_version, '0.1.32');
      assert.equal(fs.existsSync(path.join(stateDir, 'agent-package-locks.json')), false);
    } finally {
      removeFixtureTree(root);
      fs.rmSync(nextOwner.root, { recursive: true, force: true });
    }
  }

  runCase({ versionSuffix: 'matching', expectSuccess: true });
  runCase({ versionSuffix: 'missing', expectSuccess: false });
  runCase({ versionSuffix: 'f'.repeat(64), expectSuccess: false });
  runCase({
    versionSuffix: 'matching',
    wrongSourcePath: true,
    expectSuccess: false,
  });
});

test('descriptor-owned Flow update rejects a successful native no-op and preserves the previous carrier', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'opl-flow-descriptor-noop-'));
  const stateDir = path.join(root, 'state');
  const homeDir = path.join(root, 'home');
  const codex = createFakeCodexPluginManagerFixture(path.join(root, 'fake-codex'));
  const noopCodex = writeNoopPluginAddWrapper(root, codex.codexPath);
  const nextOwner = writeFirstPartyCatalogFixture('0.1.32', '2'.repeat(40), {
    requiredSkillIds: FLOW_SKILL_IDS,
  });
  const carrier = writeDescriptorOwnedFlowCarrier({ root, version: '0.1.31' });
  const commonEnv = {
    HOME: homeDir,
    CODEX_HOME: path.join(homeDir, '.codex'),
    OPL_STATE_DIR: stateDir,
    OPL_CODEX_PLUGIN_BIN: noopCodex,
    OPL_CLI_TEST_TIMEOUT_MS: '90000',
    FIXTURE_PLUGIN_ADD_NOOP: '1',
  };
  try {
    seedDescriptorOwnedFlowCarrier({ codexPath: codex.codexPath, carrier, env: commonEnv });
    for (const args of [
      ['packages', 'update', 'opl-flow'],
      ['packages', 'repair', '--package-id', 'opl-flow'],
    ]) {
      const failure = runCliFailure(args, {
        ...nextOwner.env,
        ...commonEnv,
      });
      assert.equal(
        failure.payload.error.details.failure_code,
        'configured_codex_plugin_carrier_target_currentness_mismatch',
      );
      assert.equal(failure.payload.error.details.target_version, '0.1.32');
      assert.equal(failure.payload.error.details.observed_version, '0.1.31');
      assert.equal(fs.existsSync(path.join(stateDir, 'agent-package-locks.json')), false);
      const pluginList = JSON.parse(execFileSync(codex.codexPath, ['plugin', 'list', '--json'], {
        env: { ...process.env, ...commonEnv },
        encoding: 'utf8',
      }));
      assert.equal(pluginList.installed.length, 1);
      assert.equal(pluginList.installed[0].version, '0.1.31');
    }
  } finally {
    removeFixtureTree(root);
    fs.rmSync(nextOwner.root, { recursive: true, force: true });
  }
});

test('identity-drifted bundled OMA reconciles only through its owner package channel', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'opl-first-party-oma-bundled-reconcile-'));
  const stateDir = path.join(root, 'state');
  const homeDir = path.join(root, 'home');
  const modulesRoot = path.join(root, 'modules');
  const workspace = path.join(root, 'workspace');
  const initial = writeOmaOwnerReleaseFixture({
    root: path.join(root, 'initial'),
    generation: 'initial',
  });
  const incomplete = writeOmaOwnerReleaseFixture({
    root: path.join(root, 'incomplete'),
    generation: 'incomplete',
    completeRuntime: false,
  });
  const next = writeOmaOwnerReleaseFixture({
    root: path.join(root, 'next'),
    generation: 'next',
  });
  const lockPath = path.join(stateDir, 'agent-package-locks.json');
  const lifecycleSqlitePath = path.join(stateDir, 'agent-package-lifecycle.sqlite');
  const transactionRoot = path.join(stateDir, 'agent-package-runtime-transactions');
  const commonEnv = {
    HOME: homeDir,
    CODEX_HOME: path.join(homeDir, '.codex'),
    OPL_STATE_DIR: stateDir,
    OPL_MODULES_ROOT: modulesRoot,
    OPL_MODULE_SOURCE_MODE: 'package_channel',
  };
  const fileDigest = (filePath: string) => fs.existsSync(filePath)
    ? crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex')
    : null;
  const transactionResidue = () => fs.existsSync(transactionRoot)
    ? fs.readdirSync(transactionRoot)
    : [];

  try {
    fs.mkdirSync(workspace, { recursive: true });
    const installed = runCli(['packages', 'install', 'oma'], {
      ...commonEnv,
      ...initial.releaseSet.env,
      ...initial.ownerChannel.env,
    }) as any;
    const installedLock = installed.opl_agent_package_install.package_lock;
    const bundledRuntimeRoot = installedLock.managed_runtime_source.checkout_path;
    const pluginRoot = installedLock.physical_surface.codex_plugin_cache_path;
    fs.chmodSync(bundledRuntimeRoot, 0o755);
    fs.writeFileSync(path.join(bundledRuntimeRoot, 'opl-runtime-module.json'), formatJsonPayload({
      marker_version: 1,
      module_id: 'oplmetaagent',
      repo_name: 'opl-meta-agent',
      packaged_runtime: true,
      package_channel: false,
      source_git: { head_sha: installedLock.managed_runtime_source.source_git_head_sha },
    }));
    const legacyIndex = parseJsonText(fs.readFileSync(lockPath, 'utf8')) as any;
    const legacyLock = legacyIndex.packages.find((entry: any) => entry.package_id === 'oma');
    legacyLock.source_kind = 'bundled_full_runtime_modules';
    Object.assign(legacyLock.managed_runtime_source, {
      ownership: 'preexisting_adopted',
      source_mode: 'bundled_full_runtime',
      channel_version: null,
      artifact_ref: null,
      layer_digest: null,
      source_archive_sha256: null,
      tree_sha256: computePackageChannelTreeSha256(bundledRuntimeRoot),
      rollback_ref: null,
      preparation_status: 'validated_no_write',
      bootstrap_command: null,
      package_prepare_command: null,
      preparation_root: null,
      preparation_scope: 'preexisting_read_only_probe',
    });
    fs.writeFileSync(lockPath, formatJsonPayload(legacyIndex));

    const initialReads = fs.readFileSync(initial.ownerChannel.curlLogPath, 'utf8');
    const current = runCli(['packages', 'update', 'oma'], {
      ...commonEnv,
      ...initial.releaseSet.env,
      ...initial.ownerChannel.env,
      OPL_MODULE_PATH_OPLMETAAGENT: bundledRuntimeRoot,
    }) as any;
    assert.equal(current.opl_agent_package_update.status, 'current_noop');
    assert.equal(fs.readFileSync(initial.ownerChannel.curlLogPath, 'utf8'), initialReads);

    fs.writeFileSync(path.join(bundledRuntimeRoot, 'unrecorded-owner-write.txt'), 'drift\n');
    const stateSnapshot = () => ({
      lock: fileDigest(lockPath),
      sqlite: fileDigest(lifecycleSqlitePath),
      sqliteWal: fileDigest(`${lifecycleSqlitePath}-wal`),
      sqliteShm: fileDigest(`${lifecycleSqlitePath}-shm`),
      runtimeTree: computePackageChannelTreeSha256(bundledRuntimeRoot),
      pluginTree: computePackageChannelTreeSha256(pluginRoot),
    });
    const legacySnapshot = stateSnapshot();

    const preview = runCli(['packages', 'update', 'oma', '--dry-run'], {
      ...commonEnv,
      ...next.releaseSet.env,
      ...next.ownerChannel.env,
    }) as any;
    assert.equal(preview.opl_agent_package_update.status, 'validated_no_write');
    assert.equal(preview.opl_agent_package_update.reconciliation_action, 'source_reconcile');
    assert.equal(preview.opl_agent_package_update.package_lock.source_kind, 'first_party_managed_cohort');
    assert.deepEqual(stateSnapshot(), legacySnapshot);
    assert.deepEqual(transactionResidue(), []);

    const ownerManifestLayer = path.join(root, 'next', 'owner-channel-blobs', 'oma-manifest.json');
    const ownerManifestLayerBytes = fs.readFileSync(ownerManifestLayer);
    fs.rmSync(ownerManifestLayer);
    const downloadFailure = runCliFailure(['packages', 'update', 'oma'], {
      ...commonEnv,
      ...next.releaseSet.env,
      ...next.ownerChannel.env,
    });
    fs.writeFileSync(ownerManifestLayer, ownerManifestLayerBytes);
    assert.ok(downloadFailure.payload.error);
    assert.deepEqual(stateSnapshot(), legacySnapshot);
    assert.deepEqual(transactionResidue(), []);

    const prepareFailure = runCliFailure(['packages', 'update', 'oma'], {
      ...commonEnv,
      ...incomplete.releaseSet.env,
      ...incomplete.ownerChannel.env,
    });
    assert.equal(
      prepareFailure.payload.error.details.failure_code,
      'agent_package_runtime_source_preparation_failed',
    );
    assert.deepEqual(stateSnapshot(), legacySnapshot);
    assert.deepEqual(transactionResidue(), []);

    const applyFailure = runCliFailure([
      'packages', 'update', 'oma',
      '--scope', 'workspace', '--target-workspace', workspace,
    ], {
      ...commonEnv,
      ...next.releaseSet.env,
      ...next.ownerChannel.env,
      OPL_TEST_RUNTIME_SOURCE_FAULTS_ENABLED: '1',
      OPL_TEST_CAPABILITY_RECONCILIATION_FAIL_AFTER_SCOPE: '1',
    });
    assert.equal(
      applyFailure.payload.error.details.failure_code,
      'test_capability_reconciliation_interrupted',
    );
    assert.deepEqual(stateSnapshot(), legacySnapshot);
    assert.deepEqual(transactionResidue(), []);

    const updated = runCli(['packages', 'update', 'oma'], {
      ...commonEnv,
      ...next.releaseSet.env,
      ...next.ownerChannel.env,
    }) as any;
    const updatedLock = updated.opl_agent_package_update.package_lock;
    assert.equal(updated.opl_agent_package_update.status, 'updated');
    assert.equal(updated.opl_agent_package_update.reconciliation_action, 'source_reconcile');
    assert.equal(updatedLock.source_kind, 'first_party_managed_cohort');
    assert.equal(
      updatedLock.release_channel_ref,
      'ghcr.io/fixture/one-person-lab-packages/oma:latest-stable',
    );
    assert.equal(updatedLock.managed_runtime_source.source_mode, 'package_channel');
    assert.notEqual(updatedLock.managed_runtime_source.checkout_path, bundledRuntimeRoot);
    assert.equal(fs.readFileSync(
      path.join(bundledRuntimeRoot, 'unrecorded-owner-write.txt'),
      'utf8',
    ), 'drift\n');
    assert.deepEqual(transactionResidue(), []);

    const networkReads = [
      next.ownerChannel.curlLogPath,
      incomplete.ownerChannel.curlLogPath,
    ].flatMap((logPath) => fs.existsSync(logPath)
      ? fs.readFileSync(logPath, 'utf8').trim().split('\n').filter(Boolean)
      : []);
    assert.equal(networkReads.some((line) => line.includes('/one-person-lab-manifest/')), false);
    for (const packageId of ['mas', 'mag', 'rca', 'obf', 'opl-flow', 'mas-scholar-skills']) {
      assert.equal(
        networkReads.some((line) => line.includes(`/one-person-lab-packages/${packageId}/`)),
        false,
      );
    }
    assert.equal(
      networkReads.some((line) => line.includes('/one-person-lab-packages/oma/manifests/latest-stable')),
      true,
    );
  } finally {
    removeFixtureTree(root);
  }
});

test('an installed first-party descriptor cannot mask a new manifest missing carrier authority', () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opl-first-party-carrier-state-'));
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opl-first-party-carrier-home-'));
  const codex = createFakeCodexPluginManagerFixture(path.join(stateDir, 'fake-codex'));
  const first = writeFirstPartyCatalogFixture('0.2.0', '1'.repeat(40));
  const missing = writeFirstPartyCatalogFixture('0.2.1', '2'.repeat(40), {
    configuredCarrier: false,
  });
  const commonEnv = {
    HOME: homeDir,
    CODEX_HOME: path.join(homeDir, '.codex'),
    OPL_STATE_DIR: stateDir,
    OPL_CODEX_PLUGIN_BIN: codex.codexPath,
  };
  try {
    const installed = runCli(['packages', 'install', 'opl-flow'], { ...first.env, ...commonEnv }) as any;
    assert.equal(installed.opl_agent_package_install.configured_carrier.installed_version, '0.2.0');
    assert.equal(installed.opl_agent_package_install.configured_carrier.plugin_source_path, first.sourceRoot);
    const failure = runCliFailure(['packages', 'update', 'opl-flow'], { ...missing.env, ...commonEnv });
    assert.equal(failure.payload.error.code, 'contract_shape_invalid');
    assert.equal(
      failure.payload.error.details.failure_code,
      'configured_codex_plugin_carrier_owner_authority_missing',
    );
    const retained = runCli(['packages', 'status', '--package-id', 'opl-flow'], commonEnv) as any;
    assert.equal(retained.opl_agent_package_status.installed_package_count, 1);
    assert.equal(retained.opl_agent_package_status.installed_packages.length, 0);
    assert.equal(retained.opl_agent_package_status.configured_carrier.installed_version, '0.2.0');
    assert.equal(retained.opl_agent_package_status.configured_carrier.plugin_source_path, first.sourceRoot);
    assert.equal(fs.existsSync(path.join(stateDir, 'agent-package-locks.json')), false);
  } finally {
    removeFixtureTree(stateDir);
    fs.rmSync(homeDir, { recursive: true, force: true });
    fs.rmSync(first.root, { recursive: true, force: true });
    fs.rmSync(missing.root, { recursive: true, force: true });
  }
});

test('first-party install rejects a catalog member without an immutable owner commit', () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opl-first-party-invalid-catalog-state-'));
  const fixture = writeFirstPartyCatalogFixture('0.2.0', 'not-an-owner-commit');
  try {
    const failure = runCliFailure(['packages', 'install', 'opl-flow'], {
      OPL_STATE_DIR: stateDir,
      ...fixture.env,
    });
    assert.equal(failure.payload.error.code, 'contract_shape_invalid');
    assert.equal(
      failure.payload.error.details.failure_code,
      'agent_package_manifest_carrier_source_commit_invalid',
    );
  } finally {
    removeFixtureTree(stateDir);
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('first-party activation uses the installed package without reading an invalid next catalog member', () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opl-first-party-activation-state-'));
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opl-first-party-activation-home-'));
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'opl-first-party-activation-workspace-'));
  const codex = createFakeCodexPluginManagerFixture(path.join(stateDir, 'fake-codex'));
  const installedFixture = writeFirstPartyCatalogFixture('0.2.0', '1'.repeat(40));
  const invalidFixture = writeFirstPartyCatalogFixture('0.2.1', 'not-an-owner-commit');
  const commonEnv = {
    HOME: homeDir,
    CODEX_HOME: path.join(homeDir, '.codex'),
    OPL_STATE_DIR: stateDir,
    OPL_CODEX_PLUGIN_BIN: codex.codexPath,
  };
  try {
    const installed = runCli(['packages', 'install', 'opl-flow'], {
      ...installedFixture.env,
      ...commonEnv,
    }) as any;
    assert.equal(installed.opl_agent_package_install.configured_carrier.installed_version, '0.2.0');
    const pluginPath = path.join(installedFixture.sourceRoot, '.codex-plugin', 'plugin.json');
    const invalidCatalogReadsBefore = fs.existsSync(invalidFixture.curlLogPath)
      ? fs.readFileSync(invalidFixture.curlLogPath, 'utf8').trim()
      : '';

    const activation = runCli([
      'packages', 'activate', 'opl-flow',
      '--scope', 'workspace', '--target-workspace', workspace,
    ], {
      ...invalidFixture.env,
      ...commonEnv,
    }).opl_agent_package_activation;
    assert.equal(activation.status, 'already_activated');
    assert.equal(activation.operational_ready, true);
    assert.equal(activation.launch_allowed, true);
    assert.equal(activation.writes_performed, false);
    const invalidCatalogReadsAfter = fs.existsSync(invalidFixture.curlLogPath)
      ? fs.readFileSync(invalidFixture.curlLogPath, 'utf8').trim()
      : '';
    assert.equal(invalidCatalogReadsAfter, invalidCatalogReadsBefore);
    assert.equal(JSON.parse(fs.readFileSync(pluginPath, 'utf8')).version, '0.2.0');
  } finally {
    removeFixtureTree(stateDir);
    fs.rmSync(homeDir, { recursive: true, force: true });
    fs.rmSync(workspace, { recursive: true, force: true });
    fs.rmSync(installedFixture.root, { recursive: true, force: true });
    fs.rmSync(invalidFixture.root, { recursive: true, force: true });
  }
});

test('developer checkout policy stays explicit and is not a managed-update authority', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'opl-first-party-developer-currentness-'));
  const homeDir = path.join(root, 'home');
  const stateDir = path.join(root, 'state');
  const masCheckout = path.join(root, 'workspace', 'med-autoscience');
  const scholarCheckout = path.join(root, 'workspace', 'mas-scholar-skills');
  const wrongCheckout = path.join(root, 'workspace', 'wrong-med-autoscience');
  const oldProvider = writeCapabilityProvider(path.join(root, 'old-provider'), '0.1.0');
  const oldMas = writeMasConsumer(path.join(root, 'old-mas'), oldProvider, '0.1.0');
  const oldReleaseSet = writeCapabilityCatalog(path.join(root, 'old-release-set'), [oldMas, oldProvider]);
  const nextProvider = writeCapabilityProvider(path.join(root, 'next-provider'), '0.1.1');
  const nextMas = writeMasConsumer(path.join(root, 'next-mas'), nextProvider, '0.1.1');
  const nextReleaseSet = writeCapabilityCatalog(path.join(root, 'next-release-set'), [nextMas, nextProvider]);
  const fakeBin = path.join(root, 'bin');
  const commonEnv = {
    HOME: homeDir,
    CODEX_HOME: path.join(homeDir, '.codex'),
    OPL_STATE_DIR: stateDir,
    OPL_MODULE_PATH_MEDAUTOSCIENCE: masCheckout,
    OPL_MODULE_PATH_SCHOLARSKILLS: scholarCheckout,
    PATH: `${fakeBin}${path.delimiter}${process.env.PATH ?? ''}`,
    UV_TOOL_DIR: path.join(root, 'uv-tools'),
    OPL_CLI_TEST_TIMEOUT_MS: '120000',
  };
  fs.mkdirSync(masCheckout, { recursive: true });
  fs.mkdirSync(scholarCheckout, { recursive: true });
  fs.mkdirSync(wrongCheckout, { recursive: true });
  writeDeveloperCapabilityCheckoutClosure({
    masCheckout,
    scholarCheckout,
    masManifestPath: oldMas,
    providerManifestPath: oldProvider,
  });
  writeMasOwnerGateFixture(masCheckout, fakeBin);
  commitDeveloperCheckout(masCheckout, 'add owner gate fixture');
  const oldEnv = { ...commonEnv, ...withMasOwnerGateFixturePath(oldReleaseSet.env, fakeBin) };
  const nextEnv = { ...commonEnv, ...withMasOwnerGateFixturePath(nextReleaseSet.env, fakeBin) };

  try {
    const pathFailure = runCliFailure([
      'packages', 'install', 'mas',
      '--source-kind', 'developer_checkout_override',
      '--agent-root', wrongCheckout,
    ], oldEnv);
    assert.equal(pathFailure.payload.error.code, 'contract_shape_invalid');
    assert.equal(
      pathFailure.payload.error.details.failure_code,
      'first_party_package_developer_checkout_path_mismatch',
    );
    assert.equal(fs.existsSync(path.join(stateDir, 'agent-package-locks.json')), false);

    const installed = runCli(['packages', 'install', 'mas'], oldEnv) as any;
    assert.equal(installed.opl_agent_package_install.package_lock.package_version, '0.1.0');
    assert.equal(installed.opl_agent_package_install.package_lock.source_kind, 'developer_checkout_override');
    assert.deepEqual(
      installed.opl_agent_package_install.dependency_package_locks.map((lock: any) => [
        lock.package_id,
        lock.package_version,
        lock.source_kind,
      ]),
      [
        ['mas-scholar-skills', '0.1.0', 'developer_checkout_override'],
        ['mas', '0.1.0', 'developer_checkout_override'],
      ],
    );

    updateDeveloperCapabilityCheckoutClosure({
      masCheckout,
      scholarCheckout,
      masManifestPath: nextMas,
      providerManifestPath: nextProvider,
      message: 'fixture B',
    });

    const releaseCatalogCache = path.join(stateDir, 'agent-package-release-catalog-cache.json');
    const cachedOldReleaseSet = formatJsonPayload({
      surface_kind: 'opl_agent_package_release_catalog_cache.v1',
      catalog_ref: 'ghcr.io/fixture/one-person-lab-manifest:fixture',
      catalog_digest: `sha256:${'9'.repeat(64)}`,
      checked_at: new Date().toISOString(),
      catalog_payload: JSON.parse(fs.readFileSync(oldReleaseSet.catalogPath, 'utf8')),
    });
    fs.writeFileSync(releaseCatalogCache, cachedOldReleaseSet);
    const legacyLockPath = path.join(stateDir, 'agent-package-locks.json');
    const legacyLockBytes = fs.readFileSync(legacyLockPath, 'utf8');
    const preview = runCli(['packages', 'update', '--dry-run'], nextEnv) as any;
    const previewPackages = preview.managed_update.components.find(
      (entry: any) => entry.component_id === 'opl_packages',
    );
    assert.equal(previewPackages.current.projection_source, 'native_module_directory');
    assert.equal(Object.hasOwn(previewPackages.current, 'package_lock_states'), false);
    assert.equal(previewPackages.state, 'skipped_manual_required');
    assert.equal(previewPackages.plan.action, 'manual_review');
    assert.equal(previewPackages.auto_apply.eligible, false);
    assert.equal(previewPackages.auto_apply.command_ref, null);
    assert.equal(fs.readFileSync(releaseCatalogCache, 'utf8'), cachedOldReleaseSet);

    const updated = runCli(['update', 'apply'], nextEnv) as any;
    const adapter = updated.managed_update.execution.adapter_results.find(
      (entry: any) => entry.component_id === 'opl_packages',
    );
    assert.equal(adapter, undefined);
    assert.equal(fs.readFileSync(legacyLockPath, 'utf8'), legacyLockBytes);

    const lockIndex = parseJsonText(fs.readFileSync(legacyLockPath, 'utf8')) as any;
    assert.deepEqual(
      lockIndex.packages
        .map((lock: any) => [lock.package_id, lock.package_version, lock.source_kind])
        .sort((left: string[], right: string[]) => left[0].localeCompare(right[0])),
      [
        ['mas', '0.1.0', 'developer_checkout_override'],
        ['mas-scholar-skills', '0.1.0', 'developer_checkout_override'],
      ],
    );
  } finally {
    removeFixtureTree(root);
  }
});

test('fresh Developer install admits owner checkout manifests without channel payload or content lock', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'opl-first-party-developer-direct-admission-'));
  const homeDir = path.join(root, 'home');
  const stateDir = path.join(root, 'state');
  const workspace = path.join(root, 'workspace');
  const masCheckout = path.join(root, 'workspace', 'med-autoscience');
  const scholarCheckout = path.join(root, 'workspace', 'mas-scholar-skills');
  const providerManifest = writeCapabilityProvider(path.join(root, 'provider'), '0.1.0');
  const providerPayload = JSON.parse(fs.readFileSync(providerManifest, 'utf8'));
  delete providerPayload.content_lock;
  fs.writeFileSync(providerManifest, formatJsonPayload(providerPayload));
  const masManifest = writeMasConsumer(path.join(root, 'mas'), providerManifest, '0.1.0');
  const fakeBin = path.join(root, 'bin');
  const commonEnv = {
    HOME: homeDir,
    CODEX_HOME: path.join(homeDir, '.codex'),
    OPL_STATE_DIR: stateDir,
    OPL_MODULE_PATH_MEDAUTOSCIENCE: masCheckout,
    OPL_MODULE_PATH_SCHOLARSKILLS: scholarCheckout,
    PATH: `${fakeBin}${path.delimiter}${process.env.PATH ?? ''}`,
    UV_TOOL_DIR: path.join(root, 'uv-tools'),
  };
  fs.mkdirSync(masCheckout, { recursive: true });
  fs.mkdirSync(scholarCheckout, { recursive: true });
  fs.mkdirSync(workspace, { recursive: true });
  writeDeveloperCapabilityCheckoutClosure({
    masCheckout,
    scholarCheckout,
    masManifestPath: masManifest,
    providerManifestPath: providerManifest,
  });
  writeMasOwnerGateFixture(masCheckout, fakeBin);
  commitDeveloperCheckout(masCheckout, 'add owner gate fixture');

  try {
    const installed = runCli(['packages', 'install', 'mas'], commonEnv) as any;
    assert.equal(installed.opl_agent_package_install.status, 'installed');
    assert.deepEqual(
      installed.opl_agent_package_install.dependency_package_locks.map(
        (lock: any) => [lock.package_id, lock.source_kind],
      ),
      [
        ['mas-scholar-skills', 'developer_checkout_override'],
        ['mas', 'developer_checkout_override'],
      ],
    );
    assert.equal(
      installed.opl_agent_package_install.dependency_package_locks.every(
        (lock: any) => lock.release_channel_ref === null && lock.artifact_digest === null,
      ),
      true,
    );
    assert.equal(
      fs.existsSync(path.join(stateDir, 'agent-package-release-catalog-cache.json')),
      false,
    );

    const status = runCli(['packages', 'status', '--package-id', 'mas'], commonEnv) as any;
    assert.equal(status.opl_agent_package_status.operational_ready, true);
    assert.equal(status.opl_agent_package_status.launch_allowed, true);
    runCli(['workspace', 'bind', '--project', 'medautoscience', '--path', workspace], commonEnv);
    const activation = runCli([
      'packages', 'activate', 'mas',
      '--scope', 'workspace', '--target-workspace', workspace,
    ], commonEnv) as any;
    assert.equal(activation.opl_agent_package_activation.package_lock.source_kind, 'developer_checkout_override');
    assert.equal(activation.opl_agent_package_activation.package_use_binding.root_package.package_id, 'mas');
  } finally {
    removeFixtureTree(root);
  }
});

test('bad optional inline catalog entry stays diagnostic and does not block consumer install use or launch', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'opl-first-party-optional-inline-diagnostic-'));
  const homeDir = path.join(root, 'home');
  const stateDir = path.join(root, 'state');
  const workspace = path.join(root, 'workspace');
  const fakeBin = path.join(root, 'bin');
  const providerManifest = writeCapabilityProvider(path.join(root, 'provider'), '0.1.0');
  const masManifest = writeMasConsumer(path.join(root, 'mas'), providerManifest, '0.1.0', {
    required: false,
    dependencyKind: 'optional_enhancement',
  });
  const releaseSet = writeCapabilityCatalog(
    path.join(root, 'release-set'),
    [masManifest, providerManifest],
    { corruptInlineManifestPackageId: 'mas-scholar-skills' },
  );
  writeMasOwnerGateFixture(path.dirname(masManifest), fakeBin);
  const ownerChannel = writePackageOwnerChannelFixture({
    root,
    binRoot: fakeBin,
    catalogPath: releaseSet.catalogPath,
    packageIds: ['mas'],
  });
  const commonEnv = {
    HOME: homeDir,
    CODEX_HOME: path.join(homeDir, '.codex'),
    OPL_STATE_DIR: stateDir,
    ...releaseSet.env,
    ...ownerChannel.env,
  };
  fs.mkdirSync(workspace, { recursive: true });

  try {
    const installed = runCli(['packages', 'install', 'mas'], commonEnv) as any;
    assert.equal(installed.opl_agent_package_install.status, 'installed');
    assert.deepEqual(
      installed.opl_agent_package_install.dependency_package_locks.map(
        (lock: any) => lock.package_id,
      ),
      ['mas'],
    );
    assert.deepEqual(installed.opl_agent_package_install.package_lock.resolved_dependencies, []);

    const status = runCli(['packages', 'status', '--package-id', 'mas'], commonEnv) as any;
    const readiness = status.opl_agent_package_status.package_dependency_readiness;
    assert.equal(readiness.status, 'missing');
    assert.equal(readiness.operational_ready, true);
    assert.deepEqual(readiness.dependencies[0].reasons, [
      'dependency_lock_missing',
    ]);
    assert.equal(status.opl_agent_package_status.operational_ready, true);
    assert.equal(status.opl_agent_package_status.launch_allowed, true);
    const networkReads = fs.readFileSync(ownerChannel.curlLogPath, 'utf8');
    assert.equal(
      networkReads.includes('/one-person-lab-packages/mas/manifests/latest-stable'),
      true,
    );
    assert.equal(networkReads.includes('/one-person-lab-packages/mas-scholar-skills/'), false);
    assert.equal(networkReads.includes('/one-person-lab-manifest/'), false);

    runCli(['workspace', 'bind', '--project', 'medautoscience', '--path', workspace], commonEnv);
    const activation = runCli([
      'packages', 'activate', 'mas',
      '--scope', 'workspace', '--target-workspace', workspace,
    ], commonEnv) as any;
    assert.equal(activation.opl_agent_package_activation.launch_state, 'degraded');
    assert.equal(
      activation.opl_agent_package_activation.launch_state_reason,
      'optional_dependency_missing',
    );
    assert.deepEqual(
      activation.opl_agent_package_activation.package_use_binding.provider_packages,
      [],
    );
  } finally {
    removeFixtureTree(root);
  }
});

test('MAS owner refresh reads only MAS and required ScholarSkills owner channels', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'opl-first-party-required-owner-closure-'));
  const homeDir = path.join(root, 'home');
  const stateDir = path.join(root, 'state');
  const fakeBin = path.join(root, 'bin');
  const providerManifest = writeCapabilityProvider(path.join(root, 'provider'), '0.1.0');
  const masManifest = writeMasConsumer(path.join(root, 'mas'), providerManifest, '0.1.0');
  const releaseSet = writeCapabilityCatalog(
    path.join(root, 'release-set'),
    [masManifest, providerManifest],
  );
  writeMasOwnerGateFixture(path.dirname(masManifest), fakeBin);
  const ownerChannel = writePackageOwnerChannelFixture({
    root,
    binRoot: fakeBin,
    catalogPath: releaseSet.catalogPath,
    packageIds: ['mas', 'mas-scholar-skills'],
  });
  const env = {
    HOME: homeDir,
    CODEX_HOME: path.join(homeDir, '.codex'),
    OPL_STATE_DIR: stateDir,
    ...releaseSet.env,
    ...ownerChannel.env,
  };

  try {
    const installed = runCli(['packages', 'install', 'mas'], env) as any;
    const locks = installed.opl_agent_package_install.dependency_package_locks;
    assert.deepEqual(locks.map((lock: any) => lock.package_id), [
      'mas-scholar-skills',
      'mas',
    ]);
    assert.deepEqual(
      locks.map((lock: any) => lock.release_channel_ref),
      [
        'ghcr.io/fixture/one-person-lab-packages/mas-scholar-skills:latest-stable',
        'ghcr.io/fixture/one-person-lab-packages/mas:latest-stable',
      ],
    );
    const reads = fs.readFileSync(ownerChannel.curlLogPath, 'utf8');
    for (const packageId of ['mas', 'mas-scholar-skills']) {
      assert.equal(
        reads.split('\n').filter((line) =>
          line.includes(`/one-person-lab-packages/${packageId}/manifests/latest-stable`)).length,
        1,
      );
    }
    assert.equal(reads.includes('/one-person-lab-manifest/'), false);
    for (const packageId of ['mag', 'rca', 'oma', 'obf', 'opl-flow']) {
      assert.equal(reads.includes(`/one-person-lab-packages/${packageId}/`), false);
    }
  } finally {
    removeFixtureTree(root);
  }
});

test('single-package developer update reconciles from the live owner catalog and becomes a byte-stable no-op', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'opl-first-party-single-developer-update-'));
  const homeDir = path.join(root, 'home');
  const stateDir = path.join(root, 'state');
  const masCheckout = path.join(root, 'workspace', 'med-autoscience');
  const scholarCheckout = path.join(root, 'workspace', 'mas-scholar-skills');
  const wrongCheckout = path.join(root, 'workspace', 'wrong-med-autoscience');
  const oldProvider = writeCapabilityProvider(path.join(root, 'old-provider'), '0.1.0');
  const oldMas = writeMasConsumer(path.join(root, 'old-mas'), oldProvider, '0.1.0');
  const oldReleaseSet = writeCapabilityCatalog(path.join(root, 'old-release-set'), [oldMas, oldProvider]);
  const nextProvider = writeCapabilityProvider(path.join(root, 'next-provider'), '0.1.1');
  const nextMas = writeMasConsumer(path.join(root, 'next-mas'), nextProvider, '0.1.1');
  const nextReleaseSet = writeCapabilityCatalog(path.join(root, 'next-release-set'), [nextMas, nextProvider]);
  const fakeBin = path.join(root, 'bin');
  const lockFile = path.join(stateDir, 'agent-package-locks.json');
  const releaseCatalogCache = path.join(stateDir, 'agent-package-release-catalog-cache.json');
  const masSentinel = path.join(masCheckout, 'developer-source.txt');
  const scholarSentinel = path.join(scholarCheckout, 'developer-source.txt');
  const commonEnv = {
    HOME: homeDir,
    CODEX_HOME: path.join(homeDir, '.codex'),
    OPL_STATE_DIR: stateDir,
    OPL_MODULE_PATH_MEDAUTOSCIENCE: masCheckout,
    OPL_MODULE_PATH_SCHOLARSKILLS: scholarCheckout,
    PATH: `${fakeBin}${path.delimiter}${process.env.PATH ?? ''}`,
    UV_TOOL_DIR: path.join(root, 'uv-tools'),
  };
  fs.mkdirSync(masCheckout, { recursive: true });
  fs.mkdirSync(scholarCheckout, { recursive: true });
  fs.mkdirSync(wrongCheckout, { recursive: true });
  const developerFixture = writeDeveloperCapabilityCheckoutClosure({
    masCheckout,
    scholarCheckout,
    masManifestPath: oldMas,
    providerManifestPath: oldProvider,
  });
  writeMasOwnerGateFixture(masCheckout, fakeBin);
  commitDeveloperCheckout(masCheckout, 'add owner gate fixture');
  const oldEnv = { ...commonEnv, ...withMasOwnerGateFixturePath(oldReleaseSet.env, fakeBin) };
  const nextEnv = { ...commonEnv, ...withMasOwnerGateFixturePath(nextReleaseSet.env, fakeBin) };
  fs.writeFileSync(masSentinel, 'developer MAS source\n');
  fs.writeFileSync(scholarSentinel, 'developer ScholarSkills source\n');

  try {
    const installed = runCli(['packages', 'install', 'mas'], oldEnv) as any;
    assert.equal(installed.opl_agent_package_install.package_lock.package_version, '0.1.0');
    assert.equal(installed.opl_agent_package_install.package_lock.source_kind, 'developer_checkout_override');
    const installedLockBytes = fs.readFileSync(lockFile, 'utf8');
    assert.equal(fs.existsSync(path.join(stateDir, 'agent-package-lifecycle-ledger.json')), false);
    assert.equal(fs.existsSync(releaseCatalogCache), false);

    const pathFailure = runCliFailure([
      'packages', 'update', 'mas', '--agent-root', wrongCheckout,
    ], nextEnv);
    assert.equal(pathFailure.payload.error.code, 'contract_shape_invalid');
    assert.equal(
      pathFailure.payload.error.details.failure_code,
      'first_party_package_developer_checkout_path_mismatch',
    );
    assert.equal(fs.readFileSync(lockFile, 'utf8'), installedLockBytes);
    assert.equal(fs.existsSync(path.join(stateDir, 'agent-package-lifecycle-ledger.json')), false);
    assert.equal(fs.existsSync(releaseCatalogCache), false);

    updateDeveloperCapabilityCheckoutClosure({
      masCheckout,
      scholarCheckout,
      masManifestPath: nextMas,
      providerManifestPath: nextProvider,
      message: 'fixture B',
    });

    const preview = runCli(['packages', 'update', 'mas', '--dry-run'], nextEnv) as any;
    const previewUpdate = preview.opl_agent_package_update;
    assert.equal(previewUpdate.status, 'validated_no_write');
    assert.equal(previewUpdate.reconciliation_action, 'source_reconcile');
    assert.equal(previewUpdate.currentness.status, 'update_available');
    assert.ok(previewUpdate.currentness.reasons.includes('package_version_changed'));
    assert.equal(previewUpdate.target_version, '0.1.1');
    assert.equal(previewUpdate.package_lock.package_version, '0.1.1');
    assert.equal(Object.hasOwn(previewUpdate, 'lifecycle_receipt'), false);
    assert.equal(fs.existsSync(releaseCatalogCache), false);
    assert.equal(fs.readFileSync(lockFile, 'utf8'), installedLockBytes);
    assert.equal(fs.existsSync(path.join(stateDir, 'agent-package-lifecycle-ledger.json')), false);

    const updated = runCli(['packages', 'update', 'mas'], nextEnv) as any;
    const appliedUpdate = updated.opl_agent_package_update;
    assert.equal(appliedUpdate.status, 'updated');
    assert.equal(appliedUpdate.reconciliation_action, 'source_reconcile');
    assert.equal(appliedUpdate.currentness.status, 'update_available');
    assert.equal(appliedUpdate.package_lock.package_version, '0.1.1');
    assert.equal(appliedUpdate.package_lock.source_kind, 'developer_checkout_override');
    assert.deepEqual(
      appliedUpdate.dependency_package_locks.map((lock: any) => [
        lock.package_id,
        lock.package_version,
        lock.source_kind,
      ]),
      [
        ['mas-scholar-skills', '0.1.1', 'developer_checkout_override'],
        ['mas', '0.1.1', 'developer_checkout_override'],
      ],
    );
    const updatedLockIndex = JSON.parse(fs.readFileSync(lockFile, 'utf8'));
    assert.deepEqual(
      updatedLockIndex.packages
        .map((lock: any) => [lock.package_id, lock.package_version, lock.source_kind])
        .sort((left: string[], right: string[]) => left[0].localeCompare(right[0])),
      [
        ['mas', '0.1.1', 'developer_checkout_override'],
        ['mas-scholar-skills', '0.1.1', 'developer_checkout_override'],
      ],
    );
    assert.equal(fs.readFileSync(masSentinel, 'utf8'), 'developer MAS source\n');
    assert.equal(fs.readFileSync(scholarSentinel, 'utf8'), 'developer ScholarSkills source\n');
    assert.equal(fs.existsSync(releaseCatalogCache), false);

    const driftedLockIndex = JSON.parse(fs.readFileSync(lockFile, 'utf8'));
    const driftedScholarLock = driftedLockIndex.packages.find(
      (lock: any) => lock.package_id === 'mas-scholar-skills',
    );
    driftedScholarLock.source_kind = 'first_party_managed_cohort';
    fs.writeFileSync(lockFile, `${JSON.stringify(driftedLockIndex, null, 2)}\n`);
    const dependencyReconciled = runCli(['packages', 'update', 'mas'], nextEnv) as any;
    const dependencyUpdate = dependencyReconciled.opl_agent_package_update;
    assert.equal(dependencyUpdate.status, 'updated');
    assert.equal(dependencyUpdate.currentness.status, 'update_available');
    assert.deepEqual(dependencyUpdate.currentness.reasons, ['dependency_closure_changed']);
    assert.equal(
      dependencyUpdate.closure_currentness.find(
        (entry: any) => entry.package_id === 'mas-scholar-skills',
      ).status,
      'update_available',
    );
    assert.equal(
      dependencyUpdate.dependency_package_locks.find(
        (lock: any) => lock.package_id === 'mas-scholar-skills',
      ).source_kind,
      'developer_checkout_override',
    );
    assert.equal(fs.existsSync(releaseCatalogCache), false);

    const currentLockBytes = fs.readFileSync(lockFile, 'utf8');
    const current = runCli(['packages', 'update', 'mas'], nextEnv) as any;
    const currentUpdate = current.opl_agent_package_update;
    assert.equal(currentUpdate.status, 'current_noop');
    assert.equal(currentUpdate.currentness.status, 'current');
    assert.equal(currentUpdate.reconciliation_action, null);
    assert.equal(Object.hasOwn(currentUpdate, 'lifecycle_receipt'), false);
    assert.deepEqual(
      currentUpdate.dependency_package_locks.map((lock: any) => [lock.package_id, lock.source_kind]),
      [
        ['mas-scholar-skills', 'developer_checkout_override'],
        ['mas', 'developer_checkout_override'],
      ],
    );
    assert.equal(fs.readFileSync(lockFile, 'utf8'), currentLockBytes);
    assert.equal(fs.existsSync(path.join(stateDir, 'agent-package-lifecycle-ledger.json')), false);
    assert.equal(fs.existsSync(releaseCatalogCache), false);

    const scholarHead = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: scholarCheckout,
      encoding: 'utf8',
    }).trim();
    fs.appendFileSync(developerFixture.providerHelperPath, 'offline dirty developer update\n');
    fs.rmSync(nextReleaseSet.catalogPath, { force: true });
    const offlineDeveloper = runCli(['packages', 'update', 'mas'], nextEnv) as any;
    const offlineUpdate = offlineDeveloper.opl_agent_package_update;
    const offlineProvider = offlineUpdate.dependency_package_locks.find(
      (entry: any) => entry.package_id === 'mas-scholar-skills',
    );
    assert.equal(offlineUpdate.status, 'updated');
    assert.equal(offlineUpdate.reconciliation_action, 'source_reconcile');
    assert.equal(offlineUpdate.release_catalog_freshness, null);
    assert.equal(offlineProvider.developer_checkout_source.source_git_head_sha, scholarHead);
    assert.match(
      fs.readFileSync(
        path.join(offlineProvider.physical_surface.codex_plugin_cache_path, 'skills', 'medical-manuscript-writing', 'helper.txt'),
        'utf8',
      ),
      /offline dirty developer update/,
    );
    assert.notEqual(execFileSync('git', ['status', '--porcelain'], {
      cwd: scholarCheckout,
      encoding: 'utf8',
    }), '');
    assert.equal(fs.existsSync(releaseCatalogCache), false);

    const providerSkillRoot = path.join(
      offlineProvider.physical_surface.codex_plugin_cache_path,
      'skills',
      'medical-manuscript-writing',
    );
    assert.equal(fs.statSync(offlineProvider.physical_surface.codex_plugin_cache_path).mode & 0o777, 0o555);
    assert.equal(fs.statSync(path.join(providerSkillRoot, 'SKILL.md')).mode & 0o777, 0o444);
    fs.chmodSync(providerSkillRoot, 0o755);
    const injectedSkillInstruction = path.join(providerSkillRoot, 'untracked-instruction.md');
    fs.writeFileSync(injectedSkillInstruction, 'must never enter a Skill projection\n', { mode: 0o444 });
    fs.chmodSync(providerSkillRoot, 0o555);
    assert.throws(() => materializeAgentPackageSkillProjection({
      root: offlineUpdate.package_lock,
      providers: [offlineProvider],
      dryRun: true,
    }), (error: any) =>
      error?.details?.failure_code === 'agent_package_plugin_cache_generation_invalid');
  } finally {
    removeFixtureTree(root);
  }
});
