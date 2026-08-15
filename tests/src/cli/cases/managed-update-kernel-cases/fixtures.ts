import crypto from 'node:crypto';

import { fs, parseJsonText, path } from '../../helpers.ts';
import {
  CANONICAL_PACKAGE_CONTENT_LOCK,
  packageContentLockDigest,
} from '../../../../../src/adapters/integration/agent-package-registry-parts/payload-content-lock.ts';

function readJsonFile(filePath: string) {
  return parseJsonText(fs.readFileSync(filePath, 'utf8'));
}

const MANAGED_BUNDLED_PACKAGE_FIXTURES = [
  { packageId: 'mag', project: 'med-autogrant', moduleId: 'medautogrant', pathEnv: 'OPL_MODULE_PATH_MEDAUTOGRANT' },
  { packageId: 'mas', project: 'med-autoscience', moduleId: 'medautoscience', pathEnv: 'OPL_MODULE_PATH_MEDAUTOSCIENCE' },
  { packageId: 'mas-scholar-skills', project: 'mas-scholar-skills', moduleId: 'scholarskills', pathEnv: 'OPL_MODULE_PATH_MAS_SCHOLAR_SKILLS' },
  { packageId: 'obf', project: 'opl-bookforge', moduleId: 'oplbookforge', pathEnv: 'OPL_MODULE_PATH_OPLBOOKFORGE' },
  { packageId: 'oma', project: 'opl-meta-agent', moduleId: 'oplmetaagent', pathEnv: 'OPL_MODULE_PATH_OPLMETAAGENT' },
  { packageId: 'opl-flow', project: 'opl-flow', moduleId: 'oplflow', pathEnv: 'OPL_MODULE_PATH_OPLFLOW' },
  { packageId: 'rca', project: 'redcube-ai', moduleId: 'redcube', pathEnv: 'OPL_MODULE_PATH_REDCUBE' },
] as const;

function sha256Value(value: string | Buffer) {
  return `sha256:${crypto.createHash('sha256').update(value).digest('hex')}`;
}

function writeJsonPayload(filePath: string, payload: unknown) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const json = `${JSON.stringify(payload, null, 2)}\n`;
  fs.writeFileSync(filePath, json, 'utf8');
  return json;
}

function filesUnder(root: string, relativeRoot = ''): string[] {
  const absoluteRoot = path.join(root, relativeRoot);
  if (!fs.existsSync(absoluteRoot)) return [];
  return fs.readdirSync(absoluteRoot, { withFileTypes: true }).flatMap((entry) => {
    const relativePath = path.join(relativeRoot, entry.name);
    if (entry.isDirectory()) return filesUnder(root, relativePath);
    return entry.isFile() ? [relativePath.replaceAll(path.sep, '/')] : [];
  }).sort();
}

function writeManagedBundledScholarSource(root: string, manifest: Record<string, any>, revision: string) {
  for (const relativePath of manifest.content_lock.paths as string[]) {
    const filePath = path.join(root, relativePath);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const skillId = path.basename(path.dirname(relativePath));
    const content = relativePath === '.codex-plugin/plugin.json'
      ? `${JSON.stringify({ name: 'mas-scholar-skills', skills: './skills/' }, null, 2)}\n`
      : path.basename(relativePath) === 'SKILL.md'
        ? `---\nname: ${skillId}\ndescription: Managed bundled ${revision} fixture.\n---\n\n# ${skillId}\n`
        : relativePath.endsWith('.json')
          ? `${JSON.stringify({ fixture_revision: revision }, null, 2)}\n`
          : `Managed bundled ${revision} fixture for ${relativePath}.\n`;
    fs.writeFileSync(filePath, content, 'utf8');
  }
}

