import { Context } from '@deepseek-ai/cordis';
import {
  CORDIS_AGENT_EXECUTOR_PLUGIN_API_VERSION,
  CORDIS_AGENT_EXECUTOR_PLUGIN_DESCRIPTORS,
  CORDIS_AGENT_EXECUTOR_SOURCE_COMMIT,
  CORDIS_AGENT_EXECUTOR_SOURCE_REF,
  cordisAgentExecutorAdapterPlugin,
  cordisAgentExecutorServicePlugin,
  buildCordisAgentExecutorCompositionSnapshot,
  createCordisAgentExecutorRequest as createPackageAgentExecutorRequest,
  type CordisAgentExecutorAdapter as PackageExecutorAdapter,
  type CordisAgentExecutorObserver as PackageExecutorObserver,
  type CordisAgentExecutorService as PackageExecutorService,
} from '@one-person-lab/runway-executor';
import {
  buildCordisCompositionSnapshot,
  buildCordisPluginDescriptor,
  type CordisCompositionSnapshot,
  type CordisPluginDescriptor,
} from '@one-person-lab/cordis-abi';
import { CORDIS_FIBER_STATE } from '@one-person-lab/cordis-abi/framework';
import {
  CORDIS_FRAMEWORK_INTEGRITY,
  CORDIS_FRAMEWORK_PACKAGE,
  CORDIS_FRAMEWORK_VERSION,
} from '@one-person-lab/cordis-abi/framework';

import {
  CORDIS_PACK_STAGE_BINDING_PLUGIN_API_VERSION,
  CORDIS_PACK_STAGE_BINDING_PLUGIN_ID,
  CORDIS_PACK_STAGE_BINDING_SERVICE,
  CORDIS_PACK_STAGE_BINDING_SOURCE_COMMIT,
  CORDIS_PACK_STAGE_BINDING_SOURCE_REF,
  cordisPackStageBindingPlugin,
} from './cordis-pack-stage-binding-plugin.ts';
import {
  CORDIS_ATLAS_CATALOG_SERVICE,
  CORDIS_STAGECRAFT_CONTEXT_PLUGIN_API_VERSION,
  CORDIS_STAGECRAFT_CONTEXT_PLUGIN_ID,
  CORDIS_STAGECRAFT_CONTEXT_SERVICE,
  CORDIS_STAGECRAFT_CONTEXT_SOURCE_COMMIT,
  CORDIS_STAGECRAFT_CONTEXT_SOURCE_REF,
  cordisStagecraftContextPlugin,
  type CordisAtlasCatalogService,
  type CordisStagecraftContextPluginConfig,
} from './cordis-stagecraft-context-plugin.ts';
import {
  runAgentExecutor,
  type AgentExecutionReceipt,
  type AgentExecutionRequest,
} from '../../adapters/execution/index.ts';

export const CORDIS_AGENT_EXECUTOR_EXPERIMENT_VERSION = 'cordis-agent-executor-experiment.v1';
export {
  CORDIS_AGENT_EXECUTOR_PLUGIN_API_VERSION,
  CORDIS_AGENT_EXECUTOR_PLUGIN_DESCRIPTORS,
  CORDIS_AGENT_EXECUTOR_SOURCE_COMMIT,
  CORDIS_AGENT_EXECUTOR_SOURCE_REF,
  CORDIS_FIBER_STATE,
  CORDIS_FRAMEWORK_INTEGRITY,
  CORDIS_FRAMEWORK_PACKAGE,
  CORDIS_FRAMEWORK_VERSION,
  cordisAgentExecutorAdapterPlugin,
  cordisAgentExecutorServicePlugin,
  buildCordisAgentExecutorCompositionSnapshot,
};
export type {
  AgentExecutionReceipt,
  AgentExecutionRequest,
};

export type CordisAgentExecutorAdapter = PackageExecutorAdapter<
  AgentExecutionRequest,
  AgentExecutionReceipt
>;
export type CordisAgentExecutorObserver = PackageExecutorObserver<
  AgentExecutionRequest,
  AgentExecutionReceipt
>;
export type CordisAgentExecutorService = PackageExecutorService<
  AgentExecutionRequest,
  AgentExecutionReceipt
>;

export const cordisAgentExecutorObserverPlugin = {
  name: 'opl-cordis-agent-executor-observer',
  apply(ctx: Context, observer: CordisAgentExecutorObserver) {
    if (observer.onRequest) {
      ctx.on(
        'opl/runway/executor/requested',
        observer.onRequest as (request: AgentExecutionRequest) => void,
      );
    }
    if (observer.onResult) {
      ctx.on(
        'opl/runway/executor/completed',
        (receipt) => observer.onResult!(receipt as AgentExecutionReceipt),
      );
    }
  },
};

export type CordisAgentExecutorCompositionSnapshot = CordisCompositionSnapshot;
export type CordisPackStagecraftCompositionSnapshot = CordisCompositionSnapshot;

const defaultAdapter: CordisAgentExecutorAdapter = {
  id: 'opl-existing-agent-executor',
  execute: runAgentExecutor,
};

export function createCordisAgentExecutorRequest(options: {
  adapter?: CordisAgentExecutorAdapter;
} = {}) {
  return createPackageAgentExecutorRequest({
    adapter: options.adapter ?? defaultAdapter,
  });
}

