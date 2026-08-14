import { Context } from '@deepseek-ai/cordis';

import type {
  AgentExecutionReceipt,
  AgentExecutionRequest,
} from './agent-executor.ts';
import { runAgentExecutor } from './agent-executor.ts';

export const CORDIS_AGENT_EXECUTOR_EXPERIMENT_VERSION = 'cordis-agent-executor-experiment.v1';
export const CORDIS_FRAMEWORK_PACKAGE = '@deepseek-ai/cordis';
export const CORDIS_FRAMEWORK_VERSION = '4.0.1';
// Cordis 4.0.1 exposes fiber.state, but its const enum is erased from the ESM runtime.
export const CORDIS_FIBER_STATE = {
  PENDING: 0,
  ACTIVE: 2,
} as const;

export type CordisAgentExecutorAdapter = {
  readonly id: string;
  execute(request: AgentExecutionRequest): AgentExecutionReceipt;
};

export type CordisAgentExecutorService = {
  execute(request: AgentExecutionRequest): Promise<AgentExecutionReceipt>;
};

export type CordisAgentExecutorObserver = {
  onRequest?: (request: AgentExecutionRequest) => void;
  onResult?: (receipt: AgentExecutionReceipt) => void | Promise<void>;
};

export type CordisAgentExecutorCompositionSnapshot = {
  readonly version: typeof CORDIS_AGENT_EXECUTOR_EXPERIMENT_VERSION;
  readonly framework: {
    readonly package: typeof CORDIS_FRAMEWORK_PACKAGE;
    readonly version: typeof CORDIS_FRAMEWORK_VERSION;
  };
  readonly binding: {
    readonly executor_adapter_id: string;
  };
  readonly plugins: ReadonlyArray<{
    readonly id: string;
    readonly required: boolean;
    readonly provides: readonly string[];
    readonly injects: readonly string[];
    readonly scope: 'composition';
    readonly trust: 'first_party_privileged';
  }>;
};

declare module '@deepseek-ai/cordis' {
  interface Context {
    oplAgentExecutorAdapter: CordisAgentExecutorAdapter;
    oplAgentExecutor: CordisAgentExecutorService;
  }

  interface Events {
    'opl/agent-executor/request': (request: AgentExecutionRequest) => void;
    'opl/agent-executor/result': (receipt: AgentExecutionReceipt) => void | Promise<void>;
  }
}

export const cordisAgentExecutorAdapterPlugin = {
  name: 'opl-cordis-agent-executor-adapter',
  provide: 'oplAgentExecutorAdapter',
  apply(ctx: Context, config: { adapter: CordisAgentExecutorAdapter }) {
    ctx.provide('oplAgentExecutorAdapter', config.adapter);
  },
};

export const cordisAgentExecutorServicePlugin = {
  name: 'opl-cordis-agent-executor-service',
  inject: ['oplAgentExecutorAdapter'],
  provide: 'oplAgentExecutor',
  apply(ctx: Context) {
    const service: CordisAgentExecutorService = {
      async execute(request) {
        ctx.emit('opl/agent-executor/request', request);
        const receipt = ctx.oplAgentExecutorAdapter.execute(request);
        await ctx.parallel('opl/agent-executor/result', receipt);
        return receipt;
      },
    };
    ctx.provide('oplAgentExecutor', service);
  },
};

export const cordisAgentExecutorObserverPlugin = {
  name: 'opl-cordis-agent-executor-observer',
  apply(ctx: Context, observer: CordisAgentExecutorObserver) {
    if (observer.onRequest) {
      ctx.on('opl/agent-executor/request', observer.onRequest);
    }
    if (observer.onResult) {
      ctx.on('opl/agent-executor/result', observer.onResult);
    }
  },
};

const defaultAdapter: CordisAgentExecutorAdapter = {
  id: 'opl-existing-agent-executor',
  execute: runAgentExecutor,
};

export function buildCordisAgentExecutorCompositionSnapshot(
  executorAdapterId = defaultAdapter.id,
): CordisAgentExecutorCompositionSnapshot {
  return Object.freeze({
    version: CORDIS_AGENT_EXECUTOR_EXPERIMENT_VERSION,
    framework: Object.freeze({
      package: CORDIS_FRAMEWORK_PACKAGE,
      version: CORDIS_FRAMEWORK_VERSION,
    }),
    binding: Object.freeze({
      executor_adapter_id: executorAdapterId,
    }),
    plugins: Object.freeze([
      {
        id: 'opl-cordis-agent-executor-adapter',
        required: true,
        provides: Object.freeze(['oplAgentExecutorAdapter']),
        injects: Object.freeze([]),
        scope: 'composition' as const,
        trust: 'first_party_privileged' as const,
      },
      {
        id: 'opl-cordis-agent-executor-service',
        required: true,
        provides: Object.freeze(['oplAgentExecutor']),
        injects: Object.freeze(['oplAgentExecutorAdapter']),
        scope: 'composition' as const,
        trust: 'first_party_privileged' as const,
      },
      {
        id: 'opl-cordis-agent-executor-observer',
        required: false,
        provides: Object.freeze([]),
        injects: Object.freeze([]),
        scope: 'composition' as const,
        trust: 'first_party_privileged' as const,
      },
    ].map((plugin) => Object.freeze(plugin))),
  });
}

export async function createCordisAgentExecutorComposition(options: {
  adapter?: CordisAgentExecutorAdapter;
} = {}) {
  const ctx = new Context();
  const adapter = options.adapter ?? defaultAdapter;
  const adapterFiber = await ctx.plugin(cordisAgentExecutorAdapterPlugin, {
    adapter,
  });
  const executorFiber = await ctx.plugin(cordisAgentExecutorServicePlugin);
  if (executorFiber.state !== CORDIS_FIBER_STATE.ACTIVE) {
    throw new Error(`Cordis executor service did not become active: ${executorFiber.state}`);
  }

  return {
    ctx,
    adapterFiber,
    executorFiber,
    executor: ctx.oplAgentExecutor,
    snapshot: buildCordisAgentExecutorCompositionSnapshot(adapter.id),
    async dispose() {
      await executorFiber.dispose();
      await adapterFiber.dispose();
      await ctx.fiber.dispose();
    },
  };
}
