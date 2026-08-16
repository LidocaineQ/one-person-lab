import { Context } from '@deepseek-ai/cordis';

import {
  CHANNEL_PROVIDER_HOST_SERVICE_ID,
  CHANNEL_THREAD_CALLBACK_API_VERSION,
  assertChannelDisposable,
  assertChannelProvider,
  assertChannelThreadCallback,
  type ChannelDisposable,
  type ChannelConversationIdentity,
  type ChannelProvider,
  type ChannelThreadRef,
  type ChannelThreadCallback,
  type ChannelTurnRef,
  type ChannelTurnTerminalEvent,
  type ChannelTurnTerminalObserver,
} from '../../authority/packages/index.ts';
import {
  buildCordisPluginDescriptor,
  type CordisPluginDescriptor,
} from '../../authority/packages/index.ts';

export const CORDIS_CHANNEL_PROVIDER_HOST_PLUGIN_ID = 'opl-connect-channel-provider-host';
export const CORDIS_CHANNEL_PROVIDER_HOST_PLUGIN_API_VERSION = '1.0.0';
export const CORDIS_CHANNEL_PROVIDER_HOST_SERVICE = CHANNEL_PROVIDER_HOST_SERVICE_ID;
export const CORDIS_CHANNEL_PROVIDER_HOST_SOURCE_REF =
  'src/host/plugins/cordis-channel-provider-host.ts';
export const CORDIS_CHANNEL_PROVIDER_HOST_SOURCE_COMMIT =
  'd39c4026811620a3511c8a8af708462f31a0549a';

export type CordisChannelProviderHostService = Readonly<{
  callback_api_version: typeof CHANNEL_THREAD_CALLBACK_API_VERSION;
  attach(provider: ChannelProvider): Promise<ChannelDisposable>;
}>;

export type CordisChannelProviderHostPluginConfig = Readonly<{
  callback: ChannelThreadCallback;
  providers?: readonly ChannelProvider[];
}>;

declare module '@deepseek-ai/cordis' {
  interface Context {
    [CORDIS_CHANNEL_PROVIDER_HOST_SERVICE]: CordisChannelProviderHostService;
  }
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new TypeError(`Channel callback requires ${field}.`);
  }
  return value;
}

function conversationIdentity(input: ChannelConversationIdentity): ChannelConversationIdentity {
  return Object.freeze({
    provider_id: requiredString(input?.provider_id, 'provider_id'),
    account_id: requiredString(input?.account_id, 'account_id'),
    channel_session_id: requiredString(input?.channel_session_id, 'channel_session_id'),
  });
}

function threadRef(input: ChannelThreadRef): ChannelThreadRef {
  return Object.freeze({
    canonical_thread_host: requiredString(
      input?.canonical_thread_host,
      'canonical_thread_host',
    ),
    canonical_thread_id: requiredString(input?.canonical_thread_id, 'canonical_thread_id'),
  });
}

function turnRef(input: ChannelTurnRef): ChannelTurnRef {
  return Object.freeze({
    ...threadRef(input),
    canonical_turn_id: requiredString(input?.canonical_turn_id, 'canonical_turn_id'),
  });
}

function sameThread(expected: ChannelThreadRef, actual: ChannelThreadRef) {
  if (
    expected.canonical_thread_host !== actual.canonical_thread_host
    || expected.canonical_thread_id !== actual.canonical_thread_id
  ) {
    throw new Error('Channel callback returned a mismatched canonical thread ref.');
  }
}

function terminalEvent(
  expected: ChannelTurnRef,
  event: ChannelTurnTerminalEvent,
): ChannelTurnTerminalEvent {
  const actual = turnRef(event);
  sameThread(expected, actual);
  if (expected.canonical_turn_id !== actual.canonical_turn_id) {
    throw new Error('Channel callback observed a mismatched canonical turn ref.');
  }
  switch (event.status) {
    case 'completed':
      return Object.freeze({
        ...actual,
        status: event.status,
        response_text: requiredString(event.response_text, 'response_text'),
      });
    case 'failed':
      return Object.freeze({
        ...actual,
        status: event.status,
        error: Object.freeze({
          code: requiredString(event.error?.code, 'error.code'),
          message: requiredString(event.error?.message, 'error.message'),
        }),
      });
    case 'cancelled':
      return Object.freeze({ ...actual, status: event.status });
    default:
      throw new TypeError('Channel callback terminal status is invalid.');
  }
}

