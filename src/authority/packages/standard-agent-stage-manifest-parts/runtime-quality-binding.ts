import path from 'node:path';

import { isRecord } from '../../../kernel/contract-validation.ts';
import { optionalString } from '../../../kernel/json-file.ts';
import type { FamilyStageControlPlane } from '../../stages/index.ts';
import {
  STANDARD_AGENT_STAGE_MANIFEST_REF,
} from '../standard-agent-stage-prompt.ts';
import {
  fail,
  readJsonPointer,
  record,
  text,
} from './repo-validation.ts';
import {
  reviewLaneBinding,
  validateStageQualityCyclePolicy,
} from './stage-quality-validation.ts';
import { compileStandardAgentStageManifest } from './manifest-compiler.ts';
import type {
  StandardAgentHandoffReviewBoundary,
  StandardAgentStageQualityRuntimeBinding,
} from './types.ts';

function stageLineageRefs(stage: FamilyStageControlPlane['stages'][number]) {
  return [...new Set([
    ...stage.domain_stage_refs,
    ...(stage.source_pattern_ref ? [stage.source_pattern_ref] : []),
    ...(stage.target_only_requirement_ref ? [stage.target_only_requirement_ref] : []),
    ...(stage.source_anchor_refs ?? []),
    ...(stage.stage_pattern_source_refs ?? []),
  ])];
}

export function resolveStandardAgentStageQualityRuntimeBinding(
  repoDirInput: string,
  stageIdInput: string,
): StandardAgentStageQualityRuntimeBinding | null {
  const repoDir = path.resolve(repoDirInput);
  const stageId = text(stageIdInput, 'stage_id', repoDir);
  const compilation = compileStandardAgentStageManifest(repoDir);
  const stageIndex = compilation.stage_control_plane.stages.findIndex((stage) => stage.stage_id === stageId);
  if (stageIndex === -1) {
    fail('Stage quality runtime binding requires a declared Stage.', {
      repo_dir: repoDir,
      stage_id: stageId,
      stage_manifest_ref: compilation.source_binding.stage_manifest_ref,
    });
  }
  const stage = compilation.stage_control_plane.stages[stageIndex]!;
  const policyRef = optionalString(stage.stage_quality_cycle_policy_ref);
  if (!policyRef) return null;
  const stagePromptRef = optionalString(stage.prompt_refs[0]?.ref);
  if (!stagePromptRef) {
    fail('Stage quality runtime binding requires the compiled Stage prompt ref.', {
      repo_dir: repoDir,
      stage_id: stageId,
    });
  }
  const policy = validateStageQualityCyclePolicy({
    repoDir,
    ref: policyRef,
    stageId,
    stagePromptRef,
    stageRole: optionalString(stage.stage_role),
    handoffReviewBoundary: isRecord(stage.handoff?.review_boundary)
      ? stage.handoff.review_boundary as StandardAgentHandoffReviewBoundary
      : null,
  });
  const metaReviewPolicyRef = compilation.stage_control_plane.meta_review_policy_ref;
  const metaReviewPolicy = metaReviewPolicyRef
    ? record(
        readJsonPointer(repoDir, metaReviewPolicyRef, `meta_review_policy:${stageId}`),
        `meta_review_policy:${stageId}`,
        repoDir,
      )
    : null;
  const maxRouteBackRounds = metaReviewPolicy?.max_route_back_rounds;
  if (
    metaReviewPolicy
    && (!Number.isInteger(maxRouteBackRounds) || Number(maxRouteBackRounds) < 0 || Number(maxRouteBackRounds) > 3)
  ) {
    fail('Meta Review route-back budget must be an integer between zero and three.', {
      repo_dir: repoDir,
      stage_id: stageId,
      max_route_back_rounds: maxRouteBackRounds,
    });
  }
  const routeBudget = metaReviewPolicy
    ? { max_route_back_rounds: Number(maxRouteBackRounds), route_back_rounds_used: 0 }
    : null;
  const officialAiStage = Boolean(compilation.stage_control_plane.quality_governance_profile_ref)
    && stage.trust_boundary?.lane !== 'human_gate';
  if (officialAiStage && !policy.enabled) {
    fail('Official knowledge-deliverable AI stages must enable their Stage quality cycle.', {
      repo_dir: repoDir,
      stage_id: stageId,
      stage_quality_cycle_policy_ref: policyRef,
    });
  }
  return {
    surface_kind: 'opl_pack_bound_stage_quality_runtime_binding',
    version: 'opl-pack-bound-stage-quality-runtime-binding.v1',
    stage_id: stage.stage_id,
    declared_stage_ids: compilation.stage_control_plane.stages.map((entry) => entry.stage_id),
    enabled: policy.enabled,
    stage_role: optionalString(stage.stage_role),
    policy_ref: policyRef,
    stage_prompt_ref: policy.stage_prompt_ref,
    quality_policy: policy.quality_policy,
    route_budget: routeBudget,
    handoff_review_boundary: policy.handoff_review_boundary,
    review_lane_binding: reviewLaneBinding(stage.stage_contract, repoDir),
    role_prompt_refs: policy.role_prompt_refs,
    quality_rubric_refs: policy.quality_rubric_refs,
    stage_goal_refs: [`${compilation.source_binding.stage_manifest_ref}#/stages/${stageIndex}/goal`],
    source_refs: stage.source_refs.flatMap((source) =>
      Array.isArray(source.ref) ? source.ref : [source.ref]
    ),
    lineage_refs: stageLineageRefs(stage),
    manifest_ref: STANDARD_AGENT_STAGE_MANIFEST_REF,
    manifest_sha256: compilation.source_binding.stage_manifest_sha256,
  };
}
