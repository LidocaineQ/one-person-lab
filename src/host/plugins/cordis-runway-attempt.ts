import { Context } from '@deepseek-ai/cordis';

import {
  buildCordisCompositionSnapshot,
  buildCordisPluginDescriptor,
  type CordisCompositionSnapshot,
  type CordisPluginDescriptor,
} from '../../authority/packages/index.ts';
import {
  runAgentStageRunner,
  type CodexStageRunnerInput,
  type AgentExecutorRequestCompositionFactory,
} from '../../adapters/execution/index.ts';
import {
  CORDIS_FIBER_STATE,
  CORDIS_FRAMEWORK_INTEGRITY,
  CORDIS_FRAMEWORK_PACKAGE,
  CORDIS_FRAMEWORK_VERSION,
} from './cordis-agent-executor-experiment.ts';

export const CORDIS_RUNWAY_ATTEMPT_PLUGIN_API_VERSION = '1.0.0';
export const CORDIS_RUNWAY_ATTEMPT_PLUGIN_ID = 'opl-cordis-runway-attempt-executor';
export const CORDIS_RUNWAY_ATTEMPT_SERVICE = 'opl.runway.attempt.executor';
export const CORDIS_RUNWAY_ATTEMPT_SOURCE_REF = 'src/host/plugins/cordis-runway-attempt.ts';
export const CORDIS_RUNWAY_ATTEMPT_SOURCE_COMMIT = '3de37ca5aec1007a111b9401b1cb7ccca8d57379';

export type CordisRunwayAttemptExecutionReceipt = Awaited<ReturnType<typeof runAgentStageRunner>>;

export type CordisRunwayAttemptExecutor = {
  execute(input: CodexStageRunnerInput): Promise<CordisRunwayAttemptExecutionReceipt>;
};

export type CordisRunwayAttemptAdapter = CordisRunwayAttemptExecutor & {
  readonly id: string;
};

export type CordisRunwayAttemptObserver = {
  onRequest?: (input: CodexStageRunnerInput) => void;
  onResult?: (receipt: CordisRunwayAttemptExecutionReceipt) => void | Promise<void>;
};

export type CordisRunwayAttemptCompositionSnapshot = CordisCompositionSnapshot;

declare module '@deepseek-ai/cordis' {
  interface Context {
    'opl.runway.attempt.adapter': CordisRunwayAttemptAdapter;
    'opl.runway.attempt.executor': CordisRunwayAttemptExecutor;
  }

  interface Events {
    'opl/runway/attempt/requested': (input: CodexStageRunnerInput) => void;
    'opl/runway/attempt/completed': (receipt: CordisRunwayAttemptExecutionReceipt) => void | Promise<void>;
  }
}

export const cordisRunwayAttemptAdapterPlugin = {
  name: 'opl-cordis-runway-attempt-adapter',
  provide: 'opl.runway.attempt.adapter',
  apply(ctx: Context, config: { adapter: CordisRunwayAttemptAdapter }) {
    ctx.provide('opl.runway.attempt.adapter', config.adapter);
  },
};

export const cordisRunwayAttemptServicePlugin = {
  name: CORDIS_RUNWAY_ATTEMPT_PLUGIN_ID,
  inject: ['opl.runway.attempt.adapter'],
  provide: CORDIS_RUNWAY_ATTEMPT_SERVICE,
  apply(ctx: Context) {
    const service: CordisRunwayAttemptExecutor = {
      async execute(input) {
        ctx.emit('opl/runway/attempt/requested', input);
        const receipt = await ctx['opl.runway.attempt.adapter'].execute(input);
        await ctx.parallel('opl/runway/attempt/completed', receipt);
        return receipt;
      },
    };
    ctx.provide(CORDIS_RUNWAY_ATTEMPT_SERVICE, service);
  },
};

