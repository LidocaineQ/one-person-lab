import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createCordisAppFullComposition,
  startCordisAutomationProviderHost,
} from '../../src/host/composition-profiles.ts';
import {
  CORDIS_AUTOMATION_PROVIDER_HOST_PLUGIN_ID,
  type CordisAutomationProvider,
  type CordisAutomationProviderHostPluginConfig,
} from '../../src/host/plugins/cordis-automation-provider-host.ts';

function emptyDescriptorDiscovery() {
  return { discover: () => new Map() };
}

function providerFixture(
  providerId: string,
  automationKind: 'computer_use' | 'browser_automation',
  events: string[] = [],
): CordisAutomationProvider {
  const actionId = automationKind === 'computer_use'
    ? 'settings_recheck_computer_use'
    : 'settings_recheck_browser_automation';
  return {
    provider_id: providerId,
    automation_kind: automationKind,
    buildActionCatalog() {
      return [{ action_id: actionId, label: `action:${actionId}` }];
    },
    inspect(input) {
      events.push(`inspect:${input?.runExternalChecks === true ? 'external' : 'local'}`);
      return {
        surface_kind: 'automation-test-inspection',
        provider_id: providerId,
        run_external_checks: input?.runExternalChecks === true,
      };
    },
    reconcile(input) {
      events.push(`reconcile:${input.action_id}`);
      return {
        surface_kind: 'automation-test-result',
        provider_id: providerId,
        action_id: input.action_id,
      };
    },
    dispose() {
      events.push('dispose');
    },
  };
}

function appFullOptions(
  automationProvider?: CordisAutomationProviderHostPluginConfig,
) {
  return {
    runtimeSnapshotProvider: async () => ({ runtime_tray_snapshot: {} }),
    connect: emptyDescriptorDiscovery(),
    ...(automationProvider ? { automationProvider } : {}),
  };
}

test('app-full automation provider Host is dormant without explicit configuration', async () => {
  const composition = await createCordisAppFullComposition(appFullOptions());
  try {
    assert.equal(composition.services.automationProviderHost, null);
    assert.equal(
      composition.snapshot.plugins.some(
        (plugin) => plugin.plugin_id === CORDIS_AUTOMATION_PROVIDER_HOST_PLUGIN_ID,
      ),
      false,
    );
  } finally {
    await composition.dispose();
  }
});

test('automation provider Host exposes inspect, declared actions, projection, and disposal', async () => {
  const events: string[] = [];
  const provider = providerFixture('automation-browser-test', 'browser_automation', events);
  const composition = await createCordisAppFullComposition(appFullOptions({
    providers: [provider],
  }));
  const host = composition.services.automationProviderHost!;
  try {
    assert.equal(host.api_version, '1.0.0');
    assert.equal(
      composition.snapshot.plugins.find(
        (plugin) => plugin.plugin_id === CORDIS_AUTOMATION_PROVIDER_HOST_PLUGIN_ID,
      )?.required,
      false,
    );
    assert.deepEqual(host.actionCatalog({ provider_id: provider.provider_id }), [
      {
        action_id: 'settings_recheck_browser_automation',
        label: 'action:settings_recheck_browser_automation',
      },
    ]);
    assert.deepEqual(
      await host.inspect({ provider_id: provider.provider_id, runExternalChecks: false }),
      {
        surface_kind: 'automation-test-inspection',
        provider_id: provider.provider_id,
        run_external_checks: false,
      },
    );
    assert.deepEqual(
      await host.execute({
        provider_id: provider.provider_id,
        action_id: 'settings_recheck_browser_automation',
      }),
      {
        surface_kind: 'automation-test-result',
        provider_id: provider.provider_id,
        action_id: 'settings_recheck_browser_automation',
      },
    );
    assert.deepEqual(
      await host.execute({
        provider_id: provider.provider_id,
        action_id: 'settings_recheck_browser_automation',
        dry_run: true,
      }),
      {
        surface_kind: 'automation-test-inspection',
        provider_id: provider.provider_id,
        run_external_checks: false,
      },
    );
    assert.deepEqual(host.appStatePatch(), {
      surface_kind: 'opl_automation_provider_host_projection.v1',
      api_version: '1.0.0',
      status: 'available',
      providers: [{
        provider_id: provider.provider_id,
        automation_kind: 'browser_automation',
        action_ids: ['settings_recheck_browser_automation'],
      }],
      authority_boundary: {
        provider_implementation_owner: 'framework_managed_native_provider',
        package_lifecycle_owner: 'not_applicable',
        framework_role: 'host_lifecycle_and_projection_route',
        persistence_role: 'none',
      },
    });
    await assert.rejects(
      () => host.execute({
        provider_id: provider.provider_id,
        action_id: 'unknown_action',
      }),
      /action is not declared/,
    );
    await assert.rejects(
      () => host.inspect({ automation_kind: 'computer_use' }),
      /Automation provider is unavailable/,
    );
  } finally {
    await composition.dispose();
  }
  assert.deepEqual(events, [
    'inspect:local',
    'reconcile:settings_recheck_browser_automation',
    'inspect:local',
    'dispose',
  ]);
  assert.equal((host.appStatePatch() as any).status, 'unavailable');
});

test('selected automation providers fail closed when the explicit host provider is unavailable', async () => {
  await assert.rejects(
    () => createCordisAppFullComposition(appFullOptions({
      selectedProviders: [{ provider_id: 'missing-automation-provider' }],
    })),
    /Selected automation provider is unavailable: missing-automation-provider/,
  );
});

test('public automation provider bootstrap owns the app-full Host lifecycle', async () => {
  const events: string[] = [];
  const provider = providerFixture('automation-bootstrap-test', 'computer_use', events);
  const host = await startCordisAutomationProviderHost({ providers: [provider] });
  try {
    assert.equal(typeof host.inspect, 'function');
    assert.equal(typeof host.execute, 'function');
    assert.deepEqual(host.actionCatalog({ provider_id: provider.provider_id }).map(
      (action) => action.action_id,
    ), ['settings_recheck_computer_use']);
  } finally {
    await host.dispose();
  }
  assert.deepEqual(events, ['dispose']);
});
