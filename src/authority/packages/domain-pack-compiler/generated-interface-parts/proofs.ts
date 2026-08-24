import {
  blockStatusIsReady,
  buildActiveCallerTargetProof,
  generatedSurfaceTargetAllowed,
} from '../generated-interface-active-caller-proof.ts';
import { defaultCallerSurfaceGates } from '../../../../kernel/default-caller-surface-gates.ts';
import {
  DEFAULT_CALLER_OWNER_DECISION_ACCEPTED_RESULT_SHAPES,
  DEFAULT_CALLER_OWNER_DECISION_NEXT_REQUIRED_ACTION,
  DEFAULT_CALLER_SAME_WORK_UNIT_LIVE_EVIDENCE_SCOPE,
  DEFAULT_CALLER_STATIC_RETIREMENT_PREREQUISITE_GATE_IDS,
} from '../../../../kernel/default-caller-retirement-guard.ts';
import { isRecord } from '../../../../kernel/contract-validation.ts';
import { optionalString } from '../../../../kernel/json-file.ts';
import { stringList } from '../../../../kernel/json-record.ts';

type JsonRecord = Record<string, unknown>;
type ActiveCallerTargetProof = ReturnType<typeof buildActiveCallerTargetProof>;
type ActiveCallerSurfaceTarget = ActiveCallerTargetProof['surface_targets'][number];

const GENERATED_WRAPPER_CANONICAL_TARGET_IDS: Record<string, string[]> = {
  product_entry: ['product_entry_manifest'],
  product_status: ['status_read_model'],
  product_session: ['product_session', 'product_entry_manifest', 'status_read_model'],
  domain_handler: ['domain_action_adapter_export_dispatch', 'domain_action_adapter', 'domain_handler'],
  workbench: ['workbench_drilldown'],
};

const GENERATED_WRAPPER_DESCRIPTOR_SCOPE = [
  {
    surface_id: 'cli',
    block_key: 'cli',
    target_surface_id: 'cli',
    descriptor_kind: 'opl_generated_cli_descriptor',
  },
  {
    surface_id: 'mcp',
    block_key: 'mcp',
    target_surface_id: 'mcp',
    descriptor_kind: 'opl_generated_mcp_descriptor',
  },
  {
    surface_id: 'skill',
    block_key: 'skill',
    target_surface_id: 'skill',
    descriptor_kind: 'opl_generated_skill_descriptor',
  },
  {
    surface_id: 'product_entry',
    block_key: 'product_entry',
    target_surface_id: 'product_entry',
    descriptor_kind: 'opl_generated_product_entry_descriptor',
  },
  {
    surface_id: 'product_status',
    block_key: 'product_status',
    target_surface_id: 'product_status',
    descriptor_kind: 'opl_generated_product_status_descriptor',
  },
  {
    surface_id: 'product_session',
    block_key: 'product_session',
    target_surface_id: 'product_session',
    descriptor_kind: 'opl_generated_product_session_descriptor',
  },
  {
    surface_id: 'domain_handler',
    block_key: 'domain_handler',
    target_surface_id: 'domain_handler',
    descriptor_kind: 'opl_generated_domain_handler_descriptor',
  },
  {
    surface_id: 'workbench',
    block_key: 'workbench',
    target_surface_id: 'workbench',
    descriptor_kind: 'opl_hosted_workbench_descriptor',
  },
] as const;

export function buildActiveCallerCutoverProof(
  descriptor: JsonRecord,
  compilerStatus: string,
  generatedBlocksReady: boolean,
  generatedBlockKeys: string[],
  targetProof: ActiveCallerTargetProof,
) {
  const blockerReasons = Array.isArray(descriptor.blocker_reasons)
    ? descriptor.blocker_reasons.filter((reason): reason is string => typeof reason === 'string')
    : [];
  const targetDomainId = optionalString(descriptor.target_domain_id)
    ?? optionalString(descriptor.project_id)
    ?? 'unknown';
  const ready = compilerStatus === 'ready' && generatedBlocksReady && targetProof.status === 'ready';
  return {
    surface_kind: 'opl_generated_surface_active_caller_cutover_proof',
    status: ready
      ? 'cutover_to_opl_generated_or_domain_handler_targets'
      : 'blocked',
    generated_surface_owner: 'one-person-lab',
    target_domain_id: targetDomainId,
    generated_blocks_ready: generatedBlocksReady,
    generated_block_keys: generatedBlockKeys,
    active_caller_target_proof_status: targetProof.status,
    blocked_target_count: targetProof.blocked_target_count,
    blocked_surface_ids: targetProof.surface_targets
      .filter((target) => (
        target.proof_status.startsWith('blocked')
        || !generatedSurfaceTargetAllowed(optionalString(target.target_kind) ?? '')
      ))
      .map((target) => target.surface_id),
    blocker_reasons: blockerReasons,
    domain_handler_targets_only: ready,
    domain_handler_target_policy: 'Generated descriptors route to domain action handler targets by receipt contract.',
    scope: 'generated_interface_and_domain_handler_target_proof_only_not_live_soak_or_domain_ready',
    claims_live_soak_complete: false,
    claims_domain_ready: false,
    forbidden_generated_authority: [
      'domain_truth_write',
      'memory_body_write',
      'quality_or_export_verdict',
      'artifact_mutation',
    ],
    authority_boundary_ref: 'generated_agent_interfaces.authority_boundary',
  };
}

