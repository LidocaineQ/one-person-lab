import fs from 'node:fs';
import path from 'node:path';

import { canonicalJsonText } from '../../../kernel/canonical-json.ts';
import { isRecord } from '../../../kernel/contract-validation.ts';
import {
  type DomainHandlerRegistry,
  type FamilyActionCatalogAction,
} from '../../../kernel/family-action-catalog-contract.ts';
import { parseJsonText } from '../../../kernel/json-file.ts';
import { type StandardAgentActionRuntimeInput } from './types.ts';
import { fail, sha256 } from './shared.ts';
import {
  DOMAIN_ARTIFACT_CAS_CAPABILITY_ID,
} from '../domain-artifact-cas-materialization.ts';

export const INTERNAL_STANDARD_AGENT_ACTION_INVOCATION = Symbol('internal_standard_agent_action_invocation');
export const QUALIFICATION_PROVISIONING_INVOCATION = Symbol('qualification_provisioning_invocation');
export const QUALIFICATION_PROVISIONING_ACTION_ID =
  'qualification_work_item_provisioning_authority_evaluate' as const;

export function assertStandardAgentActionInvocationSurface(
  action: FamilyActionCatalogAction,
  invocationContext?: symbol,
  registry?: DomainHandlerRegistry | null,
) {
  const internalOnly = Object.values(action.supported_surfaces).every((surface) => surface === null);
  if (invocationContext === QUALIFICATION_PROVISIONING_INVOCATION) {
    assertQualificationProvisioningAction(action, registry ?? null);
    return;
  }
  if (internalOnly && invocationContext !== INTERNAL_STANDARD_AGENT_ACTION_INVOCATION) {
    fail('Internal-only Standard Agent action cannot be invoked from an external runtime surface.', {
      failure_code: 'standard_agent_internal_action_external_invocation_forbidden',
      action_id: action.action_id,
      supported_surfaces: action.supported_surfaces,
    });
  }
}

function assertQualificationProvisioningAction(
  action: FamilyActionCatalogAction,
  registry: DomainHandlerRegistry | null,
) {
  const boundary = action.authority_boundary;
  const host = isRecord(boundary?.host_materialization_contract)
    ? boundary.host_materialization_contract
    : null;
  const handler = registry?.handlers.find((entry) => (
    action.execution_binding.kind === 'handler_ref'
    && `handler:${entry.handler_id}` === action.execution_binding.handler_ref
  ));
  const requiredFields = [
    'surface_kind',
    'schema_version',
    'authority_context',
    'qualification_authority',
    'current_workspace_index',
  ];
  if (
    action.action_id !== QUALIFICATION_PROVISIONING_ACTION_ID
    || action.effect !== 'read_only'
    || action.execution_binding.kind !== 'handler_ref'
    || action.execution_binding.handler_ref
      !== 'handler:mas.qualification-work-item-provisioning-authority-evaluate'
    || action.execution_scope?.kind !== 'none'
    || Object.values(action.supported_surfaces).some((surface) => surface !== null)
    || JSON.stringify([...action.required_fields].sort()) !== JSON.stringify([...requiredFields].sort())
    || action.optional_fields.length !== 0
    || action.workspace_locator_fields.length !== 0
    || !boundary
    || boundary.qualification_only !== true
    || boundary.public_action !== false
    || boundary.opl_can_derive_or_choose_study_id !== false
    || boundary.opl_can_write_domain_truth_without_exact_mas_authorization !== false
    || boundary.opl_can_sign_owner_receipt !== false
    || boundary.authorizes_stage_body !== false
    || boundary.authorizes_business_action !== false
    || boundary.authorizes_publication !== false
    || boundary.authorizes_submission !== false
    || !host
    || host.capability_id !== DOMAIN_ARTIFACT_CAS_CAPABILITY_ID
    || host.request_output_field !== 'opl_host_materialization_request'
    || host.authorization_output_field !== 'mas_qualification_work_item_cas_mutation_authorization'
    || host.receipt_output_field !== 'provisioning_receipt'
    || host.receipt_content_binding_output_field !== 'provisioning_receipt_content_binding'
    || host.materialization_scope_sha256_field !== 'materialization_scope_sha256'
    || host.absent_relative_path_preconditions_field !== 'absent_relative_path_preconditions'
    || handler?.binding.kind !== 'python_callable'
    || handler.binding.module
      !== 'med_autoscience.authority_handlers.qualification_work_item_provisioning'
    || handler.binding.callable !== 'evaluate_qualification_work_item_provisioning_authority'
  ) {
    fail('Qualification provisioning requires the exact internal MAS authority and receipt-bound CAS contract.', {
      failure_code: 'qualification_provisioning_contract_mismatch',
      action_id: action.action_id,
    });
  }
}

