import {
  assert,
  formatJsonPayload,
  fs,
  os,
  parseJsonText,
  path,
  removeFixtureTree,
  runCli,
  runCliAsync,
  runCliFailure,
  test,
} from './helpers.ts';
import { runCliInCwd } from '../../helpers.ts';
import {
  scholarSkillsCoreSkillIds as coreSkillIds,
  scholarSkillsModuleIds as moduleIds,
  writeCapabilityProvider as writeRawCapabilityProvider,
  writeMasConsumer as writeRawMasConsumer,
} from './capability-fixtures.ts';

const FIXTURE_CONSUMER_PACKAGE_ID = 'fixture.mas';
const FIXTURE_PROVIDER_PACKAGE_ID = 'fixture.mas-scholar-skills';
const MAG_CONSUMER_PROFILE_ID = 'mag-medical-grant.v1';
const MAG_REQUIRED_SKILL_IDS = [
  'medical-research-lit',
  'medical-statistical-review',
  'medical-methodology-planner',
  'medical-evidence-integrity-reviewer',
  'medical-evidence-synthesis-and-claim-map',
  'medical-reference-integrity-auditor',
];
const MAG_REQUIRED_MODULE_IDS = [
  'mas-scholar-skills.lit',
  'mas-scholar-skills.stats',
  'mas-scholar-skills.review',
  'mas-scholar-skills.data',
  'mas-scholar-skills.reference-provider-adapters',
  'mas-scholar-skills.scientific-search-adapters',
];
const MAG_PROVIDER_MODULE_IDS = [...new Set([...moduleIds, ...MAG_REQUIRED_MODULE_IDS])];
const MAG_SPECIALTY_SKILL_IDS = MAG_REQUIRED_SKILL_IDS.filter((skillId) => !coreSkillIds.includes(skillId));

function bindMasWorkspace(workspace: string, env: Record<string, string>) {
  fs.mkdirSync(workspace, { recursive: true });
  runCli([
    'workspace', 'bind', '--project', 'medautoscience', '--path', workspace,
  ], env);
}

function writeFixtureCapabilityProvider(
  root: string,
  version = '0.1.0',
  options: NonNullable<Parameters<typeof writeRawCapabilityProvider>[2]> = {},
) {
  return writeRawCapabilityProvider(root, version, {
    ...options,
    packageId: options.packageId ?? FIXTURE_PROVIDER_PACKAGE_ID,
  });
}

function writeFixtureMasConsumer(
  root: string,
  providerManifestPath: string,
  version = '0.1.0a4',
  options: NonNullable<Parameters<typeof writeRawMasConsumer>[3]> = {},
) {
  return writeRawMasConsumer(root, providerManifestPath, version, {
    ...options,
    packageId: FIXTURE_CONSUMER_PACKAGE_ID,
    providerPackageId: FIXTURE_PROVIDER_PACKAGE_ID,
  });
}

function appendCapabilityDependency(
  consumerManifestPath: string,
  input: {
    packageId: string;
    manifestPath: string;
    capabilityAbi: string;
    skillIds: string[];
    moduleIds: string[];
  },
) {
  const manifest = JSON.parse(fs.readFileSync(consumerManifestPath, 'utf8'));
  manifest.capability_dependencies.push({
    ...manifest.capability_dependencies[0],
    module_id: input.packageId,
    package_id: input.packageId,
    manifest_url: input.manifestPath,
    capability_abi: input.capabilityAbi,
    required_export_ids: input.skillIds,
    required_module_ids: input.moduleIds,
  });
  delete manifest.capability_dependencies.at(-1).bootstrap_manifest_url;
  delete manifest.capability_dependencies.at(-1).dependency_source;
  fs.writeFileSync(consumerManifestPath, formatJsonPayload(manifest));
}

