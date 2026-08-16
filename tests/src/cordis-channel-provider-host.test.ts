import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

import {
  CHANNEL_THREAD_CALLBACK_API_VERSION,
  buildPackageHostContext,
  readCapabilityPackageHostContract,
  type ChannelProvider,
  type ChannelThreadCallback,
} from '../../src/authority/packages/index.ts';
import {
  createCordisAppFullComposition,
  startCordisChannelProviderHost,
} from '../../src/host/composition-profiles.ts';
import {
  CORDIS_CHANNEL_PROVIDER_HOST_PLUGIN_ID,
} from '../../src/host/plugins/cordis-channel-provider-host.ts';
import {
  normalizeCapabilityPackageManifest,
} from '../../src/adapters/integration/agent-package-registry-parts/manifest-normalizers.ts';
import type {
  InstalledPackageDescriptor,
} from '../../src/adapters/integration/agent-package-registry-parts/installed-codex-plugin-directory.ts';
import { loadInstalledChannelProviders } from '../../src/adapters/integration/public/channel-provider-entrypoints.ts';
import { parseJsonText } from '../../src/kernel/json-file.ts';
import { assertJsonSchemaPayload } from '../../src/kernel/schema-registry.ts';

const repoRoot = path.resolve(import.meta.dirname, '..', '..');

function emptyDescriptorDiscovery() {
  return { discover: () => new Map() };
}

function callbackFixture(events: string[] = []): ChannelThreadCallback {
  return {
    async startThread(identity) {
      assert.deepEqual(Object.keys(identity).sort(), [
        'account_id',
        'channel_session_id',
        'provider_id',
      ]);
      events.push(`thread:start:${identity.provider_id}:${identity.channel_session_id}`);
      return { canonical_thread_host: 'studio', canonical_thread_id: 'thread-1' };
    },
    async resumeThread({ canonical_thread_id: threadId }) {
      events.push(`thread:resume:${threadId}`);
    },
    async startTurn({ canonical_thread_host: threadHost, canonical_thread_id: threadId, text }) {
      events.push(`turn:start:${threadId}:${text}`);
      return {
        canonical_thread_host: threadHost,
        canonical_thread_id: threadId,
        canonical_turn_id: 'turn-1',
      };
    },
    subscribeTurn(turn, observer) {
      events.push(`turn:subscribe:${turn.canonical_turn_id}`);
      void observer.onTerminal({
        ...turn,
        status: 'completed',
        response_text: 'done',
      });
      return {
        dispose() {
          events.push(`turn:unsubscribe:${turn.canonical_turn_id}`);
        },
      };
    },
  };
}

test('app-full channel provider is dormant unless a Shell callback is injected', async () => {
  const composition = await createCordisAppFullComposition({
    runtimeSnapshotProvider: async () => ({ runtime_tray_snapshot: {} }),
  });
  try {
    assert.equal(composition.services.channelProviderHost, null);
    assert.equal(
      composition.snapshot.plugins.some(
        (plugin) => plugin.plugin_id === CORDIS_CHANNEL_PROVIDER_HOST_PLUGIN_ID,
      ),
      false,
    );
  } finally {
    await composition.dispose();
  }
});

test('app-full attaches a long-lived provider to the bounded callback and tears it down', async () => {
  const events: string[] = [];
  const callback = callbackFixture(events);
  const provider: ChannelProvider = {
    provider_id: 'opl-channel-weixin',
    async start({ callback_api_version: apiVersion, callback: injected }) {
      assert.equal(apiVersion, CHANNEL_THREAD_CALLBACK_API_VERSION);
      assert.notEqual(injected, callback);
      assert.deepEqual(Object.keys(injected).sort(), [
        'resumeThread',
        'startThread',
        'startTurn',
        'subscribeTurn',
      ]);
      await assert.rejects(
        () => injected.startThread({
          provider_id: 'other-provider',
          account_id: 'account-1',
          channel_session_id: 'session-1',
        }),
        /cannot bind another provider identity/,
      );
      const thread = await injected.startThread({
        provider_id: 'opl-channel-weixin',
        account_id: 'account-1',
        channel_session_id: 'session-1',
        ignored: 'not-forwarded',
      } as any);
      await injected.resumeThread(thread);
      const turn = await injected.startTurn({ ...thread, text: 'hello' });
      const subscription = injected.subscribeTurn(turn, {
        onTerminal(event) {
          events.push(`turn:terminal:${event.status}`);
        },
      });
      return {
        async dispose() {
          await subscription.dispose();
          events.push('provider:dispose');
        },
      };
    },
  };
  const composition = await createCordisAppFullComposition({
    runtimeSnapshotProvider: async () => ({ runtime_tray_snapshot: {} }),
    channelProvider: { callback, providers: [provider] },
    connect: emptyDescriptorDiscovery(),
  });
  assert.ok(composition.services.channelProviderHost);
  assert.equal(composition.services.channelProviderHost.callback_api_version, '1.0.0');
  assert.equal(
    composition.snapshot.plugins.find(
      (plugin) => plugin.plugin_id === CORDIS_CHANNEL_PROVIDER_HOST_PLUGIN_ID,
    )?.required,
    false,
  );
  assert.deepEqual(events, [
    'thread:start:opl-channel-weixin:session-1',
    'thread:resume:thread-1',
    'turn:start:thread-1:hello',
    'turn:subscribe:turn-1',
    'turn:terminal:completed',
  ]);
  await assert.rejects(
    () => composition.services.channelProviderHost!.attach(provider),
    /already attached/,
  );
  await composition.dispose();
  assert.deepEqual(events.slice(-2), ['turn:unsubscribe:turn-1', 'provider:dispose']);
});

