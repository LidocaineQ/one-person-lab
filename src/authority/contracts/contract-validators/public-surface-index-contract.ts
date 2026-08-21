import type { PublicSurfaceIndexContract } from '../../../kernel/types.ts';
import {
  FrameworkContractError,
  expectString,
  expectStringArray,
  isRecord,
} from '../../../kernel/contract-validation.ts';

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
      };
    }),
  };
}
