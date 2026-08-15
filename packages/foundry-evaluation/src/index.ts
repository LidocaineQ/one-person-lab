import { Context } from '@deepseek-ai/cordis';
import { buildCordisPluginDescriptor } from '@one-person-lab/cordis-abi';

export const CORDIS_FOUNDRY_PROVIDER_MANIFEST_PLUGIN_ID =
  'opl-foundry-provider-manifest';
export const CORDIS_FOUNDRY_PROVIDER_MANIFEST_SERVICE =
  'opl.foundry.provider-manifest';
export const CORDIS_FOUNDRY_EVALUATION_ADAPTER_PLUGIN_ID =
  'opl-foundry-evaluation-adapter';
export const CORDIS_FOUNDRY_EVALUATION_SERVICE = 'opl.foundry.evaluation';
export const CORDIS_FOUNDRY_PLUGIN_API_VERSION = '1.0.0';
export const CORDIS_FOUNDRY_ADAPTERS_SOURCE_REF =
  'packages/foundry-evaluation/src/index.ts';
export const CORDIS_FOUNDRY_ADAPTERS_SOURCE_COMMIT =
  '832aa00a85eb722dc8748587ffe648b3c6afd808';

export type FoundryProviderManifest = Readonly<{
  provider_id: string;
  authority_boundary: Readonly<Record<string, boolean>>;
}> & Readonly<Record<string, unknown>>;
export type FoundryEvaluationEvidence = Readonly<Record<string, unknown>>;

export type FoundryEvaluationExecutor = {
  evaluator_id: string;
  qualification_capability: string;
  evaluate(input: Readonly<Record<string, unknown>>): Promise<FoundryEvaluationEvidence>;
  canary(input: Readonly<Record<string, unknown>>): Promise<FoundryEvaluationEvidence>;
};

export type CordisFoundryProviderManifestService = {
  normalize(parsed: unknown, manifestRef?: string): FoundryProviderManifest;
  read(checkoutRoot: string, manifestRef?: string): FoundryProviderManifest;
};

export type CordisFoundryProviderManifestPluginConfig = CordisFoundryProviderManifestService;

export type CordisFoundryEvaluationService = Pick<
  FoundryEvaluationExecutor,
  'evaluator_id' | 'qualification_capability' | 'evaluate' | 'canary'
>;

export type CordisFoundryEvaluationPluginConfig = {
  evaluator: FoundryEvaluationExecutor;
};

declare module '@deepseek-ai/cordis' {
  interface Context {
    [CORDIS_FOUNDRY_PROVIDER_MANIFEST_SERVICE]: CordisFoundryProviderManifestService;
    [CORDIS_FOUNDRY_EVALUATION_SERVICE]: CordisFoundryEvaluationService;
  }

  interface Events {
    'opl/foundry/provider-manifest/normalized': (manifest: FoundryProviderManifest) => void;
    'opl/foundry/evaluation/requested': (
      phase: 'evaluate' | 'canary',
      input: Readonly<Record<string, unknown>>,
    ) => void;
    'opl/foundry/evaluation/completed': (
      phase: 'evaluate' | 'canary',
      evidence: FoundryEvaluationEvidence,
    ) => void | Promise<void>;
  }
}

function emitProviderManifest(ctx: Context, manifest: FoundryProviderManifest) {
  ctx.emit('opl/foundry/provider-manifest/normalized', manifest);
  return manifest;
}

export const cordisFoundryProviderManifestPlugin = {
  name: CORDIS_FOUNDRY_PROVIDER_MANIFEST_PLUGIN_ID,
  provide: CORDIS_FOUNDRY_PROVIDER_MANIFEST_SERVICE,
  apply(ctx: Context, config: CordisFoundryProviderManifestPluginConfig) {
    if (typeof config?.normalize !== 'function' || typeof config?.read !== 'function') {
      throw new Error('Foundry evaluation Package requires Host-provided manifest adapters.');
    }
    const service: CordisFoundryProviderManifestService = {
      normalize(parsed, manifestRef) {
        return emitProviderManifest(ctx, config.normalize(parsed, manifestRef));
      },
      read(checkoutRoot, manifestRef) {
        return emitProviderManifest(ctx, config.read(checkoutRoot, manifestRef));
      },
    };
    ctx.provide(CORDIS_FOUNDRY_PROVIDER_MANIFEST_SERVICE, service);
  },
};