test('app-full loads a callable channel provider from an installed descriptor entrypoint', async () => {
  const packageRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'opl-channel-provider-'));
  const moduleRef = 'channel-provider.mjs';
  const modulePath = path.join(packageRoot, moduleRef);
  fs.writeFileSync(modulePath, [
    'export let factoryCount = 0;',
    'export let startCount = 0;',
    'export let disposeCount = 0;',
    'function provider(providerId = "opl-channel-test") {',
    '  return {',
    '    provider_id: providerId,',
    '    async start() {',
    '      startCount += 1;',
    '      return { async dispose() { disposeCount += 1; } };',
    '    },',
    '  };',
    '}',
    'export function createChannelProvider() {',
    '  factoryCount += 1;',
    '  return provider();',
    '}',
    'export const channelProvider = provider();',
    'export function requiresOptions(_options) { return provider(); }',
    'export async function asyncFactory() { return provider(); }',
    'export function invalidFactory() { return {}; }',
    'export function wrongIdentityFactory() { return provider("other-provider"); }',
  ].join('\n'));
  const ownerManifest = parseJsonText(fs.readFileSync(
    path.join(repoRoot, 'contracts/opl-framework/packages/opl-relay.json'),
    'utf8',
  )) as Record<string, any>;
  const manifestPath = path.join(packageRoot, 'opl-package.json');
  const packageManifestPayload: Record<string, any> = {
    ...ownerManifest,
    package_id: 'opl-channel-test',
    display_name: 'Channel test provider',
    exports: {
      ...ownerManifest.exports,
      core_skill_ids: [],
      specialty_skill_ids: [],
    },
    consumer_profiles: [],
    entrypoints: [{
      entrypoint_id: 'channel-provider',
      kind: 'channel_provider',
      module_ref: moduleRef,
      export_name: 'createChannelProvider',
    }],
    codex_surface: {
      ...ownerManifest.codex_surface,
      plugin_id: 'opl-channel-test',
      configured_codex_plugin_carrier: {
        ...ownerManifest.codex_surface.configured_codex_plugin_carrier,
        plugin_selector: 'opl-channel-test@opl-channel-test',
      },
    },
  };
  assert.throws(
    () => normalizeCapabilityPackageManifest(packageManifestPayload, manifestPath),
    /content lock/,
  );
  packageManifestPayload.content_lock = {
    ...ownerManifest.content_lock,
    paths: [
      ...ownerManifest.content_lock.paths.filter(
        (entry: string) => !entry.startsWith('skills/'),
      ),
      moduleRef,
    ],
  };
  const manifestSchema = parseJsonText(fs.readFileSync(
    path.join(repoRoot, 'contracts/opl-framework/capability-package-manifest.schema.json'),
    'utf8',
  )) as Record<string, unknown>;
  assert.doesNotThrow(() => assertJsonSchemaPayload({
    schemaId: String(manifestSchema.$id),
    schema: manifestSchema,
    sourceRef: 'contracts/opl-framework/capability-package-manifest.schema.json',
  }, packageManifestPayload));
  const manifest = normalizeCapabilityPackageManifest(packageManifestPayload, manifestPath);
  assert.deepEqual(manifest.required_skill_ids, []);
  const descriptor = {
    manifest,
    manifestPath,
    manifest_sha256: 'test',
    sourcePath: packageRoot,
    pluginId: 'opl-channel-test',
    marketplaceSource: null,
    enabled: true,
    carrier: manifest.configured_codex_plugin_carrier!,
    carrier_readback: {
      kind: 'test',
      identity: 'opl-channel-test',
      source_ref: packageRoot,
      version: manifest.version,
      enabled: true,
      lifecycle_authority: 'carrier_owned',
    },
    readiness: {
      installed: true,
      physical_status: 'available',
      callability: 'callable',
    },
  } as InstalledPackageDescriptor;
  const descriptorForExport = (exportName: string): InstalledPackageDescriptor => ({
    ...descriptor,
    manifest: {
      ...descriptor.manifest,
      entrypoints: [{
        entrypoint_id: 'channel-provider',
        kind: 'channel_provider',
        module_ref: moduleRef,
        export_name: exportName,
      }],
    },
  });
  const first = (await loadInstalledChannelProviders([descriptor]))[0];
  const second = (await loadInstalledChannelProviders([descriptor]))[0];
  assert.notEqual(first, second);
  await assert.rejects(
    () => loadInstalledChannelProviders([descriptorForExport('channelProvider')]),
    /zero-argument factory/,
  );
  await assert.rejects(
    () => loadInstalledChannelProviders([descriptorForExport('requiresOptions')]),
    /zero-argument factory/,
  );
  await assert.rejects(
    () => loadInstalledChannelProviders([descriptorForExport('asyncFactory')]),
    /return synchronously/,
  );
  await assert.rejects(
    () => loadInstalledChannelProviders([descriptorForExport('invalidFactory')]),
    /stable provider_id/,
  );
  await assert.rejects(
    () => loadInstalledChannelProviders([descriptorForExport('wrongIdentityFactory')]),
    /identity must match/,
  );
  const composition = await createCordisAppFullComposition({
    runtimeSnapshotProvider: async () => ({ runtime_tray_snapshot: {} }),
    channelProvider: { callback: callbackFixture() },
    connect: { discover: () => new Map([[manifest.package_id, descriptor]]) },
  });
  try {
    const loaded = await import(pathToFileURL(modulePath).href);
    assert.equal(loaded.factoryCount, 3);
    assert.equal(loaded.startCount, 1);
    assert.ok(composition.services.channelProviderHost);
  } finally {
    await composition.dispose();
    const loaded = await import(pathToFileURL(modulePath).href);
    assert.equal(loaded.disposeCount, 1);
    fs.rmSync(packageRoot, { recursive: true, force: true });
  }
});

