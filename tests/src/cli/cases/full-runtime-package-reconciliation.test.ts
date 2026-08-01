import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { FrameworkContractError } from '../../../../src/kernel/contract-validation.ts';
import { parseJsonText } from '../../../../src/kernel/json-file.ts';
import {
  readBundledFullRuntimePackageCatalog,
  type BundledFullRuntimeCatalogEntry,
  type BundledFullRuntimePackageCatalog,
} from '../../../../src/modules/connect/agent-package-registry-parts/bundled-full-runtime-catalog.ts';
import type { InstalledCarrierEntry } from '../../../../src/modules/connect/agent-package-registry-parts/installed-codex-plugin-directory.ts';
import {
  inspectMaterializedPhysicalCodexSurface,
  materializePhysicalCodexSurface,
} from '../../../../src/modules/connect/agent-package-registry-parts/physical-surface.ts';
import {
  CANONICAL_PACKAGE_CONTENT_LOCK,
  packageContentLockDigest,
} from '../../../../src/modules/connect/agent-package-registry-parts/payload-content-lock.ts';
import type { AgentPackageManifest } from '../../../../src/modules/connect/agent-package-registry-parts/types.ts';
import {
  materializeLocalCodexPluginMarketplaceRoute,
  resolveCanonicalOplFamilyMarketplaceId,
} from '../../../../src/modules/connect/system-installation/codex-plugin-registry.ts';
import { reconcileBundledFullRuntimePackagesIfAvailable } from '../../../../src/modules/connect/system-installation/full-runtime-package-reconciliation.ts';

function manifestProjection(entry: BundledFullRuntimeCatalogEntry) {
  const manifest = parseJsonText(entry.manifestJson) as Record<string, any>;
  const codexSurface = manifest.codex_surface as Record<string, any>;
  return {
    packageId: entry.packageId,
    pluginId: String(codexSurface.plugin_id),
    visible: codexSurface.codex_default_exposure !== false,
  };
}

function closure(catalog: BundledFullRuntimePackageCatalog, rootPackageId: string) {
  const result: string[] = [];
  const visited = new Set<string>();
  const visit = (packageId: string) => {
    if (visited.has(packageId)) return;
    visited.add(packageId);
    for (const dependencyId of catalog.entries.get(packageId)!.dependencyPackageIds) visit(dependencyId);
    result.push(packageId);
  };
  visit(rootPackageId);
  return result;
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
  assert.deepEqual(descriptorPackageIds, ['obf', 'oma', 'opl-flow', 'rca']);
});

function runtimeHomeFixture(root: string, catalog: BundledFullRuntimePackageCatalog) {
  const runtimeHome = path.join(root, 'runtime');
  for (const entry of catalog.entries.values()) {
    fs.mkdirSync(path.join(runtimeHome, entry.runtimeModuleRelativePath), { recursive: true });
  }
  return runtimeHome;
}

function fakeSurface(manifest: AgentPackageManifest) {
  const marketplaceId = `fixture-${manifest.package_id}`;
  const marketplaceRoot = path.join('/fixture', manifest.package_id, 'marketplace');
  const marketplacePluginPath = path.join(marketplaceRoot, 'plugins', manifest.plugin_id!);
  const cachePath = path.join('/fixture', manifest.package_id, 'cache');
  const visible = manifest.codex_default_exposure !== false;
  return {
    status: 'materialized' as const,
    package_id: manifest.package_id,
    plugin_id: manifest.plugin_id!,
    codex_default_exposure: visible,
    marketplace_id: visible ? marketplaceId : null,
    marketplace_root: visible ? marketplaceRoot : null,
    marketplace_path: visible
      ? path.join(marketplaceRoot, '.agents', 'plugins', 'marketplace.json')
      : null,
    marketplace_plugin_path: visible ? marketplacePluginPath : null,
    codex_home: path.join('/fixture', 'codex'),
    codex_config_path: path.join('/fixture', 'codex', 'config.toml'),
    plugin_manifest_path: path.join(cachePath, '.codex-plugin', 'plugin.json'),
    codex_plugin_cache_path: cachePath,
    materialized_required_skill_ids: [...manifest.required_skill_ids],
    materialized_required_skill_paths: manifest.required_skill_ids.map((skillId) =>
      path.join(cachePath, 'skills', skillId, 'SKILL.md')),
    profile_migration: {
      status: 'not_requested',
    },
    workflow_policy_migration: {
      detected_conflicts: [],
    },
    writes_performed: true,
    reload_required: true,
  };
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
  materialized: Set<string>;
  entries: InstalledCarrierEntry[];
  policyDrift: Set<string>;
};

