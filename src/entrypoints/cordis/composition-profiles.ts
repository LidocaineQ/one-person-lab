import { Context } from '@deepseek-ai/cordis';

import {
  CORDIS_ATLAS_CATALOG_PLUGIN_DESCRIPTOR,
  CORDIS_ATLAS_CATALOG_SERVICE,
  buildDomainManifestCatalog,
  cordisAtlasCatalogPlugin,
  type CordisAtlasCatalogPluginConfig,
  type CordisAtlasCatalogService,
} from '../../modules/atlas/index.ts';
import {
  CORDIS_CHARTER_CONTRACTS_SERVICE,
  CORDIS_CHARTER_POLICY_PLUGIN_DESCRIPTOR,
  cordisCharterPolicyPlugin,
  type CordisCharterPolicyService,
} from '../../modules/charter/index.ts';
import {
  CORDIS_CONNECT_DESCRIPTOR_DISCOVERY_PLUGIN_DESCRIPTOR,
  CORDIS_CONNECT_DESCRIPTOR_DISCOVERY_SERVICE,
  cordisConnectDescriptorDiscoveryPlugin,
  type CordisConnectDescriptorDiscoveryPluginConfig,
  type CordisConnectDescriptorDiscoveryService,
} from '../../modules/connect/index.ts';
import {
  CORDIS_CONSOLE_READINESS_PLUGIN_DESCRIPTOR,
  CORDIS_CONSOLE_READINESS_SERVICE,
  cordisFrameworkReadinessPlugin,
  type CordisFrameworkReadinessService,
} from '../../modules/console/index.ts';
import {
  CORDIS_FOUNDRY_EVALUATION_ADAPTER_PLUGIN_DESCRIPTOR,
  CORDIS_FOUNDRY_EVALUATION_SERVICE,
  CORDIS_FOUNDRY_PROVIDER_MANIFEST_PLUGIN_DESCRIPTOR,
  CORDIS_FOUNDRY_PROVIDER_MANIFEST_SERVICE,
  cordisFoundryEvaluationAdapterPlugin,
  cordisFoundryProviderManifestPlugin,
  type CordisFoundryEvaluationPluginConfig,
  type CordisFoundryEvaluationService,
  type CordisFoundryProviderManifestService,
} from '../../modules/foundry/index.ts';
import {
  CORDIS_OWNER_DELTA_OBSERVER_PLUGIN_DESCRIPTOR,
  CORDIS_OWNER_DELTA_OBSERVER_SERVICE,
  cordisOwnerDeltaObserverPlugin,
  type CordisOwnerDeltaObserverService,
} from '../../modules/ledger/index.ts';
import {
  buildCordisCompositionSnapshot,
  CORDIS_PACKAGE_HOST_PLUGIN_DESCRIPTOR,
  CORDIS_PACKAGE_HOST_SERVICE,
  CORDIS_PACK_STAGE_BINDING_SERVICE,
  cordisPackageHostPlugin,
  cordisPackStageBindingPlugin,
  type CordisCompositionSnapshot,
  type CordisPackageHostService,
  type CordisPackStageBindingService,
  type CordisPluginDescriptor,
} from '../../modules/pack/index.ts';
import {
  buildCordisAgentExecutorCompositionSnapshot,
  CORDIS_FRAMEWORK_INTEGRITY,
  CORDIS_FRAMEWORK_PACKAGE,
  CORDIS_FRAMEWORK_VERSION,
  createCordisAgentExecutorRequest,
} from '../../modules/runway/cordis-agent-executor-experiment.ts';
import {
  buildCordisRunwayAttemptCompositionSnapshot,
  createCordisRunwayAttemptComposition,
} from '../../modules/runway/cordis-runway-attempt.ts';
import type { RuntimeTraySnapshotProvider } from '../../modules/runway/index.ts';
import {
  CORDIS_PACK_STAGECRAFT_PLUGIN_DESCRIPTORS,
  buildCordisPackStagecraftCompositionSnapshot,
  createCordisStageRouteComposition,
  runFamilyRuntime,
} from '../../modules/runway/index.ts';
import {
  CORDIS_STAGECRAFT_CONTEXT_SERVICE,
  cordisStagecraftContextPlugin,
  type CordisStagecraftContextService,
} from '../../modules/stagecraft/index.ts';
import {
  CORDIS_WORKSPACE_LOCATOR_PLUGIN_DESCRIPTOR,
  CORDIS_WORKSPACE_LOCATOR_SERVICE,
  cordisWorkspaceLocatorPlugin,
  type CordisWorkspaceLocatorService,
} from '../../modules/workspace/index.ts';

