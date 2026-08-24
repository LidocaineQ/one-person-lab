import type { FamilyActionExportFormat } from '../../../../kernel/family-action-catalog-contract.ts';

type JsonRecord = Record<string, unknown>;

export type GeneratedInterfaceFormat = FamilyActionExportFormat | 'product-entry';

export function selectGeneratedInterfaceBundleFormat(
  bundle: JsonRecord,
  selectedFormat: GeneratedInterfaceFormat | 'all',
) {
  if (selectedFormat === 'all') {
    return bundle;
  }
  const selectedKey =
    selectedFormat === 'product-entry'
      ? 'product_entry'
      : selectedFormat === 'openai'
        ? 'openai_tool'
        : selectedFormat === 'ai-sdk'
          ? 'ai_sdk'
          : selectedFormat;
  const selectedBlock = bundle[selectedKey];
  return {
    surface_kind: bundle.surface_kind,
    version: bundle.version,
    owner: bundle.owner,
    generated_surface_owner: bundle.generated_surface_owner,
    domain_repo_can_own_generated_surface: bundle.domain_repo_can_own_generated_surface,
    status: bundle.status,
    blocker_reasons: bundle.blocker_reasons,
    standard_agent_contract_resolution: bundle.standard_agent_contract_resolution,
    selected_format: selectedFormat,
    project_id: bundle.project_id,
    target_domain_id: bundle.target_domain_id,
    agent_id: bundle.agent_id,
    generated_from: bundle.generated_from,
    default_entry_policy: bundle.default_entry_policy,
    supported_derived_surfaces: bundle.supported_derived_surfaces,
    source_of_work_lineage: bundle.source_of_work_lineage,
    generated_default_entry_no_resurrection_gate: bundle.generated_default_entry_no_resurrection_gate,
    [selectedKey]: selectedBlock,
    product_status: bundle.product_status,
    product_session: bundle.product_session,
    domain_handler: bundle.domain_handler,
    workbench: bundle.workbench,
    generated_wrapper_bundle: bundle.generated_wrapper_bundle,
    generated_surface_consumption_bundle: bundle.generated_surface_consumption_bundle,
    active_caller_cutover_proof: bundle.active_caller_cutover_proof,
    active_caller_target_proof: bundle.active_caller_target_proof,
    active_legacy_caller_deletion_gate_readout: bundle.active_legacy_caller_deletion_gate_readout,
    stage_routes: selectedFormat === 'product-entry' ? bundle.stage_routes : [],
    action_stage_routes: bundle.action_stage_routes,
    parity: bundle.parity,
    generated_direct_parity: bundle.generated_direct_parity,
    authority_boundary: bundle.authority_boundary,
    source_contract_consumption: bundle.source_contract_consumption,
  };
}
