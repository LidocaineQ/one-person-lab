import {
  assert,
  createFakeCodexFixture,
  fs,
  parseJsonText,
  path,
  repoRoot,
  runCli,
  runCliFailure,
  shellSingleQuote,
  test,
} from '../helpers.ts';
import os from 'node:os';
import { formatJsonPayload } from '../../../../src/kernel/json-file.ts';
import { loadFrameworkContracts } from '../../../../src/authority/contracts/contracts.ts';
import { buildManagedUpdateKernelProjection } from '../../../../src/adapters/integration/managed-update-kernel.ts';
import { selectedManagedUpdateComponentIds } from '../../../../src/adapters/integration/managed-update-owner-boundary.ts';
import { agentPackageManifest } from './packages-cases/helpers.ts';

function readManagedUpdateKernelContract() {
  return parseJsonText(
    fs.readFileSync(
      path.join(repoRoot, 'contracts/opl-framework/managed-update-kernel-contract.json'),
      'utf8',
    ),
  ) as Record<string, any>;
}

function writeFixtureFile(root: string, relativePath: string, content: string) {
  const targetPath = path.join(root, relativePath);
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  fs.writeFileSync(targetPath, content);
  return targetPath;
}

let macAppCarrierFixtureQueue = Promise.resolve();

async function withMacAppCarrierFixture<T>(
  installedVersion: string,
  latestVersion: string | null,
  callback: () => Promise<T>,
): Promise<T> {
  const previousFixture = macAppCarrierFixtureQueue;
  let releaseFixture!: () => void;
  macAppCarrierFixtureQueue = new Promise<void>((resolve) => {
    releaseFixture = resolve;
  });
  await previousFixture;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'opl-macos-app-carrier-'));
  const appPath = path.join(root, 'One Person Lab.app');
  fs.mkdirSync(path.join(appPath, 'Contents'), { recursive: true });
  fs.writeFileSync(path.join(appPath, 'Contents', 'Info.plist'), 'fixture');
  const plutilPath = writeFixtureFile(
    root,
    'bin/plutil',
    `#!/bin/sh\nprintf '%s\\n' '{"CFBundleIdentifier":"cn.onepersonlab.opl","CFBundleShortVersionString":"${installedVersion}"}'\n`,
  );
  const curlPath = writeFixtureFile(
    root,
    'bin/curl',
    latestVersion === null
      ? '#!/bin/sh\nexit 28\n'
      : `#!/bin/sh\nprintf '%s\\n' 'version: ${latestVersion}'\n`,
  );
  fs.chmodSync(plutilPath, 0o755);
  fs.chmodSync(curlPath, 0o755);
  const envKeys = [
    'OPL_APP_CARRIER_PLATFORM',
    'OPL_APP_INSTALLED_PATH',
    'OPL_PLUTIL_BIN',
    'OPL_CURL_BIN',
    'OPL_APP_LATEST_METADATA_URL',
  ] as const;
  const previous = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));
  process.env.OPL_APP_CARRIER_PLATFORM = 'darwin';
  process.env.OPL_APP_INSTALLED_PATH = appPath;
  process.env.OPL_PLUTIL_BIN = plutilPath;
  process.env.OPL_CURL_BIN = curlPath;
  process.env.OPL_APP_LATEST_METADATA_URL = 'https://fixture.invalid/latest-mac.yml';
  try {
    return await callback();
  } finally {
    for (const key of envKeys) {
      const value = previous[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    fs.rmSync(root, { recursive: true, force: true });
    releaseFixture();
  }
}

test('managed update contract exposes only OPL Base, OPL App, and OPL Packages lifecycle owners', () => {
  const contract = readManagedUpdateKernelContract();

  assert.deepEqual(contract.components, ['opl_base', 'opl_app', 'opl_packages']);
  assert.deepEqual(contract.component_classes, contract.components);
  assert.deepEqual(
    contract.lifecycle_owners.map((entry: Record<string, unknown>) => entry.lifecycle_owner),
    contract.components,
  );
  assert.equal(Object.hasOwn(contract, 'legacy_component_aliases'), false);
  assert.deepEqual(
    contract.update_plane_state_machine.component_routes.map((entry: Record<string, unknown>) => entry.component_class),
    ['opl_app', 'opl_base', 'opl_packages'],
  );
  assert.deepEqual(
    contract.owner_execution_boundary_contract.runner_can_execute_only_for,
    ['opl_base', 'opl_packages'],
  );
  assert.deepEqual(
    contract.providers.map((entry: Record<string, unknown>) => entry.lifecycle_owner),
    ['opl_app', 'opl_base', 'opl_packages'],
  );
  const appCarrier = contract.providers.find((entry: Record<string, unknown>) =>
    entry.provider_id === 'installation_carrier'
  ) as Record<string, any>;
  const macCarrier = appCarrier.carrier_variants.find(
    (entry: Record<string, unknown>) => entry.carrier_type === 'macos_standard',
  );
  assert.equal(macCarrier.host_update_route, 'one_person_lab_app_standard_updater_or_signed_installer');
  assert.equal(macCarrier.latest_version_source, 'one-person-lab-app latest-mac.yml version');
  assert.deepEqual(macCarrier.currentness_values, ['unknown', 'current', 'update_available']);

  const packages = contract.providers.find((entry: Record<string, unknown>) =>
    entry.lifecycle_owner === 'opl_packages'
  );
  assert.equal(packages.owner, 'installed-package-owner-descriptors');
  assert.equal(packages.role, 'Clean managed native module Git checkout reconciliation');
  assert.equal(packages.mutation_scope, 'clean_managed_native_module_roots_only');
  assert.equal(Object.hasOwn(packages, 'transaction_status_fields'), false);
  assert.equal(Object.hasOwn(packages, 'transaction_guards'), false);
  assert.deepEqual(packages.currentness_identity_fields, [
    'module_id',
    'install_origin',
    'source_policy',
    'git_head_sha',
    'owner_currentness',
  ]);
  assert.equal(packages.auto_apply.current_noop_receipt_policy, 'do_not_write_component_receipt');
  assert.equal(packages.auto_apply.eligible_scope, 'native_git_checkout_modules_only');
  assert.equal(Object.hasOwn(packages, 'bundled_full_runtime_reconciliation'), false);
  assert.equal(Object.hasOwn(packages, 'profile_migration_policy'), false);
  assert.equal(
    packages.partial_outcome_policy,
    'delegate_each_clean_managed_module_and_report_current_changed_manual_failed_separately',
  );
  assert.deepEqual(contract.base_dependency_catalog_contract.update_mode_values, [
    'silent_managed',
    'explicit_owner_delegated',
    'detect_only_guidance',
  ]);
  assert.equal(contract.base_dependency_catalog_contract.external_dependency_policy.confirmation_required, true);
  assert.equal(contract.base_dependency_catalog_contract.external_dependency_policy.auto_apply_allowed, false);
  assert.equal(contract.base_dependency_catalog_contract.external_dependency_policy.unverified_owner_action, null);
  assert.equal(contract.base_dependency_catalog_contract.external_dependency_policy.temporal_server_currentness_inference_allowed, false);
  assert.equal(
    contract.base_dependency_catalog_contract.flow_dependencies_projection.app_hardcoded_dependency_classification_allowed,
    false,
  );

  assert.deepEqual(contract.app_action_consumer_policy.canonical_delegated_surfaces, {
    module_sync: 'opl packages update',
    settings_sync_capabilities: 'opl packages update',
    settings_apply_opl_packages: 'opl packages update',
    settings_check_opl_base_update: 'opl update check',
    settings_apply_opl_base_update: 'opl update apply',
    settings_check_app_update: 'opl app state --profile fast',
    settings_rollback_runtime_substrate: 'opl update rollback',
  });
});

test('full managed update projection materializes only the three lifecycle owners', async () => {
  const output = await buildManagedUpdateKernelProjection(loadFrameworkContracts(), {
    operation: 'status',
  }) as Record<string, any>;

  assert.deepEqual(
    output.managed_update.components.map((component: Record<string, unknown>) => component.component_id),
    ['opl_app', 'opl_base', 'opl_packages'],
  );
  assert.equal(
    output.managed_update.components.every(
      (component: Record<string, unknown>) => component.component_class === component.component_id,
    ),
    true,
  );
});

test('opl update projects coordinated Base and installed Packages while rejecting internal selectors', () => {
  const output = runCli(['update', 'status']) as Record<string, any>;
  const components = output.managed_update.components;

  assert.equal(output.managed_update.requested_component_id, null);
  assert.equal(output.managed_update.requested_lifecycle_owner, null);
  assert.deepEqual(components.map((entry: Record<string, unknown>) => entry.component_id), ['opl_app', 'opl_base', 'opl_packages']);
  const base = components.find((entry: Record<string, unknown>) => entry.component_id === 'opl_base');
  assert.equal(base.lifecycle_owner, 'opl_base');
  assert.equal(base.provider_id, 'runtime_substrate');
  assert.equal(base.authority_boundary.can_mutate_homebrew, false);
  assert.equal(output.managed_update.authority_boundary.can_write_domain_truth, false);

  const failure = runCliFailure(['update', 'status', '--component', 'runtime_substrate']);
  assert.equal(failure.payload.error.code, 'cli_usage_error');
  assert.match(failure.payload.error.message, /Unknown option '--component'/);
});

test('OPL Packages projection delegates currentness to native module carriers', async () => {
  const output = await buildManagedUpdateKernelProjection(loadFrameworkContracts(), {
    operation: 'plan',
    componentId: 'opl_packages',
  }) as Record<string, any>;
  const components = output.managed_update.components;

  assert.equal(components.length, 1);
  assert.equal(components[0].component_id, 'opl_packages');
  assert.equal(components[0].provider_id, 'capability_packages');
  assert.equal(Object.hasOwn(components[0], 'projection_status'), false);
  assert.equal(Object.hasOwn(components[0], 'profile_migration_status'), false);
  assert.equal(components[0].owner_route.owner, 'installed-package-owner-descriptors');
  assert.equal(components[0].owner_route.apply_owner, 'opl_connect_native_package_carrier');
  assert.equal(Object.hasOwn(components[0].current, 'transaction_guards'), false);
  assert.equal(components[0].current.currentness_authority, 'native_git_checkout');
  assert.equal(
    components[0].current.shared_snapshot_role,
    'explicit_full_offline_integration_qa_compatibility_only',
  );
  assert.equal(Object.hasOwn(components[0].current, 'channel_manifest'), false);
  assert.equal(Object.hasOwn(components[0].current, 'owner_channel_refs'), false);
  assert.equal(components[0].receipt.source_manifest_ref, 'opl://packages/native-git-checkout');
  assert.deepEqual(components[0].receipt.content_identity_fields, [
    'digest',
    'sha256',
    'source_fingerprint',
    'git_head_sha',
  ]);
  assert.equal(components[0].authority_boundary.can_overwrite_dirty_checkout, false);
  assert.equal(components[0].authority_boundary.can_overwrite_developer_checkout, false);
});

test('OPL Packages managed-update projection is independent of legacy lock authority', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'opl-managed-update-legacy-read-model-'));
  const homeDir = path.join(root, 'home');
  const stateDir = path.join(root, 'state');
  const pluginSource = path.join(root, 'native-plugin');
  const nativePackageId = 'third.party.research';
  const legacyPackageId = 'legacy.package';
  fs.mkdirSync(path.join(pluginSource, '.codex-plugin'), { recursive: true });
  fs.mkdirSync(path.join(pluginSource, 'skills', 'third-party-research'), { recursive: true });
  const pluginManifestPath = path.join(pluginSource, '.codex-plugin', 'plugin.json');
  fs.writeFileSync(
    pluginManifestPath,
    formatJsonPayload({
      name: 'third-party-research',
      version: '1.2.3',
      skills: './skills/',
    }),
  );
  fs.writeFileSync(
    path.join(pluginSource, 'skills', 'third-party-research', 'SKILL.md'),
    '# Third Party Research\n',
  );
  const descriptorPath = path.join(pluginSource, 'opl-package.json');
  fs.writeFileSync(
    descriptorPath,
    formatJsonPayload(agentPackageManifest({
      packageId: nativePackageId,
      agentId: 'third-party-research',
      pluginId: 'third-party-research',
      distributionPayload: null,
    })),
  );
  const pluginList = JSON.stringify({
    installed: [{
      pluginId: 'third-party-research@fixture-carrier',
      version: '1.2.3',
      installed: true,
      enabled: true,
      source: { source: 'local', path: pluginSource },
      marketplaceSource: { sourceType: 'local', source: 'fixture-carrier' },
    }],
    available: [],
  });
  const codexFixture = createFakeCodexFixture(`
if [[ "$*" == "plugin list --json" ]]; then
  printf '%s\\n' ${shellSingleQuote(pluginList)}
  exit 0
fi
exit 2
`);
  const packageLock = (packageId: string) => ({
    surface_kind: 'opl_agent_package_lock',
    package_id: packageId,
    agent_id: packageId,
    package_role: 'standard_agent',
    display_name: packageId,
    publisher: 'fixture',
    package_version: '1.2.3',
    source_kind: 'manifest_url',
    manifest_url: `https://example.invalid/${packageId}.json`,
    manifest_sha256: '1'.repeat(64),
    content_digest: `sha256:${'2'.repeat(64)}`,
    artifact_digest: null,
    owner_source_commit: null,
    lock_ref: `opl://agent-package-lock/${packageId}/1.2.3/fixture`,
    physical_surface: { status: 'materialized', failure_reason: null },
    resolved_dependencies: [],
  });
  const lockPath = path.join(stateDir, 'agent-package-locks.json');
  const lockBytes = formatJsonPayload({
    surface_kind: 'opl_agent_package_lock_index',
    version: 'opl-agent-package-lock-index.v1',
    packages: [packageLock(nativePackageId), packageLock(legacyPackageId)],
  });
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(lockPath, lockBytes);
  const env = {
    HOME: homeDir,
    CODEX_HOME: path.join(homeDir, '.codex'),
    OPL_STATE_DIR: stateDir,
    OPL_MODULES_ROOT: path.join(root, 'modules'),
    OPL_CODEX_PLUGIN_BIN: codexFixture.codexPath,
    OPL_PACKAGE_CHANNEL_MANIFEST_REF: '',
  };
  const previousEnv = new Map(Object.keys(env).map((key) => [key, process.env[key]]));

  try {
    for (const [key, value] of Object.entries(env)) process.env[key] = value;
    const output = await buildManagedUpdateKernelProjection(loadFrameworkContracts(), {
      operation: 'status',
      componentId: 'opl_packages',
    }) as Record<string, any>;
    const packages = output.managed_update.components[0];

    assert.equal(packages.state, 'skipped_manual_required');
    assert.equal(packages.plan.action, 'manual_review');
    assert.equal(packages.current.projection_source, 'native_module_directory');
    assert.equal(Object.hasOwn(packages.current, 'package_lock_states'), false);
    assert.equal(Object.hasOwn(packages.current, 'installed_root_package_count'), false);
    assert.equal(Object.hasOwn(packages.current, 'legacy_authority'), false);
    assert.equal(fs.readFileSync(lockPath, 'utf8'), lockBytes);

    const corruptLockBytes = '{ invalid legacy lock\n';
    fs.writeFileSync(lockPath, corruptLockBytes);
    const unaffected = await buildManagedUpdateKernelProjection(loadFrameworkContracts(), {
      operation: 'status',
      componentId: 'opl_packages',
    }) as Record<string, any>;
    const unaffectedPackages = unaffected.managed_update.components[0];

    assert.equal(unaffectedPackages.state, 'skipped_manual_required');
    assert.equal(unaffectedPackages.plan.action, 'manual_review');
    assert.equal(unaffectedPackages.auto_apply.eligible, false);
    assert.deepEqual(unaffectedPackages.auto_apply.blocked_reasons, [
      'manual_required_targets_are_detect_only_and_skipped',
    ]);
    assert.equal(Object.hasOwn(unaffectedPackages.current, 'package_lock_states'), false);
    assert.equal(Object.hasOwn(unaffectedPackages.current, 'legacy_authority'), false);
    assert.equal(fs.readFileSync(lockPath, 'utf8'), corruptLockBytes);

    fs.rmSync(descriptorPath);
    fs.rmSync(pluginManifestPath);
    const descriptorIndependent = await buildManagedUpdateKernelProjection(loadFrameworkContracts(), {
      operation: 'status',
      componentId: 'opl_packages',
    }) as Record<string, any>;
    assert.equal(
      descriptorIndependent.managed_update.components[0].state,
      'skipped_manual_required',
    );
    assert.equal(fs.readFileSync(lockPath, 'utf8'), corruptLockBytes);
  } finally {
    for (const [key, value] of previousEnv) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(codexFixture.fixtureRoot, { recursive: true, force: true });
  }
});