function writeManagedBundledFlowSource(
  root: string,
  version: string,
  revision: string,
  requiredSkillIds: string[],
) {
  const capability = (input: {
    id: string;
    kind: string;
    source: string;
    installSource: string;
    lifecycleOwner: string;
    offlineBundle: 'none' | 'full';
    onlineInstallDefault: boolean;
    activation: string;
    conflictPolicy: string;
    credentialPolicy?: string;
  }) => ({
    id: input.id,
    kind: input.kind,
    owner: input.id === 'opl-base' ? 'one-person-lab' : input.id === 'officecli' ? 'iofficeai' : 'opl-flow',
    version_requirement: input.id === 'opl-flow' || requiredSkillIds.includes(input.id)
      ? `=${version}`
      : 'release_lock_exact',
    source: input.source,
    install_source: input.installSource,
    lifecycle_owner: input.lifecycleOwner,
    offline_bundle: input.offlineBundle,
    online_install_default: input.onlineInstallDefault,
    activation: input.activation,
    conflict_policy: input.conflictPolicy,
    credential_policy: input.credentialPolicy ?? 'none',
  });
  const policy = {
    schema: 'opl_flow_workflow_policy.v2',
    package: { id: 'opl-flow', version, owner: 'opl-flow', kind: 'workflow_profile' },
    workflow_generation: revision,
    provides: [
      capability({
        id: 'opl-flow', kind: 'codex_plugin', source: 'package:opl-flow',
        installSource: 'package_payload', lifecycleOwner: 'opl-framework', offlineBundle: 'full',
        onlineInstallDefault: true, activation: 'always', conflictPolicy: 'fail_closed_on_collision',
      }),
      ...requiredSkillIds.map((skillId) => capability({
        id: skillId, kind: 'codex_skill', source: `package:opl-flow/skills/${skillId}`,
        installSource: 'package_payload', lifecycleOwner: 'opl-framework', offlineBundle: 'full',
        onlineInstallDefault: true, activation: 'task_routed', conflictPolicy: 'fail_closed_on_collision',
      })),
    ],
    requires: [capability({
      id: 'opl-base', kind: 'base', source: 'gaofeng21cn/one-person-lab',
      installSource: 'framework_managed_release_lock', lifecycleOwner: 'opl-framework',
      offlineBundle: 'full', onlineInstallDefault: true, activation: 'always',
      conflictPolicy: 'managed_reconcile',
    })],
    recommends: [
      capability({
        id: 'officecli', kind: 'codex_skill', source: 'skills-manager:officecli',
        installSource: 'framework_managed_release_lock', lifecycleOwner: 'opl-framework',
        offlineBundle: 'full', onlineInstallDefault: true, activation: 'task_routed',
        conflictPolicy: 'managed_reconcile',
      }),
      capability({
        id: 'officecli', kind: 'cli', source: 'officecli',
        installSource: 'framework_managed_release_lock', lifecycleOwner: 'opl-framework',
        offlineBundle: 'full', onlineInstallDefault: true, activation: 'task_routed',
        conflictPolicy: 'managed_reconcile',
      }),
    ],
    compatible_optional: [capability({
      id: 'openai-primary-runtime-office-pdf', kind: 'runtime_capability', source: 'openai-primary-runtime',
      installSource: 'codex_builtin', lifecycleOwner: 'codex', offlineBundle: 'none',
      onlineInstallDefault: false, activation: 'task_routed', conflictPolicy: 'preserve_user_surface',
    })],
    installation_convergence: {
      standard_target_closure: 'workflow_policy_release_lock',
      full_target_closure: 'workflow_policy_release_lock',
      standard_source: 'online_exact_release_lock',
      full_source: 'embedded_exact_release_lock',
      final_projection_equivalence_required: true,
      default_dependencies_require_full_bundle: true,
      secrets_bundled: false,
      user_third_party_surfaces_policy: 'preserve',
    },
    conflicts: [{
      id: 'codexcont-intelligence-enhancement',
      discovery_ids: ['codexcont', 'intelligence_enhancement'],
      auto_retire_on_optimize: true,
      reason: 'Managed bundled fixture legacy service.',
    }],
    retires: [{
      id: 'superpowers-local-method-profile',
      discovery_ids: ['superpowers-lite', 'planner'],
      auto_retire_on_optimize: true,
      reason: 'Managed bundled fixture legacy Skill and prompt.',
    }],
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
      skill_ids: ['superpowers-lite'],
      service_ids: ['codexcont'],
      config_markers: ['codexcont'],
      legacy_prompt_ids: ['planner'],
    },
    codex_model_policy: {
      authority: 'opl-flow',
      configured_default: { model: 'gpt-fixture', reasoning_effort: revision },
      override_precedence: ['explicit_user_override', 'opl_flow_recommendation', 'app_fallback'],
    },
  };
  writeJsonPayload(path.join(root, '.codex-plugin', 'plugin.json'), {
    name: 'opl-flow',
    version,
    skills: './skills/',
  });
  for (const skillId of requiredSkillIds) {
    fs.mkdirSync(path.join(root, 'skills', skillId), { recursive: true });
    fs.writeFileSync(
      path.join(root, 'skills', skillId, 'SKILL.md'),
      `---\nname: ${skillId}\ndescription: Managed bundled ${revision} fixture.\n---\n\n# ${skillId}\n`,
      'utf8',
    );
  }
  writeJsonPayload(path.join(root, 'contracts', 'workflow-policy.json'), policy);
  writeJsonPayload(path.join(root, 'contracts', 'workflow-policy.schema.json'), { type: 'object' });
  writeJsonPayload(path.join(root, 'profile', 'manifest.json'), { fixture_revision: revision });
  fs.mkdirSync(path.join(root, 'profile', 'modules'), { recursive: true });
  fs.mkdirSync(path.join(root, 'templates'), { recursive: true });
  fs.writeFileSync(path.join(root, 'profile', 'modules', '01-user-preferences.md'), `# ${revision}\n`, 'utf8');
  fs.writeFileSync(path.join(root, 'templates', 'AGENTS.md'), `# AGENTS ${revision}\n`, 'utf8');
  fs.writeFileSync(path.join(root, 'templates', 'TASTE.md'), `# TASTE ${revision}\n`, 'utf8');
}

