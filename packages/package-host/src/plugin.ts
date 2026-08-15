import { Context } from '@deepseek-ai/cordis';

import descriptorPayload from '../contracts/opl-package-host.json' with { type: 'json' };

import {
  buildPackageHostContext,
  resolvePackageHostIntegration,
  type PackageHostContext,
  type PackageHostIntegrationTrigger,
  type PackageHostManifest,
  type PackageHostProfileId,
} from './index.ts';
import {
  buildCordisPluginDescriptor,
  type CordisCompositionSnapshot,
  type CordisPluginDescriptor,
  type CordisPluginDescriptorInput,
} from '@one-person-lab/cordis-abi';

export const CORDIS_PACKAGE_HOST_PLUGIN_ID = 'opl-package-host';
export const CORDIS_PACKAGE_HOST_PLUGIN_API_VERSION = '1.0.0';
export const CORDIS_PACKAGE_HOST_SERVICE = 'opl.pack.package-host';
export const CORDIS_PACKAGE_HOST_SOURCE_REF = 'packages/package-host/src/plugin.ts';
export const CORDIS_PACKAGE_HOST_SOURCE_COMMIT = '832aa00a85eb722dc8748587ffe648b3c6afd808';

export const CORDIS_PACKAGE_HOST_PLUGIN_DESCRIPTOR: CordisPluginDescriptor =
  buildCordisPluginDescriptor(descriptorPayload as unknown as CordisPluginDescriptorInput);

export type CordisPackageHostService = Readonly<{
  profile_id: PackageHostProfileId;
  resolve(input: {
    manifest: PackageHostManifest;
    integration_trigger: PackageHostIntegrationTrigger;
    composition_snapshot: CordisCompositionSnapshot;
    additional_snapshots?: readonly Readonly<{
      composition_id: string;
      snapshot: CordisCompositionSnapshot;
    }>[];
  }): PackageHostContext;
}>;

declare module '@deepseek-ai/cordis' {
  interface Context {
    [CORDIS_PACKAGE_HOST_SERVICE]: CordisPackageHostService;
  }
}

export const cordisPackageHostPlugin = {
  name: CORDIS_PACKAGE_HOST_PLUGIN_ID,
  provide: CORDIS_PACKAGE_HOST_SERVICE,
  apply(ctx: Context, config: { profile_id: PackageHostProfileId }) {
    const service: CordisPackageHostService = {
      profile_id: config.profile_id,
      resolve(input) {
        const integration = resolvePackageHostIntegration(input.manifest);
        return buildPackageHostContext({
          package_id: input.manifest.package_id,
          integration,
          integration_trigger: input.integration_trigger,
          environment: {
            profile_id: config.profile_id,
            snapshots: [
              { composition_id: `profile:${config.profile_id}`, snapshot: input.composition_snapshot },
              ...(input.additional_snapshots ?? []),
            ],
          },
        });
      },
    };
    ctx.provide(CORDIS_PACKAGE_HOST_SERVICE, service);
  },
};