export const CORDIS_DEFAULT_PROFILE_ID = 'base-headless' as const;
export type CordisCompositionProfileId =
  | typeof CORDIS_DEFAULT_PROFILE_ID
  | 'app-full'
  | 'foundry-dev';

type CordisFiber = Awaited<ReturnType<Context['plugin']>>;

export type CordisBaseHeadlessServices = {
  charter: CordisCharterPolicyService;
  atlas: CordisAtlasCatalogService;
  workspaceLocator: CordisWorkspaceLocatorService;
  stageBinding: CordisPackStageBindingService;
  stageContext: CordisStagecraftContextService;
  ownerDeltaObserver: CordisOwnerDeltaObserverService;
  descriptorDiscovery: CordisConnectDescriptorDiscoveryService;
  packageHost: CordisPackageHostService;
  familyRuntime: typeof runFamilyRuntime;
  childFactories: {
    createAgentExecutorRequest: typeof createCordisAgentExecutorRequest;
    createRunwayAttemptComposition: typeof createCordisRunwayAttemptComposition;
    createStageRouteComposition: typeof createCordisStageRouteComposition;
  };
};

type CordisFoundryDevServices = Pick<
  CordisBaseHeadlessServices,
  'charter' | 'atlas' | 'stageBinding' | 'stageContext' | 'packageHost'
> & {
  childFactories: Pick<
    CordisBaseHeadlessServices['childFactories'],
    'createRunwayAttemptComposition'
  >;
  foundryProviderManifest: CordisFoundryProviderManifestService;
  foundryEvaluation: CordisFoundryEvaluationService | null;
};

export type CordisBaseHeadlessComposition = {
  profileId: 'base-headless';
  ctx: Context;
  services: CordisBaseHeadlessServices;
  snapshot: CordisCompositionSnapshot;
  dispose(): Promise<void>;
};

export type CordisAppFullComposition = Omit<CordisBaseHeadlessComposition, 'profileId' | 'dispose'> & {
  profileId: 'app-full';
  services: CordisBaseHeadlessServices & {
    frameworkReadiness: CordisFrameworkReadinessService;
  };
  dispose(): Promise<void>;
};

export type CordisCliComposition = CordisBaseHeadlessComposition | CordisAppFullComposition;

export type CordisFoundryDevComposition = {
  profileId: 'foundry-dev';
  ctx: Context;
  services: CordisFoundryDevServices;
  snapshot: CordisCompositionSnapshot;
  dispose(): Promise<void>;
};

export const CORDIS_BASE_HEADLESS_PLUGIN_DESCRIPTORS: readonly CordisPluginDescriptor[] =
  Object.freeze([
    CORDIS_CHARTER_POLICY_PLUGIN_DESCRIPTOR,
    CORDIS_ATLAS_CATALOG_PLUGIN_DESCRIPTOR,
    CORDIS_WORKSPACE_LOCATOR_PLUGIN_DESCRIPTOR,
    ...CORDIS_PACK_STAGECRAFT_PLUGIN_DESCRIPTORS,
    CORDIS_PACKAGE_HOST_PLUGIN_DESCRIPTOR,
    CORDIS_OWNER_DELTA_OBSERVER_PLUGIN_DESCRIPTOR,
    CORDIS_CONNECT_DESCRIPTOR_DISCOVERY_PLUGIN_DESCRIPTOR,
  ] as CordisPluginDescriptor[]);

function requiredService<T>(ctx: Context, serviceId: string): T {
  const service = ctx.get(serviceId);
  if (!service) throw new Error(`Cordis profile did not provide required service: ${serviceId}`);
  return service as T;
}

function profileSnapshot(
  profileId: CordisCompositionProfileId,
  plugins: readonly CordisPluginDescriptor[],
  childCompositionIds: readonly (
    'agent_executor_request' | 'runway_attempt' | 'pack_stagecraft_route'
  )[] = ['agent_executor_request', 'runway_attempt', 'pack_stagecraft_route'],
) {
  const childSnapshots = {
    agent_executor_request: buildCordisAgentExecutorCompositionSnapshot(),
    runway_attempt: buildCordisRunwayAttemptCompositionSnapshot(),
    pack_stagecraft_route: buildCordisPackStagecraftCompositionSnapshot(),
  };
  return buildCordisCompositionSnapshot({
    framework: {
      package: CORDIS_FRAMEWORK_PACKAGE,
      version: CORDIS_FRAMEWORK_VERSION,
      integrity: CORDIS_FRAMEWORK_INTEGRITY,
    },
    binding: {
      executor_adapter_id: `opl-cordis-profile:${profileId}`,
      executor_route: `opl.profile.${profileId}`,
      child_composition_snapshot_refs: Object.fromEntries(
        childCompositionIds.map((id) => {
          const snapshot = childSnapshots[id];
          return [id, {
          snapshot_id: snapshot.snapshot_id,
          snapshot_digest: snapshot.snapshot_digest,
          }];
        }),
      ),
    },
    foundry_evidence_ref: null,
    plugins,
  });
}