test('public channel-provider bootstrap owns the app-full Host lifecycle', async () => {
  const previousBinary = process.env.OPL_CODEX_PLUGIN_BIN;
  process.env.OPL_CODEX_PLUGIN_BIN = path.join(
    os.tmpdir(),
    `missing-codex-plugin-manager-${process.pid}`,
  );
  try {
    const host = await startCordisChannelProviderHost({ callback: callbackFixture() });
    assert.equal(typeof host.dispose, 'function');
    await host.dispose();
  } finally {
    if (previousBinary === undefined) delete process.env.OPL_CODEX_PLUGIN_BIN;
    else process.env.OPL_CODEX_PLUGIN_BIN = previousBinary;
  }
});

test('capability Package channel-provider context requires the optional app-full host', async () => {
  const dormant = await createCordisAppFullComposition({
    runtimeSnapshotProvider: async () => ({ runtime_tray_snapshot: {} }),
  });
  const configured = await createCordisAppFullComposition({
    runtimeSnapshotProvider: async () => ({ runtime_tray_snapshot: {} }),
    channelProvider: { callback: callbackFixture() },
    connect: emptyDescriptorDiscovery(),
  });
  try {
    const manifest = parseJsonText(fs.readFileSync(
      path.join(repoRoot, 'contracts/opl-framework/packages/opl-relay.json'),
      'utf8',
    )) as { surface_kind: 'opl_capability_package_manifest.v2'; package_id: string };
    const integration = readCapabilityPackageHostContract();
    const dormantContext = buildPackageHostContext({
      package_id: manifest.package_id,
      integration,
      integration_trigger: 'channel_provider',
      environment: {
        profile_id: 'app-full',
        snapshots: [{ composition_id: 'profile:app-full', snapshot: dormant.snapshot }],
      },
    });
    const configuredContext = buildPackageHostContext({
      package_id: manifest.package_id,
      integration,
      integration_trigger: 'channel_provider',
      environment: {
        profile_id: 'app-full',
        snapshots: [{ composition_id: 'profile:app-full', snapshot: configured.snapshot }],
      },
    });
    assert.equal(dormantContext.status, 'blocked');
    assert.deepEqual(dormantContext.blockers, [
      'required_host_capability_missing:opl.connect.channel-provider-host',
    ]);
    assert.equal(configuredContext.status, 'ready');
    assert.equal(configuredContext.capabilities.required[0]?.status, 'resolved');
  } finally {
    await configured.dispose();
    await dormant.dispose();
  }
});