export const cordisRunwayAttemptObserverPlugin = {
  name: 'opl-cordis-runway-attempt-observer',
  apply(ctx: Context, observer: CordisRunwayAttemptObserver) {
    if (observer.onRequest) {
      ctx.on('opl/runway/attempt/requested', observer.onRequest);
    }
    if (observer.onResult) {
      ctx.on('opl/runway/attempt/completed', observer.onResult);
    }
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
    plugin_api_version: CORDIS_RUNWAY_ATTEMPT_PLUGIN_API_VERSION,
    source_ref: CORDIS_RUNWAY_ATTEMPT_SOURCE_REF,
    source_commit: CORDIS_RUNWAY_ATTEMPT_SOURCE_COMMIT,
    package_ref: null,
    required: input.required,
    provides: input.provides ?? [],
    injects: {
      required: (input.requiredInjects ?? []).map((serviceId) => ({
        service_id: serviceId,
        plugin_api_versions: [CORDIS_RUNWAY_ATTEMPT_PLUGIN_API_VERSION],
      })),
      optional: [],
    },
    events: input.events ?? [],
    scope: 'attempt',
    trust: 'first_party_privileged',
    disposer: { required: true, boundary: 'plugin_fiber' },
    authority_boundary: { forbidden_authorities: forbiddenAuthorities },
  });
}

export const CORDIS_RUNWAY_ATTEMPT_PLUGIN_DESCRIPTORS: readonly CordisPluginDescriptor[] = Object.freeze([
  descriptor({
    pluginId: 'opl-cordis-runway-attempt-adapter',
    required: true,
    provides: ['opl.runway.attempt.adapter'],
  }),
  descriptor({
    pluginId: CORDIS_RUNWAY_ATTEMPT_PLUGIN_ID,
    required: true,
    provides: [CORDIS_RUNWAY_ATTEMPT_SERVICE],
    requiredInjects: ['opl.runway.attempt.adapter'],
    events: [
      {
        name: 'opl/runway/attempt/requested',
        mode: 'emit',
        role: 'publish',
        payload_schema_ref: null,
      },
      {
        name: 'opl/runway/attempt/completed',
        mode: 'parallel',
        role: 'publish',
        payload_schema_ref: null,
      },
    ],
  }),
  descriptor({
    pluginId: 'opl-cordis-runway-attempt-observer',
    required: false,
    events: [
      {
        name: 'opl/runway/attempt/requested',
        mode: 'observe',
        role: 'observe',
        payload_schema_ref: null,
      },
      {
        name: 'opl/runway/attempt/completed',
        mode: 'observe',
        role: 'observe',
        payload_schema_ref: null,
      },
    ],
  }),
]);

export function buildCordisRunwayAttemptCompositionSnapshot(
  adapterId = defaultAdapter.id,
): CordisRunwayAttemptCompositionSnapshot {
  return buildCordisCompositionSnapshot({
    framework: {
      package: CORDIS_FRAMEWORK_PACKAGE,
      version: CORDIS_FRAMEWORK_VERSION,
      integrity: CORDIS_FRAMEWORK_INTEGRITY,
    },
    binding: {
      executor_adapter_id: adapterId,
      executor_route: CORDIS_RUNWAY_ATTEMPT_SERVICE,
    },
    foundry_evidence_ref: null,
    plugins: CORDIS_RUNWAY_ATTEMPT_PLUGIN_DESCRIPTORS,
  });
}

const defaultAdapter: CordisRunwayAttemptAdapter = {
  id: 'opl-existing-codex-stage-runner',
  async execute(input) {
    return await runAgentStageRunner(input);
  },
};

export async function createCordisRunwayAttemptComposition(options: {
  attemptRef: string;
  adapter?: CordisRunwayAttemptAdapter;
  createAgentExecutorRequest?: AgentExecutorRequestCompositionFactory;
}) {
  const ctx = new Context();
  const adapter = options.adapter ?? (
    options.createAgentExecutorRequest
      ? {
          ...defaultAdapter,
          execute: async (input: CodexStageRunnerInput) => await runAgentStageRunner(input, {
            createAgentExecutorRequest: options.createAgentExecutorRequest,
          }),
        }
      : defaultAdapter
  );
  const adapterFiber = await ctx.plugin(cordisRunwayAttemptAdapterPlugin, { adapter });
  const executorFiber = await ctx.plugin(cordisRunwayAttemptServicePlugin);
  if (executorFiber.state !== CORDIS_FIBER_STATE.ACTIVE) {
    throw new Error(`Cordis Runway attempt service did not become active: ${executorFiber.state}`);
  }
  return {
    ctx,
    adapterFiber,
    executorFiber,
    attemptRef: options.attemptRef,
    executor: ctx[CORDIS_RUNWAY_ATTEMPT_SERVICE],
    snapshot: buildCordisRunwayAttemptCompositionSnapshot(adapter.id),
  async dispose() {
      await executorFiber.dispose();
      await adapterFiber.dispose();
      await ctx.fiber.dispose();
    },
  };
}
