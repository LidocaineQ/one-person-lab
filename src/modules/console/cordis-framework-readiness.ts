import { Context } from '@deepseek-ai/cordis';

import descriptorPayload from '../../../contracts/opl-framework/cordis-plugins/opl-console-readiness-projection.json' with { type: 'json' };
import type { FrameworkContracts } from '../../kernel/types.ts';
import {
  CORDIS_ATLAS_CATALOG_PLUGIN_API_VERSION,
  CORDIS_ATLAS_CATALOG_PLUGIN_DESCRIPTOR,
  CORDIS_ATLAS_CATALOG_SERVICE,
  cordisAtlasCatalogPlugin,
  type CordisAtlasCatalogPluginConfig,
  type CordisAtlasCatalogService,
} from '../atlas/index.ts';
import {
  buildCordisCompositionSnapshot,
  buildCordisPluginDescriptor,
  CordisCompositionContractError,
  type CordisCompositionSnapshot,
  type CordisPluginDescriptor,
  type CordisPluginDescriptorInput,
} from '../pack/index.ts';
import type { RuntimeTraySnapshotProvider } from '../runway/index.ts';
import { buildFrameworkReadinessCompactReadback } from './framework-readiness-compact-readback.ts';
import { buildFrameworkReadinessSummary } from './framework-readiness.ts';

export const CORDIS_CONSOLE_READINESS_PLUGIN_ID = 'opl-console-readiness-projection';
export const CORDIS_CONSOLE_READINESS_PLUGIN_API_VERSION = '1.0.0';
export const CORDIS_CONSOLE_READINESS_SERVICE = 'opl.console.framework-readiness';
export const CORDIS_FRAMEWORK_PACKAGE = '@deepseek-ai/cordis';
export const CORDIS_FRAMEWORK_VERSION = '4.0.1';
export const CORDIS_FRAMEWORK_INTEGRITY =
  'sha512-YBdskTU2Po1kru3GgcUWUbkTsPMA9LkSQDAY8rBkFJeajdgcQad3QPJZE26JyK99Xb6HaASvoXg2DSUTeN/0Nw==';

export const CORDIS_CONSOLE_READINESS_PLUGIN_DESCRIPTOR = buildCordisPluginDescriptor(
  descriptorPayload as unknown as CordisPluginDescriptorInput,
);

export type CordisFrameworkReadinessInput = {
  familyDefaults: boolean;
};

export type CordisFrameworkReadinessService = {
  full(
    contracts: FrameworkContracts,
    input: CordisFrameworkReadinessInput,
  ): ReturnType<typeof buildFrameworkReadinessSummary>;
  compact(
    contracts: FrameworkContracts,
    input: CordisFrameworkReadinessInput,
  ): ReturnType<typeof buildFrameworkReadinessCompactReadback>;
};

export type CordisFrameworkReadinessPluginConfig = {
  runtimeSnapshotProvider: RuntimeTraySnapshotProvider;
};

declare module '@deepseek-ai/cordis' {
  interface Context {
    [CORDIS_CONSOLE_READINESS_SERVICE]: CordisFrameworkReadinessService;
  }

  interface Events {
    'opl/console/framework-readiness/projected': (
      detail: 'full' | 'compact',
      payload: unknown,
    ) => void;
  }
}

