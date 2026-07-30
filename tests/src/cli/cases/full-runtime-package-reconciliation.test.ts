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
import type {
  AgentPackageLock,
  AgentPackageManifest,
} from '../../../../src/modules/connect/agent-package-registry-parts/types.ts';
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
  };
}

function expectedCarrier(entry: BundledFullRuntimeCatalogEntry): InstalledCarrierEntry | null {
  const projection = manifestProjection(entry);
  if (!projection.visible) return null;
  const surface = fakeSurface({
    package_id: projection.packageId,
    plugin_id: projection.pluginId,
    codex_default_exposure: true,
    required_skill_ids: [],
  } as unknown as AgentPackageManifest);
  return {
    pluginId: `${projection.pluginId}@${surface.marketplace_id}`,
    version: entry.packageVersion,
    enabled: true,
    sourcePath: surface.marketplace_plugin_path!,
    sourceKind: 'codex_plugin_manager',
    marketplaceSource: surface.marketplace_root,
  };
}

type ProjectionState = {
  materialized: Set<string>;
  entries: InstalledCarrierEntry[];
  policyDrift: Set<string>;
};

function currentState(catalog: BundledFullRuntimePackageCatalog): ProjectionState {
  return {
    materialized: new Set(catalog.entries.keys()),
    entries: [...catalog.entries.values()].flatMap((entry) => {
      const carrier = expectedCarrier(entry);
      return carrier ? [carrier] : [];
    }),
    policyDrift: new Set(),
  };
}

function convergePackage(
  state: ProjectionState,
  catalog: BundledFullRuntimePackageCatalog,
  packageId: string,
) {
  state.materialized.add(packageId);
  const projection = manifestProjection(catalog.entries.get(packageId)!);
  state.entries = state.entries.filter((entry) =>
    entry.pluginId.split('@', 1)[0] !== projection.pluginId);
  const carrier = expectedCarrier(catalog.entries.get(packageId)!);
  if (carrier) state.entries.push(carrier);
  state.policyDrift.delete(packageId);
}

function convergeClosure(
  state: ProjectionState,
  catalog: BundledFullRuntimePackageCatalog,
  rootPackageId: string,
) {
  for (const packageId of closure(catalog, rootPackageId)) {
    convergePackage(state, catalog, packageId);
  }
}

function mutationLocks(
  catalog: BundledFullRuntimePackageCatalog,
  rootPackageId: string,
) {
  return closure(catalog, rootPackageId).map((packageId) => ({
    package_id: packageId,
    package_version: 'stale-transport-is-not-currentness',
    manifest_sha256: '0'.repeat(64),
    content_digest: `sha256:${'0'.repeat(64)}`,
  })) as AgentPackageLock[];
}

