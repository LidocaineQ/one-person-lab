import type { Context, Fiber, Plugin } from '@deepseek-ai/cordis';

export const CORDIS_COMPOSITION_INSPECT_VERSION = 'cordis-composition-inspect.v1';
export const CORDIS_COMPOSITION_INSPECT_SCHEMA_REF =
  'contracts/opl-framework/cordis-composition-inspect.schema.json';

type CordisCompositionSnapshotPlugin = {
  readonly id: string;
  readonly required: boolean;
  readonly provides: readonly string[];
  readonly injects: readonly string[];
  readonly scope: string;
  readonly trust: string;
};

export type CordisCompositionSnapshotLike = {
  readonly version: string;
  readonly framework: {
    readonly package: string;
    readonly version: string;
  };
  readonly binding: Readonly<Record<string, unknown>>;
  readonly plugins: readonly CordisCompositionSnapshotPlugin[];
};

export type CordisCompositionPluginEvent = {
  readonly name: string;
  readonly mode: 'emit' | 'parallel' | 'serial' | 'bail' | 'waterfall' | 'observe';
  readonly role: 'publish' | 'observe';
};

export type CordisCompositionPluginMetadata = {
  readonly id: string;
  readonly source_ref: string;
  readonly version?: string;
  readonly events?: readonly CordisCompositionPluginEvent[];
};

type CordisPluginState =
  | 'active'
  | 'pending'
  | 'loading'
  | 'failed'
  | 'unloading'
  | 'disposed'
  | 'not_loaded'
  | 'mixed'
  | 'unknown';

type CordisDisposerStatus =
  | 'registered_at_observation'
  | 'not_registered'
  | 'disposed'
  | 'unknown';

type CordisPluginInspection = {
  id: string;
  version: string | null;
  source_ref: string | null;
  metadata_status: 'complete' | 'unknown';
  required: boolean | null;
  provides: string[] | null;
  injects: string[] | null;
  state: CordisPluginState;
  scope: string;
  trust: string;
  events: CordisCompositionPluginEvent[] | null;
  fiber_count: number;
  disposer_status: CordisDisposerStatus;
  diagnostic_refs: string[];
};

export type CordisCompositionInspect = {
  version: typeof CORDIS_COMPOSITION_INSPECT_VERSION;
  surface_kind: 'opl_cordis_composition_inspect';
  schema_ref: typeof CORDIS_COMPOSITION_INSPECT_SCHEMA_REF;
  authority_boundary: {
    installed_truth: false;
    currentness_truth: false;
    domain_truth: false;
    readiness_truth: false;
    lifecycle_authority: false;
    mutation_authority: false;
  };
  side_effects: {
    external_writes: false;
    persistent_writes: false;
    installed_truth_mutated: false;
  };
  observation: {
    scope: 'isolated_experiment_command';
    state: 'active_context_observation';
    teardown_status: 'caller_managed' | 'disposed_after_observation';
  };
  composition: {
    snapshot_version: string;
    framework: {
      package: string;
      version: string;
    };
    binding: Record<string, unknown>;
    default_caller_activated: false;
    plugin_runtime_count: number;
  };
  plugins: CordisPluginInspection[];
  diagnostics: Array<{
    code: 'unknown_plugin_metadata' | 'required_plugin_not_loaded' | 'optional_plugin_not_loaded';
    plugin_id: string;
    diagnostic_ref: string;
  }>;
};