export function buildGeneratedWrapperBundle(
  blocks: JsonRecord,
  generatedBlocksReady: boolean,
  targetProof: ActiveCallerTargetProof,
) {
  const targetBySurface = new Map(
    targetProof.surface_targets.map((target) => [target.surface_id, target]),
  );
  const descriptorScope = GENERATED_WRAPPER_DESCRIPTOR_SCOPE.map((scope) => {
    const block = isRecord(blocks[scope.block_key]) ? blocks[scope.block_key] as JsonRecord : null;
    const canonicalTargetSurfaceIds =
      GENERATED_WRAPPER_CANONICAL_TARGET_IDS[scope.surface_id] ?? [scope.target_surface_id];
    const candidateTargets = canonicalTargetSurfaceIds
      .map((targetSurfaceId) => targetBySurface.get(targetSurfaceId))
      .filter((target): target is ActiveCallerSurfaceTarget => Boolean(target));
    const readyTargets = candidateTargets.filter((target) => (
      !optionalString(target.proof_status)?.startsWith('blocked')
      && generatedSurfaceTargetAllowed(optionalString(target.target_kind) ?? '')
    ));
    const target = readyTargets.find((candidate) => (
      optionalString(candidate.active_caller_module_id)
      || stringList(candidate.current_surface_refs).length > 0
      || isRecord(candidate.bridge_exit_gate)
    ))
      ?? readyTargets[0]
      ?? candidateTargets[0];
    const status = optionalString(block?.status);
    const targetStatus = optionalString(target?.proof_status);
    const targetKind = optionalString(target?.target_kind);
    const blockers = [
      blockStatusIsReady(status) ? null : `blocked_descriptor:${scope.surface_id}`,
      targetStatus?.startsWith('blocked') ? `blocked_target:${scope.surface_id}` : null,
      !targetKind || generatedSurfaceTargetAllowed(targetKind) ? null : `unsupported_target:${scope.surface_id}`,
    ].filter((entry): entry is string => Boolean(entry));
    return {
      surface_id: scope.surface_id,
      descriptor_kind: scope.descriptor_kind,
      owner: 'one-person-lab',
      generated_surface_owner: 'one-person-lab',
      domain_repo_can_own_generated_surface: false,
      domain_repo_role: 'domain_handler_target_or_refs_only_adapter',
      status: blockers.length === 0 ? 'ready' : 'blocked',
      blockers,
      block_key: scope.block_key,
      descriptor_status: status,
      active_caller_target_kind: targetKind,
      active_caller_proof_status: targetStatus,
      active_caller_module_id: optionalString(target?.active_caller_module_id),
      canonical_target_surface_ids: canonicalTargetSurfaceIds,
      target_boundary: {
        allowed_target_kinds: [
          'domain_handler_target',
          'refs_only_domain_adapter_target',
          'opl_generated_surface',
          'opl_hosted_surface',
        ],
        domain_handler_target_allowed: true,
        refs_only_domain_adapter_target_allowed: true,
      },
    };
  });
  const blockers = descriptorScope.flatMap((scope) => scope.blockers);
  return {
    surface_kind: 'opl_generated_hosted_wrapper_bundle_descriptor',
    version: 'opl-generated-hosted-wrapper-bundle.v1',
    owner: 'one-person-lab',
    generated_surface_owner: 'one-person-lab',
    domain_repo_can_own_generated_surface: false,
    domain_repo_declared_as_generated_wrapper_owner: false,
    status:
      generatedBlocksReady && targetProof.status === 'ready' && blockers.length === 0
        ? 'ready'
        : 'blocked',
    blockers,
    descriptor_scope: descriptorScope,
    descriptor_scope_ids: descriptorScope.map((scope) => scope.surface_id),
    descriptor_owner_policy: 'OPL owns generated and hosted wrapper descriptors; domain repos declare pack inputs and expose handler targets or refs-only adapters.',
    domain_repo_role_policy: 'domain_handler_target_or_refs_only_adapter',
    scope_claim:
      'generated_hosted_descriptor_ownership_only_not_live_soak_domain_ready_or_artifact_owner_receipt',
    claims_live_soak_complete: false,
    claims_domain_ready: false,
    claims_artifact_producing_owner_receipt: false,
    authority_boundary: {
      generated_wrapper_can_write_domain_truth: false,
      generated_wrapper_can_write_memory_body: false,
      generated_wrapper_can_authorize_quality_or_export: false,
      generated_wrapper_can_mutate_artifacts: false,
      generated_wrapper_routes_to_domain_handler_or_refs_only_adapter: true,
    },
  };
}