test('OPL Packages aggregate consumes explicit owner currentness for clean managed Packages', async () => {
  const module = {
    module_id: 'redcube',
    label: 'RedCube AI',
    default_install: true,
    installed: true,
    install_origin: 'managed_root',
    checkout_path: '/fixture/modules/redcube-ai',
    managed_checkout_path: '/fixture/modules/redcube-ai',
    health_status: 'ready',
    recommended_action: null,
    source_policy: {
      effective_install_update_source: 'git_checkout',
    },
    git: { dirty: false, sync_status: 'behind' },
  };
  const output = await buildManagedUpdateKernelProjection(loadFrameworkContracts(), {
    operation: 'status',
    componentId: 'opl_packages',
  }, {
    buildOplModules: (() => ({ modules: { modules: [module] } })) as never,
    readFirstPartyPackageOwnerCurrentness: async (packageIds) => {
      assert.deepEqual(packageIds, ['rca']);
      return [{
        package_id: 'rca',
        status: 'update_available',
        reasons: ['package_version_changed'],
        installed_version: '0.2.7',
        target_version: '0.2.15',
        installed_content_digest: null,
        target_content_digest: `sha256:${'1'.repeat(64)}`,
        installed_artifact_digest: null,
        target_artifact_digest: `sha256:${'2'.repeat(64)}`,
        installed_manifest_sha256: null,
        target_manifest_sha256: `sha256:${'3'.repeat(64)}`,
        source_policy: null,
        owner_channel_ref: 'ghcr.io/fixture/one-person-lab-packages/rca:latest-stable',
        catalog_freshness: 'live',
      }];
    },
  }) as Record<string, any>;
  const packages = output.managed_update.components[0];
  const rca = packages.current.module_states[0];

  assert.equal(packages.state, 'update_available');
  assert.equal(packages.plan.action, 'update');
  assert.equal(output.managed_update.summary.update_available_components_count, 1);
  assert.equal(rca.state, 'update_available');
  assert.equal(rca.owner_currentness.installed_version, '0.2.7');
  assert.equal(rca.owner_currentness.target_version, '0.2.15');
  assert.equal(rca.owner_currentness.target_manifest_sha256, `sha256:${'3'.repeat(64)}`);
  assert.equal(rca.owner_currentness.target_content_digest, `sha256:${'1'.repeat(64)}`);
  assert.equal(rca.owner_currentness.target_artifact_digest, `sha256:${'2'.repeat(64)}`);
});

