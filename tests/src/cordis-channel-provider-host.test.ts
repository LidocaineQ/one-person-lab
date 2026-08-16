import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import {
  CHANNEL_THREAD_CALLBACK_API_VERSION,
  buildPackageHostContext,
  readCapabilityPackageHostContract,
  type ChannelProvider,
  type ChannelThreadCallback,
} from '../../src/authority/packages/package-host-integration.ts';
import {
  createCordisAppFullComposition,
} from '../../src/host/composition-profiles.ts';
import {
  CORDIS_CHANNEL_PROVIDER_HOST_PLUGIN_ID,
} from '../../src/host/plugins/cordis-channel-provider-host.ts';
import { parseJsonText } from '../../src/kernel/json-file.ts';

const repoRoot = path.resolve(import.meta.dirname, '..', '..');

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

test('capability Package channel-provider context requires the optional app-full host', async () => {
  const dormant = await createCordisAppFullComposition({
    runtimeSnapshotProvider: async () => ({ runtime_tray_snapshot: {} }),
  });
  const configured = await createCordisAppFullComposition({
    runtimeSnapshotProvider: async () => ({ runtime_tray_snapshot: {} }),
    channelProvider: { callback: callbackFixture() },
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
