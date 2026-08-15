import assert from 'node:assert/strict';
import test from 'node:test';

import {
  normalizeManagedPackageCatalog,
  selectManagedCatalogPackageVersion,
} from '../../src/adapters/integration/agent-package-registry-parts/capability-reconciliation.ts';

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

test('Package owner catalog selects the exact declared root version without compatibility resolution', () => {
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

test('Package owner catalog defaults selected versions to the owner channel', () => {
  const payload = releaseSetCatalog({
    example: {
      package_id: 'example',
      package_role: 'standard_agent',
      selected_version: '2.0.0',
      versions: [{
        package_version: '2.0.0',
        manifest_url: 'https://packages.example.test/example/2.0.0/manifest.json',
        manifest_sha256: digest('2'),
      }],
    },
  });

  const selected = selectManagedCatalogPackageVersion(
    normalizeManagedPackageCatalog(payload),
    'example',
  );

  assert.equal(selected.selection_status, 'selected_for_owner_channel');
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
});

test('catalog normalization rejects the retired Framework repository index', () => {
  const payload = releaseSetCatalog({}, 'opl_package_repository_index.v1');

  assert.throws(
    () => normalizeManagedPackageCatalog(payload),
    (error: any) => {
      assert.equal(error?.details?.failure_code, 'agent_package_repository_index_retired');
      assert.match(error.message, /Package owner's OCI latest-stable channel/);
      assert.doesNotMatch(error.message, /Release Set/);
      return true;
    },
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
