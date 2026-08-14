import { Context } from '@deepseek-ai/cordis';

import descriptorPayload from '../../../contracts/opl-framework/cordis-plugins/opl-atlas-catalog.json' with { type: 'json' };
import {
  buildCordisPluginDescriptor,
  type CordisPluginDescriptorInput,
} from '../pack/index.ts';
import { buildDomainManifestCatalog } from './domain-manifest/catalog-builder.ts';
import { buildStandardAgentDomainManifestCatalog } from './domain-manifest/standard-agent-catalog.ts';

export const CORDIS_ATLAS_CATALOG_PLUGIN_ID = 'opl-atlas-catalog';
export const CORDIS_ATLAS_CATALOG_PLUGIN_API_VERSION = '1.0.0';
export const CORDIS_ATLAS_CATALOG_SERVICE = 'opl.atlas.catalog';

export const CORDIS_ATLAS_CATALOG_PLUGIN_DESCRIPTOR = buildCordisPluginDescriptor(
  descriptorPayload as unknown as CordisPluginDescriptorInput,
);

export type CordisDomainManifestCatalogOptions = Parameters<typeof buildDomainManifestCatalog>[1];
type CordisAtlasCatalogLoader = (
  ...args: Parameters<typeof buildDomainManifestCatalog>
) => ReturnType<typeof buildDomainManifestCatalog>['domain_manifests'];
export type CordisAtlasCatalogService = CordisAtlasCatalogLoader & {
  buildStandardAgent(
    contracts: Parameters<typeof buildStandardAgentDomainManifestCatalog>[0],
    options: Parameters<typeof buildStandardAgentDomainManifestCatalog>[1],
  ): ReturnType<typeof buildStandardAgentDomainManifestCatalog>['domain_manifests'];
};

export type CordisAtlasCatalogPluginConfig = {
  buildCatalog?: typeof buildDomainManifestCatalog;
  buildStandardAgentCatalog?: typeof buildStandardAgentDomainManifestCatalog;
};

declare module '@deepseek-ai/cordis' {
  interface Events {
    'opl/atlas/catalog/observed': (
      catalog: {
        summary: { total_projects_count: number; resolved_count: number; [key: string]: unknown };
        projects: readonly unknown[];
        notes: readonly string[];
        [key: string]: unknown;
      },
    ) => void;
  }
}

export const cordisAtlasCatalogPlugin = {
  name: CORDIS_ATLAS_CATALOG_PLUGIN_ID,
  provide: CORDIS_ATLAS_CATALOG_SERVICE,
  apply(ctx: Context, config: CordisAtlasCatalogPluginConfig = {}) {
    const buildCatalog = config.buildCatalog ?? buildDomainManifestCatalog;
    const buildStandardAgentCatalog = config.buildStandardAgentCatalog
      ?? buildStandardAgentDomainManifestCatalog;
    const load: CordisAtlasCatalogLoader = (contracts, options = {}) => {
      const result = buildCatalog(contracts, options);
      ctx.emit('opl/atlas/catalog/observed', result.domain_manifests);
      return result.domain_manifests;
    };
    const service: CordisAtlasCatalogService = Object.assign(load, {
      buildStandardAgent(
        contracts: Parameters<typeof buildStandardAgentDomainManifestCatalog>[0],
        options: Parameters<typeof buildStandardAgentDomainManifestCatalog>[1],
      ) {
        const result = buildStandardAgentCatalog(contracts, options);
        ctx.emit('opl/atlas/catalog/observed', result.domain_manifests);
        return result.domain_manifests;
      },
    });
    ctx.provide(CORDIS_ATLAS_CATALOG_SERVICE, service);
  },
};
