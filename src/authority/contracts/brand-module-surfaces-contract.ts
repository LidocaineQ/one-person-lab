import type {
  BrandModuleNativeCliFamily,
  BrandModuleSurfacesContract,
  FoundryControlOperation,
} from '../../kernel/types.ts';
import {
  FrameworkContractError,
  expectBoolean,
  expectString,
  expectStringArray,
  isRecord,
} from '../../kernel/contract-validation.ts';
import {
  BRAND_MODULE_IDS,
  FOUNDRY_CONTROL_COMMANDS,
  FOUNDRY_CONTROL_OPERATIONS,
  STANDARD_BRAND_MODULE_CLI_OPERATIONS,
  expectAllowedStringArray,
  expectBrandModuleId,
  expectNonEmptyStringArray,
  requireEveryValue,
  validateBrandModuleAuthorityBoundary,
} from './brand-module-contracts.ts';

export function validateBrandModuleSurfaces(
  filePath: string,
  value: unknown,
): BrandModuleSurfacesContract {
  if (!isRecord(value)) {
    throw new FrameworkContractError(
      'contract_shape_invalid',
      'brand-module-surfaces.json must contain an object root.',
      { file: filePath },
    );
  }

  const modulesRaw = value.modules;
  const requiredSubcommands = expectNonEmptyStringArray(
    value.required_native_subcommands,
    'required_native_subcommands',
    filePath,
  );
  const foundryControlOperations = expectAllowedStringArray(
    value.foundry_control_operations,
    'foundry_control_operations',
    filePath,
    FOUNDRY_CONTROL_OPERATIONS,
  );
  requireEveryValue(
    foundryControlOperations,
    FOUNDRY_CONTROL_OPERATIONS,
    'foundry_control_operations',
    filePath,
  );
  const requiredGates = expectNonEmptyStringArray(value.required_gates, 'required_gates', filePath);
  for (const subcommand of STANDARD_BRAND_MODULE_CLI_OPERATIONS) {
    if (!requiredSubcommands.includes(subcommand)) {
      throw new FrameworkContractError('contract_shape_invalid', 'brand-module-surfaces.json must require every native module subcommand.', {
        file: filePath,
        field: 'required_native_subcommands',
        missing_subcommand: subcommand,
      });
    }
  }
  for (const gate of ['object_model', 'native_cli_family', 'app_read_model', 'descriptor_surface', 'validation', 'doctor', 'status', 'authority_boundary', 'forbidden_claims']) {
    if (!requiredGates.includes(gate)) {
      throw new FrameworkContractError('contract_shape_invalid', 'brand-module-surfaces.json must require every module surface gate.', {
        file: filePath,
        field: 'required_gates',
        missing_gate: gate,
      });
    }
  }

  if (!Array.isArray(modulesRaw)) {
    throw new FrameworkContractError(
      'contract_shape_invalid',
      'brand-module-surfaces.json must contain a modules array.',
      { file: filePath, field: 'modules' },
    );
  }

  const seen = new Set<string>();
  const modules = modulesRaw.map((entry, index) => {
    if (!isRecord(entry)) {
      throw new FrameworkContractError('contract_shape_invalid', 'Each brand module surface entry must be an object.', {
        file: filePath,
        index,
      });
    }

    const moduleId = expectBrandModuleId(entry.module_id, 'module_id', filePath);
    if (seen.has(moduleId)) {
      throw new FrameworkContractError('contract_shape_invalid', 'Each brand module surface id must be unique.', {
        file: filePath,
        index,
        module_id: moduleId,
      });
    }
    seen.add(moduleId);

    const prefix = expectString(entry.command_prefix, 'command_prefix', filePath);
    if (prefix !== moduleId) {
      throw new FrameworkContractError('contract_shape_invalid', 'command_prefix must match the module id.', {
        file: filePath,
        index,
        module_id: moduleId,
        command_prefix: prefix,
      });
    }

    const objectModel = entry.object_model;
    const nativeCliFamily = entry.native_cli_family;
    const appReadModel = entry.app_read_model;
    const descriptorSurface = entry.descriptor_surface;
    const validation = entry.validation;
    const doctor = entry.doctor;
    const status = entry.status;
    if (
      !isRecord(objectModel)
      || !isRecord(nativeCliFamily)
      || !isRecord(appReadModel)
      || !isRecord(descriptorSurface)
      || !isRecord(validation)
      || !isRecord(doctor)
      || !isRecord(status)
    ) {
      throw new FrameworkContractError('contract_shape_invalid', 'Each brand module surface entry must declare object_model, native_cli_family, app_read_model, descriptor_surface, validation, doctor, and status objects.', {
        file: filePath,
        index,
        module_id: moduleId,
      });
    }

    let nativeCommands: BrandModuleNativeCliFamily;
    if (moduleId === 'foundry') {
      if (!isRecord(nativeCliFamily.control_commands)) {
        throw new FrameworkContractError('contract_shape_invalid', 'Foundry native_cli_family must declare control_commands.', {
          file: filePath,
          index,
          module_id: moduleId,
          field: 'native_cli_family.control_commands',
        });
      }
      for (const legacyOperation of STANDARD_BRAND_MODULE_CLI_OPERATIONS) {
        if (legacyOperation !== 'status' && legacyOperation in nativeCliFamily) {
          throw new FrameworkContractError('contract_shape_invalid', 'Foundry must not expose the generic brand-module CLI family.', {
            file: filePath,
            index,
            module_id: moduleId,
            forbidden_operation: legacyOperation,
          });
        }
      }
      const controlCommands = {} as Record<FoundryControlOperation, string>;
      for (const operation of FOUNDRY_CONTROL_OPERATIONS) {
        const actualCommand = expectString(
          nativeCliFamily.control_commands[operation],
          `native_cli_family.control_commands.${operation}`,
          filePath,
        );
        const expectedCommand = FOUNDRY_CONTROL_COMMANDS[operation];
        if (actualCommand !== expectedCommand) {
          throw new FrameworkContractError('contract_shape_invalid', 'Foundry control command must match the dedicated operator ABI.', {
            file: filePath,
            index,
            module_id: moduleId,
            operation,
            expected_command: expectedCommand,
            actual_command: actualCommand,
          });
        }
        controlCommands[operation] = actualCommand;
      }
      nativeCommands = {
        control_commands: controlCommands,
        additional_commands: expectStringArray(nativeCliFamily.additional_commands, 'native_cli_family.additional_commands', filePath),
      };
    } else {
      const standardCommands = {
        status: expectString(nativeCliFamily.status, 'native_cli_family.status', filePath),
        inspect: expectString(nativeCliFamily.inspect, 'native_cli_family.inspect', filePath),
        interfaces: expectString(nativeCliFamily.interfaces, 'native_cli_family.interfaces', filePath),
        validate: expectString(nativeCliFamily.validate, 'native_cli_family.validate', filePath),
        doctor: expectString(nativeCliFamily.doctor, 'native_cli_family.doctor', filePath),
        additional_commands: expectStringArray(nativeCliFamily.additional_commands, 'native_cli_family.additional_commands', filePath),
      };
      for (const subcommand of STANDARD_BRAND_MODULE_CLI_OPERATIONS) {
        const expectedCommand = `opl ${moduleId} ${subcommand} --json`;
        if (standardCommands[subcommand] !== expectedCommand) {
          throw new FrameworkContractError('contract_shape_invalid', 'Native brand module command must match its module prefix and subcommand.', {
            file: filePath,
            index,
            module_id: moduleId,
            field: `native_cli_family.${subcommand}`,
            expected_command: expectedCommand,
          });
        }
      }
      nativeCommands = standardCommands;
    }

    const descriptorsRaw = appReadModel.descriptors;
    if (!Array.isArray(descriptorsRaw)) {
      throw new FrameworkContractError('contract_shape_invalid', 'app_read_model.descriptors must be an array.', {
        file: filePath,
        index,
        module_id: moduleId,
      });
    }
    const descriptors = descriptorsRaw.map((descriptor, descriptorIndex) => {
      if (!isRecord(descriptor)) {
        throw new FrameworkContractError('contract_shape_invalid', 'Each app descriptor must be an object.', {
          file: filePath,
          index,
          module_id: moduleId,
          descriptorIndex,
        });
      }
      return {
        action_id: expectString(descriptor.action_id, 'app_read_model.descriptors.action_id', filePath),
        command: expectString(descriptor.command, 'app_read_model.descriptors.command', filePath),
        mutation: expectBoolean(descriptor.mutation, 'app_read_model.descriptors.mutation', filePath),
        descriptor_only: expectBoolean(descriptor.descriptor_only, 'app_read_model.descriptors.descriptor_only', filePath),
      };
    });

    return {
      module_id: moduleId,
      brand_name: expectString(entry.brand_name, 'brand_name', filePath),
      command_prefix: prefix,
      surface_kind_prefix: expectString(entry.surface_kind_prefix, 'surface_kind_prefix', filePath),
      state: expectString(entry.state, 'state', filePath),
      module_doc_ref: expectString(entry.module_doc_ref, 'module_doc_ref', filePath),
      object_model: {
        primary_objects: expectNonEmptyStringArray(objectModel.primary_objects, 'object_model.primary_objects', filePath),
        canonical_contract_refs: expectNonEmptyStringArray(objectModel.canonical_contract_refs, 'object_model.canonical_contract_refs', filePath),
        read_model_refs: expectNonEmptyStringArray(objectModel.read_model_refs, 'object_model.read_model_refs', filePath),
      },
      native_cli_family: nativeCommands,
      app_read_model: {
        descriptors,
        projection_refs: expectNonEmptyStringArray(appReadModel.projection_refs, 'app_read_model.projection_refs', filePath),
      },
      descriptor_surface: {
        delegate_ids: expectNonEmptyStringArray(descriptorSurface.delegate_ids, 'descriptor_surface.delegate_ids', filePath),
        descriptor_refs: expectNonEmptyStringArray(descriptorSurface.descriptor_refs, 'descriptor_surface.descriptor_refs', filePath),
      },
      validation: {
        commands: expectNonEmptyStringArray(validation.commands, 'validation.commands', filePath),
        checks: expectNonEmptyStringArray(validation.checks, 'validation.checks', filePath),
        required_refs: expectNonEmptyStringArray(validation.required_refs, 'validation.required_refs', filePath),
      },
      doctor: {
        checks: expectNonEmptyStringArray(doctor.checks, 'doctor.checks', filePath),
        fail_closed_on: expectNonEmptyStringArray(doctor.fail_closed_on, 'doctor.fail_closed_on', filePath),
      },
      status: {
        completion_level: (() => {
          const completionLevel = expectString(status.completion_level, 'status.completion_level', filePath);
          if (completionLevel !== 'L4_structural_baseline') {
            throw new FrameworkContractError('contract_shape_invalid', 'status.completion_level must be L4_structural_baseline.', {
              file: filePath,
              index,
              module_id: moduleId,
              actual: completionLevel,
            });
          }
          return 'L4_structural_baseline' as const;
        })(),
        evidence_refs: expectNonEmptyStringArray(status.evidence_refs, 'status.evidence_refs', filePath),
        not_claims: expectNonEmptyStringArray(status.not_claims, 'status.not_claims', filePath),
      },
      authority_boundary: validateBrandModuleAuthorityBoundary(filePath, entry.authority_boundary),
      forbidden_claims: expectNonEmptyStringArray(entry.forbidden_claims, 'forbidden_claims', filePath),
      notes: expectString(entry.notes, 'notes', filePath),
    };
  });

  const missingModuleIds = BRAND_MODULE_IDS.filter((moduleId) => !seen.has(moduleId));
  if (missingModuleIds.length > 0 || seen.size !== BRAND_MODULE_IDS.length) {
    throw new FrameworkContractError('contract_shape_invalid', 'brand-module-surfaces.json must contain exactly the configured OPL brand modules.', {
      file: filePath,
      expected_module_ids: [...BRAND_MODULE_IDS],
      missing_module_ids: missingModuleIds,
      actual_module_ids: [...seen],
    });
  }

  return {
    version: expectString(value.version, 'version', filePath),
    scope: expectString(value.scope, 'scope', filePath),
    owner: expectString(value.owner, 'owner', filePath),
    purpose: expectString(value.purpose, 'purpose', filePath),
    state: expectString(value.state, 'state', filePath),
    machine_boundary: expectString(value.machine_boundary, 'machine_boundary', filePath),
    baseline_module_id: expectBrandModuleId(value.baseline_module_id, 'baseline_module_id', filePath),
    required_native_subcommands: requiredSubcommands,
    foundry_control_operations: foundryControlOperations,
    required_gates: requiredGates,
    modules,
  };
}
