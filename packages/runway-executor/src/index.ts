import { Context } from '@deepseek-ai/cordis';
import {
  buildCordisCompositionSnapshot,
  buildCordisPluginDescriptor,
  type CordisCompositionSnapshot,
  type CordisPluginDescriptor,
} from '@one-person-lab/cordis-abi';
import {
  CORDIS_FIBER_STATE,
  CORDIS_FRAMEWORK_INTEGRITY,
  CORDIS_FRAMEWORK_PACKAGE,
  CORDIS_FRAMEWORK_VERSION,
} from '@one-person-lab/cordis-abi/framework';

export const CORDIS_AGENT_EXECUTOR_PLUGIN_API_VERSION = '1.0.0';
export const CORDIS_AGENT_EXECUTOR_SOURCE_REF =
  'packages/runway-executor/src/index.ts';
export const CORDIS_AGENT_EXECUTOR_SOURCE_COMMIT =
  '832aa00a85eb722dc8748587ffe648b3c6afd808';

export type BaseAgentExecutionRequest = Readonly<{
  prompt: string;
}> & Readonly<Record<string, unknown>>;

export type BaseAgentExecutionReceipt = Readonly<{
  surface_kind: string;
}> & Readonly<Record<string, unknown>>;

export type CordisAgentExecutorAdapter<
  TRequest extends BaseAgentExecutionRequest = BaseAgentExecutionRequest,
  TReceipt extends BaseAgentExecutionReceipt = BaseAgentExecutionReceipt,
> = {
  readonly id: string;
  execute(request: TRequest): TReceipt;
};

export type CordisAgentExecutorService<
  TRequest extends BaseAgentExecutionRequest = BaseAgentExecutionRequest,
  TReceipt extends BaseAgentExecutionReceipt = BaseAgentExecutionReceipt,
> = {
  execute(request: TRequest): Promise<TReceipt>;
};

export type CordisAgentExecutorObserver<
  TRequest extends BaseAgentExecutionRequest = BaseAgentExecutionRequest,
  TReceipt extends BaseAgentExecutionReceipt = BaseAgentExecutionReceipt,
> = {
  onRequest?: (request: TRequest) => void;
  onResult?: (receipt: TReceipt) => void | Promise<void>;
};

declare module '@deepseek-ai/cordis' {
  interface Context {
    'opl.runway.executor.adapter': CordisAgentExecutorAdapter;
    'opl.runway.executor': CordisAgentExecutorService;
  }

  interface Events {
    'opl/runway/executor/requested': (request: BaseAgentExecutionRequest) => void;
    'opl/runway/executor/completed': (receipt: BaseAgentExecutionReceipt) => void | Promise<void>;
  }
}

export const cordisAgentExecutorAdapterPlugin = {
  name: 'opl-cordis-agent-executor-adapter',
  provide: 'opl.runway.executor.adapter',
  apply(ctx: Context, config: { adapter: CordisAgentExecutorAdapter }) {
    ctx.provide('opl.runway.executor.adapter', config.adapter);
  },
};

export const cordisAgentExecutorServicePlugin = {
  name: 'opl-cordis-agent-executor-service',
  inject: ['opl.runway.executor.adapter'],
  provide: 'opl.runway.executor',
  apply(ctx: Context) {
    const service: CordisAgentExecutorService = {
      async execute(request) {
        ctx.emit('opl/runway/executor/requested', request);
        const receipt = ctx['opl.runway.executor.adapter'].execute(request);
        await ctx.parallel('opl/runway/executor/completed', receipt);
        return receipt;
      },
    };
    ctx.provide('opl.runway.executor', service);
  },
};

export const cordisAgentExecutorObserverPlugin = {
  name: 'opl-cordis-agent-executor-observer',
  apply(ctx: Context, observer: CordisAgentExecutorObserver) {
    if (observer.onRequest) ctx.on('opl/runway/executor/requested', observer.onRequest);
    if (observer.onResult) ctx.on('opl/runway/executor/completed', observer.onResult);
  },
};

const forbiddenAuthorities = Object.freeze([
  'package_installed_truth',
  'package_currentness',
  'native_carrier_lifecycle',
  'temporal_workflow_history',
  'temporal_retry_replay',
  'workspace_file_bytes',
  'workspace_binding_registry',
  'ledger_evidence_persistence',
  'ledger_receipt_authority',
  'foundry_agent_version',
  'foundry_promotion_activation',
  'domain_truth',
  'domain_quality_verdict',
  'app_product_truth',
  'credential_material',
  'security_sandbox',
]);