function qualificationProvisioningMismatch(message: string, details: Record<string, unknown> = {}): never {
  fail(message, { failure_code: 'qualification_provisioning_contract_mismatch', ...details });
}

function qualificationObject(value: unknown, label: string) {
  if (!isRecord(value)) qualificationProvisioningMismatch(`${label} must be an object.`);
  return value;
}

function qualificationRecord(value: unknown, label: string, fields: readonly string[]) {
  const record = qualificationObject(value, label);
  const actual = Object.keys(record).sort();
  const expected = [...fields].sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    qualificationProvisioningMismatch(`${label} must use its exact closed shape.`, {
      actual_fields: actual,
      expected_fields: expected,
    });
  }
  return record;
}

function qualificationText(value: unknown, label: string) {
  if (typeof value !== 'string' || !value.trim() || value !== value.trim()) {
    qualificationProvisioningMismatch(`${label} must be an exact non-empty string.`);
  }
  return value;
}

function qualificationDigest(value: unknown, label: string) {
  const text = qualificationText(value, label);
  const match = /^(?:sha256:)?([a-f0-9]{64})$/u.exec(text);
  if (!match) qualificationProvisioningMismatch(`${label} must be a SHA-256 digest.`);
  return match[1]!;
}

function qualificationBytes(value: unknown, label: string) {
  const encoded = qualificationText(value, label);
  const bytes = Buffer.from(encoded, 'base64');
  if (bytes.toString('base64') !== encoded) {
    qualificationProvisioningMismatch(`${label} must be canonical base64.`);
  }
  return bytes;
}