function projectionOptions(state: ProjectionState) {
  return {
    readInstalledCarrierEntries: () => structuredClone(state.entries),
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

function lifecycleResult(
  action: 'install' | 'update',
  catalog: BundledFullRuntimePackageCatalog,
  rootPackageId: string,
) {
  const locks = mutationLocks(catalog, rootPackageId);
  return action === 'update'
    ? {
        version: 'g2',
        opl_agent_package_update: {
          status: 'updated',
          dependency_transaction_id: `fixture-${rootPackageId}`,
          dependency_package_locks: locks,
        },
      }
    : {
        version: 'g2',
        opl_agent_package_install: {
          status: 'installed',
          dependency_transaction_id: `fixture-${rootPackageId}`,
          dependency_package_locks: locks,
        },
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
  const catalog = readBundledFullRuntimePackageCatalog();
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
        { OPL_FULL_RUNTIME_HOME: runtimeHome },
        {
          ...projectionOptions(state),
          readCatalog: () => catalog,
          installPackage: (async (input: { packageId: string }) => {
            installCalls.push(input.packageId);
            convergeClosure(state, catalog, input.packageId);
            return lifecycleResult('install', catalog, input.packageId) as any;
          }) as any,
        },
      );
      assert.ok(first);
      assert.equal(first.status, 'completed');
      assert.equal(first.summary.installed, 7);
      assert.deepEqual(installCalls, ['mag', 'mas', 'obf', 'oma', 'opl-flow', 'rca']);
      assert.equal(
        first.items.find((item) => item.package_id === 'mas-scholar-skills')?.exposure_state,
        'hidden',
      );
      assert.equal(first.items.some((item) => 'package_lock_ref' in item), false);

      installCalls.length = 0;
      const current = await reconcileBundledFullRuntimePackagesIfAvailable(
        { OPL_FULL_RUNTIME_HOME: runtimeHome },
        {
          ...projectionOptions(state),
          readCatalog: () => catalog,
          installPackage: (async () => {
            throw new Error('current native projection must not mutate');
          }) as any,
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

test('native carrier disabled, ambiguous, source drift, and hidden exposure each trigger bounded repair', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'opl-full-runtime-native-drift-'));
  const catalog = readBundledFullRuntimePackageCatalog();
  const runtimeHome = runtimeHomeFixture(root, catalog);
  const state = currentState(catalog);
  const repairedRoots: string[] = [];
  const installPackage = async (input: { packageId: string }) => {
    repairedRoots.push(input.packageId);
    convergeClosure(state, catalog, input.packageId);
    return lifecycleResult('install', catalog, input.packageId) as any;
  };
  const reconcile = () => reconcileBundledFullRuntimePackagesIfAvailable(
    { OPL_FULL_RUNTIME_HOME: runtimeHome },
    {
      ...projectionOptions(state),
      readCatalog: () => catalog,
      installPackage: installPackage as any,
    },
  );
  try {
    state.entries.find((entry) => entry.pluginId.startsWith('med-autogrant@'))!.enabled = false;
    assert.equal((await reconcile())?.status, 'completed');
    assert.deepEqual(repairedRoots.splice(0), ['mag']);

    state.entries.find((entry) => entry.pluginId.startsWith('opl-meta-agent@'))!.sourcePath = '/stale/source';
    assert.equal((await reconcile())?.status, 'completed');
    assert.deepEqual(repairedRoots.splice(0), ['oma']);

    const masCarrier = state.entries.find((entry) => entry.pluginId.startsWith('med-autoscience@'))!;
    state.entries.push({ ...masCarrier, pluginId: 'med-autoscience@historical-marketplace' });
    assert.equal((await reconcile())?.status, 'completed');
    assert.deepEqual(repairedRoots.splice(0), ['mas']);

    state.entries.push({
      pluginId: 'mas-scholar-skills@unexpected-global',
      version: '0.2.22',
      enabled: true,
      sourcePath: '/unexpected/global/scholar',
      sourceKind: 'codex_plugin_manager',
      marketplaceSource: '/unexpected/global',
    });
    assert.equal((await reconcile())?.status, 'completed');
    assert.deepEqual(repairedRoots.splice(0), ['mas']);

    state.policyDrift.add('opl-flow');
    assert.equal((await reconcile())?.status, 'completed');
    assert.deepEqual(repairedRoots.splice(0), ['opl-flow']);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('managed updates require fresh native and materialized readback after mutation transport returns', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'opl-full-runtime-post-apply-readback-'));
  const catalog = readBundledFullRuntimePackageCatalog();
  const runtimeHome = runtimeHomeFixture(root, catalog);
  const state = currentState(catalog);
  state.materialized.delete('oma');
  try {
    const staleTransport = await reconcileBundledFullRuntimePackagesIfAvailable(
      { OPL_FULL_RUNTIME_HOME: runtimeHome },
      {
        ...projectionOptions(state),
        lifecycleAction: 'update',
        readCatalog: () => catalog,
        updatePackage: (async (input: Record<string, any>) => {
          await input.verifyAppliedPackageLocks(mutationLocks(catalog, input.packageId));
          return lifecycleResult('update', catalog, input.packageId);
        }) as any,
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
      { OPL_FULL_RUNTIME_HOME: runtimeHome },
      {
        ...projectionOptions(state),
        lifecycleAction: 'update',
        readCatalog: () => catalog,
        updatePackage: (async (input: Record<string, any>) => {
          convergeClosure(state, catalog, input.packageId);
          await input.verifyAppliedPackageLocks(mutationLocks(catalog, input.packageId));
          return lifecycleResult('update', catalog, input.packageId);
        }) as any,
      },
    );
    assert.ok(verified);
    assert.equal(verified.status, 'completed');
    assert.equal(
      verified.root_installs.find((entry) => entry.package_id === 'oma')?.status,
      'completed',
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