function descriptor(input: {
  pluginId: string;
  required: boolean;
  provides?: readonly string[];
  requiredInjects?: readonly string[];
  events?: CordisPluginDescriptor['events'];
}): CordisPluginDescriptor {
  return buildCordisPluginDescriptor({
    plugin_id: input.pluginId,
    plugin_api_version: CORDIS_AGENT_EXECUTOR_PLUGIN_API_VERSION,
    source_ref: CORDIS_AGENT_EXECUTOR_SOURCE_REF,
    source_commit: CORDIS_AGENT_EXECUTOR_SOURCE_COMMIT,
    package_ref: {
      package_id: '@one-person-lab/runway-executor',
      package_version: '0.1.0',
      package_ref: 'npm:@one-person-lab/runway-executor@0.1.0',
    },
    required: input.required,
    provides: input.provides ?? [],
    injects: {
      required: (input.requiredInjects ?? []).map((serviceId) => ({
        service_id: serviceId,
        plugin_api_versions: [CORDIS_AGENT_EXECUTOR_PLUGIN_API_VERSION],
      })),
      optional: [],
    },
    events: input.events ?? [],
    scope: 'request',
    trust: 'first_party_privileged',
    disposer: { required: true, boundary: 'plugin_fiber' },
    authority_boundary: { forbidden_authorities: forbiddenAuthorities },
  });
}

export const CORDIS_AGENT_EXECUTOR_PLUGIN_DESCRIPTORS: readonly CordisPluginDescriptor[] = Object.freeze([
  descriptor({
    pluginId: 'opl-cordis-agent-executor-adapter',
    required: true,
    provides: ['opl.runway.executor.adapter'],
  }),
  descriptor({
    pluginId: 'opl-cordis-agent-executor-service',
    required: true,
    provides: ['opl.runway.executor'],
    requiredInjects: ['opl.runway.executor.adapter'],
    events: [
      { name: 'opl/runway/executor/requested', mode: 'emit', role: 'publish', payload_schema_ref: null },
      { name: 'opl/runway/executor/completed', mode: 'parallel', role: 'publish', payload_schema_ref: null },
    ],
  }),
  descriptor({
    pluginId: 'opl-cordis-agent-executor-observer',
    required: false,
    events: [
      { name: 'opl/runway/executor/requested', mode: 'observe', role: 'observe', payload_schema_ref: null },
      { name: 'opl/runway/executor/completed', mode: 'observe', role: 'observe', payload_schema_ref: null },
    ],
  }),
]);

export function buildCordisAgentExecutorCompositionSnapshot(
  executorAdapterId: string,
): CordisCompositionSnapshot {
  return buildCordisCompositionSnapshot({
    framework: {
      package: CORDIS_FRAMEWORK_PACKAGE,
      version: CORDIS_FRAMEWORK_VERSION,
      integrity: CORDIS_FRAMEWORK_INTEGRITY,
    },
    binding: {
      executor_adapter_id: executorAdapterId,
      executor_route: 'opl.runway.executor',
    },
    foundry_evidence_ref: null,
    plugins: CORDIS_AGENT_EXECUTOR_PLUGIN_DESCRIPTORS,
  });
}

export async function createCordisAgentExecutorRequest<
  TRequest extends BaseAgentExecutionRequest,
  TReceipt extends BaseAgentExecutionReceipt,
>(options: {
  adapter: CordisAgentExecutorAdapter<TRequest, TReceipt>;
}) {
  const ctx = new Context();
  const adapterFiber = await ctx.plugin(cordisAgentExecutorAdapterPlugin, {
    adapter: options.adapter as CordisAgentExecutorAdapter,
  });
  const executorFiber = await ctx.plugin(cordisAgentExecutorServicePlugin);
  if (executorFiber.state !== CORDIS_FIBER_STATE.ACTIVE) {
    throw new Error(`Cordis executor service did not become active: ${executorFiber.state}`);
  }
  return {
    ctx,
    adapterFiber,
    executorFiber,
    executor: ctx['opl.runway.executor'] as CordisAgentExecutorService<TRequest, TReceipt>,
    snapshot: buildCordisAgentExecutorCompositionSnapshot(options.adapter.id),
    async dispose() {
      await executorFiber.dispose();
      await adapterFiber.dispose();
      await ctx.fiber.dispose();
    },
  };
}
