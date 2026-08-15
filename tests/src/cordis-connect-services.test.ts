import assert from 'node:assert/strict';
import test from 'node:test';

import * as connect from '../../src/host/plugins/cordis-connect-services.ts';
import {
  buildCordisConnectCompositionSnapshot,
  CORDIS_CONNECT_DESCRIPTOR_DISCOVERY_PLUGIN_DESCRIPTOR,
  CORDIS_CONNECT_DESCRIPTOR_DISCOVERY_SERVICE,
  createCordisConnectComposition,
} from '../../src/host/plugins/cordis-connect-services.ts';

test('Connect does not expose an import-time default discovery composition', () => {
  assert.equal('discoverInstalledPackageDescriptorsViaCordis' in connect, false);
});

test('Connect descriptor discovery composes, emits refs-only observation, and disposes', async () => {
  const calls: unknown[] = [];
  const composition = await createCordisConnectComposition({
    discover(input = {}) {
      calls.push(input);
      return new Map();
    },
  });
  const observations: unknown[] = [];
  composition.ctx.on('opl/connect/descriptors/discovered', (observation) => {
    observations.push(observation);
  });

  try {
    assert.equal(
      composition.ctx.get(CORDIS_CONNECT_DESCRIPTOR_DISCOVERY_SERVICE),
      composition.descriptorDiscovery,
    );
    assert.deepEqual(composition.snapshot, buildCordisConnectCompositionSnapshot());
    assert.equal(composition.snapshot.plugins.length, 1);
    assert.deepEqual(
      composition.snapshot.plugins[0],
      CORDIS_CONNECT_DESCRIPTOR_DISCOVERY_PLUGIN_DESCRIPTOR,
    );

    const descriptors = composition.descriptorDiscovery.discover({
      packageId: 'future-agent',
    });
    assert.equal(descriptors.size, 0);
    assert.deepEqual(calls, [{ packageId: 'future-agent' }]);
    assert.deepEqual(observations, [{
      surface_kind: 'opl_connect_descriptor_discovery_observation.v1',
      package_filter: 'future-agent',
      descriptor_count: 0,
      package_ids: [],
      authority_boundary: {
        descriptor_source: 'native_carrier_fresh_readback',
        installed_truth_owner: 'native_carrier',
        currentness_truth_owner: 'package_owner_channel',
        cordis_installed_truth: false,
        cordis_currentness_truth: false,
        cordis_lifecycle_authority: false,
      },
    }]);
  } finally {
    await composition.dispose();
  }

  assert.equal(
    composition.ctx.get(CORDIS_CONNECT_DESCRIPTOR_DISCOVERY_SERVICE),
    undefined,
  );
});

test('Connect Cordis service delegates every read to the native carrier without cache or lifecycle state', async () => {
  const nativeCalls: Array<{ binary: string; args: string[] }> = [];
  const composition = await createCordisConnectComposition();
  try {
    const descriptors = composition.descriptorDiscovery.discover({
      packageId: 'future-agent',
      binary: 'fixture-codex',
      runner(input) {
        nativeCalls.push({ binary: input.binary, args: input.args });
        return {
          status: 0,
          stdout: '{"installed":[]}',
          stderr: '',
          error: null,
        };
      },
    });
    assert.equal(descriptors.size, 0);
    assert.deepEqual(nativeCalls, [{
      binary: 'fixture-codex',
      args: ['plugin', 'list', '--json'],
    }]);
    assert.ok(
      CORDIS_CONNECT_DESCRIPTOR_DISCOVERY_PLUGIN_DESCRIPTOR.authority_boundary
        .forbidden_authorities.includes('package_installed_truth'),
    );
    assert.ok(
      CORDIS_CONNECT_DESCRIPTOR_DISCOVERY_PLUGIN_DESCRIPTOR.authority_boundary
        .forbidden_authorities.includes('package_currentness'),
    );
    assert.ok(
      CORDIS_CONNECT_DESCRIPTOR_DISCOVERY_PLUGIN_DESCRIPTOR.authority_boundary
        .forbidden_authorities.includes('credential_material'),
    );
  } finally {
    await composition.dispose();
  }
});