export function assertQualificationProvisioningOutput(input: {
  workspaceRoot: string;
  requestPayload: Record<string, unknown>;
  output: unknown;
}) {
  const output = qualificationObject(input.output, 'qualification provisioning result');
  if (output.status !== 'authorized') return;
  if (
    output.surface_kind !== 'mas_qualification_work_item_provisioning_authority_result'
    || output.schema_version !== 1
    || output.typed_blocker !== null
    || output.error !== null
  ) qualificationProvisioningMismatch('Authorized qualification provisioning result has invalid identity or status fields.');

  const authority = qualificationRecord(
    input.requestPayload.qualification_authority,
    'qualification_authority',
    ['authority_sha256', 'authority_bytes_base64', 'authority_byte_size', 'record'],
  );
  const authorityRecord = qualificationRecord(authority.record, 'qualification_authority.record', [
    'surface_kind',
    'schema_version',
    'authority_ref',
    'domain_owner',
    'domain_id',
    'canonical_workspace_root',
    'qualification_scope',
    'issued_at',
    'single_use',
    'qualification_only',
    'provisions_work_item',
    'authorizes_stage_body',
    'authorizes_business_action',
    'authorizes_publication',
    'authorizes_submission',
    'provider_completion_is_domain_completion',
  ]);
  const authorityBytes = qualificationBytes(authority.authority_bytes_base64, 'qualification_authority.authority_bytes_base64');
  const authoritySha256 = qualificationDigest(authority.authority_sha256, 'qualification_authority.authority_sha256');
  let parsedAuthority: unknown;
  try {
    parsedAuthority = parseJsonText(new TextDecoder('utf-8', { fatal: true }).decode(authorityBytes));
  } catch {
    qualificationProvisioningMismatch('Qualification authority bytes must be strict UTF-8 JSON.');
  }
  const canonicalWorkspaceRoot = path.resolve(input.workspaceRoot);
  if (
    sha256(authorityBytes) !== authoritySha256
    || authority.authority_byte_size !== authorityBytes.byteLength
    || canonicalJsonText(parsedAuthority) !== canonicalJsonText(authorityRecord)
    || authorityRecord.surface_kind !== 'mas_qualification_work_item_provisioning_authority'
    || authorityRecord.schema_version !== 1
    || authorityRecord.domain_owner !== 'MedAutoScience'
    || authorityRecord.domain_id !== 'medautoscience'
    || authorityRecord.canonical_workspace_root !== canonicalWorkspaceRoot
    || authorityRecord.qualification_scope !== 'standard_agent_full_vm_qualification'
    || authorityRecord.single_use !== true
    || authorityRecord.qualification_only !== true
    || authorityRecord.provisions_work_item !== true
    || authorityRecord.authorizes_stage_body !== false
    || authorityRecord.authorizes_business_action !== false
    || authorityRecord.authorizes_publication !== false
    || authorityRecord.authorizes_submission !== false
    || authorityRecord.provider_completion_is_domain_completion !== false
  ) qualificationProvisioningMismatch('Qualification authority exact bytes or qualification-only boundary do not match the host request.');

  const identity = qualificationObject(output.study_identity, 'study_identity');
  const studyId = qualificationText(identity.study_id, 'study_identity.study_id');
  const studyRoot = `studies/${studyId}`;
  if (identity.canonical_study_root !== studyRoot) {
    qualificationProvisioningMismatch('Study identity root does not bind its MAS-provided study_id.');
  }
  const lifecyclePath = `${studyRoot}/control/lifecycle.json`;
  const receiptPath = `${studyRoot}/artifacts/controller/qualification/provisioning-receipt.json`;
  const receipt = qualificationObject(output.provisioning_receipt, 'provisioning_receipt');
  const authorityRef = qualificationText(authorityRecord.authority_ref, 'qualification_authority.record.authority_ref');
  const receiptFingerprint = qualificationText(receipt.receipt_fingerprint, 'provisioning_receipt.receipt_fingerprint');
  const fingerprint = qualificationDigest(receiptFingerprint, 'provisioning_receipt.receipt_fingerprint');
  if (
    receipt.surface_kind !== 'mas_qualification_work_item_provisioning_receipt'
    || receipt.schema_version !== 1
    || receipt.domain_owner !== 'MedAutoScience'
    || receipt.domain_id !== 'medautoscience'
    || receipt.canonical_workspace_root !== canonicalWorkspaceRoot
    || receipt.study_id !== studyId
    || receipt.canonical_study_root !== studyRoot
    || receipt.lifecycle_state !== 'active'
    || receipt.lifecycle_generation !== 1
    || receipt.qualification_scope !== 'standard_agent_full_vm_qualification'
    || receipt.qualification_authority_ref !== authorityRef
    || qualificationDigest(receipt.qualification_authority_sha256, 'provisioning_receipt.qualification_authority_sha256') !== authoritySha256
    || receipt.qualification_authority_byte_size !== authorityBytes.byteLength
    || receipt.workspace_index_ref !== 'workspace_index.json'
    || receipt.lifecycle_relative_path !== lifecyclePath
    || receipt.receipt_relative_path !== receiptPath
    || receipt.single_use !== true
    || receipt.qualification_only !== true
    || receipt.stage_body_authorized !== false
    || receipt.business_action_authorized !== false
    || receipt.publication_authorized !== false
    || receipt.submission_authorized !== false
    || receipt.requires_opl_cas_materialization_receipt !== true
    || receipt.materialization_semantics !== 'journaled_all_or_rollback'
    || receipt.provider_completion_is_domain_completion !== false
    || receipt.receipt_ref !== `mas-qualification-work-item-provisioning:${fingerprint}`
  ) qualificationProvisioningMismatch('MAS provisioning receipt does not preserve its exact identity and qualification-only boundary.');
  qualificationText(receipt.handler_call_ref, 'provisioning_receipt.handler_call_ref');
  qualificationText(receipt.owner_ledger_ref, 'provisioning_receipt.owner_ledger_ref');
  qualificationText(receipt.issued_at, 'provisioning_receipt.issued_at');
  if (receipt.workspace_index_before_sha256 !== null) {
    qualificationDigest(receipt.workspace_index_before_sha256, 'provisioning_receipt.workspace_index_before_sha256');
  }

  const binding = qualificationObject(
    output.provisioning_receipt_content_binding,
    'provisioning_receipt_content_binding',
  );
  const authorization = qualificationObject(
    output.mas_qualification_work_item_cas_mutation_authorization,
    'mas_qualification_work_item_cas_mutation_authorization',
  );
  const request = qualificationRecord(output.opl_host_materialization_request, 'opl_host_materialization_request', [
    'surface_kind', 'version', 'capability_id', 'request_id', 'domain_id', 'authorization_ref',
    'operations_sha256', 'materialization_scope_sha256', 'absent_relative_path_preconditions', 'operations',
  ]);
  const operations = Array.isArray(request.operations) ? request.operations : [];
  const expectedPaths = ['workspace_index.json', lifecyclePath, receiptPath];
  if (
    authorization.surface_kind !== 'mas_qualification_work_item_cas_mutation_authorization'
    || authorization.version !== 'mas-qualification-work-item-cas-mutation-authorization.v1'
    || authorization.authorized !== true
    || authorization.authority_receipt_ref !== receipt.receipt_ref
    || request.surface_kind !== 'opl_domain_artifact_cas_materialization_request'
    || request.version !== 'opl-domain-artifact-cas-materialization.v1'
    || request.capability_id !== DOMAIN_ARTIFACT_CAS_CAPABILITY_ID
    || authorization.capability_id !== DOMAIN_ARTIFACT_CAS_CAPABILITY_ID
    || request.domain_id !== 'medautoscience'
    || authorization.domain_id !== 'medautoscience'
    || request.request_id !== authorization.request_id
    || request.authorization_ref !== authorization.authorization_ref
    || request.operations_sha256 !== authorization.operations_sha256
    || request.materialization_scope_sha256 !== authorization.materialization_scope_sha256
    || canonicalJsonText(request.absent_relative_path_preconditions)
      !== canonicalJsonText(authorization.absent_relative_path_preconditions)
    || operations.length !== 3
    || canonicalJsonText(operations.map((operation) => isRecord(operation) ? operation.target_relative_path : null))
      !== canonicalJsonText(expectedPaths)
  ) qualificationProvisioningMismatch('MAS authorization and host request do not bind the exact three-path provisioning transaction.');
  const preparedOperations = operations.map((operation, index) => (
    qualificationRecord(operation, `opl_host_materialization_request.operations[${index}]`, [
      'target_relative_path', 'precondition', 'replacement_bytes_base64', 'replacement_sha256',
      'replacement_byte_size',
    ])
  ));
  const preconditions = preparedOperations.map((operation, index) => (
    qualificationRecord(
      operation.precondition,
      `opl_host_materialization_request.operations[${index}].precondition`,
      index === 0 && isRecord(operation.precondition) && operation.precondition.kind === 'existing_exact'
        ? ['kind', 'sha256', 'byte_size']
        : ['kind'],
    )
  ));
  if (
    !['absent', 'existing_exact'].includes(String(preconditions[0]!.kind))
    || preconditions[1]!.kind !== 'absent'
    || preconditions[2]!.kind !== 'absent'
    || qualificationDigest(preparedOperations[0]!.replacement_sha256, 'workspace index replacement_sha256')
      !== qualificationDigest(receipt.workspace_index_after_sha256, 'provisioning_receipt.workspace_index_after_sha256')
    || qualificationDigest(preparedOperations[1]!.replacement_sha256, 'lifecycle replacement_sha256')
      !== qualificationDigest(receipt.lifecycle_sha256, 'provisioning_receipt.lifecycle_sha256')
    || binding.surface_kind !== 'mas_qualification_work_item_provisioning_receipt_content_binding'
    || binding.schema_version !== 1
    || binding.receipt_ref !== receipt.receipt_ref
    || binding.target_relative_path !== receiptPath
    || qualificationDigest(binding.sha256, 'provisioning_receipt_content_binding.sha256')
      !== qualificationDigest(preparedOperations[2]!.replacement_sha256, 'receipt replacement_sha256')
    || binding.byte_size !== preparedOperations[2]!.replacement_byte_size
  ) qualificationProvisioningMismatch('Provisioning receipt and exact CAS operation bindings do not match.');
}

