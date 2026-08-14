import { Context } from '@deepseek-ai/cordis';

import type { FrameworkContracts } from '../../kernel/types.ts';
import {
  buildFamilyStageContextObservation,
  type FamilyStageContextObservation,
} from './family-stage-control-plane.ts';
import type { FamilyStageDomainManifestCatalog } from './family-stage-domain-manifest.ts';

export const CORDIS_STAGECRAFT_CONTEXT_PLUGIN_ID = 'opl-stagecraft-context';
export const CORDIS_STAGECRAFT_CONTEXT_PLUGIN_API_VERSION = '1.0.0';
export const CORDIS_STAGECRAFT_CONTEXT_SERVICE = 'opl.stagecraft.context';
export const CORDIS_ATLAS_CATALOG_SERVICE = 'opl.atlas.catalog';
export const CORDIS_STAGECRAFT_CONTEXT_SOURCE_REF =
  'src/modules/stagecraft/cordis-stagecraft-context-plugin.ts';
export const CORDIS_STAGECRAFT_CONTEXT_SOURCE_COMMIT =
  'a2e7a1a25b5f7f4abda6a7ed6ed746039b92513d';

type ManifestCatalogOptions = Parameters<typeof buildFamilyStageContextObservation>[2];
export type CordisAtlasCatalogService = NonNullable<
  NonNullable<ManifestCatalogOptions>['loadDomainManifests']
>;

export type CordisStagecraftContextService = {
  observe(
    contracts: FrameworkContracts,
    input: { domainId: string; stageId: string; actionId?: string },
    options?: ManifestCatalogOptions,
  ): FamilyStageContextObservation;
};

export type CordisStagecraftContextPluginConfig = {
  loadDomainManifests?: CordisAtlasCatalogService;
};

declare module '@deepseek-ai/cordis' {
  interface Context {
    [CORDIS_STAGECRAFT_CONTEXT_SERVICE]: CordisStagecraftContextService;
    [CORDIS_ATLAS_CATALOG_SERVICE]: CordisAtlasCatalogService;
  }

  interface Events {
    'opl/stagecraft/context/observed': (
      observation: FamilyStageContextObservation,
    ) => void;
  }
}

const resolveCatalogLoader = (
  ctx: Context,
  configured?: CordisAtlasCatalogService,
): CordisAtlasCatalogService | undefined => configured ?? ctx.get(CORDIS_ATLAS_CATALOG_SERVICE);

export const cordisStagecraftContextPlugin = {
  name: CORDIS_STAGECRAFT_CONTEXT_PLUGIN_ID,
  provide: CORDIS_STAGECRAFT_CONTEXT_SERVICE,
  apply(ctx: Context, config: CordisStagecraftContextPluginConfig = {}) {
    const service: CordisStagecraftContextService = {
      observe(contracts, input, options = {}) {
        const loader = resolveCatalogLoader(ctx, config.loadDomainManifests);
        const observation = buildFamilyStageContextObservation(
          contracts,
          input,
          loader && !options.loadDomainManifests
            ? { ...options, loadDomainManifests: loader }
            : options,
        );
        ctx.emit('opl/stagecraft/context/observed', observation);
        return observation;
      },
    };
    ctx.provide(CORDIS_STAGECRAFT_CONTEXT_SERVICE, service);
  },
};

export type { FamilyStageDomainManifestCatalog };