test('OPL Packages aggregate preserves protected managed checkout state without owner currentness', async () => {
  const module = {
    module_id: 'redcube',
    label: 'RedCube AI',
    default_install: true,
    installed: true,
    install_origin: 'managed_root',
    checkout_path: '/fixture/modules/redcube-ai',
    managed_checkout_path: '/fixture/modules/redcube-ai',
    health_status: 'ready',
    recommended_action: null,
    source_policy: {
      effective_install_update_source: 'git_checkout',
    },
    git: { dirty: false, sync_status: 'ahead' },
  };
  const output = await buildManagedUpdateKernelProjection(loadFrameworkContracts(), {
    operation: 'status',
    componentId: 'opl_packages',
  }, {
    buildOplModules: (() => ({ modules: { modules: [module] } })) as never,
    readFirstPartyPackageOwnerCurrentness: async (packageIds) => {
      assert.deepEqual(packageIds, []);
      return [];
    },
  }) as Record<string, any>;
  const packages = output.managed_update.components[0];
  const rca = packages.current.module_states[0];

  assert.equal(packages.state, 'skipped_manual_required');
  assert.equal(packages.plan.action, 'manual_review');
  assert.equal(rca.state, 'skipped_manual_required');
  assert.equal(rca.owner_currentness, null);
});

