import type { TargetOperatingArchitectureContract } from '../../kernel/types.ts';
import {
  FrameworkContractError,
  expectString,
  isRecord,
} from '../../kernel/contract-validation.ts';
import {
  expectNonEmptyStringArray,
  requireEveryValue,
} from './brand-module-contracts.ts';
import {
  TARGET_ARCHITECTURE_EXPERIENCE_AXIS_IDS,
  expectBrandModuleIdArray,
  validateFalseBoundaryRecord,
} from './target-operating-architecture-shared.ts';

export function validateTargetOperatingArchitectureExperienceModel(
  filePath: string,
  value: unknown,
): TargetOperatingArchitectureContract['experience_operating_model'] {
  if (!isRecord(value)) {
    throw new FrameworkContractError(
      'contract_shape_invalid',
      'target-operating-architecture-contract.json must declare experience_operating_model.',
      { file: filePath, field: 'experience_operating_model' },
    );
  }
  const modelId = expectString(value.model_id, 'experience_operating_model.model_id', filePath);
  if (modelId !== 'opl_family_ideal_experience_operating_model.v1') {
    throw new FrameworkContractError('contract_shape_invalid', 'experience_operating_model.model_id must be canonical.', {
      file: filePath,
      field: 'experience_operating_model.model_id',
      actual: modelId,
    });
  }
  const defaultUserPathRaw = value.default_user_path;
  const targetAxesRaw = value.target_axes;
  if (!isRecord(defaultUserPathRaw) || !Array.isArray(targetAxesRaw)) {
    throw new FrameworkContractError(
      'contract_shape_invalid',
      'experience_operating_model must declare default_user_path and target_axes.',
      { file: filePath, field: 'experience_operating_model' },
    );
  }
  const seenAxisIds = new Set<string>();
  const targetAxes = targetAxesRaw.map((axis, index) => {
    if (!isRecord(axis)) {
      throw new FrameworkContractError('contract_shape_invalid', 'Each experience target axis must be an object.', {
        file: filePath,
        index,
      });
    }
    const axisId = expectString(axis.axis_id, 'experience_operating_model.target_axes.axis_id', filePath);
    if (!TARGET_ARCHITECTURE_EXPERIENCE_AXIS_IDS.includes(axisId as typeof TARGET_ARCHITECTURE_EXPERIENCE_AXIS_IDS[number])) {
      throw new FrameworkContractError('contract_shape_invalid', 'experience_operating_model.target_axes.axis_id must be known.', {
        file: filePath,
        index,
        axis_id: axisId,
        allowed: [...TARGET_ARCHITECTURE_EXPERIENCE_AXIS_IDS],
      });
    }
    if (seenAxisIds.has(axisId)) {
      throw new FrameworkContractError('contract_shape_invalid', 'experience_operating_model target axes must be unique.', {
        file: filePath,
        index,
        axis_id: axisId,
      });
    }
    seenAxisIds.add(axisId);
    return {
      axis_id: axisId as TargetOperatingArchitectureContract['experience_operating_model']['target_axes'][number]['axis_id'],
      owner_modules: expectBrandModuleIdArray(
        axis.owner_modules,
        'experience_operating_model.target_axes.owner_modules',
        filePath,
      ),
      success_policy: expectString(
        axis.success_policy,
        'experience_operating_model.target_axes.success_policy',
        filePath,
      ),
      machine_checks: expectNonEmptyStringArray(
        axis.machine_checks,
        'experience_operating_model.target_axes.machine_checks',
        filePath,
      ),
      forbidden_regressions: expectNonEmptyStringArray(
        axis.forbidden_regressions,
        'experience_operating_model.target_axes.forbidden_regressions',
        filePath,
      ),
    };
  });
  requireEveryValue(
    [...seenAxisIds],
    TARGET_ARCHITECTURE_EXPERIENCE_AXIS_IDS,
    'experience_operating_model.target_axes.axis_id',
    filePath,
  );

  return {
    model_id: modelId,
    purpose: expectString(value.purpose, 'experience_operating_model.purpose', filePath),
    default_user_path: {
      planning_root: expectString(
        defaultUserPathRaw.planning_root,
        'experience_operating_model.default_user_path.planning_root',
        filePath,
      ),
      first_screen_policy: expectString(
        defaultUserPathRaw.first_screen_policy,
        'experience_operating_model.default_user_path.first_screen_policy',
        filePath,
      ),
      primary_read_surface: expectString(
        defaultUserPathRaw.primary_read_surface,
        'experience_operating_model.default_user_path.primary_read_surface',
        filePath,
      ),
      drilldown_policy: expectString(
        defaultUserPathRaw.drilldown_policy,
        'experience_operating_model.default_user_path.drilldown_policy',
        filePath,
      ),
    },
    target_axes: targetAxes,
    authority_boundary: validateFalseBoundaryRecord(
      filePath,
      value.authority_boundary,
      'experience_operating_model.authority_boundary',
    ),
    forbidden_claims: expectNonEmptyStringArray(
      value.forbidden_claims,
      'experience_operating_model.forbidden_claims',
      filePath,
    ),
  };
}
