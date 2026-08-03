import { execFileSync } from 'node:child_process';

import {
  assert,
  createFakeCodexPluginManagerFixture,
  fs,
  os,
  path,
  removeFixtureTree,
  runCli,
  test,
} from '../../helpers.ts';
import {
  createFakeFamilySkillWorkspace,
} from '../../../cli-codex-default-shell-helpers.ts';
import {
  createFakeCompanionInstallEnv,
  writeFakeCompanionToolBinaries,
} from '../system-install-fixtures.ts';
import {
  reconcileBundledFullRuntimePackagesIfAvailable,
} from '../../../../../src/modules/connect/system-installation/full-runtime-package-reconciliation.ts';
import {
  MANAGED_BUNDLED_PACKAGE_FIXTURES,
  managedBundledStateFingerprint,
  markFakeCodexPluginManagerVersionsStale,
  ownerPackageDescriptorReadback,
  pathBytesDigest,
  readJsonFile,
  sha256Value,
  writeJsonPayload,
  writeManagedBundledCatalogFixture,
  withProcessEnvironment,
} from './fixtures.ts';

test('public update apply retains successful bundled roots when another native carrier verification fails', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'opl-managed-bundled-public-apply-'));
  const captureRoot = path.join(root, 'capture');
  const homeRoot = path.join(root, 'home');
  const stateRoot = path.join(root, 'state');
  const codexHome = path.join(homeRoot, 'codex-home');
  const runtimeHome = path.join(root, 'full-runtime');
  const scopeRoot = path.join(root, 'workspace-scope');
  const baseSentinelRoot = path.join(root, 'base-sentinel');
  const appSentinelRoot = path.join(root, 'app-sentinel');
  fs.mkdirSync(captureRoot, { recursive: true });
  fs.mkdirSync(runtimeHome, { recursive: true });
  fs.mkdirSync(scopeRoot, { recursive: true });
  fs.mkdirSync(baseSentinelRoot, { recursive: true });
  fs.mkdirSync(appSentinelRoot, { recursive: true });
  fs.writeFileSync(path.join(baseSentinelRoot, 'authority.bin'), Buffer.from([0, 1, 2, 3]));
  fs.writeFileSync(path.join(appSentinelRoot, 'authority.bin'), Buffer.from([4, 5, 6, 7]));
    const family = createFakeFamilySkillWorkspace(captureRoot);
    const companionEnv = createFakeCompanionInstallEnv(homeRoot);
    const companionToolBin = writeFakeCompanionToolBinaries(homeRoot);
    const managedOfficeCliSkillRoot = path.join(homeRoot, '.skills-manager', 'skills', 'officecli');
    fs.mkdirSync(path.dirname(managedOfficeCliSkillRoot), { recursive: true });
    fs.cpSync(companionEnv.OPL_OFFICECLI_SOURCE_ROOT, managedOfficeCliSkillRoot, { recursive: true });
    fs.mkdirSync(stateRoot, { recursive: true });
    writeJsonPayload(path.join(stateRoot, 'developer-supervisor.json'), {
      version: 'g1',
      enabled: 'on',
      mode: 'developer_apply_safe',
      auto_enable_github_login: 'fixture-user',
      updated_at: new Date(0).toISOString(),
      source: 'user_config',
    });
    const codexFixture = createFakeCodexPluginManagerFixture();
    const baseRuntimeRoot = path.join(root, 'base-runtime');
    const baseRuntimeBin = path.join(baseRuntimeRoot, 'current', 'bin');
    const baseRuntimeCodex = path.join(baseRuntimeBin, 'codex');
    const baseFixtureBin = path.join(root, 'base-fixture-bin');
    fs.mkdirSync(baseRuntimeBin, { recursive: true });
    fs.mkdirSync(baseFixtureBin, { recursive: true });
    fs.writeFileSync(
      baseRuntimeCodex,
      '#!/bin/sh\necho "codex-cli 0.130.0"\n',
      { mode: 0o755 },
    );
    fs.writeFileSync(
      path.join(baseFixtureBin, 'npm'),
      '#!/bin/sh\nexit 91\n',
      { mode: 0o755 },
    );
    const launchctlLog = path.join(root, 'launchctl-invocations.log');
    fs.writeFileSync(
      path.join(codexFixture.fixtureRoot, 'launchctl'),
      '#!/bin/sh\nprintf \'%s\\n\' "$*" >> "$OPL_TEST_LAUNCHCTL_LOG"\nexit 91\n',
      { mode: 0o755 },
    );
  try {
    const oldCatalog = writeManagedBundledCatalogFixture({
      workspaceRoot: family.workspaceRoot,
      outputRoot: path.join(root, 'catalog-old'),
      revision: 'old',
    });
    const rootEnv = Object.fromEntries(MANAGED_BUNDLED_PACKAGE_FIXTURES.flatMap((entry) => {
      const packageRoot = oldCatalog.roots[entry.packageId];
      return entry.packageId === 'opl-flow'
        ? [[entry.pathEnv, packageRoot], ['OPL_FLOW_REPO_ROOT', packageRoot]]
        : [[entry.pathEnv, packageRoot]];
    }));
    const commonEnv = {
      HOME: homeRoot,
      CODEX_HOME: codexHome,
      OPL_STATE_DIR: stateRoot,
      OPL_FULL_RUNTIME_HOME: runtimeHome,
      OPL_TEST_RUNTIME_SOURCE_FAULTS_ENABLED: '1',
      OPL_TEST_BUNDLED_FULL_RUNTIME_PACKAGE_CATALOG: oldCatalog.catalogPath,
      OPL_CODEX_CLI_LATEST_VERSION: '0.134.0',
      OPL_CODEX_PLUGIN_BIN: codexFixture.codexPath,
      OPL_FRAMEWORK_UPDATE_SOURCE: path.resolve('.'),
      OPL_CLI_TEST_TIMEOUT_MS: '120000',
      OPL_TEST_LAUNCHCTL_LOG: launchctlLog,
      ...companionEnv,
      PATH: `${companionToolBin}${path.delimiter}${codexFixture.fixtureRoot}${path.delimiter}${process.env.PATH ?? ''}`,
      ...rootEnv,
    };
    const installed = await withProcessEnvironment(commonEnv, async () =>
      await reconcileBundledFullRuntimePackagesIfAvailable(process.env, { lifecycleAction: 'install' })
    );
    assert.equal(installed?.status, 'completed', JSON.stringify(installed, null, 2));
    assert.deepEqual(installed?.root_package_ids, ['mag', 'mas', 'obf', 'oma', 'opl-flow', 'rca']);
    assert.equal(installed?.summary.installed_package_count, 7);
    const legacyLockPath = path.join(stateRoot, 'agent-package-locks.json');
    assert.equal(fs.existsSync(legacyLockPath), false);

    const bound = runCli([
      'workspace',
      'bind',
      '--project',
      'medautoscience',
      '--path',
      scopeRoot,
    ], commonEnv) as any;
    assert.equal(bound.workspace_catalog.binding.status, 'active');
    assert.equal(bound.workspace_catalog.binding.workspace_path, scopeRoot);

    const activated = runCli([
      'packages',
      'activate',
      'mas',
      '--scope',
      'workspace',
      '--target-workspace',
      scopeRoot,
    ], commonEnv) as any;
    assert.equal(activated.opl_agent_package_activation.status, 'already_activated');
    assert.equal(activated.opl_agent_package_activation.writes_performed, false);
    assert.equal(Object.hasOwn(activated.opl_agent_package_activation, 'package_lock'), false);
    assert.equal(Object.hasOwn(activated.opl_agent_package_activation, 'lifecycle_receipt'), false);
    assert.equal(fs.existsSync(legacyLockPath), false);

    const newCatalog = writeManagedBundledCatalogFixture({
      workspaceRoot: family.workspaceRoot,
      outputRoot: path.join(root, 'catalog-new'),
      revision: 'new',
    });
    const updateEnv = {
      ...commonEnv,
      OPL_TEST_BUNDLED_FULL_RUNTIME_PACKAGE_CATALOG: newCatalog.catalogPath,
    };
    markFakeCodexPluginManagerVersionsStale({ stateRoot, codexHome });
    const userOwnedProfiles = new Map(['AGENTS.md', 'TASTE.md'].map((fileName) => {
      const filePath = path.join(codexHome, fileName);
      const content = Buffer.from(`# User-owned ${path.basename(filePath)}\n`);
      return [filePath, content] as const;
    }));
    fs.mkdirSync(codexHome, { recursive: true });
    for (const [filePath, content] of userOwnedProfiles) fs.writeFileSync(filePath, content);
    const profileSafe = runCli(['update', 'apply'], {
      ...updateEnv,
      OPL_RUNTIME_ROOT: baseRuntimeRoot,
      OPL_CODEX_BIN: baseRuntimeCodex,
      OPL_FRAMEWORK_UPDATE_SOURCE: '',
      PATH: `${baseFixtureBin}${path.delimiter}${updateEnv.PATH}`,
    }) as any;
    assert.deepEqual(
      profileSafe.managed_update.execution.adapter_results.map((entry: any) => entry.component_id),
      ['opl_packages'],
    );
    assert.deepEqual(
      profileSafe.managed_update.components.map((entry: any) => entry.component_id),
      ['opl_packages'],
    );
    const profileAdapter = profileSafe.managed_update.execution.adapter_results.find(
      (entry: any) => entry.component_id === 'opl_packages',
    );
    assert.equal(profileAdapter.adapter_id, 'capability_packages_adapter');
    const profileReconciliation = profileAdapter.result.bundled_full_runtime_reconciliation;
    assert.equal(profileSafe.managed_update.execution.status, 'completed');
    assert.equal(profileAdapter.status, 'completed');
    assert.equal(profileReconciliation.status, 'completed');
    assert.deepEqual(
      profileReconciliation.root_installs.map((entry: any) => entry.status),
      ['completed', 'completed', 'completed', 'completed', 'completed', 'completed'],
    );
    assert.equal(
      profileReconciliation.failures.some((entry: any) => entry.package_id === 'opl-flow'),
      false,
    );
    for (const [filePath, content] of userOwnedProfiles) {
      assert.deepEqual(fs.readFileSync(filePath), content);
    }
    assert.equal(fs.existsSync(launchctlLog), false);
    assert.equal(fs.existsSync(legacyLockPath), false);

    const servicePath = path.join(homeRoot, 'Library', 'LaunchAgents', 'codexcont.plist');
    const serviceStateSentinel = path.join(root, 'codexcont-runtime-state.sentinel');
    fs.mkdirSync(path.dirname(servicePath), { recursive: true });
    fs.writeFileSync(servicePath, '<plist><string>managed-service-sentinel</string></plist>\n', 'utf8');
    fs.writeFileSync(serviceStateSentinel, 'enabled-and-running\n', 'utf8');
    markFakeCodexPluginManagerVersionsStale({
      stateRoot,
      codexHome,
      pluginIds: ['opl-flow'],
    });
    const serviceDefinitionDigest = pathBytesDigest(servicePath);
    const serviceStateDigest = pathBytesDigest(serviceStateSentinel);
    const serviceConflictPrestate = managedBundledStateFingerprint({
      homeRoot,
      stateRoot,
      codexHome,
      scopeRoot,
      baseSentinelRoot,
      appSentinelRoot,
    });
    const serviceIsolated = runCli(['update', 'apply'], updateEnv) as any;
    const serviceAdapter = serviceIsolated.managed_update.execution.adapter_results[0];
    const serviceReconciliation = serviceAdapter.result.bundled_full_runtime_reconciliation;
    assert.equal(serviceIsolated.managed_update.execution.status, 'completed');
    assert.equal(serviceAdapter.status, 'completed');
    assert.equal(serviceReconciliation.status, 'completed');
    assert.deepEqual(
      serviceReconciliation.root_installs.map((entry: any) => entry.status),
      ['skipped', 'skipped', 'skipped', 'skipped', 'completed', 'skipped'],
    );
    assert.equal(
      serviceReconciliation.failures.some((entry: any) => entry.package_id === 'opl-flow'),
      false,
    );
    assert.equal(fs.existsSync(launchctlLog), false);
    assert.equal(pathBytesDigest(servicePath), serviceDefinitionDigest);
    assert.equal(pathBytesDigest(serviceStateSentinel), serviceStateDigest);
    assert.deepEqual(managedBundledStateFingerprint({
      homeRoot,
      stateRoot,
      codexHome,
      scopeRoot,
      baseSentinelRoot,
      appSentinelRoot,
    }), serviceConflictPrestate);
    assert.equal(fs.existsSync(path.join(stateRoot, 'managed-update-kernel.lock')), false);
    fs.rmSync(servicePath);
    fs.rmSync(serviceStateSentinel);

    const faultCatalog = writeManagedBundledCatalogFixture({
      workspaceRoot: family.workspaceRoot,
      outputRoot: path.join(root, 'catalog-fault'),
      revision: 'fault',
    });
    const faultEnv = {
      ...commonEnv,
      OPL_TEST_BUNDLED_FULL_RUNTIME_PACKAGE_CATALOG: faultCatalog.catalogPath,
    };
    markFakeCodexPluginManagerVersionsStale({ stateRoot, codexHome });
    const unrelatedSurfacePaths = {
      family_carrier: path.join(stateRoot, 'codex-plugin-carriers', 'unrelated-family', 'sentinel.bin'),
      plugin_registry: path.join(codexHome, 'plugins', 'unrelated-family', 'sentinel.bin'),
      codex_state: path.join(codexHome, 'state', 'unrelated-family', 'sentinel.bin'),
      companion_source: path.join(codexHome, 'opl-companion-sources', 'unrelated-family', 'sentinel.bin'),
    };
    for (const [indexValue, filePath] of Object.values(unrelatedSurfacePaths).entries()) {
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, Buffer.from([9, 8, 7, indexValue]));
    }
    const unrelatedSurfacePrestate = Object.fromEntries(Object.entries(unrelatedSurfacePaths).map(
      ([key, filePath]) => [key, pathBytesDigest(filePath)],
    ));
    const authoritySentinels = {
      base: pathBytesDigest(baseSentinelRoot),
      app: pathBytesDigest(appSentinelRoot),
    };
    const scopeSkillsPreFault = pathBytesDigest(path.join(scopeRoot, '.codex', 'skills'));
    const componentLedgerPath = path.join(stateRoot, 'managed-update-component-receipts.json');
    const componentReceiptCountBeforeFault = (readJsonFile(componentLedgerPath) as any).receipts.length;

    const partial = runCli(['update', 'apply'], {
      ...faultEnv,
      OPL_TEST_MANAGED_BUNDLED_UPDATE_POST_VERIFY_FAIL_PACKAGE_ID: 'mas',
    }) as any;
    assert.deepEqual(partial.managed_update.components.map((entry: any) => entry.component_id), ['opl_packages']);
    assert.deepEqual(
      partial.managed_update.execution.adapter_results.map((entry: any) => entry.component_id),
      ['opl_packages'],
    );
    const partialAdapter = partial.managed_update.execution.adapter_results[0];
    const partialReconciliation = partialAdapter.result.bundled_full_runtime_reconciliation;
    assert.equal(partial.managed_update.execution.status, 'partial_failure');
    assert.equal(partialAdapter.status, 'partial_failure');
    assert.equal(partialAdapter.apply_mode, 'auto_apply');
    assert.equal(partialAdapter.result.app_background_safe, false);
    assert.equal(partialReconciliation.status, 'partial');
    assert.equal(partialReconciliation.orchestration_policy, 'fail_open_per_root_package');
    assert.equal(
      partialReconciliation.package_mutation_policy,
      'package_local_native_carrier_root_retryable',
    );
    assert.deepEqual(
      partialReconciliation.root_installs.map((entry: any) => entry.status),
      ['completed', 'failed', 'completed', 'completed', 'completed', 'completed'],
    );
    const failedMas = partialAdapter.result.targets.find((entry: any) => entry.target_id === 'mas');
    assert.equal(failedMas.result.failure.failure_code, 'test_managed_bundled_update_post_verify_interrupted');
    assert.deepEqual(failedMas.result.failure.details.completed_package_ids, ['mas']);
    assert.equal(failedMas.result.package_mutation_unit.status, 'partially_applied_native_carrier_retryable');
    assert.equal(failedMas.result.package_mutation_unit.local_prestate_restored, null);
    assert.equal(failedMas.result.package_mutation_unit.mutation_started, true);
    assert.equal(pathBytesDigest(path.join(scopeRoot, '.codex', 'skills')), scopeSkillsPreFault);
    const descriptorReadbackAfterPartial = ownerPackageDescriptorReadback({
      sourcePaths: faultCatalog.sourcePaths,
      packageIds: MANAGED_BUNDLED_PACKAGE_FIXTURES.map((entry) => entry.packageId),
    });
    assert.equal(descriptorReadbackAfterPartial.length, MANAGED_BUNDLED_PACKAGE_FIXTURES.length);
    for (const descriptor of descriptorReadbackAfterPartial) {
      assert.equal(
        descriptor.carrier_source_commit,
        faultCatalog.sourceCommits[descriptor.package_id],
      );
    }
    assert.equal(fs.existsSync(legacyLockPath), false);
    assert.equal((readJsonFile(componentLedgerPath) as any).receipts.length, componentReceiptCountBeforeFault + 1);
    assert.equal(partial.managed_update.execution.receipt_record.recorded_receipt_count, 1);
    const partialReceiptRef = partial.managed_update.execution.receipt_record.receipt_refs[0];
    const partialComponentReceipt = (readJsonFile(componentLedgerPath) as any).receipts
      .find((entry: any) => entry.receipt_ref === partialReceiptRef);
    assert.equal(partialComponentReceipt.adapter_result_ref, partialAdapter.result_ref);
    assert.equal(partialComponentReceipt.verify_result, 'failed');
    assert.equal(partialComponentReceipt.status_detail.changed_targets_count, 5);
    assert.equal(partialComponentReceipt.status_detail.failed_targets_count, 1);
    assert.equal(partialAdapter.post_apply_actions.every((entry: any) => entry.status === 'manual_required'), true);
    assert.deepEqual(
      partialAdapter.post_apply_actions.map((entry: any) => entry.command_ref),
      Array(3).fill('opl packages status --json'),
    );
    assert.equal(
      partialAdapter.post_apply_actions
        .filter((entry: any) => entry.action_id !== 'reconcile_packages')
        .every((entry: any) => entry.result.writes_performed === false),
      true,
    );
    assert.equal(
      partialAdapter.post_apply_actions.some((entry: any) => (
        /packages update|configure-codex/.test(entry.command_ref)
      )),
      false,
    );
    assert.equal(fs.existsSync(path.join(stateRoot, 'managed-update-kernel.lock')), false);

    const isolatedFaultPrestate = managedBundledStateFingerprint({
      homeRoot,
      stateRoot,
      codexHome,
      scopeRoot,
      baseSentinelRoot,
      appSentinelRoot,
    });
    const isolatedReceiptCount = (readJsonFile(componentLedgerPath) as any).receipts.length;
    const isolatedFault = runCli(['update', 'apply'], {
      ...faultEnv,
      OPL_TEST_MANAGED_BUNDLED_UPDATE_POST_VERIFY_FAIL_PACKAGE_ID: 'mas',
    }) as any;
    const isolatedAdapter = isolatedFault.managed_update.execution.adapter_results[0];
    assert.equal(isolatedFault.managed_update.execution.status, 'skipped');
    assert.equal(isolatedAdapter.status, 'skipped');
    assert.deepEqual(
      isolatedAdapter.result.targets.map((entry: any) => entry.status),
      ['skipped', 'skipped', 'skipped', 'skipped', 'skipped', 'skipped'],
    );
    assert.deepEqual(managedBundledStateFingerprint({
      homeRoot,
      stateRoot,
      codexHome,
      scopeRoot,
      baseSentinelRoot,
      appSentinelRoot,
    }), isolatedFaultPrestate);
    assert.equal((readJsonFile(componentLedgerPath) as any).receipts.length, isolatedReceiptCount);
    assert.equal(fs.existsSync(path.join(stateRoot, 'managed-update-kernel.lock')), false);

    const output = runCli(['update', 'apply'], faultEnv) as any;
    assert.deepEqual(
      output.managed_update.components.map((entry: any) => entry.component_id),
      ['opl_packages'],
    );
    assert.deepEqual(
      output.managed_update.execution.adapter_results.map((entry: any) => entry.component_id),
      ['opl_packages'],
    );
    const adapter = output.managed_update.execution.adapter_results[0];
    assert.equal(output.managed_update.operation, 'apply');
    assert.equal(output.managed_update.operation_mode, 'controlled_apply');
    assert.equal(output.managed_update.execution.status, 'skipped');
    assert.equal(output.managed_update.authority_boundary.can_mutate_app_owned_runtime_root, false);
    assert.equal(output.managed_update.authority_boundary.can_mutate_installation_carrier, false);
    assert.equal(output.managed_update.authority_boundary.can_silently_update_clean_managed_modules, true);
    assert.equal(adapter.status, 'skipped');
    assert.equal(adapter.apply_mode, 'projection_only');
    assert.equal(adapter.result.app_background_safe, false);
    assert.equal(
      adapter.result.framework_commit,
      execFileSync('git', ['rev-parse', 'HEAD'], { cwd: path.resolve('.'), encoding: 'utf8' }).trim(),
    );
    assert.equal(adapter.result.catalog_ref, `file://${faultCatalog.catalogPath}`);
    assert.equal(adapter.result.catalog_sha256, sha256Value(fs.readFileSync(faultCatalog.catalogPath)));
    assert.equal(adapter.result.summary.manual_required_targets_count, 0);
    assert.equal(adapter.result.summary.failed_targets_count, 0);
    assert.deepEqual(
      adapter.result.targets.map((entry: any) => entry.target_id),
      ['mag', 'mas', 'obf', 'oma', 'opl-flow', 'rca'],
    );
    assert.deepEqual(adapter.result.targets.map((entry: any) => entry.status), Array(6).fill('skipped'));
    const updatedTargets = adapter.result.targets.filter((entry: any) => entry.status === 'completed');
    assert.equal(updatedTargets.length, 0);
    const reconciliation = adapter.result.bundled_full_runtime_reconciliation;
    assert.equal(reconciliation.status, 'completed');
    assert.deepEqual(reconciliation.root_package_ids, ['mag', 'mas', 'obf', 'oma', 'opl-flow', 'rca']);
    assert.deepEqual(reconciliation.items.map((entry: any) => entry.package_id).sort(), [
      'mag', 'mas', 'mas-scholar-skills', 'obf', 'oma', 'opl-flow', 'rca',
    ]);
    assert.deepEqual(reconciliation.failures, []);
    assert.equal(reconciliation.summary.installed_package_count, 7);
    assert.equal(Object.hasOwn(adapter.result, 'component_transaction'), false);
    assert.deepEqual(adapter.post_apply_actions, []);
    assert.equal(
      adapter.post_apply_actions.some((entry: any) => /packages update|configure-codex/.test(entry.command_ref)),
      false,
    );
    assert.equal(
      adapter.post_apply_actions
        .filter((entry: any) => entry.action_id !== 'reconcile_packages')
        .every((entry: any) => entry.result.writes_performed === false),
      true,
    );
    const newCatalogPayload = readJsonFile(faultCatalog.catalogPath) as any;
    const expectedCatalogDigest = sha256Value(fs.readFileSync(faultCatalog.catalogPath));
    const masTarget = adapter.result.targets.find((entry: any) => entry.target_id === 'mas');
    const expectedMas = newCatalogPayload.packages.mas;
    assert.equal(masTarget.target_version, expectedMas.package_version);
    assert.equal(masTarget.target_manifest_sha256, expectedMas.manifest_sha256.replace(/^sha256:/, ''));
    assert.equal(masTarget.release_catalog_digest, expectedCatalogDigest);
    assert.equal(output.managed_update.execution.receipt_record.recorded_receipt_count, 0);
    assert.equal(output.managed_update.idempotency_lock.status, 'released');
    assert.equal(fs.existsSync(path.join(stateRoot, 'managed-update-kernel.lock')), false);
    assert.equal(pathBytesDigest(baseSentinelRoot), authoritySentinels.base);
    assert.equal(pathBytesDigest(appSentinelRoot), authoritySentinels.app);
    assert.deepEqual(Object.fromEntries(Object.entries(unrelatedSurfacePaths).map(
      ([key, filePath]) => [key, pathBytesDigest(filePath)],
    )), unrelatedSurfacePrestate);
    assert.equal(fs.existsSync(launchctlLog), false);
    assert.equal(pathBytesDigest(path.join(scopeRoot, '.codex', 'skills')), scopeSkillsPreFault);
    const scopeTransactionRoot = path.join(scopeRoot, '.codex', '.opl-package-transactions');
    assert.equal(
      fs.existsSync(scopeTransactionRoot) ? fs.readdirSync(scopeTransactionRoot).length : 0,
      0,
    );

    const finalDescriptors = ownerPackageDescriptorReadback({
      sourcePaths: faultCatalog.sourcePaths,
      packageIds: MANAGED_BUNDLED_PACKAGE_FIXTURES.map((entry) => entry.packageId),
    });
    assert.deepEqual(finalDescriptors.map((entry) => entry.package_id), [
      'mag',
      'mas',
      'mas-scholar-skills',
      'obf',
      'oma',
      'opl-flow',
      'rca',
    ]);
    for (const descriptor of finalDescriptors) {
      assert.equal(descriptor.carrier_source_commit, faultCatalog.sourceCommits[descriptor.package_id]);
    }
    assert.equal(fs.existsSync(legacyLockPath), false);
    assert.equal(
      fs.existsSync(path.join(stateRoot, 'agent-package-lifecycle-ledger.json')),
      false,
    );
    const componentLedger = readJsonFile(path.join(stateRoot, 'managed-update-component-receipts.json')) as any;
    const retainedPartialReceipt = componentLedger.receipts.find((entry: any) => (
      entry.receipt_ref === partialReceiptRef
    ));
    assert.equal(retainedPartialReceipt.receipt_ref, partialReceiptRef);
    assert.equal(retainedPartialReceipt.verify_result, 'failed');
  } finally {
    removeFixtureTree(root);
    removeFixtureTree(family.workspaceRoot);
    removeFixtureTree(codexFixture.fixtureRoot);
  }
});
