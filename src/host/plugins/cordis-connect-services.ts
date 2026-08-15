import {
  buildCordisConnectCompositionSnapshot,
  CORDIS_CONNECT_DESCRIPTOR_DISCOVERY_PLUGIN_API_VERSION,
  CORDIS_CONNECT_DESCRIPTOR_DISCOVERY_PLUGIN_DESCRIPTOR,
  CORDIS_CONNECT_DESCRIPTOR_DISCOVERY_PLUGIN_ID,
  CORDIS_CONNECT_DESCRIPTOR_DISCOVERY_SERVICE,
  CORDIS_CONNECT_DESCRIPTOR_DISCOVERY_SOURCE_COMMIT,
  CORDIS_CONNECT_DESCRIPTOR_DISCOVERY_SOURCE_REF,
  cordisConnectDescriptorDiscoveryPlugin,
  createCordisConnectComposition as createPackageCordisConnectComposition,
  type CordisConnectDescriptorDiscoveryObservation,
} from '@one-person-lab/connect-discovery';

import {
  discoverInstalledPackageDescriptors,
  type InstalledPackageDescriptor,
} from '../../adapters/integration/index.ts';

export {
  buildCordisConnectCompositionSnapshot,
  CORDIS_CONNECT_DESCRIPTOR_DISCOVERY_PLUGIN_API_VERSION,
  CORDIS_CONNECT_DESCRIPTOR_DISCOVERY_PLUGIN_DESCRIPTOR,
  CORDIS_CONNECT_DESCRIPTOR_DISCOVERY_PLUGIN_ID,
  CORDIS_CONNECT_DESCRIPTOR_DISCOVERY_SERVICE,
  CORDIS_CONNECT_DESCRIPTOR_DISCOVERY_SOURCE_COMMIT,
  CORDIS_CONNECT_DESCRIPTOR_DISCOVERY_SOURCE_REF,
  cordisConnectDescriptorDiscoveryPlugin,
};
export type { CordisConnectDescriptorDiscoveryObservation };

export type CordisConnectDescriptorDiscoveryInput = Parameters<
  typeof discoverInstalledPackageDescriptors
>[0];
export type CordisConnectDescriptorDiscovery = (
  input?: CordisConnectDescriptorDiscoveryInput,
) => Map<string, InstalledPackageDescriptor>;
export type CordisConnectDescriptorDiscoveryService = {
  discover(
    input?: CordisConnectDescriptorDiscoveryInput,
  ): Map<string, InstalledPackageDescriptor>;
};
export type CordisConnectDescriptorDiscoveryPluginConfig = {
  discover?: CordisConnectDescriptorDiscovery;
};

export async function createCordisConnectComposition(
  options: CordisConnectDescriptorDiscoveryPluginConfig = {},
) {
  const composition = await createPackageCordisConnectComposition<InstalledPackageDescriptor>({
    discover: options.discover ?? discoverInstalledPackageDescriptors,
  });
  return {
    ...composition,
    descriptorDiscovery:
      composition.descriptorDiscovery as CordisConnectDescriptorDiscoveryService,
  };
}
