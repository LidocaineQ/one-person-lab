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
    'opl.runway.executor.adapter': CordisAgentExecutorAdapter;
    'opl.runway.executor': CordisAgentExecutorService;
  }

  interface Events {
    'opl/runway/executor/requested': (request: AgentExecutionRequest) => void;
    'opl/runway/executor/completed': (receipt: AgentExecutionReceipt) => void | Promise<void>;
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
    if (observer.onRequest) {
      ctx.on('opl/runway/executor/requested', observer.onRequest);
    }
    if (observer.onResult) {
      ctx.on('opl/runway/executor/completed', observer.onResult);
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
        provides: Object.freeze(['opl.runway.executor.adapter']),
        injects: Object.freeze([]),
        scope: 'composition' as const,
        trust: 'first_party_privileged' as const,
      },
      {
        id: 'opl-cordis-agent-executor-service',
        required: true,
        provides: Object.freeze(['opl.runway.executor']),
        injects: Object.freeze(['opl.runway.executor.adapter']),
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
    executor: ctx['opl.runway.executor'],
    snapshot: buildCordisAgentExecutorCompositionSnapshot(adapter.id),
    async dispose() {
      await executorFiber.dispose();
      await adapterFiber.dispose();
      await ctx.fiber.dispose();
    },
  };
}