function currentState(
  catalog: BundledFullRuntimePackageCatalog,
  stateDir: string,
): ProjectionState {
  return {
    materialized: new Set(catalog.entries.keys()),
    entries: [...catalog.entries.values()].flatMap((entry) => {
      const carrier = expectedCarrier(entry, stateDir);
      return carrier ? [carrier] : [];
    }),
    policyDrift: new Set(),
  };
}

function convergePackage(
  state: ProjectionState,
  catalog: BundledFullRuntimePackageCatalog,
  packageId: string,
  stateDir: string,
) {
  state.materialized.add(packageId);
  const projection = manifestProjection(catalog.entries.get(packageId)!);
  state.entries = state.entries.filter((entry) =>
    entry.pluginId.split('@', 1)[0] !== projection.pluginId);
  const carrier = expectedCarrier(catalog.entries.get(packageId)!, stateDir);
  if (carrier) state.entries.push(carrier);
  state.policyDrift.delete(packageId);
}

function convergeLegacyPackage(
  state: ProjectionState,
  catalog: BundledFullRuntimePackageCatalog,
  packageId: string,
) {
  state.materialized.add(packageId);
  const entry = catalog.entries.get(packageId)!;
  const projection = manifestProjection(entry);
  state.entries = state.entries.filter((carrier) =>
    carrier.pluginId.split('@', 1)[0] !== projection.pluginId);
  if (projection.visible) {
    const surface = fakeSurface({
      package_id: projection.packageId,
      plugin_id: projection.pluginId,
      codex_default_exposure: true,
      required_skill_ids: [],
    } as unknown as AgentPackageManifest);
    state.entries.push({
      pluginId: `${projection.pluginId}@${surface.marketplace_id}`,
      version: entry.packageVersion,
      enabled: true,
      sourcePath: surface.marketplace_plugin_path!,
      sourceKind: 'codex_plugin_manager',
      marketplaceSource: surface.marketplace_root,
    });
  }
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
    inspectMaterializedSurface: ((manifest: AgentPackageManifest) => {
      if (!state.materialized.has(manifest.package_id)) {
        throw new FrameworkContractError(
          'contract_shape_invalid',
          'Fixture materialized surface is absent.',
          {
            package_id: manifest.package_id,
            failure_code: 'full_runtime_package_projection_incomplete',
          },
        );
      }
      return fakeSurface(manifest);
    }) as typeof inspectMaterializedPhysicalCodexSurface,
    inspectManagedPolicy: ((input: { manifest: AgentPackageManifest }) => ({
      status: state.policyDrift.has(input.manifest.package_id) ? 'drifted' : 'current',
      reason: 'fixture',
    })) as any,
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
    materialized: new Set(),
    entries: [],
    policyDrift: new Set(),
  };
  const installCalls: string[] = [];
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(path.join(stateDir, 'agent-package-locks.json'), '{corrupt legacy second truth');
  try {
    await withEnvironment({ OPL_STATE_DIR: stateDir }, async () => {
      const first = await reconcileBundledFullRuntimePackagesIfAvailable(
        { OPL_FULL_RUNTIME_HOME: runtimeHome, OPL_STATE_DIR: stateDir },
        {
          ...projectionOptions(state, catalog, stateDir, { carrierActions: installCalls }),
          readCatalog: () => catalog,
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
        },
      );
      assert.ok(current);
      assert.equal(current.status, 'completed');
      assert.equal(current.summary.already_installed, 7);
      assert.equal(current.root_installs.every((entry) => entry.status === 'skipped'), true);
      assert.equal(installCalls.length, 0);
    });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('descriptor-bearing roots use native carriers while legacy roots retain their installer', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'opl-full-runtime-mixed-materialization-'));
  const stateDir = path.join(root, 'state');
  const catalog = descriptorlessPackageCatalog('obf');
  const runtimeHome = runtimeHomeFixture(root, catalog);
  const state = currentState(catalog, stateDir);
  const legacyInstalls: string[] = [];
  const nativeCarrierActions: string[] = [];
  state.materialized.delete('obf');
  state.entries = state.entries.filter((entry) => !entry.pluginId.startsWith('opl-flow@'));
  try {
    const result = await reconcileBundledFullRuntimePackagesIfAvailable(
      { OPL_FULL_RUNTIME_HOME: runtimeHome, OPL_STATE_DIR: stateDir },
      {
        ...projectionOptions(state, catalog, stateDir, { carrierActions: nativeCarrierActions }),
        readCatalog: () => catalog,
        installPackage: (async (input: { packageId: string }) => {
          legacyInstalls.push(input.packageId);
          const dependencyPackageIds = closure(catalog, input.packageId);
          for (const packageId of dependencyPackageIds) {
            convergeLegacyPackage(state, catalog, packageId);
          }
          return {
            opl_agent_package_install: {
              dependency_transaction_id: `fixture-${input.packageId}`,
              dependency_package_locks: dependencyPackageIds.map((packageId) => ({ package_id: packageId })),
            },
          } as any;
        }) as any,
      },
    );
    assert.ok(result);
    assert.equal(result.status, 'completed', JSON.stringify(result, null, 2));
    assert.equal(result.package_mutation_policy, 'per_root_native_carrier_with_legacy_compatibility');
    assert.deepEqual(legacyInstalls, ['obf']);
    assert.deepEqual(nativeCarrierActions, ['opl-flow']);
    assert.equal(
      result.root_installs.find((entry) => entry.package_id === 'obf')?.reason,
      'package_install_unit_completed',
    );
    assert.equal(
      result.root_installs.find((entry) => entry.package_id === 'opl-flow')?.reason,
      'native_carrier_reconciliation_completed',
    );
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

function makeWritable(root: string) {
  if (!fs.existsSync(root)) return;
  const stat = fs.lstatSync(root);
  if (stat.isDirectory()) {
    fs.chmodSync(root, 0o755);
    for (const entry of fs.readdirSync(root)) makeWritable(path.join(root, entry));
  } else {
    fs.chmodSync(root, 0o644);
  }
}

test('materialized readback verifies immutable bytes and keeps hidden Packages off global surfaces', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'opl-full-runtime-materialized-readback-'));
  const home = path.join(root, 'home');
  const codexHome = path.join(root, 'codex');
  const stateDir = path.join(root, 'state');
  const sourceRoot = path.join(root, 'source');
  const pluginJson = Buffer.from('{"name":"fixture-full-runtime"}\n');
  const skillMarkdown = Buffer.from('# Fixture Full runtime\n');
  const files = [
    { path: '.codex-plugin/plugin.json', content: pluginJson },
    { path: 'skills/fixture-full-runtime/SKILL.md', content: skillMarkdown },
  ];
  for (const file of files) {
    const filePath = path.join(sourceRoot, file.path);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, file.content);
  }
  const manifest = {
    package_id: 'fixture-full-runtime',
    agent_id: null,
    package_role: 'capability_package',
    display_name: 'Fixture Full runtime',
    publisher: 'fixture',
    version: '1.0.0',
    source: 'fixture',
    codex_surface: {},
    codex_default_exposure: false,
    rollback_ref: 'fixture',
    codex_visible_entry: 'fixture-full-runtime',
    required_skill_ids: ['fixture-full-runtime'],
    optional_skill_refs: [],
    plugin_id: 'fixture-full-runtime',
    plugin_source_path: sourceRoot,
    profile_surface: null,
    managed_policy_surface: null,
    capability_dependencies: [],
    capability_provider: null,
    content_digest: packageContentLockDigest(CANONICAL_PACKAGE_CONTENT_LOCK, files),
    content_lock_canonicalization: CANONICAL_PACKAGE_CONTENT_LOCK,
    content_lock_paths: files.map((file) => file.path),
  } as unknown as AgentPackageManifest;
  try {
    await withEnvironment({ HOME: home, CODEX_HOME: codexHome, OPL_STATE_DIR: stateDir }, () => {
      const materialized = materializePhysicalCodexSurface(manifest, false, {
        skipManagedSurfaces: true,
      });
      const current = inspectMaterializedPhysicalCodexSurface(manifest);
      assert.equal(current.codex_plugin_cache_path, materialized.codex_plugin_cache_path);
      assert.equal(current.marketplace_id, null);

      const marketplaceRoot = path.join(
        stateDir,
        'codex-plugin-marketplaces',
        'opl-agent-fixture-full-runtime-local',
      );
      fs.mkdirSync(marketplaceRoot, { recursive: true });
      assert.throws(
        () => inspectMaterializedPhysicalCodexSurface(manifest),
        (error: any) => error?.details?.failure_code === 'full_runtime_package_projection_incomplete',
      );
      fs.rmSync(marketplaceRoot, { recursive: true, force: true });

      const skillPath = path.join(
        current.codex_plugin_cache_path,
        'skills',
        'fixture-full-runtime',
        'SKILL.md',
      );
      fs.chmodSync(skillPath, 0o644);
      fs.writeFileSync(skillPath, '# drifted\n');
      assert.throws(
        () => inspectMaterializedPhysicalCodexSurface(manifest),
        (error: any) => error?.details?.failure_code === 'capability_package_content_digest_mismatch',
      );
    });
  } finally {
    makeWritable(root);
    fs.rmSync(root, { recursive: true, force: true });
  }
});