async function disposeFibers(fibers: readonly CordisFiber[]) {
  for (const fiber of [...fibers].reverse()) await fiber.dispose();
}

type CordisBaseCompositionOptions = {
  atlas?: CordisAtlasCatalogPluginConfig;
  connect?: CordisConnectDescriptorDiscoveryPluginConfig;
};
type CordisBaseComposition = Omit<CordisBaseHeadlessComposition, 'profileId'>;

async function createCordisBaseComposition(
  profileId: 'base-headless' | 'app-full',
  options: CordisBaseCompositionOptions = {},
): Promise<CordisBaseComposition> {
  const ctx = new Context();
  const fibers: CordisFiber[] = [];
  try {
    fibers.push(await ctx.plugin(cordisCharterPolicyPlugin));
    fibers.push(await ctx.plugin(cordisWorkspaceLocatorPlugin));
    fibers.push(await ctx.plugin(cordisConnectDescriptorDiscoveryPlugin, options.connect ?? {}));
    const workspaceLocator = requiredService<CordisWorkspaceLocatorService>(
      ctx,
      CORDIS_WORKSPACE_LOCATOR_SERVICE,
    );
    fibers.push(await ctx.plugin(cordisAtlasCatalogPlugin, {
      ...options.atlas,
      buildCatalog: options.atlas?.buildCatalog
        ?? ((contracts, catalogOptions = {}) => buildDomainManifestCatalog(contracts, {
          ...catalogOptions,
          resolveActiveWorkspaceBinding: workspaceLocator.active,
        })),
    }));
    fibers.push(await ctx.plugin(cordisStagecraftContextPlugin));
    fibers.push(await ctx.plugin(cordisPackStageBindingPlugin));
    fibers.push(await ctx.plugin(cordisPackageHostPlugin, { profile_id: profileId }));
    fibers.push(await ctx.plugin(cordisOwnerDeltaObserverPlugin));
    const stageBinding = requiredService<CordisPackStageBindingService>(
      ctx,
      CORDIS_PACK_STAGE_BINDING_SERVICE,
    );
    const stageContext = requiredService<CordisStagecraftContextService>(
      ctx,
      CORDIS_STAGECRAFT_CONTEXT_SERVICE,
    );
    const atlas = requiredService<CordisAtlasCatalogService>(ctx, CORDIS_ATLAS_CATALOG_SERVICE);
    return {
      ctx,
      services: {
        charter: requiredService(ctx, CORDIS_CHARTER_CONTRACTS_SERVICE),
        atlas,
        workspaceLocator,
        stageBinding,
        stageContext,
        ownerDeltaObserver: requiredService(ctx, CORDIS_OWNER_DELTA_OBSERVER_SERVICE),
        descriptorDiscovery: requiredService(ctx, CORDIS_CONNECT_DESCRIPTOR_DISCOVERY_SERVICE),
        packageHost: requiredService(ctx, CORDIS_PACKAGE_HOST_SERVICE),
        familyRuntime: (args, runtimeOptions = {}) => runFamilyRuntime(args, {
          ...runtimeOptions,
          loadDomainManifests: runtimeOptions.loadDomainManifests ?? atlas,
          stageRunRuntime: {
            ...runtimeOptions.stageRunRuntime,
            stageBindingService: stageBinding,
            stageContextService: stageContext,
            resolveStageBinding: runtimeOptions.stageRunRuntime?.resolveStageBinding
              ?? stageBinding.resolve.bind(stageBinding),
          },
        }),
        childFactories: {
          createAgentExecutorRequest: createCordisAgentExecutorRequest,
          createRunwayAttemptComposition: createCordisRunwayAttemptComposition,
          createStageRouteComposition: createCordisStageRouteComposition,
        },
      },
      snapshot: profileSnapshot(profileId, CORDIS_BASE_HEADLESS_PLUGIN_DESCRIPTORS),
      async dispose() {
        await disposeFibers(fibers);
        await ctx.fiber.dispose();
      },
    };
  } catch (error) {
    await disposeFibers(fibers);
    await ctx.fiber.dispose();
    throw error;
  }
}

export async function createCordisBaseHeadlessComposition(
  options: CordisBaseCompositionOptions = {},
): Promise<CordisBaseHeadlessComposition> {
  const base = await createCordisBaseComposition(CORDIS_DEFAULT_PROFILE_ID, options);
  return {
    profileId: CORDIS_DEFAULT_PROFILE_ID,
    ...base,
  };
}