test('MAS package lifecycle atomically installs and repairs its 11-core capability closure', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'opl-package-dependency-closure-'));
  const stateDir = path.join(root, 'state');
  const codexHome = path.join(root, 'codex-home');
  const workspace = path.join(root, 'workspace');
  fs.mkdirSync(workspace, { recursive: true });
  const providerRoot = path.join(root, 'provider');
  const providerManifestPath = writeFixtureCapabilityProvider(providerRoot);
  const consumerManifestPath = writeFixtureMasConsumer(root, providerManifestPath);
  const env = { OPL_STATE_DIR: stateDir, CODEX_HOME: codexHome };
  try {
    bindMasWorkspace(workspace, env);
    const install = await runCliAsync([
      'packages', 'install', '--manifest-url', consumerManifestPath,
      '--trust-tier', 'first_party', '--scope', 'workspace', '--target-workspace', workspace,
    ], env) as any;
    assert.equal(install.opl_agent_package_install.status, 'installed');
    assert.deepEqual(
      install.opl_agent_package_install.dependency_package_locks.map((entry: any) => entry.package_id).sort(),
      [FIXTURE_CONSUMER_PACKAGE_ID, FIXTURE_PROVIDER_PACKAGE_ID],
    );
    const masLock = install.opl_agent_package_install.package_lock;
    assert.equal(masLock.resolved_dependencies[0].installed_version, '0.1.0');
    assert.match(masLock.resolved_dependencies[0].manifest_sha256, /^[0-9a-f]{64}$/);
    assert.match(masLock.resolved_dependencies[0].content_digest, /^sha256:[0-9a-f]{64}$/);
    assert.deepEqual(masLock.capability_dependencies[0].required_module_ids, moduleIds);
    const localSkillRoot = path.join(workspace, '.codex', 'skills');
    assert.deepEqual(fs.readdirSync(localSkillRoot).sort(), [...coreSkillIds].sort());
    assert.equal(fs.existsSync(path.join(localSkillRoot, 'medical-optional-specialty')), false);
    assert.equal(fs.existsSync(path.join(localSkillRoot, 'medical-manuscript-writing', 'helper.txt')), true);

    const current = runCli([
      'packages', 'status', '--package-id', FIXTURE_CONSUMER_PACKAGE_ID,
      '--scope', 'workspace', '--target-workspace', workspace,
    ], env) as any;
    assert.equal(current.opl_agent_package_status.package_dependency_readiness.status, 'current');
    assert.equal(current.opl_agent_package_status.materialization_readiness.status, 'current');
    assert.equal(
      Object.hasOwn(current.opl_agent_package_status.materialization_readiness, 'lifecycle_receipt_ref'),
      false,
    );
    assert.equal(Object.hasOwn(masLock.scope_materializations[0], 'lifecycle_receipt_ref'), false);
    assert.equal(current.opl_agent_package_status.operational_ready, true);
    assert.equal(current.opl_agent_package_status.launch_allowed, true);
    assert.equal(current.opl_agent_package_status.owner_route_readback.packages.length, 1);
    assert.equal(
      current.opl_agent_package_status.owner_route_readback.packages[0].package_core.package_id,
      FIXTURE_CONSUMER_PACKAGE_ID,
    );
    assert.deepEqual(
      current.opl_agent_package_status.owner_route_readback.packages[0]
        .package_core.dependencies.dependency_readiness,
      current.opl_agent_package_status.package_dependency_readiness,
    );

    const currentFromWorkspace = runCliInCwd([
      'packages', 'status', '--package-id', FIXTURE_CONSUMER_PACKAGE_ID,
      '--scope', 'workspace', '--target-workspace', workspace,
    ], workspace, env) as any;
    assert.equal(currentFromWorkspace.opl_agent_package_status.materialization_readiness.status, 'current');
    assert.equal(currentFromWorkspace.opl_agent_package_status.materialization_readiness.target_root, workspace);

    fs.rmSync(path.join(localSkillRoot, 'medical-manuscript-writing'), { recursive: true, force: true });
    const degraded = runCli([
      'packages', 'status', '--package-id', FIXTURE_CONSUMER_PACKAGE_ID,
      '--scope', 'workspace', '--target-workspace', workspace,
    ], env) as any;
    assert.equal(degraded.opl_agent_package_status.materialization_readiness.status, 'missing');
    assert.equal(degraded.opl_agent_package_status.operational_ready, false);
    assert.equal(degraded.opl_agent_package_status.launch_allowed, false);
    assert.deepEqual(degraded.opl_agent_package_status.allowed_when_blocked, ['status', 'doctor', 'repair']);

    const repaired = await runCliAsync([
      'packages', 'repair', FIXTURE_CONSUMER_PACKAGE_ID, '--scope', 'workspace', '--target-workspace', workspace,
    ], env) as any;
    assert.equal(repaired.opl_agent_package_repair.status, 'repaired');
    assert.equal(fs.existsSync(path.join(localSkillRoot, 'medical-manuscript-writing', 'SKILL.md')), true);

    const lockPath = path.join(stateDir, 'agent-package-locks.json');
    const lockIndex = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
    const providerLock = lockIndex.packages.find((entry: any) => entry.package_id === FIXTURE_PROVIDER_PACKAGE_ID);
    providerLock.capability_provider.module_export_ids = providerLock.capability_provider.module_export_ids.slice(1);
    fs.writeFileSync(lockPath, formatJsonPayload(lockIndex));
    const moduleMissing = runCli([
      'packages', 'status', '--package-id', FIXTURE_CONSUMER_PACKAGE_ID, '--scope', 'workspace', '--target-workspace', workspace,
    ], env) as any;
    const dependencyItem = moduleMissing.opl_agent_package_status.package_dependency_readiness.dependencies[0];
    assert.equal(dependencyItem.status, 'incompatible');
    assert.deepEqual(dependencyItem.missing_required_export_ids, []);
    assert.deepEqual(dependencyItem.missing_required_module_ids, ['mas-scholar-skills.display']);
    assert.equal(moduleMissing.opl_agent_package_status.operational_ready, false);
    providerLock.capability_provider.module_export_ids = moduleIds;
    fs.writeFileSync(lockPath, formatJsonPayload(lockIndex));

    const disabled = runCliFailure(['packages', 'disable', FIXTURE_PROVIDER_PACKAGE_ID], env);
    assert.equal(
      disabled.payload.error.details.failure_code,
      'agent_package_exposure_native_owner_required',
    );
    const uninstallBlocked = runCliFailure(['packages', 'uninstall', FIXTURE_PROVIDER_PACKAGE_ID], env);
    assert.equal(
      uninstallBlocked.payload.error.details.failure_code,
      'agent_package_required_by_installed_dependents',
    );
    assert.deepEqual(
      uninstallBlocked.payload.error.details.dependent_package_ids,
      [FIXTURE_CONSUMER_PACKAGE_ID],
    );

    assert.equal(fs.existsSync(path.join(stateDir, 'agent-package-lifecycle-ledger.json')), false);
    const receiptIndependent = runCli([
      'packages', 'status', '--package-id', FIXTURE_CONSUMER_PACKAGE_ID, '--scope', 'workspace', '--target-workspace', workspace,
    ], env) as any;
    assert.equal(receiptIndependent.opl_agent_package_status.materialization_readiness.status, 'current');
    assert.equal(
      Object.hasOwn(receiptIndependent.opl_agent_package_status.materialization_readiness, 'lifecycle_receipt_ref'),
      false,
    );
    assert.equal(receiptIndependent.opl_agent_package_status.status, 'available');
    assert.equal(receiptIndependent.opl_agent_package_status.operational_ready, true);
    assert.equal(receiptIndependent.opl_agent_package_status.launch_allowed, true);
    assert.equal(receiptIndependent.opl_agent_package_status.launch_blocked_reason, null);
    assert.equal(receiptIndependent.opl_agent_package_status.repair_action, null);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('MAG consumer profile promotes its six grant Skills into a profile-specific readiness floor', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'opl-package-mag-consumer-profile-'));
  const workspace = path.join(root, 'workspace');
  const providerManifestPath = writeFixtureCapabilityProvider(path.join(root, 'provider'), '0.1.0', {
    moduleIds: MAG_PROVIDER_MODULE_IDS,
    specialtySkillIds: MAG_SPECIALTY_SKILL_IDS,
    consumerProfiles: [{
      profile_id: MAG_CONSUMER_PROFILE_ID,
      consumer_agent_id: 'mag',
      required_export_ids: MAG_REQUIRED_SKILL_IDS,
      required_module_ids: MAG_REQUIRED_MODULE_IDS,
    }],
  });
  const consumerManifestPath = writeRawMasConsumer(
    path.join(root, 'consumer'),
    providerManifestPath,
    '0.1.0a4',
    {
      packageId: 'fixture.mag',
      providerPackageId: FIXTURE_PROVIDER_PACKAGE_ID,
      agentId: 'mag',
      pluginId: 'med-autogrant',
      consumerProfileId: MAG_CONSUMER_PROFILE_ID,
      requiredExportIds: MAG_REQUIRED_SKILL_IDS,
      requiredModuleIds: MAG_REQUIRED_MODULE_IDS,
    },
  );
  const env = {
    OPL_STATE_DIR: path.join(root, 'state'),
    CODEX_HOME: path.join(root, 'codex-home'),
  };
  try {
    bindMasWorkspace(workspace, env);
    const installed = await runCliAsync([
      'packages', 'install', '--manifest-url', consumerManifestPath,
      '--trust-tier', 'first_party', '--scope', 'workspace', '--target-workspace', workspace,
    ], env) as any;
    const lock = installed.opl_agent_package_install.package_lock;
    assert.equal(lock.capability_dependencies[0].consumer_profile_id, MAG_CONSUMER_PROFILE_ID);
    assert.equal(lock.resolved_dependencies[0].consumer_profile_id, MAG_CONSUMER_PROFILE_ID);
    assert.deepEqual(
      lock.scope_materializations[0].required_skill_ids.slice().sort(),
      MAG_REQUIRED_SKILL_IDS.slice().sort(),
    );
    assert.equal(
      fs.existsSync(path.join(workspace, '.codex', 'skills', 'medical-methodology-planner', 'SKILL.md')),
      true,
    );

    fs.rmSync(
      path.join(workspace, '.codex', 'skills', 'medical-methodology-planner'),
      { recursive: true, force: true },
    );
    const missing = runCli([
      'packages', 'status', '--package-id', 'fixture.mag',
      '--scope', 'workspace', '--target-workspace', workspace,
    ], env) as any;
    assert.equal(missing.opl_agent_package_status.materialization_readiness.status, 'missing');
    assert.deepEqual(
      missing.opl_agent_package_status.materialization_readiness.core_readiness.required_skill_ids.slice().sort(),
      MAG_REQUIRED_SKILL_IDS.slice().sort(),
    );
    assert.equal(missing.opl_agent_package_status.operational_ready, false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('consumer profile cannot be selected by a different Agent', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'opl-package-consumer-profile-owner-'));
  const workspace = path.join(root, 'workspace');
  const providerManifestPath = writeFixtureCapabilityProvider(path.join(root, 'provider'), '0.1.0', {
    moduleIds: MAG_PROVIDER_MODULE_IDS,
    specialtySkillIds: MAG_SPECIALTY_SKILL_IDS,
    consumerProfiles: [{
      profile_id: MAG_CONSUMER_PROFILE_ID,
      consumer_agent_id: 'mag',
      required_export_ids: MAG_REQUIRED_SKILL_IDS,
      required_module_ids: MAG_REQUIRED_MODULE_IDS,
    }],
  });
  const consumerManifestPath = writeRawMasConsumer(
    path.join(root, 'consumer'),
    providerManifestPath,
    '0.1.0a4',
    {
      packageId: 'fixture.mas-profile-mismatch',
      providerPackageId: FIXTURE_PROVIDER_PACKAGE_ID,
      agentId: 'fixture-mas',
      pluginId: 'fixture-mas',
      consumerProfileId: MAG_CONSUMER_PROFILE_ID,
      requiredExportIds: MAG_REQUIRED_SKILL_IDS,
      requiredModuleIds: MAG_REQUIRED_MODULE_IDS,
    },
  );
  const env = {
    OPL_STATE_DIR: path.join(root, 'state'),
    CODEX_HOME: path.join(root, 'codex-home'),
  };
  try {
    bindMasWorkspace(workspace, env);
    const failed = runCliFailure([
      'packages', 'install', '--manifest-url', consumerManifestPath,
      '--trust-tier', 'first_party', '--scope', 'workspace', '--target-workspace', workspace,
    ], env);
    assert.equal(failed.payload.error.details.failure_code, 'agent_package_dependency_incompatible');
    assert.deepEqual(failed.payload.error.details.reasons, ['consumer_profile_consumer_mismatch']);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('MAS dependency readiness is presence and callability only, not SemVer or ABI gated', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'opl-package-dependency-latest-compatible-'));
  const workspace = path.join(root, 'workspace');
  const providerManifestPath = writeFixtureCapabilityProvider(path.join(root, 'provider'), '0.2.0', {
    capabilityAbi: 'mas-scholar-skills.v2',
  });
  const consumerManifestPath = writeFixtureMasConsumer(path.join(root, 'consumer'), providerManifestPath);
  const env = {
    OPL_STATE_DIR: path.join(root, 'state'),
    CODEX_HOME: path.join(root, 'codex-home'),
  };
  try {
    bindMasWorkspace(workspace, env);
    const installed = await runCliAsync([
      'packages', 'install', '--manifest-url', consumerManifestPath,
      '--trust-tier', 'first_party', '--scope', 'workspace', '--target-workspace', workspace,
    ], env) as any;
    assert.equal(installed.opl_agent_package_install.status, 'installed');
    assert.equal(
      installed.opl_agent_package_install.package_lock.resolved_dependencies[0].installed_version,
      '0.2.0',
    );

    const status = runCli([
      'packages', 'status', '--package-id', FIXTURE_CONSUMER_PACKAGE_ID,
      '--scope', 'workspace', '--target-workspace', workspace,
    ], env) as any;
    const readiness = status.opl_agent_package_status.package_dependency_readiness;
    assert.equal(readiness.status, 'current');
    assert.equal(readiness.operational_ready, true);
    assert.equal(readiness.dependencies[0].status, 'current');
    assert.deepEqual(readiness.dependencies[0].reasons, []);
    assert.equal(status.opl_agent_package_status.status, 'available');
    assert.equal(status.opl_agent_package_status.operational_ready, true);
    assert.equal(status.opl_agent_package_status.launch_allowed, true);
    assert.equal(status.opl_agent_package_status.launch_blocked_reason, null);
    assert.equal(status.opl_agent_package_status.repair_action, null);
    assert.equal(
      fs.readFileSync(
        path.join(workspace, '.codex', 'skills', 'medical-manuscript-writing', 'helper.txt'),
        'utf8',
      ),
      'medical-manuscript-writing helper 0.2.0\n',
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('MAS dependency closure update atomically rematerializes known scopes', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'opl-package-dependency-rollback-'));
  const stateDir = path.join(root, 'state');
  const codexHome = path.join(root, 'codex-home');
  const workspace = path.join(root, 'workspace');
  const secondWorkspace = path.join(root, 'workspace-two');
  fs.mkdirSync(workspace, { recursive: true });
  fs.mkdirSync(secondWorkspace, { recursive: true });
  const providerV1Root = path.join(root, 'provider-v1');
  const consumerV1Root = path.join(root, 'consumer-v1');
  const providerV2Root = path.join(root, 'provider-v2');
  const consumerV2Root = path.join(root, 'consumer-v2');
  const providerV1 = writeFixtureCapabilityProvider(providerV1Root, '0.1.0');
  const consumerV1 = writeFixtureMasConsumer(consumerV1Root, providerV1, '0.1.0a4');
  const providerV2 = writeFixtureCapabilityProvider(providerV2Root, '0.1.1');
  const consumerV2 = writeFixtureMasConsumer(consumerV2Root, providerV2, '0.1.0');
  const env = { OPL_STATE_DIR: stateDir, CODEX_HOME: codexHome };
  const helperPath = path.join(workspace, '.codex', 'skills', 'medical-manuscript-writing', 'helper.txt');
  try {
    bindMasWorkspace(workspace, env);
    bindMasWorkspace(secondWorkspace, env);
    await runCliAsync([
      'packages', 'install', '--manifest-url', consumerV1, '--trust-tier', 'first_party',
      '--scope', 'workspace', '--target-workspace', workspace,
    ], env);
    runCli([
      'packages', 'activate', FIXTURE_CONSUMER_PACKAGE_ID, '--scope', 'workspace', '--target-workspace', secondWorkspace,
    ], env);
    assert.match(fs.readFileSync(helperPath, 'utf8'), /0\.1\.0/);

    const updated = await runCliAsync([
      'packages', 'update', FIXTURE_CONSUMER_PACKAGE_ID, '--manifest-url', consumerV2, '--trust-tier', 'first_party',
    ], env) as any;
    assert.equal(updated.opl_agent_package_update.status, 'updated');
    assert.deepEqual(
      updated.opl_agent_package_update.dependency_package_locks
        .map((entry: any) => `${entry.package_id}@${entry.package_version}`).sort(),
      [`${FIXTURE_PROVIDER_PACKAGE_ID}@0.1.1`, `${FIXTURE_CONSUMER_PACKAGE_ID}@0.1.0`],
    );
    assert.match(fs.readFileSync(helperPath, 'utf8'), /0\.1\.1/);
    const updatedStatus = runCli([
      'packages', 'status', '--package-id', FIXTURE_CONSUMER_PACKAGE_ID,
      '--scope', 'workspace', '--target-workspace', workspace,
    ], env) as any;
    assert.equal(updatedStatus.opl_agent_package_status.materialization_readiness.status, 'current');
    const secondUpdatedStatus = runCli([
      'packages', 'status', '--package-id', FIXTURE_CONSUMER_PACKAGE_ID,
      '--scope', 'workspace', '--target-workspace', secondWorkspace,
    ], env) as any;
    assert.equal(secondUpdatedStatus.opl_agent_package_status.materialization_readiness.status, 'current');
  } finally {
    removeFixtureTree(root);
  }
});