test('OPL Packages aggregate does not claim current when owner currentness is unavailable', async () => {
  const module = {
    module_id: 'redcube',
    label: 'RedCube AI',
    default_install: true,
    installed: true,
    install_origin: 'managed_root',
    checkout_path: '/fixture/modules/redcube-ai',
    managed_checkout_path: '/fixture/modules/redcube-ai',
    health_status: 'ready',
    recommended_action: null,
    source_policy: {
      effective_install_update_source: 'git_checkout',
    },
    git: { dirty: false, sync_status: 'no_upstream' },
  };
  const output = await buildManagedUpdateKernelProjection(loadFrameworkContracts(), {
    operation: 'status',
    componentId: 'opl_packages',
  }, {
    buildOplModules: (() => ({ modules: { modules: [module] } })) as never,
    readFirstPartyPackageOwnerCurrentness: async () => [{
      package_id: 'rca',
      status: 'unavailable',
      reasons: ['agent_package_capability_channel_unavailable'],
      installed_version: null,
      target_version: null,
      installed_content_digest: null,
      target_content_digest: null,
      installed_artifact_digest: null,
      target_artifact_digest: null,
      installed_manifest_sha256: null,
      target_manifest_sha256: null,
      source_policy: null,
      owner_channel_ref: 'ghcr.io/fixture/one-person-lab-packages/rca:latest-stable',
      catalog_freshness: 'unavailable',
    }],
  }) as Record<string, any>;
  const packages = output.managed_update.components[0];
  const rca = packages.current.module_states[0];

  assert.equal(packages.state, 'skipped_manual_required');
  assert.equal(packages.plan.action, 'manual_review');
  assert.equal(rca.state, 'skipped_manual_required');
  assert.equal(rca.owner_currentness.status, 'unavailable');
});

