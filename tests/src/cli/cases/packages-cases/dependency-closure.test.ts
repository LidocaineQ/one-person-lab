import { pathToFileURL } from 'node:url';

import {
  assert,
  fs,
  os,
  parseJsonText,
  path,
  test,
} from './helpers.ts';
import {
  scholarSkillsCoreSkillIds as coreSkillIds,
  scholarSkillsModuleIds as moduleIds,
  writeCapabilityProvider as writeRawCapabilityProvider,
  writeMasConsumer as writeRawMasConsumer,
} from './capability-fixtures.ts';
import { validateCapabilityProvider } from '../../../../../src/adapters/integration/agent-package-registry-parts/dependency-closure.ts';
import { normalizePackageManifest } from '../../../../../src/adapters/integration/agent-package-registry-parts/manifest-normalizers.ts';

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

test('consumer profile cannot be selected by a different Agent', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'opl-package-consumer-profile-owner-'));
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
  try {
    const consumer = normalizePackageManifest(
      parseJsonText(fs.readFileSync(consumerManifestPath, 'utf8')),
      pathToFileURL(consumerManifestPath).toString(),
    );
    const provider = normalizePackageManifest(
      parseJsonText(fs.readFileSync(providerManifestPath, 'utf8')),
      pathToFileURL(providerManifestPath).toString(),
    );
    assert.throws(
      () => validateCapabilityProvider(
        consumer.capability_dependencies[0],
        provider,
        'fixture-manifest-sha256',
        consumer.agent_id,
      ),
      (error: any) => error?.details?.failure_code === 'agent_package_dependency_incompatible'
        && error?.details?.reasons?.length === 1
        && error.details.reasons[0] === 'consumer_profile_consumer_mismatch',
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
