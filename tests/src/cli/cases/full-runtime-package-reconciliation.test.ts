import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { parseJsonText } from '../../../../src/kernel/json-file.ts';
import {
  readBundledFullRuntimePackageCatalog,
  type BundledFullRuntimeCatalogEntry,
  type BundledFullRuntimePackageCatalog,
} from '../../../../src/adapters/integration/agent-package-registry-parts/bundled-full-runtime-catalog.ts';
import type { InstalledCarrierEntry } from '../../../../src/adapters/integration/agent-package-registry-parts/installed-codex-plugin-directory.ts';
import type { AgentPackageManifest } from '../../../../src/adapters/integration/agent-package-registry-parts/types.ts';
import {
  materializeLocalCodexPluginMarketplaceRoute,
  resolveCanonicalOplFamilyMarketplaceId,
} from '../../../../src/adapters/integration/system-installation/codex-plugin-registry.ts';
import { reconcileBundledFullRuntimePackagesIfAvailable } from '../../../../src/adapters/integration/system-installation/full-runtime-package-reconciliation.ts';

function manifestProjection(entry: BundledFullRuntimeCatalogEntry) {
  const manifest = parseJsonText(entry.manifestJson) as Record<string, any>;
  const codexSurface = manifest.codex_surface as Record<string, any>;
  return {
    packageId: entry.packageId,
    pluginId: String(codexSurface.plugin_id),
    visible: codexSurface.codex_default_exposure !== false,
  };
}

function descriptorBearingCatalog() {
  const catalog = readBundledFullRuntimePackageCatalog();
  return {
    ...catalog,
    entries: new Map([...catalog.entries].map(([packageId, entry]) => {
      const payload = parseJsonText(entry.payloadManifestJson) as Record<string, any>;
      if (!payload.files.some((file: Record<string, unknown>) => file.path === 'opl-package.json')) {
        payload.files.push({ path: 'opl-package.json' });
      }
      return [packageId, {
        ...entry,
        payloadManifestJson: JSON.stringify(payload),
      }];
    })),
  };
}

function descriptorlessPackageCatalog(packageId: string) {
  const catalog = descriptorBearingCatalog();
  const entry = catalog.entries.get(packageId)!;
  const payload = parseJsonText(entry.payloadManifestJson) as Record<string, any>;
  payload.files = payload.files.filter((file: Record<string, unknown>) => file.path !== 'opl-package.json');
  catalog.entries.set(packageId, {
    ...entry,
    payloadManifestJson: JSON.stringify(payload),
  });
  return catalog;
}

test('canonical Full catalog carries only immutable owner descriptors that have been projected', () => {
  const catalog = readBundledFullRuntimePackageCatalog();
  const descriptorPackageIds = [...catalog.entries]
    .filter(([, entry]) => {
      const payload = parseJsonText(entry.payloadManifestJson) as Record<string, any>;
      return payload.files.some((file: Record<string, unknown>) => file.path === 'opl-package.json');
    })
    .map(([packageId]) => packageId)
    .sort();
  assert.deepEqual(descriptorPackageIds, ['mag', 'mas', 'mas-scholar-skills', 'obf', 'oma', 'opl-flow', 'rca']);
});

function runtimeHomeFixture(root: string, catalog: BundledFullRuntimePackageCatalog) {
  const runtimeHome = path.join(root, 'runtime');
  for (const entry of catalog.entries.values()) {
    fs.mkdirSync(path.join(runtimeHome, entry.runtimeModuleRelativePath), { recursive: true });
  }
  return runtimeHome;
}

function ownerSourcePath(packageId: string) {
  return path.join('/fixture', packageId, 'owner-source');
}

function marketplaceId(entry: BundledFullRuntimeCatalogEntry) {
  const projection = manifestProjection(entry);
  return resolveCanonicalOplFamilyMarketplaceId(projection.packageId, projection.pluginId)
    ?? `opl-agent-${projection.packageId}-local`;
}

function expectedCarrier(
  entry: BundledFullRuntimeCatalogEntry,
  stateDir: string,
): InstalledCarrierEntry | null {
  const projection = manifestProjection(entry);
  if (!projection.visible) return null;
  const carrierMarketplaceId = marketplaceId(entry);
  const marketplaceRoot = path.join(stateDir, 'codex-plugin-marketplaces', carrierMarketplaceId);
  return {
    pluginId: `${projection.pluginId}@${carrierMarketplaceId}`,
    version: entry.packageVersion,
    enabled: true,
    sourcePath: ownerSourcePath(projection.packageId),
    sourceKind: 'codex_plugin_manager',
    marketplaceSource: marketplaceRoot,
  };
}

type ProjectionState = {
  entries: InstalledCarrierEntry[];
};

