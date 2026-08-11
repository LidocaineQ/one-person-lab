import type { PublicSurfaceIndexContract } from '../../../kernel/types.ts';
import {
  FrameworkContractError,
  expectBoolean,
  expectString,
  expectStringArray,
  isRecord,
} from '../../../kernel/contract-validation.ts';

function expectFalseBoolean(value: unknown, field: string, filePath: string) {
  if (value !== false) {
    throw new FrameworkContractError('contract_shape_invalid', `${field} must be false.`, { file: filePath, field });
  }
  return false as const;
}

function optionalStringField(value: Record<string, unknown>, field: string) {
  return typeof value[field] === 'string' ? { [field]: value[field] as string } : {};
}

function validateSurfaceBudget(filePath: string, value: unknown, index: number) {
  if (!isRecord(value)) {
    throw new FrameworkContractError('contract_shape_invalid', 'Each public surface must declare a surface_budget object.', {
      file: filePath, index, field: 'surface_budget',
    });
  }
  const promotionEvidence = value.promotion_evidence_refs;
  const authority = value.authority_boundary;
  if (!isRecord(promotionEvidence) || !isRecord(authority)) {
    throw new FrameworkContractError('contract_shape_invalid', 'surface_budget must declare promotion_evidence_refs and authority_boundary objects.', {
      file: filePath, index, field: 'surface_budget',
    });
  }
  return {
    default_surface: expectBoolean(value.default_surface, 'surface_budget.default_surface', filePath),
    default_surface_allowed_reasons: expectStringArray(value.default_surface_allowed_reasons, 'surface_budget.default_surface_allowed_reasons', filePath),
    promotion_evidence_refs: {
      ...optionalStringField(promotionEvidence, 'replaced_or_folded_surface_ref'),
      ...optionalStringField(promotionEvidence, 'retired_surface_ref'),
      ...optionalStringField(promotionEvidence, 'folded_into_attention_entry_ref'),
    },
    consumer_refs: expectStringArray(value.consumer_refs, 'surface_budget.consumer_refs', filePath),
    authority_boundary: {
      can_claim_domain_ready: expectFalseBoolean(authority.can_claim_domain_ready, 'can_claim_domain_ready', filePath),
      can_claim_quality_verdict: expectFalseBoolean(authority.can_claim_quality_verdict, 'can_claim_quality_verdict', filePath),
      can_claim_artifact_authority: expectFalseBoolean(authority.can_claim_artifact_authority, 'can_claim_artifact_authority', filePath),
      can_claim_production_ready: expectFalseBoolean(authority.can_claim_production_ready, 'can_claim_production_ready', filePath),
      can_replace_ai_executor_planning: expectFalseBoolean(authority.can_replace_ai_executor_planning, 'can_replace_ai_executor_planning', filePath),
      can_replace_domain_owner: expectFalseBoolean(authority.can_replace_domain_owner, 'can_replace_domain_owner', filePath),
    },
  };
}

export function validatePublicSurfaceIndex(
  filePath: string,
  value: unknown,
): PublicSurfaceIndexContract {
  if (!isRecord(value)) {
    throw new FrameworkContractError(
      'contract_shape_invalid',
      'public-surface-index.json must contain an object root.',
      { file: filePath },
    );
  }

  const categoriesRaw = value.surface_categories;
  if (!Array.isArray(categoriesRaw)) {
    throw new FrameworkContractError(
      'contract_shape_invalid',
      'public-surface-index.json must contain a surface_categories array.',
      { file: filePath, field: 'surface_categories' },
    );
  }

  const surfacesRaw = value.surfaces;
  if (!Array.isArray(surfacesRaw)) {
    throw new FrameworkContractError(
      'contract_shape_invalid',
      'public-surface-index.json must contain a surfaces array.',
      { file: filePath, field: 'surfaces' },
    );
  }

  return {
    version: expectString(value.version, 'version', filePath),
    scope: expectString(value.scope, 'scope', filePath),
    description: expectString(value.description, 'description', filePath),
    non_goals: expectStringArray(value.non_goals, 'non_goals', filePath),
    ownership_rules: expectStringArray(value.ownership_rules, 'ownership_rules', filePath),
    surface_categories: categoriesRaw.map((entry, index) => {
      if (!isRecord(entry)) {
        throw new FrameworkContractError(
          'contract_shape_invalid',
          'Each public surface category entry must be an object.',
          { file: filePath, index },
        );
      }
      return {
        category_id: expectString(entry.category_id, 'category_id', filePath),
        owner_scope: expectString(entry.owner_scope, 'owner_scope', filePath),
        description: expectString(entry.description, 'description', filePath),
      };
    }),
    surfaces: surfacesRaw.map((entry, index) => {
      if (!isRecord(entry)) {
        throw new FrameworkContractError(
          'contract_shape_invalid',
          'Each public surface entry must be an object.',
          { file: filePath, index },
        );
      }

      const refsRaw = entry.refs;
      if (!Array.isArray(refsRaw)) {
        throw new FrameworkContractError(
          'contract_shape_invalid',
          'refs must be an array.',
          { file: filePath, index, field: 'refs' },
        );
      }

      return {
        surface_id: expectString(entry.surface_id, 'surface_id', filePath),
        category_id: expectString(entry.category_id, 'category_id', filePath),
        surface_kind: expectString(entry.surface_kind, 'surface_kind', filePath),
        boundary_role: expectString(entry.boundary_role, 'boundary_role', filePath),
        owner_scope: expectString(entry.owner_scope, 'owner_scope', filePath),
        truth_mode: expectString(entry.truth_mode, 'truth_mode', filePath),
        workstream_ids: expectStringArray(entry.workstream_ids, 'workstream_ids', filePath),
        domain_ids: expectStringArray(entry.domain_ids, 'domain_ids', filePath),
        refs: refsRaw.map((ref, refIndex) => {
          if (!isRecord(ref)) {
            throw new FrameworkContractError(
              'contract_shape_invalid',
              'Each public surface ref must be an object.',
              { file: filePath, index, refIndex },
            );
          }
          if (ref.language !== undefined && typeof ref.language !== 'string') {
            throw new FrameworkContractError(
              'contract_shape_invalid',
              'Ref field "language" must be a string when provided.',
              { file: filePath, index, refIndex, field: 'language' },
            );
          }
          return {
            ref_kind: expectString(ref.ref_kind, 'ref_kind', filePath),
            ref: expectString(ref.ref, 'ref', filePath),
            ...(typeof ref.language === 'string' ? { language: ref.language } : {}),
          };
        }),
        routes_to: expectStringArray(entry.routes_to, 'routes_to', filePath),
        notes: expectStringArray(entry.notes, 'notes', filePath),
        surface_budget: validateSurfaceBudget(filePath, entry.surface_budget, index),
      };
    }),
  };
}
