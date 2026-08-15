import { Context } from '@deepseek-ai/cordis';
import {
  buildCordisCompositionSnapshot,
  buildCordisPluginDescriptor,
  type CordisCompositionSnapshot,
  type CordisPluginDescriptor,
} from '@one-person-lab/cordis-abi';
import {
  CORDIS_FIBER_STATE,
  CORDIS_FRAMEWORK_INTEGRITY,
  CORDIS_FRAMEWORK_PACKAGE,
  CORDIS_FRAMEWORK_VERSION,
} from '@one-person-lab/cordis-abi/framework';

export const CORDIS_CONNECT_DESCRIPTOR_DISCOVERY_PLUGIN_ID =
  'opl-connect-descriptor-discovery';
export const CORDIS_CONNECT_DESCRIPTOR_DISCOVERY_PLUGIN_API_VERSION = '1.0.0';
export const CORDIS_CONNECT_DESCRIPTOR_DISCOVERY_SERVICE =
  'opl.connect.descriptor-discovery';
export const CORDIS_CONNECT_DESCRIPTOR_DISCOVERY_SOURCE_REF =
  'packages/connect-discovery/src/index.ts';
export const CORDIS_CONNECT_DESCRIPTOR_DISCOVERY_SOURCE_COMMIT =
  '97510b268300b1996f308e7a4110205cd703b95e';

export type CordisConnectDescriptorDiscoveryInput = Readonly<{
  packageId?: string;
}> & Readonly<Record<string, unknown>>;

export type CordisConnectDescriptorDiscovery<TDescriptor> = (
  input?: CordisConnectDescriptorDiscoveryInput,
) => Map<string, TDescriptor>;

export type CordisConnectDescriptorDiscoveryObservation = {
  surface_kind: 'opl_connect_descriptor_discovery_observation.v1';
  package_filter: string | null;
  descriptor_count: number;
  package_ids: string[];
  authority_boundary: {
    descriptor_source: 'native_carrier_fresh_readback';
    installed_truth_owner: 'native_carrier';
    currentness_truth_owner: 'package_owner_channel';
    cordis_installed_truth: false;
    cordis_currentness_truth: false;
    cordis_lifecycle_authority: false;
  };
};

export type CordisConnectDescriptorDiscoveryService<TDescriptor = unknown> = {
  discover(input?: CordisConnectDescriptorDiscoveryInput): Map<string, TDescriptor>;
};

export type CordisConnectDescriptorDiscoveryPluginConfig<TDescriptor> = {
  discover: CordisConnectDescriptorDiscovery<TDescriptor>;
};

declare module '@deepseek-ai/cordis' {
  interface Context {
    [CORDIS_CONNECT_DESCRIPTOR_DISCOVERY_SERVICE]: CordisConnectDescriptorDiscoveryService;
  }

  interface Events {
    'opl/connect/descriptors/discovered': (
      observation: CordisConnectDescriptorDiscoveryObservation,
    ) => void;
  }
}

export const cordisConnectDescriptorDiscoveryPlugin = {
  name: CORDIS_CONNECT_DESCRIPTOR_DISCOVERY_PLUGIN_ID,
  provide: CORDIS_CONNECT_DESCRIPTOR_DISCOVERY_SERVICE,
  apply<TDescriptor>(
    ctx: Context,
    config: CordisConnectDescriptorDiscoveryPluginConfig<TDescriptor>,
  ) {
    if (typeof config.discover !== 'function') {
      throw new Error('Connect discovery Package requires a Host-provided discovery adapter.');
    }
    const service: CordisConnectDescriptorDiscoveryService<TDescriptor> = {
      discover(input = {}) {
        const descriptors = config.discover(input);
        ctx.emit('opl/connect/descriptors/discovered', {
          surface_kind: 'opl_connect_descriptor_discovery_observation.v1',
          package_filter: input.packageId?.trim() || null,
          descriptor_count: descriptors.size,
          package_ids: [...descriptors.keys()].sort(),
          authority_boundary: {
            descriptor_source: 'native_carrier_fresh_readback',
            installed_truth_owner: 'native_carrier',
            currentness_truth_owner: 'package_owner_channel',
            cordis_installed_truth: false,
            cordis_currentness_truth: false,
            cordis_lifecycle_authority: false,
          },
        });
        return descriptors;
      },
    };
    ctx.provide(CORDIS_CONNECT_DESCRIPTOR_DISCOVERY_SERVICE, service);
  },
};