function currentState(
  catalog: BundledFullRuntimePackageCatalog,
  stateDir: string,
): ProjectionState {
  return {
    entries: [...catalog.entries.values()].flatMap((entry) => {
      const carrier = expectedCarrier(entry, stateDir);
      return carrier ? [carrier] : [];
    }),
  };
}

function convergePackage(
  state: ProjectionState,
  catalog: BundledFullRuntimePackageCatalog,
  packageId: string,
  stateDir: string,
) {
  const projection = manifestProjection(catalog.entries.get(packageId)!);
  state.entries = state.entries.filter((entry) =>
    entry.pluginId.split('@', 1)[0] !== projection.pluginId);
  const carrier = expectedCarrier(catalog.entries.get(packageId)!, stateDir);
  if (carrier) state.entries.push(carrier);
}

function configuredCarrierReadback(
  catalog: BundledFullRuntimePackageCatalog,
  packageId: string,
  stateDir: string,
  operation: 'install' | 'update',
) {
  const entry = catalog.entries.get(packageId)!;
  const carrier = expectedCarrier(entry, stateDir)!;
  return {
    surface_kind: 'opl_configured_codex_plugin_carrier_readback.v1' as const,
    package_id: packageId,
    carrier: {
      kind: 'codex_plugin_manager' as const,
      plugin_id: carrier.pluginId,
      marketplace_source: carrier.marketplaceSource,
      observed_sources: [],
      precedence: 'exact_single_source' as const,
    },
    executor: {
      route: 'codex_cli' as const,
      required_skill_ids: [],
      status: 'callable' as const,
    },
    publication_ref: null,
    status: 'installed' as const,
    installed_version: entry.packageVersion,
    enabled: true,
    plugin_source_path: carrier.sourcePath,
    operation,
    native_command: ['plugin', 'add', carrier.pluginId, '--json'],
    native_action_dispatched: true,
    reason: null,
  };
}

function projectionOptions(
  state: ProjectionState,
  catalog: BundledFullRuntimePackageCatalog,
  stateDir: string,
  options: {
    carrierActions?: string[];
    applyCarrierAction?: boolean;
  } = {},
) {
  return {
    readInstalledCarrierEntries: () => structuredClone(state.entries),
    resolveOwnerSource: ((input: { manifest: AgentPackageManifest }) => ({
      ...input.manifest,
      plugin_source_path: ownerSourcePath(input.manifest.package_id),
    })) as any,
    materializeCarrierRoute: ((spec: { marketplace_id: string; plugin_id: string }, sourcePath: string, marketplaceRoot: string) => ({
      marketplace_root: marketplaceRoot,
      marketplace_path: path.join(marketplaceRoot, '.agents', 'plugins', 'marketplace.json'),
      plugin_manifest_path: path.join(sourcePath, '.codex-plugin', 'plugin.json'),
      marketplace_plugin_path: sourcePath,
    })) as any,
    runConfiguredCarrier: ((input: { descriptor: { packageId: string }; action: 'install' | 'update' }) => {
      options.carrierActions?.push(input.descriptor.packageId);
      if (options.applyCarrierAction !== false) {
        convergePackage(state, catalog, input.descriptor.packageId, stateDir);
      }
      return configuredCarrierReadback(catalog, input.descriptor.packageId, stateDir, input.action);
    }) as any,
  };
}