test('OPL Packages current state cannot mask the latest failed component receipt', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'opl-managed-update-failed-receipt-'));
  const previousStateDir = process.env.OPL_STATE_DIR;
  process.env.OPL_STATE_DIR = root;
  const module = {
    module_id: 'redcube',
    label: 'RedCube AI',
    default_install: true,
    installed: true,
    install_origin: 'managed_root',
    checkout_path: '/fixture/modules/redcube-ai',
    managed_checkout_path: '/fixture/modules/redcube-ai',
    health_status: 'ready',
    recommended_action: null,
    source_policy: {
      effective_install_update_source: 'git_checkout',
    },
    git: { dirty: false, sync_status: 'behind' },
  };
  const receipt = (verifyResult: 'passed' | 'failed', activatedAt: string) => ({
    surface_kind: 'opl_managed_update_component_receipt',
    schema_version: 'opl_managed_update_component_receipt.v1',
    receipt_ref: `opl://fixture/${verifyResult}/${activatedAt}`,
    receipt_status: 'recorded',
    recorded_at: activatedAt,
    operation: 'apply',
    component_id: 'opl_packages',
    provider_id: 'capability_packages',
    adapter_id: 'capability_packages_adapter',
    source_manifest_ref: 'opl://packages/native-git-checkout',
    from_version: null,
    from_digest: null, // reuse-first: allow existing owner-routed receipt fixture.
    to_version: null,
    to_digest: null, // reuse-first: allow existing owner-routed receipt fixture.
    verify_result: verifyResult,
    activated_at: activatedAt,
    post_apply_hooks: [], // reuse-first: allow existing owner-routed receipt fixture.
    rollback_ref: null,
    repair_action: verifyResult === 'failed' ? 'update_packages' : null,
    adapter_result_ref: null,
    apply_mode: 'auto_apply',
    owner_projection: {},
    status_detail: {},
    post_apply_action_statuses: [],
    reload_guidance: {},
    authority_boundary: {},
  });
  const project = () => buildManagedUpdateKernelProjection(loadFrameworkContracts(), {
    operation: 'status',
    componentId: 'opl_packages',
  }, {
    buildOplModules: (() => ({ modules: { modules: [module] } })) as never,
    readFirstPartyPackageOwnerCurrentness: async () => [{
      package_id: 'rca',
      status: 'current',
      reasons: [],
      installed_version: '0.2.15',
      target_version: '0.2.15',
      installed_content_digest: null,
      target_content_digest: `sha256:${'1'.repeat(64)}`,
      installed_artifact_digest: null,
      target_artifact_digest: `sha256:${'2'.repeat(64)}`,
      installed_manifest_sha256: null,
      target_manifest_sha256: `sha256:${'3'.repeat(64)}`,
      source_policy: null,
      owner_channel_ref: 'ghcr.io/fixture/one-person-lab-packages/rca:latest-stable',
      catalog_freshness: 'live',
    }],
  }) as Promise<Record<string, any>>;

  try {
    fs.mkdirSync(root, { recursive: true });
    fs.writeFileSync(path.join(root, 'managed-update-component-receipts.json'), formatJsonPayload({
      surface_kind: 'opl_managed_update_component_receipt_ledger',
      version: 'opl-managed-update-component-receipts.v1',
      receipts: [receipt('failed', '2026-08-13T00:00:00.000Z')],
    }));
    const failed = (await project()).managed_update.components[0];
    assert.equal(failed.state, 'failed_with_repair');
    assert.equal(failed.plan.action, 'manual_review');
    assert.equal(failed.receipt.verify_result, 'failed');

    fs.writeFileSync(path.join(root, 'managed-update-component-receipts.json'), formatJsonPayload({
      surface_kind: 'opl_managed_update_component_receipt_ledger',
      version: 'opl-managed-update-component-receipts.v1',
      receipts: [
        receipt('passed', '2026-08-13T00:01:00.000Z'),
        receipt('failed', '2026-08-13T00:00:00.000Z'),
      ],
    }));
    const recovered = (await project()).managed_update.components[0];
    assert.equal(recovered.state, 'current');
    assert.equal(recovered.plan.action, 'none');
    assert.equal(recovered.receipt.verify_result, 'passed');
  } finally {
    if (previousStateDir === undefined) delete process.env.OPL_STATE_DIR;
    else process.env.OPL_STATE_DIR = previousStateDir;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('generic apply selects only eligible background-safe components while explicit owner actions stay scoped', async () => {
  const output = await buildManagedUpdateKernelProjection(loadFrameworkContracts(), {
    operation: 'plan',
  }) as Record<string, any>;
  const components = output.managed_update.components.map((component: Record<string, any>) => ({
    ...component,
    auto_apply: component.component_id === 'opl_packages'
      ? { ...component.auto_apply, eligible: true, app_background_safe: true, command_ref: 'opl packages update --json' }
      : { ...component.auto_apply, eligible: true, app_background_safe: false, command_ref: 'opl update apply --json' },
  }));

  assert.deepEqual(selectedManagedUpdateComponentIds({ operation: 'apply' }, components), ['opl_packages']);
  assert.deepEqual(selectedManagedUpdateComponentIds({ operation: 'apply', componentId: 'opl_base' }, components), ['opl_base']);
});

test('developer Framework source override is visible but excluded from generic background apply', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'opl-framework-source-override-plan-'));
  const target = path.join(root, 'target');
  const source = path.join(root, 'source');
  for (const directory of [target, source]) {
    fs.mkdirSync(path.join(directory, 'bin'), { recursive: true });
    fs.mkdirSync(path.join(directory, 'src', 'entrypoints'), { recursive: true });
    fs.writeFileSync(path.join(directory, 'package.json'), '{}\n', 'utf8');
    fs.writeFileSync(path.join(directory, 'bin', 'opl'), '#!/bin/sh\n', { mode: 0o755 });
    fs.writeFileSync(path.join(directory, 'src', 'entrypoints', 'cli.ts'), 'export {};\n', 'utf8');
  }
  const previousSource = process.env.OPL_FRAMEWORK_UPDATE_SOURCE;
  const previousTarget = process.env.OPL_FRAMEWORK_UPDATE_TARGET_ROOT;
  try {
    process.env.OPL_FRAMEWORK_UPDATE_SOURCE = source;
    process.env.OPL_FRAMEWORK_UPDATE_TARGET_ROOT = target;
    const output = await buildManagedUpdateKernelProjection(loadFrameworkContracts(), {
      operation: 'plan',
      componentId: 'opl_base',
    }) as Record<string, any>;
    const base = output.managed_update.components[0];
    assert.equal(base.current.opl_framework_runtime.source_root_configured, true);
    assert.equal(base.auto_apply.eligible, false);
    assert.equal(base.auto_apply.app_background_safe, false);
    assert.deepEqual(base.auto_apply.blocked_reasons, ['developer_framework_source_override_detect_only']);
  } finally {
    if (previousSource === undefined) delete process.env.OPL_FRAMEWORK_UPDATE_SOURCE;
    else process.env.OPL_FRAMEWORK_UPDATE_SOURCE = previousSource;
    if (previousTarget === undefined) delete process.env.OPL_FRAMEWORK_UPDATE_TARGET_ROOT;
    else process.env.OPL_FRAMEWORK_UPDATE_TARGET_ROOT = previousTarget;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('OPL App projects macOS owner currentness without entering opl update apply', async () => {
  await withMacAppCarrierFixture('26.8.1290', '26.8.1290', async () => {
    const output = await buildManagedUpdateKernelProjection(loadFrameworkContracts(), {
      operation: 'status',
      componentId: 'opl_app',
    }) as Record<string, any>;
    const component = output.managed_update.components[0];

    assert.equal(component.component_id, 'opl_app');
    assert.equal(component.provider_id, 'installation_carrier');
    assert.equal(component.state, 'current');
    assert.equal(component.current.carrier_type, 'macos_standard');
    assert.equal(component.current.currentness, 'current');
    assert.equal(component.current.installed_version, '26.8.1290');
    assert.equal(component.current.latest_version, '26.8.1290');
    assert.equal(component.current.host_update_route, 'one_person_lab_app_standard_updater_or_signed_installer');
    assert.equal(component.current.host_executor_required, false);
    assert.equal(component.owner_route.apply_owner, 'one-person-lab-app-standard-updater');
    assert.equal(component.owner_execution_boundary.owner_executor_id, 'one-person-lab-app-standard-updater');
    assert.equal(component.owner_execution_boundary.runner_can_execute, false);
    assert.deepEqual(component.post_apply_guidance.command_refs, []);
    assert.deepEqual(component.plan.command_refs, []);
    assert.equal(component.authority_boundary.can_mutate_installation_carrier, false);
  });
});

test('OPL App treats a newer installed macOS App as current without downgrade', async () => {
  await withMacAppCarrierFixture('26.9.0', '26.8.1290', async () => {
    const output = await buildManagedUpdateKernelProjection(loadFrameworkContracts(), {
      operation: 'status',
      componentId: 'opl_app',
    }) as Record<string, any>;
    const component = output.managed_update.components[0];
    assert.equal(component.state, 'current');
    assert.equal(component.current.currentness, 'current');
    assert.equal(component.current.update_available, false);
    assert.equal(component.plan.action, 'none');
  });
});

test('OPL App projects owner update_available for an older installed macOS App', async () => {
  await withMacAppCarrierFixture('26.8.1200', '26.8.1290', async () => {
    const output = await buildManagedUpdateKernelProjection(loadFrameworkContracts(), {
      operation: 'status',
      componentId: 'opl_app',
    }) as Record<string, any>;
    const component = output.managed_update.components[0];
    assert.equal(component.state, 'update_available');
    assert.equal(component.current.currentness, 'update_available');
    assert.equal(component.plan.action, 'manual_review');
    assert.equal(component.current.host_update_route, 'one_person_lab_app_standard_updater_or_signed_installer');
  });
});

test('OPL App remains manual_required when macOS owner metadata is unavailable', async () => {
  await withMacAppCarrierFixture('26.8.1290', null, async () => {
    const output = await buildManagedUpdateKernelProjection(loadFrameworkContracts(), {
      operation: 'status',
      componentId: 'opl_app',
    }) as Record<string, any>;
    const component = output.managed_update.components[0];
    assert.equal(component.state, 'skipped_manual_required');
    assert.equal(component.current.currentness, 'unknown');
    assert.equal(component.current.latest_version, null);
    assert.equal(component.plan.action, 'manual_review');
  });
});