export const CORDIS_AGENT_EXECUTOR_INSPECT_METADATA: readonly CordisCompositionPluginMetadata[] = Object.freeze([
  {
    id: 'opl-cordis-agent-executor-adapter',
    source_ref: 'src/modules/runway/cordis-agent-executor-experiment.ts',
    events: Object.freeze([]),
  },
  {
    id: 'opl-cordis-agent-executor-service',
    source_ref: 'src/modules/runway/cordis-agent-executor-experiment.ts',
    events: Object.freeze([
      Object.freeze({
        name: 'opl/runway/executor/requested',
        mode: 'emit' as const,
        role: 'publish' as const,
      }),
      Object.freeze({
        name: 'opl/runway/executor/completed',
        mode: 'parallel' as const,
        role: 'publish' as const,
      }),
    ]),
  },
  {
    id: 'opl-cordis-agent-executor-observer',
    source_ref: 'src/modules/runway/cordis-agent-executor-experiment.ts',
    events: Object.freeze([
      Object.freeze({
        name: 'opl/runway/executor/requested',
        mode: 'observe' as const,
        role: 'observe' as const,
      }),
      Object.freeze({
        name: 'opl/runway/executor/completed',
        mode: 'observe' as const,
        role: 'observe' as const,
      }),
    ]),
  },
]);

const FIBER_STATE_NAMES: Readonly<Record<number, CordisPluginState>> = {
  0: 'pending',
  1: 'loading',
  2: 'active',
  3: 'failed',
  4: 'disposed',
  5: 'unloading',
};

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function stableRecord(value: Readonly<Record<string, unknown>>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => compareStrings(left, right))
      .map(([key, entry]) => [
        key,
        entry && typeof entry === 'object' && !Array.isArray(entry)
          ? stableRecord(entry as Readonly<Record<string, unknown>>)
          : entry,
      ]),
  );
}

function stateOf(fiber: Fiber): CordisPluginState {
  return FIBER_STATE_NAMES[fiber.state] ?? 'unknown';
}

function providedServices(context: Context, fibers: readonly Fiber[]): string[] {
  const names = new Set<string>();
  for (const key of Object.getOwnPropertySymbols(context.reflect.store)) {
    const implementation = context.reflect.store[key];
    if (implementation && fibers.includes(implementation.fiber)) names.add(implementation.name);
  }
  return [...names].sort(compareStrings);
}

function actualInjects(fibers: readonly Fiber[]): string[] {
  return [...new Set(fibers.flatMap((fiber) => Object.keys(fiber.inject)))].sort(compareStrings);
}

function runtimeId(runtime: Plugin.Runtime, index: number): string {
  const name = runtime.name?.trim();
  if (name) return name;
  const callbackName = runtime.callback.name?.trim();
  if (callbackName && callbackName !== 'apply') return callbackName;
  return `unknown-plugin-${index + 1}`;
}

function inspectPlugin(
  context: Context,
  id: string,
  fibers: readonly Fiber[],
  descriptor: CordisCompositionSnapshotPlugin | undefined,
  metadata: CordisCompositionPluginMetadata | undefined,
  compositionVersion: string,
): CordisPluginInspection {
  const states = [...new Set(fibers.map(stateOf))];
  const state = states.length === 0
    ? 'not_loaded'
    : states.length === 1
      ? states[0]
      : 'mixed';
  const allDisposed = fibers.length > 0 && fibers.every((fiber) => fiber.uid === null || stateOf(fiber) === 'disposed');
  const inspection: CordisPluginInspection = {
    id,
    version: metadata?.version ?? (descriptor ? compositionVersion : null),
    source_ref: metadata?.source_ref ?? null,
    metadata_status: metadata ? 'complete' : 'unknown',
    required: descriptor?.required ?? null,
    provides: descriptor?.provides
      ? [...descriptor.provides].sort(compareStrings)
      : fibers.length > 0 ? providedServices(context, fibers) : null,
    injects: descriptor?.injects
      ? [...descriptor.injects].sort(compareStrings)
      : fibers.length > 0 ? actualInjects(fibers) : null,
    state,
    scope: descriptor?.scope ?? 'unknown',
    trust: descriptor?.trust ?? 'unknown',
    events: metadata?.events
      ? [...metadata.events]
        .sort((left, right) => compareStrings(
          `${left.name}:${left.mode}:${left.role}`,
          `${right.name}:${right.mode}:${right.role}`,
        ))
        .map((event) => ({ ...event }))
      : null,
    fiber_count: fibers.length,
    disposer_status: fibers.length === 0
      ? 'not_registered'
      : allDisposed
        ? 'disposed'
        : fibers.some((fiber) => fiber.uid !== null)
          ? 'registered_at_observation'
          : 'unknown',
    diagnostic_refs: metadata ? [metadata.source_ref] : [],
  };
  return inspection;
}