export const cordisFrameworkReadinessPlugin = {
  name: CORDIS_CONSOLE_READINESS_PLUGIN_ID,
  inject: [CORDIS_ATLAS_CATALOG_SERVICE],
  provide: CORDIS_CONSOLE_READINESS_SERVICE,
  apply(ctx: Context, config: CordisFrameworkReadinessPluginConfig) {
    const atlas = ctx.get(CORDIS_ATLAS_CATALOG_SERVICE) as unknown as CordisAtlasCatalogService;
    const catalogs = (contracts: FrameworkContracts) => {
      const domainManifests = atlas(contracts, {
        manifestCommandTimeoutMs: 5_000,
        manifestCommandTimeoutPolicy: 'fixed',
        materializeFamilyTransitions: false,
        useProjectionCacheOnFailure: true,
      });
      const standardAgentDomainManifests = atlas.buildStandardAgent(contracts, {
        legacyDomainManifests: domainManifests,
      });
      return { domainManifests, standardAgentDomainManifests };
    };
    const service: CordisFrameworkReadinessService = {
      async full(contracts, input) {
        const output = await buildFrameworkReadinessSummary(contracts, input, {
          runtimeSnapshotProvider: config.runtimeSnapshotProvider,
          ...catalogs(contracts),
        });
        ctx.emit('opl/console/framework-readiness/projected', 'full', output);
        return output;
      },
      async compact(contracts, input) {
        const output = await buildFrameworkReadinessCompactReadback(contracts, input, {
          runtimeSnapshotProvider: config.runtimeSnapshotProvider,
          ...catalogs(contracts),
        });
        ctx.emit('opl/console/framework-readiness/projected', 'compact', output);
        return output;
      },
    };
    ctx.provide(CORDIS_CONSOLE_READINESS_SERVICE, service);
  },
};

export const CORDIS_ATLAS_CONSOLE_PLUGIN_DESCRIPTORS: readonly CordisPluginDescriptor[] =
  Object.freeze([
    CORDIS_ATLAS_CATALOG_PLUGIN_DESCRIPTOR,
    CORDIS_CONSOLE_READINESS_PLUGIN_DESCRIPTOR,
  ]);

export function buildCordisFrameworkReadinessCompositionSnapshot(
  plugins: readonly CordisPluginDescriptor[] = CORDIS_ATLAS_CONSOLE_PLUGIN_DESCRIPTORS,
): CordisCompositionSnapshot {
  return buildCordisCompositionSnapshot({
    framework: {
      package: CORDIS_FRAMEWORK_PACKAGE,
      version: CORDIS_FRAMEWORK_VERSION,
      integrity: CORDIS_FRAMEWORK_INTEGRITY,
    },
    binding: {
      executor_adapter_id: CORDIS_ATLAS_CATALOG_SERVICE,
      executor_route: CORDIS_CONSOLE_READINESS_SERVICE,
    },
    foundry_evidence_ref: null,
    plugins,
  });
}

export async function createCordisFrameworkReadinessComposition(options: {
  runtimeSnapshotProvider: RuntimeTraySnapshotProvider;
  atlas?: CordisAtlasCatalogPluginConfig;
  mountAtlas?: boolean;
}) {
  if (options.mountAtlas === false) {
    buildCordisFrameworkReadinessCompositionSnapshot([
      CORDIS_CONSOLE_READINESS_PLUGIN_DESCRIPTOR,
    ]);
  }
  const ctx = new Context();
  const atlasFiber = options.mountAtlas === false
    ? null
    : await ctx.plugin(cordisAtlasCatalogPlugin, options.atlas ?? {});
  let readinessFiber: Awaited<ReturnType<Context['plugin']>> | null = null;
  try {
    readinessFiber = await ctx.plugin(cordisFrameworkReadinessPlugin, {
      runtimeSnapshotProvider: options.runtimeSnapshotProvider,
    });
    const readiness = ctx.get(CORDIS_CONSOLE_READINESS_SERVICE);
    if (!readiness) {
      throw new CordisCompositionContractError(
        'missing_required_provider',
        'Cordis Console readiness service did not become active because Atlas catalog is unavailable.',
        {
          plugin_id: CORDIS_CONSOLE_READINESS_PLUGIN_ID,
          service_id: CORDIS_ATLAS_CATALOG_SERVICE,
        },
      );
    }
    return {
      ctx,
      atlasFiber,
      readinessFiber,
      readiness,
      snapshot: buildCordisFrameworkReadinessCompositionSnapshot(),
      async dispose() {
        await readinessFiber?.dispose();
        await atlasFiber?.dispose();
        await ctx.fiber.dispose();
      },
    };
  } catch (error) {
    await readinessFiber?.dispose();
    await atlasFiber?.dispose();
    await ctx.fiber.dispose();
    throw error;
  }
}

export const CORDIS_CONSOLE_REQUIRED_ATLAS_API_VERSION =
  CORDIS_ATLAS_CATALOG_PLUGIN_API_VERSION;