export function qualificationProvisioningPayload(
  input: StandardAgentActionRuntimeInput,
  workspaceRoot: string,
) {
  if (input.actionId !== QUALIFICATION_PROVISIONING_ACTION_ID) return input.payload;
  const workspaceIndexPath = path.join(workspaceRoot, 'workspace_index.json');
  let currentWorkspaceIndex: Record<string, unknown>;
  try {
    const stat = fs.lstatSync(workspaceIndexPath);
    if (stat.isSymbolicLink() || !stat.isFile()) {
      fail('Qualification provisioning workspace index must be a physical file.', {
        failure_code: 'qualification_provisioning_workspace_index_invalid',
        workspace_index_path: workspaceIndexPath,
      });
    }
    const bytes = fs.readFileSync(workspaceIndexPath);
    const record = parseJsonText(bytes.toString('utf8'));
    if (!isRecord(record)) {
      fail('Qualification provisioning workspace index must contain a JSON object.', {
        failure_code: 'qualification_provisioning_workspace_index_invalid',
        workspace_index_path: workspaceIndexPath,
      });
    }
    currentWorkspaceIndex = {
      exists: true,
      workspace_index_ref: 'workspace_index.json',
      workspace_index_sha256: sha256(bytes),
      workspace_index_bytes_base64: bytes.toString('base64'),
      workspace_index_byte_size: bytes.byteLength,
      record,
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    currentWorkspaceIndex = {
      exists: false,
      workspace_index_ref: 'workspace_index.json',
      workspace_index_sha256: null,
      workspace_index_bytes_base64: null,
      workspace_index_byte_size: null,
      record: null,
    };
  }
  return {
    ...input.payload,
    current_workspace_index: currentWorkspaceIndex,
  };
}