function diagnostic(
  code: CordisCompositionInspect['diagnostics'][number]['code'],
  pluginId: string,
): CordisCompositionInspect['diagnostics'][number] {
  return {
    code,
    plugin_id: pluginId,
    diagnostic_ref: `cordis:composition/${code}/${pluginId}`,
  };
}

export function buildCordisCompositionInspect(input: {
  context: Context;
  snapshot: CordisCompositionSnapshotLike;
  metadata?: readonly CordisCompositionPluginMetadata[];
}): CordisCompositionInspect {
  const metadataById = new Map((input.metadata ?? []).map((entry) => [entry.id, entry]));
  const descriptorById = new Map(input.snapshot.plugins.map((entry) => [entry.id, entry]));
  const runtimeEntries = [...input.context.registry.values()]
    .map((runtime, index) => ({ runtime, id: runtimeId(runtime, index) }))
    .sort((left, right) => compareStrings(left.id, right.id));
  const fibersById = new Map(runtimeEntries.map(({ runtime, id }) => [id, [...runtime.fibers]]));
  const pluginIds = new Set<string>([
    ...descriptorById.keys(),
    ...fibersById.keys(),
  ]);
  const plugins = [...pluginIds]
    .sort(compareStrings)
    .map((id) => inspectPlugin(
      input.context,
      id,
      fibersById.get(id) ?? [],
      descriptorById.get(id),
      metadataById.get(id),
      input.snapshot.version,
    ));

  const diagnostics = plugins.flatMap((plugin) => {
    const entries: CordisCompositionInspect['diagnostics'] = [];
    if (plugin.metadata_status === 'unknown') entries.push(diagnostic('unknown_plugin_metadata', plugin.id));
    if (plugin.state === 'not_loaded' && plugin.required === true) entries.push(diagnostic('required_plugin_not_loaded', plugin.id));
    if (plugin.state === 'not_loaded' && plugin.required === false) entries.push(diagnostic('optional_plugin_not_loaded', plugin.id));
    return entries;
  }).sort((left, right) => compareStrings(
    `${left.code}:${left.plugin_id}`,
    `${right.code}:${right.plugin_id}`,
  ));

  return {
    version: CORDIS_COMPOSITION_INSPECT_VERSION,
    surface_kind: 'opl_cordis_composition_inspect',
    schema_ref: CORDIS_COMPOSITION_INSPECT_SCHEMA_REF,
    authority_boundary: {
      installed_truth: false,
      currentness_truth: false,
      domain_truth: false,
      readiness_truth: false,
      lifecycle_authority: false,
      mutation_authority: false,
    },
    side_effects: {
      external_writes: false,
      persistent_writes: false,
      installed_truth_mutated: false,
    },
    observation: {
      scope: 'isolated_experiment_command',
      state: 'active_context_observation',
      teardown_status: 'caller_managed',
    },
    composition: {
      snapshot_version: input.snapshot.version,
      framework: {
        package: input.snapshot.framework.package,
        version: input.snapshot.framework.version,
      },
      binding: stableRecord(input.snapshot.binding),
      default_caller_activated: false,
      plugin_runtime_count: runtimeEntries.length,
    },
    plugins,
    diagnostics,
  };
}

export function markCordisCompositionInspectDisposed(
  inspect: CordisCompositionInspect,
): CordisCompositionInspect {
  return {
    ...inspect,
    observation: {
      ...inspect.observation,
      teardown_status: 'disposed_after_observation',
    },
  };
}