function terminalObserver(
  expected: ChannelTurnRef,
  observer: ChannelTurnTerminalObserver,
): ChannelTurnTerminalObserver {
  if (!observer || typeof observer.onTerminal !== 'function') {
    throw new TypeError('Channel turn subscription requires a terminal observer.');
  }
  return Object.freeze({
    onTerminal: (event) => observer.onTerminal(terminalEvent(expected, event)),
  });
}

export const cordisChannelProviderHostPlugin = {
  name: CORDIS_CHANNEL_PROVIDER_HOST_PLUGIN_ID,
  provide: CORDIS_CHANNEL_PROVIDER_HOST_SERVICE,
  async apply(ctx: Context, config: CordisChannelProviderHostPluginConfig) {
    assertChannelThreadCallback(config.callback);
    const activeProviders = new Set<string>();
    const service: CordisChannelProviderHostService = {
      callback_api_version: CHANNEL_THREAD_CALLBACK_API_VERSION,
      async attach(provider) {
        assertChannelProvider(provider);
        if (activeProviders.has(provider.provider_id)) {
          throw new Error(`Channel provider is already attached: ${provider.provider_id}`);
        }
        activeProviders.add(provider.provider_id);
        const boundedCallback: ChannelThreadCallback = Object.freeze({
          async startThread(input) {
            const identity = conversationIdentity(input);
            if (identity.provider_id !== provider.provider_id) {
              throw new Error(
                `Channel provider ${provider.provider_id} cannot bind another provider identity: ${identity.provider_id}`,
              );
            }
            return threadRef(await config.callback.startThread(identity));
          },
          resumeThread: (input) => config.callback.resumeThread(threadRef(input)),
          async startTurn(input) {
            const canonicalThread = threadRef(input);
            const result = turnRef(await config.callback.startTurn({
              ...canonicalThread,
              text: requiredString(input?.text, 'text'),
            }));
            sameThread(canonicalThread, result);
            return result;
          },
          subscribeTurn(input, observer) {
            const canonicalTurn = turnRef(input);
            const subscription = config.callback.subscribeTurn(
              canonicalTurn,
              terminalObserver(canonicalTurn, observer),
            );
            assertChannelDisposable(subscription);
            return Object.freeze({ dispose: () => subscription.dispose() });
          },
        });
        let providerDisposable: ChannelDisposable;
        try {
          providerDisposable = await provider.start({
            callback_api_version: CHANNEL_THREAD_CALLBACK_API_VERSION,
            callback: boundedCallback,
          });
          assertChannelDisposable(providerDisposable);
        } catch (error) {
          activeProviders.delete(provider.provider_id);
          throw error;
        }
        let disposed = false;
        const disposeEffect = ctx.effect(() => async () => {
          if (disposed) return;
          disposed = true;
          activeProviders.delete(provider.provider_id);
          await providerDisposable.dispose();
        }, `channel-provider:${provider.provider_id}`);
        return Object.freeze({
          async dispose() {
            await disposeEffect();
          },
        });
      },
    };
    ctx.provide(CORDIS_CHANNEL_PROVIDER_HOST_SERVICE, service);
    for (const provider of config.providers ?? []) await service.attach(provider);
  },
};

const forbiddenAuthorities = Object.freeze([
  'package_installed_truth',
  'package_currentness',
  'native_carrier_lifecycle',
  'temporal_workflow_history',
  'workspace_file_bytes',
  'workspace_binding_registry',
  'ledger_evidence_persistence',
  'ledger_receipt_authority',
  'app_product_truth',
  'credential_material',
  'security_sandbox',
]);

export const CORDIS_CHANNEL_PROVIDER_HOST_PLUGIN_DESCRIPTOR: CordisPluginDescriptor =
  buildCordisPluginDescriptor({
    plugin_id: CORDIS_CHANNEL_PROVIDER_HOST_PLUGIN_ID,
    plugin_api_version: CORDIS_CHANNEL_PROVIDER_HOST_PLUGIN_API_VERSION,
    source_ref: CORDIS_CHANNEL_PROVIDER_HOST_SOURCE_REF,
    source_commit: CORDIS_CHANNEL_PROVIDER_HOST_SOURCE_COMMIT,
    package_ref: {
      package_id: 'opl-framework',
      package_version: '0.3.5',
      package_ref: 'workspace:opl-framework@0.3.5',
    },
    required: false,
    provides: [CORDIS_CHANNEL_PROVIDER_HOST_SERVICE],
    injects: { required: [], optional: [] },
    events: [],
    scope: 'composition',
    trust: 'first_party_restricted',
    disposer: { required: true, boundary: 'plugin_fiber' },
    authority_boundary: { forbidden_authorities: forbiddenAuthorities },
  });