async function withEnvironment<T>(
  values: Record<string, string>,
  run: () => Promise<T> | T,
) {
  const previous = Object.fromEntries(Object.keys(values).map((key) => [key, process.env[key]]));
  Object.assign(process.env, values);
  try {
    return await run();
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test('Full runtime currentness ignores legacy lock state and installs each missing native closure', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'opl-full-runtime-native-currentness-'));
  const stateDir = path.join(root, 'state');
  const catalog = descriptorBearingCatalog();
  const runtimeHome = runtimeHomeFixture(root, catalog);
  const state: ProjectionState = {
    entries: [],
  };
  const installCalls: string[] = [];
  const migrationCalls: string[] = [];
  const migrateLegacyOplDocInstall = () => {
    migrationCalls.push('opl-flow');
    return {
      surface_kind: 'opl_legacy_opl_doc_install_migration.v1' as const,
      status: 'absent' as const,
      writes_performed: false,
      failure_code: null,
      plugin_root: '/fixture/plugins/opl-doc',
      command_path: '/fixture/.local/bin/opl-doc-doctor',
      marketplace_path: '/fixture/.agents/plugins/marketplace.json',
      before: { plugin_root: false, command: false, marketplace_entry: false },
      after: { plugin_root: false, command: false, marketplace_entry: false },
    };
  };
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(path.join(stateDir, 'agent-package-locks.json'), '{corrupt legacy second truth');
  try {
    await withEnvironment({ OPL_STATE_DIR: stateDir }, async () => {
      const first = await reconcileBundledFullRuntimePackagesIfAvailable(
        { OPL_FULL_RUNTIME_HOME: runtimeHome, OPL_STATE_DIR: stateDir },
        {
          ...projectionOptions(state, catalog, stateDir, { carrierActions: installCalls }),
          readCatalog: () => catalog,
          migrateLegacyOplDocInstall,
        },
      );
      assert.ok(first);
      assert.equal(first.status, 'completed', JSON.stringify(first, null, 2));
      assert.equal(first.summary.installed, 6);
      assert.deepEqual(
        installCalls,
        ['mag', 'mas', 'obf', 'oma', 'opl-flow', 'rca'],
      );
      assert.equal(
        first.items.find((item) => item.package_id === 'mas-scholar-skills')?.exposure_state,
        'hidden',
      );
      assert.equal(first.items.some((item) => 'package_lock_ref' in item), false);

      installCalls.length = 0;
      const current = await reconcileBundledFullRuntimePackagesIfAvailable(
        { OPL_FULL_RUNTIME_HOME: runtimeHome, OPL_STATE_DIR: stateDir },
        {
          ...projectionOptions(state, catalog, stateDir, { carrierActions: installCalls }),
          readCatalog: () => catalog,
          migrateLegacyOplDocInstall,
        },
      );
      assert.ok(current);
      assert.equal(current.status, 'completed');
      assert.equal(current.summary.already_installed, 7);
      assert.equal(current.root_installs.every((entry) => entry.status === 'skipped'), true);
      assert.equal(installCalls.length, 0);
      assert.deepEqual(migrationCalls, ['opl-flow', 'opl-flow']);
    });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('descriptorless Full Packages fail closed before native carrier or legacy lock mutation', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'opl-full-runtime-descriptorless-'));
  const stateDir = path.join(root, 'state');
  const catalog = descriptorlessPackageCatalog('obf');
  const runtimeHome = runtimeHomeFixture(root, catalog);
  const state = currentState(catalog, stateDir);
  const nativeCarrierActions: string[] = [];
  state.entries = state.entries.filter((entry) => !entry.pluginId.startsWith('opl-flow@'));
  try {
    const result = await reconcileBundledFullRuntimePackagesIfAvailable(
      { OPL_FULL_RUNTIME_HOME: runtimeHome, OPL_STATE_DIR: stateDir },
      {
        ...projectionOptions(state, catalog, stateDir, { carrierActions: nativeCarrierActions }),
        readCatalog: () => catalog,
      },
    );
    assert.ok(result);
    assert.equal(result.status, 'failed', JSON.stringify(result, null, 2));
    assert.equal(result.package_mutation_policy, 'package_local_native_carrier_root_retryable');
    assert.equal(
      result.failures[0]?.failure_code,
      'configured_codex_plugin_carrier_owner_descriptor_missing',
    );
    const failureDetails = result.failures[0]?.details as Record<string, unknown>;
    assert.deepEqual(failureDetails.package_ids, ['obf']);
    assert.equal(failureDetails.mutation_started, false);
    assert.deepEqual(nativeCarrierActions, []);
    assert.equal(fs.existsSync(path.join(stateDir, 'agent-package-locks.json')), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('native carrier disabled, ambiguous, source and version drift trigger bounded repair while hidden exposure fails closed', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'opl-full-runtime-native-drift-'));
  const stateDir = path.join(root, 'state');
  const catalog = descriptorBearingCatalog();
  const runtimeHome = runtimeHomeFixture(root, catalog);
  const state = currentState(catalog, stateDir);
  const repairedRoots: string[] = [];
  const reconcile = () => reconcileBundledFullRuntimePackagesIfAvailable(
    { OPL_FULL_RUNTIME_HOME: runtimeHome, OPL_STATE_DIR: stateDir },
    {
      ...projectionOptions(state, catalog, stateDir, { carrierActions: repairedRoots }),
      readCatalog: () => catalog,
    },
  );
  try {
    state.entries.find((entry) => entry.pluginId.startsWith('med-autogrant@'))!.enabled = false;
    const disabledRepair = await reconcile();
    assert.equal(disabledRepair?.status, 'completed', JSON.stringify(disabledRepair, null, 2));
    assert.deepEqual(repairedRoots.splice(0), ['mag']);

    state.entries.find((entry) => entry.pluginId.startsWith('opl-meta-agent@'))!.sourcePath = '/stale/source';
    assert.equal((await reconcile())?.status, 'completed');
    assert.deepEqual(repairedRoots.splice(0), ['oma']);

    const masCarrier = state.entries.find((entry) => entry.pluginId.startsWith('med-autoscience@'))!;
    state.entries.push({ ...masCarrier, pluginId: 'med-autoscience@historical-marketplace' });
    assert.equal((await reconcile())?.status, 'completed');
    assert.deepEqual(repairedRoots.splice(0), ['mas']);

    state.entries.find((entry) => entry.pluginId.startsWith('opl-flow@'))!.version = '0.0.0';
    assert.equal((await reconcile())?.status, 'completed');
    assert.deepEqual(repairedRoots.splice(0), ['opl-flow']);

    state.entries.push({
      pluginId: 'mas-scholar-skills@unexpected-global',
      version: '0.2.22',
      enabled: true,
      sourcePath: '/unexpected/global/scholar',
      sourceKind: 'codex_plugin_manager',
      marketplaceSource: '/unexpected/global',
    });
    const hiddenExposure = await reconcile();
    assert.equal(hiddenExposure?.status, 'partial');
    assert.equal(
      hiddenExposure?.failures.some((failure) =>
        failure.failure_code === 'full_runtime_package_projection_incomplete'),
      true,
    );
    assert.deepEqual(repairedRoots, []);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('managed updates require fresh native readback after mutation transport returns', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'opl-full-runtime-post-apply-readback-'));
  const stateDir = path.join(root, 'state');
  const catalog = descriptorBearingCatalog();
  const runtimeHome = runtimeHomeFixture(root, catalog);
  const state = currentState(catalog, stateDir);
  state.entries = state.entries.filter((entry) => !entry.pluginId.startsWith('opl-meta-agent@'));
  try {
    const staleTransport = await reconcileBundledFullRuntimePackagesIfAvailable(
      { OPL_FULL_RUNTIME_HOME: runtimeHome, OPL_STATE_DIR: stateDir },
      {
        ...projectionOptions(state, catalog, stateDir, { applyCarrierAction: false }),
        lifecycleAction: 'update',
        readCatalog: () => catalog,
      },
    );
    assert.ok(staleTransport);
    assert.equal(staleTransport.status, 'partial');
    assert.equal(
      staleTransport.root_installs.find((entry) => entry.package_id === 'oma')?.status,
      'failed',
    );
    assert.equal(
      staleTransport.failures.some((failure) =>
        failure.failure_code === 'full_runtime_package_projection_incomplete'),
      true,
    );

    const verified = await reconcileBundledFullRuntimePackagesIfAvailable(
      { OPL_FULL_RUNTIME_HOME: runtimeHome, OPL_STATE_DIR: stateDir },
      {
        ...projectionOptions(state, catalog, stateDir),
        lifecycleAction: 'update',
        readCatalog: () => catalog,
      },
    );
    assert.ok(verified);
    assert.equal(verified.status, 'completed', JSON.stringify(verified, null, 2));
    assert.equal(
      verified.root_installs.find((entry) => entry.package_id === 'oma')?.status,
      'completed',
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('route-only marketplace points at verified owner source without copying plugin payload', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'opl-full-runtime-route-only-'));
  const sourceRoot = path.join(root, 'owner-source');
  const marketplaceRoot = path.join(root, 'marketplace');
  fs.mkdirSync(path.join(sourceRoot, '.codex-plugin'), { recursive: true });
  fs.mkdirSync(path.join(sourceRoot, 'skills', 'fixture'), { recursive: true });
  fs.writeFileSync(
    path.join(sourceRoot, '.codex-plugin', 'plugin.json'),
    JSON.stringify({ name: 'fixture-full-runtime', version: '1.0.0', skills: './skills/' }),
  );
  fs.writeFileSync(path.join(sourceRoot, 'skills', 'fixture', 'SKILL.md'), '# Fixture\n');
  try {
    const route = materializeLocalCodexPluginMarketplaceRoute({
      marketplace_id: 'fixture-full-runtime-local',
      plugin_id: 'fixture-full-runtime',
      display_name: 'Fixture Full runtime',
      category: 'OPL Packages',
    }, sourceRoot, marketplaceRoot);
    const marketplace = parseJsonText(fs.readFileSync(route.marketplace_path, 'utf8')) as Record<string, any>;
    assert.equal(route.marketplace_plugin_path, fs.realpathSync.native(sourceRoot));
    assert.equal(marketplace.plugins[0].source.path, fs.realpathSync.native(sourceRoot));
    assert.equal(fs.existsSync(path.join(marketplaceRoot, 'plugins')), false);
    assert.equal(fs.existsSync(path.join(sourceRoot, 'skills', 'fixture', 'SKILL.md')), true);
    const symlinkSource = path.join(root, 'owner-source-link');
    fs.symlinkSync(sourceRoot, symlinkSource);
    assert.throws(
      () => materializeLocalCodexPluginMarketplaceRoute({
        marketplace_id: 'fixture-full-runtime-local',
        plugin_id: 'fixture-full-runtime',
        display_name: 'Fixture Full runtime',
        category: 'OPL Packages',
      }, symlinkSource, marketplaceRoot),
      /Plugin source must be a real directory/,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
