import assert from 'node:assert/strict';
import test from 'node:test';

import {
  managedPackageCatalogDigest,
  normalizeManagedPackageCatalog,
  selectCapabilityCatalogVersion,
  selectManagedCatalogPackageVersion,
} from '../../src/modules/connect/agent-package-registry-parts/capability-reconciliation.ts';
import type { AgentPackageCapabilityDependency } from '../../src/modules/connect/agent-package-registry-parts/types.ts';

function digest(character: string) {
  return `sha256:${character.repeat(64)}`;
}

function catalogVersion(
  version: string,
  input: {
    capabilityAbi?: string | null;
    baseAbiRange?: string | null;
    selectionStatus?: 'selected_for_release_set' | 'retained_history';
  } = {},
) {
  return {
    package_version: version,
    selection_status: input.selectionStatus ?? 'retained_history',
    manifest_url: `https://packages.example.test/example/${version}/manifest.json`,
    manifest_sha256: digest(version.replace(/\D/g, '')[0] ?? '1'),
    compatibility: {
      declaration_status: input.baseAbiRange ? 'declared' : 'legacy_unspecified',
      base_abi_range: input.baseAbiRange ?? null,
      capability_abi: input.capabilityAbi ?? null,
    },
  };
}

function releaseSetCatalog(
  packages: Record<string, unknown>,
  surfaceKind: string | undefined = 'opl_package_catalog.v1',
) {
  return {
    ...(surfaceKind ? { surface_kind: surfaceKind } : {}),
    packages: { package_catalog: packages },
  };
}

function capabilityDependency(): AgentPackageCapabilityDependency {
  return {
    package_id: 'provider',
    required: true,
    dependency_kind: 'hard_runtime_dependency',
    version_requirement: '>=9.0.0 <10.0.0',
    capability_abi: 'provider.v9',
    required_export_ids: [],
    required_module_ids: [],
    bootstrap_manifest_url: null,
    dependency_source: null,
  };
}

test('Release Set catalog selects the exact declared root version without compatibility resolution', () => {
  const payload = releaseSetCatalog({
    example: {
      package_id: 'example',
      package_role: 'standard_agent',
      selected_version: '1.0.0-alpha.4',
      versions: [
        catalogVersion('9.0.0', {
          baseAbiRange: '>=9.0.0 <10.0.0',
          selectionStatus: 'selected_for_release_set',
        }),
        catalogVersion('1.0.0-alpha.4', {
          baseAbiRange: '>=1.0.0 <2.0.0',
        }),
      ],
    },
  });

  const selected = selectManagedCatalogPackageVersion(
    normalizeManagedPackageCatalog(payload),
    'example',
    { currentBaseAbi: '99.0.0' },
  );

  assert.equal(selected.package_version, '1.0.0-alpha.4');
  assert.equal(selected.selection_status, 'retained_history');
});

test('capability dependency uses its provider Release Set selection without ABI or range admission', () => {
  const payload = releaseSetCatalog({
    provider: {
      package_id: 'provider',
      package_role: 'capability_package',
      selected_version: '1.2.3',
      versions: [
        catalogVersion('9.1.0', {
          capabilityAbi: 'provider.v9',
          baseAbiRange: '>=9.0.0 <10.0.0',
          selectionStatus: 'selected_for_release_set',
        }),
        catalogVersion('1.2.3', {
          capabilityAbi: 'provider.v1',
          baseAbiRange: '>=1.0.0 <2.0.0',
        }),
      ],
    },
  });

  const selected = selectCapabilityCatalogVersion(
    normalizeManagedPackageCatalog(payload),
    capabilityDependency(),
    { currentBaseAbi: '99.0.0' },
  );

  assert.equal(selected.package_version, '1.2.3');
  assert.equal(selected.capability_abi, 'provider.v1');
});

test('offline Release Set bridge without a surface kind retains exact selection and digest', () => {
  const payload = releaseSetCatalog({
    example: {
      package_id: 'example',
      package_role: 'standard_agent',
      selected_version: '2.0.0',
      versions: [catalogVersion('2.0.0', { selectionStatus: 'selected_for_release_set' })],
    },
  }, undefined);

  assert.equal(
    selectManagedCatalogPackageVersion(normalizeManagedPackageCatalog(payload), 'example').package_version,
    '2.0.0',
  );
  assert.match(managedPackageCatalogDigest(payload), /^sha256:[0-9a-f]{64}$/);
});

test('catalog normalization rejects the retired Framework repository index', () => {
  const payload = releaseSetCatalog({}, 'opl_package_repository_index.v1');

  assert.throws(
    () => normalizeManagedPackageCatalog(payload),
    (error: any) => error?.details?.failure_code === 'agent_package_repository_index_retired',
  );
});

test('catalog normalization fails closed when selected_version has no exact candidate', () => {
  const payload = releaseSetCatalog({
    example: {
      package_id: 'example',
      package_role: 'standard_agent',
      selected_version: '2.0.0',
      versions: [catalogVersion('1.0.0')],
    },
  });

  assert.throws(
    () => normalizeManagedPackageCatalog(payload),
    (error: any) => error?.details?.failure_code === 'agent_package_catalog_selection_invalid',
  );
});