test('MAS scope materialization never overwrites an unowned local Skill', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'opl-package-scope-collision-'));
  const workspace = path.join(root, 'workspace');
  const localSkill = path.join(workspace, '.codex', 'skills', 'medical-manuscript-writing');
  const providerManifest = writeFixtureCapabilityProvider(path.join(root, 'provider'));
  const consumerManifest = writeFixtureMasConsumer(path.join(root, 'consumer'), providerManifest);
  const env = { OPL_STATE_DIR: path.join(root, 'state'), CODEX_HOME: path.join(root, 'codex-home') };
  try {
    fs.mkdirSync(localSkill, { recursive: true });
    fs.writeFileSync(path.join(localSkill, 'SKILL.md'), '# user-owned local Skill\n');
    bindMasWorkspace(workspace, env);
    const blocked = await runCliFailure([
      'packages', 'install', '--manifest-url', consumerManifest, '--trust-tier', 'first_party',
      '--scope', 'workspace', '--target-workspace', workspace,
    ], env);
    assert.equal(blocked.payload.error.details.failure_code, 'agent_package_scope_unowned_skill_collision');
    assert.deepEqual(blocked.payload.error.details.collision_skill_ids, ['medical-manuscript-writing']);
    assert.equal(fs.readFileSync(path.join(localSkill, 'SKILL.md'), 'utf8'), '# user-owned local Skill\n');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('MAS scope materialization rejects forged legacy OPL management markers', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'opl-package-scope-forged-managed-'));
  const workspace = path.join(root, 'workspace');
  const localSkill = path.join(workspace, '.codex', 'skills', 'medical-manuscript-writing');
  const providerRoot = path.join(root, 'provider');
  const providerManifest = writeFixtureCapabilityProvider(providerRoot);
  const consumerManifest = writeFixtureMasConsumer(path.join(root, 'consumer'), providerManifest);
  const env = { OPL_STATE_DIR: path.join(root, 'state'), CODEX_HOME: path.join(root, 'codex-home') };
  try {
    fs.mkdirSync(localSkill, { recursive: true });
    fs.writeFileSync(path.join(localSkill, 'SKILL.md'), '# user-owned local Skill\n');
    fs.writeFileSync(path.join(localSkill, '.opl-connect-skill-sync.json'), formatJsonPayload({
      surface_kind: 'opl_connect_managed_mas_scholar_skills_specialist_dir',
      schema_version: 'g1',
      pack_id: 'medical-manuscript-writing',
      source_skill_dir: path.join(root, 'unrelated', 'skills', 'medical-manuscript-writing'),
    }));
    bindMasWorkspace(workspace, env);
    const blocked = await runCliFailure([
      'packages', 'install', '--manifest-url', consumerManifest, '--trust-tier', 'first_party',
      '--scope', 'workspace', '--target-workspace', workspace,
    ], env);
    assert.equal(blocked.payload.error.details.failure_code, 'agent_package_scope_unowned_skill_collision');
    assert.deepEqual(blocked.payload.error.details.collision_skill_ids, ['medical-manuscript-writing']);
    assert.equal(fs.readFileSync(path.join(localSkill, 'SKILL.md'), 'utf8'), '# user-owned local Skill\n');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('fresh MAS install records only its installed closure', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'opl-package-fresh-install-rollback-'));
  const workspace = path.join(root, 'workspace');
  const originalSkillRoot = path.join(workspace, '.codex', 'skills', 'workspace-user-skill');
  const providerManifest = writeFixtureCapabilityProvider(path.join(root, 'provider'));
  const consumerManifest = writeFixtureMasConsumer(path.join(root, 'consumer'), providerManifest);
  const env = { OPL_STATE_DIR: path.join(root, 'state'), CODEX_HOME: path.join(root, 'codex-home') };
  try {
    fs.mkdirSync(originalSkillRoot, { recursive: true });
    fs.writeFileSync(path.join(originalSkillRoot, 'SKILL.md'), '# workspace prestate\n');
    fs.writeFileSync(path.join(originalSkillRoot, 'local.txt'), 'keep me\n');
    bindMasWorkspace(workspace, env);
    await runCliAsync([
      'packages', 'install', '--manifest-url', consumerManifest, '--trust-tier', 'first_party',
      '--scope', 'workspace', '--target-workspace', workspace,
    ], env);

    const lockIndex = JSON.parse(fs.readFileSync(
      path.join(env.OPL_STATE_DIR, 'agent-package-locks.json'),
      'utf8',
    ));
    assert.equal('last_known_good_transactions' in lockIndex, false);
    assert.equal(runCli(['packages', 'status', '--package-id', FIXTURE_CONSUMER_PACKAGE_ID], env)
      .opl_agent_package_status.installed_package_count, 1);
    assert.equal(runCli(['packages', 'status', '--package-id', FIXTURE_PROVIDER_PACKAGE_ID], env)
      .opl_agent_package_status.installed_package_count, 1);
    assert.equal(fs.readFileSync(path.join(originalSkillRoot, 'SKILL.md'), 'utf8'), '# workspace prestate\n');
    assert.equal(fs.readFileSync(path.join(originalSkillRoot, 'local.txt'), 'utf8'), 'keep me\n');
    assert.equal(fs.existsSync(path.join(workspace, '.codex', 'skills', 'medical-manuscript-writing')), true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('multi-provider scope readiness checks every provider and activation compensates partial writes', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'opl-package-multi-provider-scope-'));
  const workspace = path.join(root, 'workspace');
  const failedWorkspace = path.join(root, 'failed-workspace');
  const providerARoot = path.join(root, 'provider-a');
  const providerA = writeFixtureCapabilityProvider(providerARoot, '0.1.0', {
    packageId: 'capability-provider-a',
    capabilityAbi: 'capability-provider-a.v1',
    coreSkillIds: ['provider-a-skill'],
    moduleIds: ['provider-a.module'],
  });
  const providerBRoot = path.join(root, 'provider-b');
  const providerB = writeFixtureCapabilityProvider(providerBRoot, '0.1.0', {
    packageId: 'capability-provider-b',
    capabilityAbi: 'capability-provider-b.v1',
    coreSkillIds: ['provider-b-skill'],
    moduleIds: ['provider-b.module'],
  });
  const consumer = writeFixtureMasConsumer(path.join(root, 'consumer'), providerA);
  const manifest = JSON.parse(fs.readFileSync(consumer, 'utf8'));
  Object.assign(manifest.capability_dependencies[0], {
    module_id: 'provider-a',
    package_id: 'capability-provider-a',
    manifest_url: providerA,
    capability_abi: 'capability-provider-a.v1',
    required_export_ids: ['provider-a-skill'],
    required_module_ids: ['provider-a.module'],
  });
  fs.writeFileSync(consumer, formatJsonPayload(manifest));
  appendCapabilityDependency(consumer, {
    packageId: 'capability-provider-b',
    manifestPath: providerB,
    capabilityAbi: 'capability-provider-b.v1',
    skillIds: ['provider-b-skill'],
    moduleIds: ['provider-b.module'],
  });
  const env = { OPL_STATE_DIR: path.join(root, 'state'), CODEX_HOME: path.join(root, 'codex-home') };
  try {
    fs.mkdirSync(workspace, { recursive: true });
    fs.mkdirSync(failedWorkspace, { recursive: true });
    await runCliAsync(['packages', 'install', '--manifest-url', consumer, '--trust-tier', 'first_party'], env);
    const lockIndex = parseJsonText(fs.readFileSync(
      path.join(env.OPL_STATE_DIR, 'agent-package-locks.json'),
      'utf8',
    )) as any;
    const providerBLock = lockIndex.packages.find(
      (entry: any) => entry.package_id === 'capability-provider-b',
    );
    assert.ok(providerBLock.physical_surface.codex_plugin_cache_path);
    fs.rmSync(providerARoot, { recursive: true, force: true });
    fs.rmSync(providerBRoot, { recursive: true, force: true });
    runCli(['packages', 'activate', FIXTURE_CONSUMER_PACKAGE_ID, '--scope', 'workspace', '--target-workspace', workspace], env);
    assert.equal(
      fs.readFileSync(path.join(workspace, '.codex', 'skills', 'provider-b-skill', 'helper.txt'), 'utf8'),
      'provider-b-skill helper 0.1.0\n',
    );
    fs.rmSync(path.join(workspace, '.codex', 'skills', 'provider-b-skill'), { recursive: true, force: true });
    const degraded = runCli([
      'packages', 'status', '--package-id', FIXTURE_CONSUMER_PACKAGE_ID, '--scope', 'workspace', '--target-workspace', workspace,
    ], env).opl_agent_package_status;
    assert.equal(degraded.materialization_readiness.status, 'missing');
    assert.equal(degraded.launch_allowed, false);

    const providerBCacheSkill = path.join(
      providerBLock.physical_surface.codex_plugin_cache_path,
      'skills',
      'provider-b-skill',
    );
    fs.writeFileSync(path.join(providerBCacheSkill, 'injected.txt'), 'not content locked\n');
    const unexpectedCacheFailure = runCliFailure([
      'packages', 'activate', FIXTURE_CONSUMER_PACKAGE_ID, '--scope', 'workspace', '--target-workspace', failedWorkspace,
    ], env);
    assert.equal(
      unexpectedCacheFailure.payload.error.details.failure_code,
      'agent_package_skill_content_lock_incomplete',
    );
    assert.equal(fs.existsSync(path.join(failedWorkspace, '.codex', 'skills', 'provider-a-skill')), false);
    fs.rmSync(path.join(providerBCacheSkill, 'injected.txt'), { force: true });

    fs.rmSync(path.join(providerBCacheSkill, 'SKILL.md'), { force: true });
    const failure = runCliFailure([
      'packages', 'activate', FIXTURE_CONSUMER_PACKAGE_ID, '--scope', 'workspace', '--target-workspace', failedWorkspace,
    ], env);
    assert.equal(failure.payload.error.details.failure_code, 'capability_package_content_lock_path_missing');
    assert.equal(fs.existsSync(path.join(failedWorkspace, '.codex', 'skills', 'provider-a-skill')), false);
  } finally {
    removeFixtureTree(root);
  }
});