function managedBundledSourceCommit(packageId: string, revision: string) {
  return crypto.createHash('sha256').update(`${packageId}\n${revision}`).digest('hex').slice(0, 40);
}

function managedBundledRawSourceUrl(
  sourceRepo: string,
  sourceCommit: string,
  sourceRoot: string,
  relativePath: string,
) {
  const coordinates = new URL(sourceRepo).pathname.replace(/^\//, '').replace(/\.git$/, '');
  const treePath = sourceRoot === '.' ? relativePath : `${sourceRoot}/${relativePath}`;
  return `https://raw.githubusercontent.com/${coordinates}/${sourceCommit}/${treePath
    .split('/')
    .map(encodeURIComponent)
    .join('/')}`;
}

function writeManagedBundledCatalogFixture(input: {
  workspaceRoot: string;
  outputRoot: string;
  revision: string;
}) {
  const packages: Record<string, unknown> = {};
  const sourcePaths: Record<string, string> = {};
  const roots = Object.fromEntries(MANAGED_BUNDLED_PACKAGE_FIXTURES.map((entry) => [
    entry.packageId,
    path.join(input.workspaceRoot, entry.project),
  ])) as Record<string, string>;
  const scholarManifest = readJsonFile(
    path.resolve('contracts', 'opl-framework', 'packages', 'mas-scholar-skills.json'),
  ) as Record<string, any>;
  writeManagedBundledScholarSource(roots['mas-scholar-skills'], scholarManifest, input.revision);
  const flowManifest = readJsonFile(
    path.resolve('contracts', 'opl-framework', 'packages', 'opl-flow.json'),
  ) as Record<string, any>;
  writeManagedBundledFlowSource(
    roots['opl-flow'],
    flowManifest.version,
    input.revision,
    flowManifest.codex_surface.required_skill_ids as string[],
  );

  for (const fixture of MANAGED_BUNDLED_PACKAGE_FIXTURES) {
    const root = roots[fixture.packageId];
    const canonicalManifestPath = path.resolve(
      'contracts',
      'opl-framework',
      'packages',
      `${fixture.packageId}.json`,
    );
    const manifest = structuredClone(readJsonFile(canonicalManifestPath)) as Record<string, any>;
    const canonicalPayloadPath = path.resolve(
      path.dirname(canonicalManifestPath),
      manifest.codex_surface.plugin_payload_manifest_url,
    );
    const canonicalPayload = readJsonFile(canonicalPayloadPath) as Record<string, any>;
    const sourceRoot = canonicalPayload.source_root as string;
    const sourcePath = sourceRoot === '.' ? root : path.join(root, sourceRoot);
    sourcePaths[fixture.packageId] = sourcePath;
    const sourceCommit = managedBundledSourceCommit(fixture.packageId, input.revision);
    manifest.codex_surface = {
      ...manifest.codex_surface,
      carrier_source_commit: sourceCommit,
      plugin_payload_manifest_url: `payloads/${fixture.packageId}.json`,
    };
    fs.mkdirSync(sourcePath, { recursive: true });
    const pluginManifestPath = path.join(sourcePath, '.codex-plugin', 'plugin.json');
    if (fs.existsSync(pluginManifestPath)) {
      const pluginManifest = readJsonFile(pluginManifestPath) as Record<string, unknown>;
      writeJsonPayload(pluginManifestPath, { ...pluginManifest, version: manifest.version });
    }
    writeJsonPayload(path.join(sourcePath, 'opl-package.json'), manifest);
    fs.writeFileSync(path.join(sourcePath, '.opl-managed-bundled-revision'), `${input.revision}\n`, 'utf8');
    for (const skillPath of filesUnder(sourcePath).filter((entry) => entry.endsWith('/SKILL.md'))) {
      const current = fs.readFileSync(path.join(sourcePath, skillPath), 'utf8')
        .replace(/\nManaged bundled revision: .*\n$/, '\n');
      fs.writeFileSync(
        path.join(sourcePath, skillPath),
        `${current.trimEnd()}\n\nManaged bundled revision: ${input.revision}\n`,
        'utf8',
      );
    }
    writeJsonPayload(path.join(root, 'opl-runtime-module.json'), {
      marker_version: 1,
      module_id: fixture.moduleId,
      repo_name: fixture.project,
      packaged_runtime: true,
      source_git: { head_sha: sourceCommit },
    });
    const files = filesUnder(sourcePath).map((relativePath) => {
      const filePath = path.join(sourcePath, relativePath);
      const bytes = fs.readFileSync(filePath);
      return {
        path: relativePath,
        mode: (fs.statSync(filePath).mode & 0o111) !== 0 ? '100755' : '100644',
        source_url: managedBundledRawSourceUrl(
          manifest.source_repo,
          sourceCommit,
          sourceRoot,
          relativePath,
        ),
        sha256: sha256Value(bytes),
      };
    });
    const contentDigest = packageContentLockDigest(
      CANONICAL_PACKAGE_CONTENT_LOCK,
      files.map((entry) => ({
        path: entry.path,
        content: fs.readFileSync(path.join(sourcePath, entry.path)),
      })),
    );
    if (fixture.packageId === 'mas-scholar-skills') {
      manifest.content_lock = {
        ...manifest.content_lock,
        paths: files.map((entry) => entry.path),
        digest: contentDigest,
      };
    }
    const manifestRef = `packages/${fixture.packageId}.json`;
    const payloadRef = `packages/payloads/${fixture.packageId}.json`;
    const payload = {
      surface_kind: 'opl_package_payload_manifest.v2',
      schema_ref: 'contracts/opl-framework/package-payload-manifest-v2.schema.json',
      package_id: fixture.packageId,
      plugin_id: manifest.codex_surface.plugin_id,
      package_version: manifest.version,
      source_repo: manifest.source_repo,
      source_commit: sourceCommit,
      source_root: sourceRoot,
      content_lock: {
        algorithm: 'sha256',
        canonicalization: CANONICAL_PACKAGE_CONTENT_LOCK,
        digest: contentDigest,
      },
      files,
    };
    const manifestJson = writeJsonPayload(path.join(input.outputRoot, manifestRef), manifest);
    const payloadJson = writeJsonPayload(path.join(input.outputRoot, payloadRef), payload);
    packages[fixture.packageId] = {
      package_id: fixture.packageId,
      package_role: manifest.surface_kind === 'opl_capability_package_manifest.v2'
        ? 'capability_package'
        : manifest.surface_kind === 'opl_workflow_profile_package_manifest.v1'
          ? 'workflow_profile'
          : 'standard_agent',
      package_version: manifest.version,
      owner_source_commit: sourceCommit,
      manifest_ref: manifestRef,
      manifest_sha256: sha256Value(manifestJson),
      payload_manifest_ref: payloadRef,
      payload_manifest_sha256: sha256Value(payloadJson),
      runtime_module_relative_path: `modules/${fixture.packageId}`,
    };
  }
  const catalogPath = path.join(input.outputRoot, 'catalog.json');
  writeJsonPayload(catalogPath, {
    surface_kind: 'opl_bundled_full_runtime_package_catalog.v1',
    schema_ref: 'contracts/opl-framework/bundled-full-runtime-package-catalog.schema.json',
    catalog_id: 'opl-framework-bundled-full-runtime-packages',
    packages,
  });
  return {
    catalogPath,
    roots,
    sourcePaths,
    sourceCommits: Object.fromEntries(MANAGED_BUNDLED_PACKAGE_FIXTURES.map((entry) => [
      entry.packageId,
      managedBundledSourceCommit(entry.packageId, input.revision),
    ])) as Record<string, string>,
  };
}

async function withProcessEnvironment<T>(
  env: Record<string, string>,
  operation: () => Promise<T>,
) {
  const previous = new Map(Object.keys(env).map((key) => [key, process.env[key]]));
  try {
    for (const [key, value] of Object.entries(env)) process.env[key] = value;
    return await operation();
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

function pathBytesDigest(targetPath: string) {
  if (!fs.existsSync(targetPath)) return 'absent';
  const digest = crypto.createHash('sha256');
  const visit = (currentPath: string, relativePath: string) => {
    const stat = fs.lstatSync(currentPath);
    if (stat.isSymbolicLink()) {
      digest.update(`link\0${relativePath}\0${fs.readlinkSync(currentPath)}\0`);
      return;
    }
    if (stat.isDirectory()) {
      digest.update(`dir\0${relativePath}\0`);
      for (const entry of fs.readdirSync(currentPath).sort()) {
        visit(path.join(currentPath, entry), path.join(relativePath, entry));
      }
      return;
    }
    digest.update(`file\0${relativePath}\0`);
    digest.update(fs.readFileSync(currentPath));
  };
  visit(targetPath, '.');
  return digest.digest('hex');
}

function markFakeCodexPluginManagerVersionsStale(input: {
  stateRoot: string;
  codexHome: string;
  pluginIds?: string[];
}) {
  const homeKey = crypto.createHash('sha256').update(input.codexHome).digest('hex');
  const statePath = path.join(input.stateRoot, 'fake-codex-plugin-manager', `${homeKey}.json`);
  const state = readJsonFile(statePath) as {
    marketplaces: Array<Record<string, unknown>>;
    installed: Array<{ pluginId: string; version: string | null }>;
  };
  const pluginIds = input.pluginIds ? new Set(input.pluginIds) : null;
  for (const entry of state.installed) {
    if (!pluginIds || pluginIds.has(entry.pluginId.split('@', 1)[0])) entry.version = '0.0.0';
  }
  writeJsonPayload(statePath, state);
}

function managedBundledStateFingerprint(input: {
  homeRoot: string;
  stateRoot: string;
  codexHome: string;
  scopeRoot: string;
  baseSentinelRoot: string;
  appSentinelRoot: string;
}) {
  const paths = {
    package_lock: path.join(input.stateRoot, 'agent-package-locks.json'),
    lifecycle_ledger: path.join(input.stateRoot, 'agent-package-lifecycle-ledger.json'),
    payload_cache: path.join(input.stateRoot, 'agent-package-payloads'),
    marketplace_cache: path.join(input.stateRoot, 'codex-plugin-marketplaces'),
    plugin_carriers: path.join(input.stateRoot, 'codex-plugin-carriers'),
    package_transactions: path.join(input.stateRoot, 'agent-package-transactions'),
    skill_projections: path.join(input.stateRoot, 'agent-package-skill-projections'),
    base_dependencies: path.join(input.stateRoot, 'base-dependencies'),
    codex_config: path.join(input.codexHome, 'config.toml'),
    codex_agents: path.join(input.codexHome, 'AGENTS.md'),
    codex_taste: path.join(input.codexHome, 'TASTE.md'),
    codex_state: path.join(input.codexHome, 'state'),
    codex_plugins: path.join(input.codexHome, 'plugins'),
    codex_skills: path.join(input.codexHome, 'skills'),
    codex_prompts: path.join(input.codexHome, 'prompts'),
    codex_prompt_agents: path.join(input.codexHome, 'agents'),
    codex_staged_plugins: path.join(input.codexHome, '.tmp', 'plugins', 'plugins'),
    companion_sources: path.join(input.codexHome, 'opl-companion-sources'),
    agents_skills: path.join(input.homeRoot, '.agents', 'skills'),
    skills_manager_skills: path.join(input.homeRoot, '.skills-manager', 'skills'),
    launch_agents: path.join(input.homeRoot, 'Library', 'LaunchAgents'),
    systemd_user_services: path.join(input.homeRoot, '.config', 'systemd', 'user'),
    legacy_home_service: path.join(input.homeRoot, '.codexcont'),
    user_tool_root: path.join(input.homeRoot, '.local', 'bin'),
    scope_skills: path.join(input.scopeRoot, '.codex', 'skills'),
    scope_transactions: path.join(input.scopeRoot, '.codex', '.opl-package-transactions'),
    base_sentinel: input.baseSentinelRoot,
    app_sentinel: input.appSentinelRoot,
  };
  return Object.fromEntries(Object.entries(paths).map(([key, targetPath]) => [
    key,
    pathBytesDigest(targetPath),
  ]));
}

function ownerPackageDescriptorReadback(input: {
  sourcePaths: Record<string, string>;
  packageIds: string[];
}) {
  return input.packageIds
    .map((packageId) => {
      const descriptorPath = path.join(input.sourcePaths[packageId], 'opl-package.json');
      const manifest = readJsonFile(descriptorPath) as any;
      return {
        package_id: manifest.package_id,
        descriptor_ref: descriptorPath,
        descriptor_sha256: pathBytesDigest(descriptorPath),
        package_root_sha256: pathBytesDigest(path.dirname(descriptorPath)),
        carrier_source_commit: manifest.codex_surface?.carrier_source_commit ?? null,
      };
    })
    .sort((left, right) => left.package_id.localeCompare(right.package_id));
}
export {
  readJsonFile,
  MANAGED_BUNDLED_PACKAGE_FIXTURES,
  sha256Value,
  writeJsonPayload,
  writeManagedBundledCatalogFixture,
  withProcessEnvironment,
  markFakeCodexPluginManagerVersionsStale,
  pathBytesDigest,
  managedBundledStateFingerprint,
  ownerPackageDescriptorReadback,
};