export const cordisFoundryEvaluationAdapterPlugin = {
  name: CORDIS_FOUNDRY_EVALUATION_ADAPTER_PLUGIN_ID,
  provide: CORDIS_FOUNDRY_EVALUATION_SERVICE,
  apply(ctx: Context, config: CordisFoundryEvaluationPluginConfig) {
    const { evaluator } = config;
    const service: CordisFoundryEvaluationService = {
      evaluator_id: evaluator.evaluator_id,
      qualification_capability: evaluator.qualification_capability,
      async evaluate(input) {
        ctx.emit('opl/foundry/evaluation/requested', 'evaluate', input);
        const evidence = await evaluator.evaluate(input);
        await ctx.parallel('opl/foundry/evaluation/completed', 'evaluate', evidence);
        return evidence;
      },
      async canary(input) {
        ctx.emit('opl/foundry/evaluation/requested', 'canary', input);
        const evidence = await evaluator.canary(input);
        await ctx.parallel('opl/foundry/evaluation/completed', 'canary', evidence);
        return evidence;
      },
    };
    ctx.provide(CORDIS_FOUNDRY_EVALUATION_SERVICE, service);
  },
};

const foundryForbiddenAuthorities = Object.freeze([
  'domain_quality_verdict',
  'domain_truth',
  'foundry_agent_version',
  'foundry_promotion_activation',
  'ledger_receipt_authority',
  'package_installed_truth',
]);

function descriptor(input: {
  pluginId: string;
  serviceId: string;
  required: boolean;
  scope: 'composition' | 'attempt';
  events: readonly {
    name: string;
    mode: 'emit' | 'parallel';
    role: 'publish';
    payload_schema_ref: null;
  }[];
}) {
  return buildCordisPluginDescriptor({
    plugin_id: input.pluginId,
    plugin_api_version: CORDIS_FOUNDRY_PLUGIN_API_VERSION,
    source_ref: CORDIS_FOUNDRY_ADAPTERS_SOURCE_REF,
    source_commit: CORDIS_FOUNDRY_ADAPTERS_SOURCE_COMMIT,
    package_ref: {
      package_id: '@one-person-lab/foundry-evaluation',
      package_version: '0.1.0',
      package_ref: 'npm:@one-person-lab/foundry-evaluation@0.1.0',
    },
    required: input.required,
    provides: [input.serviceId],
    injects: { required: [], optional: [] },
    events: input.events,
    scope: input.scope,
    trust: input.scope === 'attempt' ? 'first_party_restricted' : 'first_party_privileged',
    disposer: { required: true, boundary: 'plugin_fiber' },
    authority_boundary: { forbidden_authorities: foundryForbiddenAuthorities },
  });
}

export const CORDIS_FOUNDRY_PROVIDER_MANIFEST_PLUGIN_DESCRIPTOR = descriptor({
  pluginId: CORDIS_FOUNDRY_PROVIDER_MANIFEST_PLUGIN_ID,
  serviceId: CORDIS_FOUNDRY_PROVIDER_MANIFEST_SERVICE,
  required: true,
  scope: 'composition',
  events: [{
    name: 'opl/foundry/provider-manifest/normalized',
    mode: 'emit',
    role: 'publish',
    payload_schema_ref: null,
  }],
});

export const CORDIS_FOUNDRY_EVALUATION_ADAPTER_PLUGIN_DESCRIPTOR = descriptor({
  pluginId: CORDIS_FOUNDRY_EVALUATION_ADAPTER_PLUGIN_ID,
  serviceId: CORDIS_FOUNDRY_EVALUATION_SERVICE,
  required: false,
  scope: 'attempt',
  events: [
    { name: 'opl/foundry/evaluation/completed', mode: 'parallel', role: 'publish', payload_schema_ref: null },
    { name: 'opl/foundry/evaluation/requested', mode: 'emit', role: 'publish', payload_schema_ref: null },
  ],
});

export const CORDIS_FOUNDRY_PLUGIN_DESCRIPTORS = Object.freeze([
  CORDIS_FOUNDRY_PROVIDER_MANIFEST_PLUGIN_DESCRIPTOR,
  CORDIS_FOUNDRY_EVALUATION_ADAPTER_PLUGIN_DESCRIPTOR,
]);
