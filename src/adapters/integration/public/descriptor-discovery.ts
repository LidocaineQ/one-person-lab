import type {
  CordisConnectDescriptorDiscoveryService as PackageDescriptorDiscoveryService,
} from '@one-person-lab/connect-discovery';

import type { InstalledPackageDescriptor } from '../agent-package-registry-parts/installed-codex-plugin-directory.ts';

export type CordisConnectDescriptorDiscoveryService =
  PackageDescriptorDiscoveryService<InstalledPackageDescriptor>;