const forbiddenAuthorities = Object.freeze([
  'package_installed_truth',
  'package_currentness',
  'native_carrier_lifecycle',
  'credential_material',
  'app_product_truth',
  'app_contribution_confirmation',
  'app_contribution_abi',
  'workspace_file_bytes',
  'security_sandbox',
]);

export const CORDIS_CONNECT_DESCRIPTOR_DISCOVERY_PLUGIN_DESCRIPTOR: CordisPluginDescriptor =
  buildCordisPluginDescriptor({
    plugin_id: CORDIS_CONNECT_DESCRIPTOR_DISCOVERY_PLUGIN_ID,
    plugin_api_version: CORDIS_CONNECT_DESCRIPTOR_DISCOVERY_PLUGIN_API_VERSION,
    source_ref: CORDIS_CONNECT_DESCRIPTOR_DISCOVERY_SOURCE_REF,
    source_commit: CORDIS_CONNECT_DESCRIPTOR_DISCOVERY_SOURCE_COMMIT,
    package_ref: {
      package_id: '@one-person-lab/connect-discovery',
      package_version: '0.1.0',
      package_ref: 'npm:@one-person-lab/connect-discovery@0.1.0',
    },
    required: true,
    provides: [CORDIS_CONNECT_DESCRIPTOR_DISCOVERY_SERVICE],
    injects: { required: [], optional: [] },
    events: [{
      name: 'opl/connect/descriptors/discovered',
      mode: 'emit',
      role: 'publish',
      payload_schema_ref: null,
    }],
    scope: 'process',
    trust: 'first_party_restricted',
    disposer: { required: true, boundary: 'plugin_fiber' },
    authority_boundary: { forbidden_authorities: forbiddenAuthorities },
  });

export function buildCordisConnectCompositionSnapshot(): CordisCompositionSnapshot {
  return buildCordisCompositionSnapshot({
    framework: {
      package: CORDIS_FRAMEWORK_PACKAGE,
      version: CORDIS_FRAMEWORK_VERSION,
      integrity: CORDIS_FRAMEWORK_INTEGRITY,
    },
    binding: {
      executor_adapter_id: 'opl-native-carrier-descriptor-discovery',
      executor_route: CORDIS_CONNECT_DESCRIPTOR_DISCOVERY_SERVICE,
    },
    foundry_evidence_ref: null,
    plugins: [CORDIS_CONNECT_DESCRIPTOR_DISCOVERY_PLUGIN_DESCRIPTOR],
  });
}

export async function createCordisConnectComposition<TDescriptor>(
  options: CordisConnectDescriptorDiscoveryPluginConfig<TDescriptor>,
) {
  const ctx = new Context();
  const descriptorDiscoveryFiber = await ctx.plugin(
    cordisConnectDescriptorDiscoveryPlugin,
    options,
  );
  if (descriptorDiscoveryFiber.state !== CORDIS_FIBER_STATE.ACTIVE) {
    throw new Error(
      `Cordis Connect descriptor discovery service did not become active: ${descriptorDiscoveryFiber.state}`,
    );
  }
  return {
    ctx,
    descriptorDiscoveryFiber,
    descriptorDiscovery: ctx[CORDIS_CONNECT_DESCRIPTOR_DISCOVERY_SERVICE] as CordisConnectDescriptorDiscoveryService<TDescriptor>,
    snapshot: buildCordisConnectCompositionSnapshot(),
    async dispose() {
      await descriptorDiscoveryFiber.dispose();
      await ctx.fiber.dispose();
    },
  };
}
