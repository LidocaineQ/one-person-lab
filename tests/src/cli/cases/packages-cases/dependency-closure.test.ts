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
import { createFakeCodexPluginManagerFixture, runCliInCwd } from '../../helpers.ts';
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
    assert.equal(Object.hasOwn(failure.payload.error.details, 'repair_commands'), false);
    assert.equal(
      failure.payload.error.details.uninstall_policy,
      'remove_dependents_in_the_same_transaction_or_uninstall_dependents_first',
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
