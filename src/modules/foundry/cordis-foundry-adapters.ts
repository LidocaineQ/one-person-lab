import { Context } from '@deepseek-ai/cordis';
import {
  CORDIS_FOUNDRY_ADAPTERS_SOURCE_COMMIT,
  CORDIS_FOUNDRY_ADAPTERS_SOURCE_REF,
  CORDIS_FOUNDRY_EVALUATION_ADAPTER_PLUGIN_DESCRIPTOR,
  CORDIS_FOUNDRY_EVALUATION_ADAPTER_PLUGIN_ID,
  CORDIS_FOUNDRY_EVALUATION_SERVICE,
  CORDIS_FOUNDRY_PLUGIN_API_VERSION,
  CORDIS_FOUNDRY_PLUGIN_DESCRIPTORS,
  CORDIS_FOUNDRY_PROVIDER_MANIFEST_PLUGIN_DESCRIPTOR,
  CORDIS_FOUNDRY_PROVIDER_MANIFEST_PLUGIN_ID,
  CORDIS_FOUNDRY_PROVIDER_MANIFEST_SERVICE,
  cordisFoundryEvaluationAdapterPlugin as packageEvaluationPlugin,
  cordisFoundryProviderManifestPlugin as packageProviderManifestPlugin,
  type CordisFoundryEvaluationPluginConfig as PackageEvaluationPluginConfig,
  type CordisFoundryEvaluationService as PackageEvaluationService,
} from '@one-person-lab/foundry-evaluation';

import {
  normalizeFoundryProviderManifest,
  readFoundryProviderManifest,
  type FoundryProviderManifest,
} from './designer-adapter.ts';
import type { EvaluationExecutor } from './ports.ts';

export {
  CORDIS_FOUNDRY_ADAPTERS_SOURCE_COMMIT,
  CORDIS_FOUNDRY_ADAPTERS_SOURCE_REF,
  CORDIS_FOUNDRY_EVALUATION_ADAPTER_PLUGIN_DESCRIPTOR,
  CORDIS_FOUNDRY_EVALUATION_ADAPTER_PLUGIN_ID,
  CORDIS_FOUNDRY_EVALUATION_SERVICE,
  CORDIS_FOUNDRY_PLUGIN_API_VERSION,
  CORDIS_FOUNDRY_PLUGIN_DESCRIPTORS,
  CORDIS_FOUNDRY_PROVIDER_MANIFEST_PLUGIN_DESCRIPTOR,
  CORDIS_FOUNDRY_PROVIDER_MANIFEST_PLUGIN_ID,
  CORDIS_FOUNDRY_PROVIDER_MANIFEST_SERVICE,
};

export type CordisFoundryProviderManifestService = {
  normalize(parsed: unknown, manifestRef?: string): FoundryProviderManifest;
  read(checkoutRoot: string, manifestRef?: string): FoundryProviderManifest;
};
export type CordisFoundryEvaluationService = Pick<
  EvaluationExecutor,
  'evaluator_id' | 'qualification_capability' | 'evaluate' | 'canary'
>;
export type CordisFoundryEvaluationPluginConfig = { evaluator: EvaluationExecutor };

export const cordisFoundryProviderManifestPlugin = {
  ...packageProviderManifestPlugin,
  apply(ctx: Context) {
    return packageProviderManifestPlugin.apply(ctx, {
      normalize: (parsed: unknown, manifestRef?: string) =>
        normalizeFoundryProviderManifest(parsed, manifestRef),
      read: (checkoutRoot: string, manifestRef?: string) =>
        readFoundryProviderManifest(checkoutRoot, manifestRef),
    });
  },
};

export const cordisFoundryEvaluationAdapterPlugin = {
  ...packageEvaluationPlugin,
  apply(ctx: Context, config: CordisFoundryEvaluationPluginConfig) {
    return packageEvaluationPlugin.apply(ctx, config as unknown as PackageEvaluationPluginConfig);
  },
};

const _packageServiceShape: PackageEvaluationService | null = null;
void _packageServiceShape;
