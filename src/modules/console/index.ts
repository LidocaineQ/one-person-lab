export const OPL_CONSOLE_SOURCE_MODULE = {
  moduleId: 'console',
  brandName: 'OPL Console',
  contractRef: 'contracts/opl-framework/source-module-map.json#modules.console',
  physicalRoot: 'src/modules/console',
} as const;

export {
  buildCordisCompositionInspect,
  markCordisCompositionInspectDisposed,
  CORDIS_AGENT_EXECUTOR_INSPECT_METADATA,
  CORDIS_COMPOSITION_INSPECT_SCHEMA_REF,
  CORDIS_COMPOSITION_INSPECT_VERSION,
} from './cordis-composition-inspect.ts';
export type {
  CordisCompositionInspect,
  CordisCompositionPluginEvent,
  CordisCompositionPluginMetadata,
  CordisCompositionSnapshotLike,
} from './cordis-composition-inspect.ts';
export {
  buildCordisFrameworkReadinessCompositionSnapshot,
  CORDIS_ATLAS_CONSOLE_PLUGIN_DESCRIPTORS,
  CORDIS_CONSOLE_READINESS_PLUGIN_API_VERSION,
  CORDIS_CONSOLE_READINESS_PLUGIN_DESCRIPTOR,
  CORDIS_CONSOLE_READINESS_PLUGIN_ID,
  CORDIS_CONSOLE_READINESS_SERVICE,
  CORDIS_CONSOLE_REQUIRED_ATLAS_API_VERSION,
  cordisFrameworkReadinessPlugin,
  createCordisFrameworkReadinessComposition,
} from './cordis-framework-readiness.ts';
export type {
  CordisFrameworkReadinessInput,
  CordisFrameworkReadinessPluginConfig,
  CordisFrameworkReadinessService,
} from './cordis-framework-readiness.ts';

export { buildEvidenceGroundedDecisionAgentProfileConsoleDrilldown } from './evidence-grounded-profile-drilldown.ts';
export type { EvidenceGroundedDecisionAgentProfileDrilldownInput } from './evidence-grounded-profile-drilldown.ts';
export * from './agent-readiness.ts';
export * from './foundry-operator-projection.ts';
export * from './framework-operating-maturity.ts';
export * from './framework-readiness-attention-actions.ts';
export * from './framework-readiness-attention-counts.ts';
export * from './framework-readiness-compact-readback.ts';
export * from './framework-readiness-owner-delta-handoff-summary.ts';
export {
  CORDIS_WORKSPACE_LEDGER_COMPOSITION_ID,
  CORDIS_WORKSPACE_LEDGER_PLUGIN_DESCRIPTORS,
  buildCordisWorkspaceLedgerCompositionSnapshot,
  createCordisWorkspaceLedgerComposition,
} from './cordis-workspace-ledger.ts';
export * from './framework-readiness-typed-blocker-attention.ts';
export * from './framework-readiness.ts';
export * from './framework-semantic-hygiene.ts';
export * from './private-platform-residue-owner-decisions.ts';
export * from './stage-candidate-portfolio.ts';
export * from './standard-domain-agent-template-consumption.ts';
export * from './work-item-projection/session-activity.ts';
export * from './work-item-execution-session-observer.ts';