export async function createCordisAppFullComposition(options: {
  runtimeSnapshotProvider: RuntimeTraySnapshotProvider;
  atlas?: CordisAtlasCatalogPluginConfig;
  connect?: CordisConnectDescriptorDiscoveryPluginConfig;
}): Promise<CordisAppFullComposition> {
  const base = await createCordisBaseComposition('app-full', options);
  let readinessFiber: CordisFiber | null = null;
  try {
    const runtimeSnapshotProvider: RuntimeTraySnapshotProvider = (contracts, snapshotOptions) =>
      options.runtimeSnapshotProvider(contracts, {
        ...snapshotOptions,
        ownerDeltaObserver: base.services.ownerDeltaObserver,
      });
    readinessFiber = await base.ctx.plugin(cordisFrameworkReadinessPlugin, {
      runtimeSnapshotProvider,
    });
    return {
      profileId: 'app-full',
      ctx: base.ctx,
      services: {
        ...base.services,
        frameworkReadiness: requiredService(base.ctx, CORDIS_CONSOLE_READINESS_SERVICE),
      },
      snapshot: profileSnapshot('app-full', [
        ...CORDIS_BASE_HEADLESS_PLUGIN_DESCRIPTORS,
        CORDIS_CONSOLE_READINESS_PLUGIN_DESCRIPTOR,
      ]),
      async dispose() {
        await readinessFiber?.dispose();
        await base.dispose();
      },
    };
  } catch (error) {
    await readinessFiber?.dispose();
    await base.dispose();
    throw error;
  }
}

export async function createCordisFoundryDevComposition(options: {
  evaluation?: CordisFoundryEvaluationPluginConfig;
  atlas?: CordisAtlasCatalogPluginConfig;
  connect?: CordisConnectDescriptorDiscoveryPluginConfig;
} = {}): Promise<CordisFoundryDevComposition> {
  const ctx = new Context();
  const fibers: CordisFiber[] = [];
  try {
    fibers.push(await ctx.plugin(cordisCharterPolicyPlugin));
    fibers.push(await ctx.plugin(cordisAtlasCatalogPlugin, options.atlas ?? {}));
    fibers.push(await ctx.plugin(cordisStagecraftContextPlugin));
    fibers.push(await ctx.plugin(cordisPackStageBindingPlugin));
    fibers.push(await ctx.plugin(cordisPackageHostPlugin, { profile_id: 'foundry-dev' }));
    fibers.push(await ctx.plugin(cordisFoundryProviderManifestPlugin));
    if (options.evaluation) {
      fibers.push(await ctx.plugin(cordisFoundryEvaluationAdapterPlugin, options.evaluation));
    }
    return {
      profileId: 'foundry-dev',
      ctx,
      services: {
        charter: requiredService(ctx, CORDIS_CHARTER_CONTRACTS_SERVICE),
        atlas: requiredService(ctx, CORDIS_ATLAS_CATALOG_SERVICE),
        stageBinding: requiredService(ctx, CORDIS_PACK_STAGE_BINDING_SERVICE),
        stageContext: requiredService(ctx, CORDIS_STAGECRAFT_CONTEXT_SERVICE),
        packageHost: requiredService(ctx, CORDIS_PACKAGE_HOST_SERVICE),
        childFactories: {
          createRunwayAttemptComposition: createCordisRunwayAttemptComposition,
        },
        foundryProviderManifest: requiredService(
          ctx,
          CORDIS_FOUNDRY_PROVIDER_MANIFEST_SERVICE,
        ),
        foundryEvaluation: options.evaluation
          ? requiredService(ctx, CORDIS_FOUNDRY_EVALUATION_SERVICE)
          : null,
      },
      snapshot: profileSnapshot('foundry-dev', [
        CORDIS_CHARTER_POLICY_PLUGIN_DESCRIPTOR,
        CORDIS_ATLAS_CATALOG_PLUGIN_DESCRIPTOR,
        ...CORDIS_PACK_STAGECRAFT_PLUGIN_DESCRIPTORS,
        CORDIS_PACKAGE_HOST_PLUGIN_DESCRIPTOR,
        CORDIS_FOUNDRY_PROVIDER_MANIFEST_PLUGIN_DESCRIPTOR,
        ...(options.evaluation ? [CORDIS_FOUNDRY_EVALUATION_ADAPTER_PLUGIN_DESCRIPTOR] : []),
      ], ['runway_attempt']),
      async dispose() {
        await disposeFibers(fibers);
        await ctx.fiber.dispose();
      },
    };
  } catch (error) {
    await disposeFibers(fibers);
    await ctx.fiber.dispose();
    throw error;
  }
}