const cordisPackStagecraftForbiddenAuthorities = Object.freeze([
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

function packStagecraftDescriptor(input: {
  pluginId: string;
  pluginApiVersion: string;
  sourceRef: string;
  sourceCommit: string;
  required: boolean;
  provides: readonly string[];
  requiredInjects?: readonly { service_id: string; plugin_api_versions: readonly string[] }[];
  optionalInjects?: readonly { service_id: string; plugin_api_versions: readonly string[] }[];
  events?: CordisPluginDescriptor['events'];
}): CordisPluginDescriptor {
  return buildCordisPluginDescriptor({
    plugin_id: input.pluginId,
    plugin_api_version: input.pluginApiVersion,
    source_ref: input.sourceRef,
    source_commit: input.sourceCommit,
    package_ref: null,
    required: input.required,
    provides: input.provides,
    injects: {
      required: input.requiredInjects ?? [],
      optional: input.optionalInjects ?? [],
    },
    events: input.events ?? [],
    scope: 'composition',
    trust: 'first_party_privileged',
    disposer: { required: true, boundary: 'plugin_fiber' },
    authority_boundary: { forbidden_authorities: cordisPackStagecraftForbiddenAuthorities },
  });
}

export const CORDIS_PACK_STAGECRAFT_PLUGIN_DESCRIPTORS: readonly CordisPluginDescriptor[] = Object.freeze([
  packStagecraftDescriptor({
    pluginId: CORDIS_STAGECRAFT_CONTEXT_PLUGIN_ID,
    pluginApiVersion: CORDIS_STAGECRAFT_CONTEXT_PLUGIN_API_VERSION,
    sourceRef: CORDIS_STAGECRAFT_CONTEXT_SOURCE_REF,
    sourceCommit: CORDIS_STAGECRAFT_CONTEXT_SOURCE_COMMIT,
    required: true,
    provides: [CORDIS_STAGECRAFT_CONTEXT_SERVICE],
    optionalInjects: [{
      service_id: CORDIS_ATLAS_CATALOG_SERVICE,
      plugin_api_versions: [CORDIS_STAGECRAFT_CONTEXT_PLUGIN_API_VERSION],
    }],
    events: [{
      name: 'opl/stagecraft/context/observed',
      mode: 'emit',
      role: 'publish',
      payload_schema_ref: null,
    }],
  }),
  packStagecraftDescriptor({
    pluginId: CORDIS_PACK_STAGE_BINDING_PLUGIN_ID,
    pluginApiVersion: CORDIS_PACK_STAGE_BINDING_PLUGIN_API_VERSION,
    sourceRef: CORDIS_PACK_STAGE_BINDING_SOURCE_REF,
    sourceCommit: CORDIS_PACK_STAGE_BINDING_SOURCE_COMMIT,
    required: true,
    provides: [CORDIS_PACK_STAGE_BINDING_SERVICE],
    requiredInjects: [{
      service_id: CORDIS_STAGECRAFT_CONTEXT_SERVICE,
      plugin_api_versions: [CORDIS_STAGECRAFT_CONTEXT_PLUGIN_API_VERSION],
    }],
    events: [{
      name: 'opl/pack/stage-binding/resolved',
      mode: 'emit',
      role: 'publish',
      payload_schema_ref: null,
    }],
  }),
]);

export function buildCordisPackStagecraftCompositionSnapshot(): CordisPackStagecraftCompositionSnapshot {
  return buildCordisCompositionSnapshot({
    framework: {
      package: CORDIS_FRAMEWORK_PACKAGE,
      version: CORDIS_FRAMEWORK_VERSION,
      integrity: CORDIS_FRAMEWORK_INTEGRITY,
    },
    binding: {
      executor_adapter_id: defaultAdapter.id,
      executor_route: 'opl.runway.executor',
    },
    foundry_evidence_ref: null,
    plugins: CORDIS_PACK_STAGECRAFT_PLUGIN_DESCRIPTORS,
  });
}

export async function createCordisStageRouteComposition(
  options: CordisStagecraftContextPluginConfig = {},
) {
  const ctx = new Context();
  const stagecraftFiber = await ctx.plugin(cordisStagecraftContextPlugin, options);
  const stageBindingFiber = await ctx.plugin(cordisPackStageBindingPlugin);
  if (stagecraftFiber.state !== CORDIS_FIBER_STATE.ACTIVE) {
    throw new Error(`Cordis Stagecraft context service did not become active: ${stagecraftFiber.state}`);
  }
  if (stageBindingFiber.state !== CORDIS_FIBER_STATE.ACTIVE) {
    throw new Error(`Cordis Pack stage binding service did not become active: ${stageBindingFiber.state}`);
  }
  return {
    ctx,
    stagecraftFiber,
    stageBindingFiber,
    stageContext: ctx[CORDIS_STAGECRAFT_CONTEXT_SERVICE],
    stageBinding: ctx[CORDIS_PACK_STAGE_BINDING_SERVICE],
    snapshot: buildCordisPackStagecraftCompositionSnapshot(),
    async dispose() {
      await stageBindingFiber.dispose();
      await stagecraftFiber.dispose();
      await ctx.fiber.dispose();
    },
  };
}

export type { CordisAtlasCatalogService };