test('install cannot overwrite a provider that has installed required dependents', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'opl-package-provider-install-guard-'));
  const providerV1 = writeFixtureCapabilityProvider(path.join(root, 'provider-v1'));
  const providerV2 = writeFixtureCapabilityProvider(path.join(root, 'provider-v2'), '0.1.1');
  const consumer = writeFixtureMasConsumer(path.join(root, 'consumer'), providerV1);
  const env = { OPL_STATE_DIR: path.join(root, 'state'), CODEX_HOME: path.join(root, 'codex-home') };
  try {
    await runCliAsync(['packages', 'install', '--manifest-url', consumer, '--trust-tier', 'first_party'], env);
    const failure = await runCliFailure([
      'packages', 'install', '--manifest-url', providerV2, '--trust-tier', 'first_party',
    ], env);
    assert.equal(failure.payload.error.details.failure_code, 'agent_package_required_by_installed_dependents');
    assert.deepEqual(failure.payload.error.details.dependent_package_ids, [FIXTURE_CONSUMER_PACKAGE_ID]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('failed MAS closure update restores package state and scope files together', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'opl-package-dependency-failure-'));
  const stateDir = path.join(root, 'state');
  const codexHome = path.join(root, 'codex-home');
  const workspace = path.join(root, 'workspace');
  fs.mkdirSync(workspace, { recursive: true });
  const providerV1 = writeFixtureCapabilityProvider(path.join(root, 'provider-v1'), '0.1.0');
  const consumerV1 = writeFixtureMasConsumer(path.join(root, 'consumer-v1'), providerV1, '0.1.0a4');
  const providerV2 = writeFixtureCapabilityProvider(path.join(root, 'provider-v2'), '0.1.1');
  const consumerV2 = writeFixtureMasConsumer(path.join(root, 'consumer-v2'), providerV2, '0.1.0');
  const env = { OPL_STATE_DIR: stateDir, CODEX_HOME: codexHome };
  const helperPath = path.join(workspace, '.codex', 'skills', 'medical-manuscript-writing', 'helper.txt');
  const status = () => runCli([
    'packages', 'status', '--package-id', FIXTURE_CONSUMER_PACKAGE_ID,
    '--scope', 'workspace', '--target-workspace', workspace,
  ], env).opl_agent_package_status;
  const withReadOnlyState = (action: () => void) => {
    fs.chmodSync(stateDir, 0o555);
    try {
      action();
    } finally {
      fs.chmodSync(stateDir, 0o755);
    }
  };
  try {
    bindMasWorkspace(workspace, env);
    fs.mkdirSync(stateDir, { recursive: true });
    withReadOnlyState(() => {
      runCliFailure([
        'packages', 'install', '--manifest-url', consumerV1, '--trust-tier', 'first_party',
        '--scope', 'workspace', '--target-workspace', workspace,
      ], env);
    });
    assert.equal(fs.existsSync(path.join(workspace, '.codex', 'skills')), false);
    assert.equal(runCli([
      'packages', 'status', '--package-id', FIXTURE_CONSUMER_PACKAGE_ID,
      '--scope', 'workspace', '--target-workspace', workspace,
    ], env).opl_agent_package_status.installed_package_count, 0);

    await runCliAsync([
      'packages', 'install', '--manifest-url', consumerV1, '--trust-tier', 'first_party',
      '--scope', 'workspace', '--target-workspace', workspace,
    ], env);

    withReadOnlyState(() => {
      runCliFailure([
        'packages', 'update', FIXTURE_CONSUMER_PACKAGE_ID, '--manifest-url', consumerV2, '--trust-tier', 'first_party',
      ], env);
    });
    assert.match(fs.readFileSync(helperPath, 'utf8'), /0\.1\.0/);
    assert.equal(status().materialization_readiness.status, 'current');
    assert.equal(status().installed_packages[0].package_version, '0.1.0-alpha.4');

    await runCliAsync([
      'packages', 'update', FIXTURE_CONSUMER_PACKAGE_ID, '--manifest-url', consumerV2, '--trust-tier', 'first_party',
    ], env);
    assert.match(fs.readFileSync(helperPath, 'utf8'), /0\.1\.1/);
  } finally {
    if (fs.existsSync(stateDir)) fs.chmodSync(stateDir, 0o755);
    fs.rmSync(root, { recursive: true, force: true });
  }
});