export function buildActiveLegacyCallerDeletionGateReadout(
  activeCallerTargetProof: ActiveCallerTargetProof,
  generatedWrapperBundle: ReturnType<typeof buildGeneratedWrapperBundle>,
) {
  const gates = defaultCallerSurfaceGates({
    active_caller_target_proof: activeCallerTargetProof,
    generated_wrapper_bundle: generatedWrapperBundle,
  });
  const surfaces = gates.map((gate) => {
    const worklist: JsonRecord = isRecord(gate.deletion_evidence_worklist)
      ? gate.deletion_evidence_worklist
      : {};
    const activeCallerCutover: JsonRecord = isRecord(worklist.active_caller_cutover)
      ? worklist.active_caller_cutover
      : {};
    const replacementParity: JsonRecord = isRecord(worklist.replacement_parity) ? worklist.replacement_parity : {};
    const noActiveCaller: JsonRecord = isRecord(worklist.no_active_caller_proof) ? worklist.no_active_caller_proof : {};
    const noForbiddenWrite: JsonRecord = isRecord(worklist.no_forbidden_write_proof)
      ? worklist.no_forbidden_write_proof
      : {};
    const tombstoneOrProvenance = isRecord(worklist.tombstone_or_provenance_ref)
      ? worklist.tombstone_or_provenance_ref
      : {};
    return {
      surface_id: gate.surface_id,
      active_caller_module_id: gate.active_caller_module_id,
      proof_status: gate.active_caller_proof_status,
      target_kind: gate.active_caller_target_kind,
      replacement_parity: optionalString(replacementParity.status) === 'observed' ? 'observed' : 'blocked_or_missing',
      replacement_parity_refs: stringList(replacementParity.source_refs),
      no_active_caller_proof_refs: stringList(noActiveCaller.evidence_refs),
      no_forbidden_write_refs: stringList(noForbiddenWrite.evidence_refs),
      tombstone_or_provenance_refs: stringList(tombstoneOrProvenance.evidence_refs),
      owner_decision_refs: stringList(worklist.owner_decision_refs),
      owner_decision_result_shape: optionalString(worklist.owner_decision_result_shape),
      active_caller_cutover: activeCallerCutover,
      bridge_exit_gate: isRecord(worklist.bridge_exit_gate) ? worklist.bridge_exit_gate : null,
      structural_prerequisites_observed: worklist.delete_or_keep_prerequisites_observed === true,
      owner_decision_required: worklist.owner_decision_required_after_prerequisites_observed === true,
      physical_delete_authorized: false,
    };
  });
  const structuralReadyCount = surfaces.filter((surface) => surface.structural_prerequisites_observed).length;
  const ownerDecisionObservedCount = surfaces.filter((surface) => surface.owner_decision_refs.length > 0).length;
  return {
    surface_kind: 'opl_active_legacy_caller_deletion_gate_readout',
    version: 'opl-active-legacy-caller-deletion-gate-readout.v1',
    owner: 'one-person-lab',
    status: surfaces.length === 0
      ? 'no_active_caller_targets'
      : structuralReadyCount === surfaces.length
        ? 'owner_decision_route_required'
        : 'deletion_gate_evidence_required',
    source_refs: [
      'generated_agent_interfaces.active_caller_target_proof',
      'generated_agent_interfaces.generated_direct_parity',
    ],
    required_before_physical_delete: [
      'replacement_parity',
      'no_active_caller_proof',
      'no_forbidden_write_proof',
      'tombstone_or_provenance_ref',
      'owner_delete_keep_or_typed_blocker_decision',
    ],
    static_retirement_prerequisite_gate_ids: [
      ...DEFAULT_CALLER_STATIC_RETIREMENT_PREREQUISITE_GATE_IDS,
    ],
    same_work_unit_live_evidence_scope: {
      ...DEFAULT_CALLER_SAME_WORK_UNIT_LIVE_EVIDENCE_SCOPE,
    },
    surface_count: surfaces.length,
    structural_prerequisites_observed_count: structuralReadyCount,
    owner_decision_observed_count: ownerDecisionObservedCount,
    missing_no_forbidden_write_count: surfaces.filter((surface) => surface.no_forbidden_write_refs.length === 0).length,
    missing_tombstone_or_provenance_count:
      surfaces.filter((surface) => surface.tombstone_or_provenance_refs.length === 0).length,
    next_required_owner_action: DEFAULT_CALLER_OWNER_DECISION_NEXT_REQUIRED_ACTION,
    accepted_refs_only_result_shapes: [
      ...DEFAULT_CALLER_OWNER_DECISION_ACCEPTED_RESULT_SHAPES,
    ],
    physical_delete_authorized: false,
    readout_can_authorize_domain_repo_physical_delete: false,
    surfaces,
  };
}
