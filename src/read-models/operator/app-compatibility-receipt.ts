import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { satisfies, valid, validRange } from 'semver';

import { FrameworkContractError } from '../../kernel/contract-validation.ts';
import { parseJsonText } from '../../kernel/json-file.ts';
import compatibilityContract from '../../../contracts/opl-framework/app-component-compatibility-receipt-contract.json' with { type: 'json' };
import frameworkPackage from '../../../package.json' with { type: 'json' };

type JsonRecord = Record<string, unknown>;

type CompatibilityRequirement = {
  requirement_id: string;
  component_id: string;
  kind: 'capability_id_with_versioned_schema' | 'minimum_version' | 'semver_range';
  capability_id?: string;
  schema_range?: string;
  version_requirement?: string;
};

type ObservedCapability = {
  capability_id: string;
  schema_version: string;
};

type ObservedComponent = {
  component_id: string;
  owner_authority: string;
  version: string;
  observation_ref: string;
  capabilities: ObservedCapability[];
};

type ParsedJsonSource = {
  path: string;
  sha256: string;
  value: JsonRecord;
};

type ReceiptClock = {
  now?: () => Date;
  producerEntrypointFile?: string;
};

export type AppCompatibilityReceiptOptions = {
  requirementsFile: string;
  subjectFile: string;
  outputFile: string;
  ttlSeconds?: number;
};

const CONTRACT_REF =
  'contracts/app-install-exposure-policy.json#component_interoperability.compatibility_admission';
const PRODUCER_CONTRACT_REF =
  'contracts/opl-framework/app-component-compatibility-receipt-contract.json';
const RECEIPT_SCHEMA = 'opl_component_compatibility_receipt.v1';
const REQUIREMENTS_SCHEMA = 'opl_component_compatibility_requirements.v1';
const SUBJECT_SCHEMA = 'opl_app_compatibility_subject.v1';
const COMMAND_ID = 'app compatibility receipt';
const DIGEST_PATTERN = /^(?:sha256:)?([0-9a-f]{64})$/;
const MIN_TTL_SECONDS = 60;
const MAX_TTL_SECONDS = 86_400;
const FRAMEWORK_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const FRAMEWORK_PACKAGE_FILE = path.join(FRAMEWORK_ROOT, 'package.json');
const SEMVER_OPTIONS = {
  includePrerelease: false,
  loose: false,
} as const;

function fail(message: string, failureCode: string, details: JsonRecord = {}): never {
  throw new FrameworkContractError('contract_shape_invalid', message, {
    failure_code: failureCode,
    ...details,
  });
}

function record(value: unknown, label: string): JsonRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    fail(`${label} must be an object.`, 'component_compatibility_input_invalid', { label });
  }
  return value as JsonRecord;
}

function nonEmptyString(value: unknown, label: string) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    fail(`${label} must be a non-empty string.`, 'component_compatibility_input_invalid', { label });
  }
  return value.trim();
}

function stringArray(value: unknown, label: string) {
  if (!Array.isArray(value)) {
    fail(`${label} must be an array.`, 'component_compatibility_input_invalid', { label });
  }
  return value;
}

function sha256Bytes(bytes: Buffer | string) {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

function normalizedSha256(value: unknown, label: string) {
  const text = nonEmptyString(value, label).toLowerCase();
  const match = text.match(DIGEST_PATTERN);
  if (!match) {
    fail(`${label} must be a SHA-256 digest.`, 'component_compatibility_digest_invalid', { label });
  }
  return `sha256:${match[1]}`;
}

function readRegularFile(filePath: string, label: string) {
  const resolved = path.resolve(filePath);
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(resolved);
  } catch {
    fail(`${label} is missing.`, 'component_compatibility_evidence_missing', {
      label,
      path: resolved,
    });
  }
  if (stat.isSymbolicLink() || !stat.isFile()) {
    fail(`${label} must be a regular non-symlink file.`, 'component_compatibility_evidence_invalid', {
      label,
      path: resolved,
    });
  }
  const realPath = fs.realpathSync(resolved);
  const bytes = fs.readFileSync(realPath);
  return {
    path: realPath,
    bytes,
    sha256: sha256Bytes(bytes),
  };
}

function readJsonSource(filePath: string, label: string): ParsedJsonSource {
  const source = readRegularFile(filePath, label);
  let parsed: unknown;
  try {
    parsed = parseJsonText(source.bytes.toString('utf8'));
  } catch {
    fail(`${label} must contain valid JSON.`, 'component_compatibility_input_invalid', {
      label,
      path: source.path,
    });
  }
  return {
    path: source.path,
    sha256: source.sha256,
    value: record(parsed, label),
  };
}

function assertIdentity(value: JsonRecord, field: string, expected: string, label: string) {
  if (value[field] !== expected) {
    fail(`${label}.${field} must be ${expected}.`, 'component_compatibility_authority_invalid', {
      label,
      field,
      expected,
      actual: value[field] ?? null,
    });
  }
}

function assertContainedFile(root: string, candidate: string, label: string) {
  const relative = path.relative(root, candidate);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    fail(`${label} must be contained by the Framework package root.`, 'component_compatibility_producer_identity_invalid', {
      framework_root: root,
      path: candidate,
    });
  }
}

function currentProducerEntrypointFile() {
  const argv0 = process.argv0?.trim();
  if (!argv0 || !path.isAbsolute(argv0)) return process.argv[1];
  try {
    if (fs.realpathSync(argv0) === fs.realpathSync(process.execPath)) {
      return process.argv[1];
    }
  } catch {
    return argv0;
  }
  return argv0;
}

function buildProducerIdentity(entrypointFile = currentProducerEntrypointFile()) {
  const entrypoint = readRegularFile(
    nonEmptyString(entrypointFile, 'Framework producer entrypoint'),
    'Framework producer entrypoint',
  );
  const packageManifest = readRegularFile(FRAMEWORK_PACKAGE_FILE, 'Framework package manifest');
  assertContainedFile(FRAMEWORK_ROOT, entrypoint.path, 'Framework producer entrypoint');
  let packagePayload: JsonRecord;
  try {
    packagePayload = record(
      parseJsonText(packageManifest.bytes.toString('utf8')),
      'Framework package manifest',
    );
  } catch {
    fail(
      'Framework package manifest must contain valid JSON.',
      'component_compatibility_producer_identity_invalid',
      { path: packageManifest.path },
    );
  }
  assertIdentity(packagePayload, 'name', 'opl-framework', 'Framework package manifest');
  assertIdentity(
    packagePayload,
    'version',
    nonEmptyString(frameworkPackage.version, 'package.json#version'),
    'Framework package manifest',
  );
  return {
    command_surface: `opl ${COMMAND_ID}`,
    executable_path: entrypoint.path,
    executable_sha256: entrypoint.sha256,
    framework_version: nonEmptyString(frameworkPackage.version, 'package.json#version'),
    package_ref: pathToFileURL(FRAMEWORK_ROOT).href,
  };
}

function verifyProducerIdentity(value: unknown) {
  const identity = record(value, 'Component compatibility receipt.producer_identity');
  const expected = buildProducerIdentity(
    nonEmptyString(identity.executable_path, 'Producer identity.executable_path'),
  );
  if (!isDeepStrictEqual(identity, expected)) {
    fail(
      'Component compatibility receipt producer identity does not match the bound Framework bytes.',
      'component_compatibility_producer_identity_mismatch',
      { expected, actual: identity },
    );
  }
  return expected;
}

function validatedRange(range: string, label: string) {
  const normalizedRange = validRange(range, SEMVER_OPTIONS);
  if (!normalizedRange) {
    fail(`${label} contains an invalid SemVer range.`, 'component_compatibility_requirement_invalid', {
      label,
      range,
    });
  }
  return normalizedRange;
}

function versionSatisfiesRange(version: string, range: string, label: string) {
  const candidate = valid(version, SEMVER_OPTIONS);
  if (!candidate) {
    fail(`${label} observed version must be valid SemVer.`, 'component_compatibility_observation_invalid', {
      label,
      version,
    });
  }
  const normalizedRange = validatedRange(range, label);
  return satisfies(candidate, normalizedRange, SEMVER_OPTIONS);
}

function parseRequirements(source: ParsedJsonSource) {
  assertIdentity(source.value, 'schema', REQUIREMENTS_SCHEMA, 'Compatibility requirements');
  assertIdentity(source.value, 'owner', 'one-person-lab-app', 'Compatibility requirements');
  assertIdentity(source.value, 'contract_ref', CONTRACT_REF, 'Compatibility requirements');
  const items = stringArray(source.value.requirements, 'Compatibility requirements.requirements');
  if (items.length === 0) {
    fail(
      'Compatibility requirements must contain at least one external requirement.',
      'component_compatibility_requirements_missing',
    );
  }
  const ids = new Set<string>();
  return items.map((value, index): CompatibilityRequirement => {
    const item = record(value, `Compatibility requirement[${index}]`);
    const requirementId = nonEmptyString(item.requirement_id, `Compatibility requirement[${index}].requirement_id`);
    if (ids.has(requirementId)) {
      fail('Compatibility requirement ids must be unique.', 'component_compatibility_requirement_invalid', {
        requirement_id: requirementId,
      });
    }
    ids.add(requirementId);
    const componentId = nonEmptyString(item.component_id, `Compatibility requirement[${index}].component_id`);
    const kind = nonEmptyString(item.kind, `Compatibility requirement[${index}].kind`);
    if (
      kind !== 'capability_id_with_versioned_schema'
      && kind !== 'minimum_version'
      && kind !== 'semver_range'
    ) {
      fail('Compatibility requirement kind is not supported.', 'component_compatibility_requirement_invalid', {
        requirement_id: requirementId,
        kind,
      });
    }
    if (kind === 'capability_id_with_versioned_schema') {
      const schemaRange = nonEmptyString(
        item.schema_range,
        `Compatibility requirement[${index}].schema_range`,
      );
      validatedRange(schemaRange, `Compatibility requirement[${index}].schema_range`);
      return {
        requirement_id: requirementId,
        component_id: componentId,
        kind,
        capability_id: nonEmptyString(item.capability_id, `Compatibility requirement[${index}].capability_id`),
        schema_range: schemaRange,
      };
    }
    const versionRequirement = nonEmptyString(
      item.version_requirement,
      `Compatibility requirement[${index}].version_requirement`,
    );
    if (kind === 'minimum_version') {
      if (!valid(versionRequirement, SEMVER_OPTIONS)) {
        fail(
          'minimum_version requirements must contain a valid SemVer version.',
          'component_compatibility_requirement_invalid',
          { requirement_id: requirementId },
        );
      }
    } else {
      validatedRange(versionRequirement, `Compatibility requirement[${index}].version_requirement`);
    }
    return {
      requirement_id: requirementId,
      component_id: componentId,
      kind,
      version_requirement: versionRequirement,
    };
  });
}

function buildFrameworkObservations(generatedAt: string): ObservedComponent[] {
  const producer = record(compatibilityContract.producer_observation, 'Compatibility producer observation');
  assertIdentity(producer, 'component_id', 'opl_framework', 'Compatibility producer observation');
  assertIdentity(producer, 'owner_authority', 'one-person-lab', 'Compatibility producer observation');
  assertIdentity(producer, 'version_source', 'package.json#version', 'Compatibility producer observation');
  const capabilityIds = new Set<string>();
  const capabilities = stringArray(producer.capabilities, 'Compatibility producer observation.capabilities')
    .map((value, index): ObservedCapability => {
      const capability = record(value, `Producer capability[${index}]`);
      const capabilityId = nonEmptyString(capability.capability_id, `Producer capability[${index}].capability_id`);
      if (capabilityIds.has(capabilityId)) {
        fail('Producer capability ids must be unique.', 'component_compatibility_observation_invalid', {
          capability_id: capabilityId,
        });
      }
      capabilityIds.add(capabilityId);
      return {
        capability_id: capabilityId,
        schema_version: nonEmptyString(capability.schema_version, `Producer capability[${index}].schema_version`),
      };
    });
  if (capabilities.length === 0) {
    fail('Framework compatibility producer must declare at least one capability.', 'component_compatibility_observation_invalid');
  }
  return [{
    component_id: 'opl_framework',
    owner_authority: 'one-person-lab',
    version: nonEmptyString(frameworkPackage.version, 'package.json#version'),
    observation_ref: `${PRODUCER_CONTRACT_REF}#producer_observation@${generatedAt}`,
    capabilities,
  }];
}

function parseSubject(source: ParsedJsonSource) {
  assertIdentity(source.value, 'schema', SUBJECT_SCHEMA, 'Compatibility subject');
  assertIdentity(source.value, 'owner', 'one-person-lab-app', 'Compatibility subject');
  const artifact = record(source.value.selected_app_artifact, 'Compatibility subject.selected_app_artifact');
  const selectedAppArtifact = {
    owner_authority: nonEmptyString(artifact.owner_authority, 'selected_app_artifact.owner_authority'),
    immutable_release_tag: nonEmptyString(artifact.immutable_release_tag, 'selected_app_artifact.immutable_release_tag'),
    asset_url: nonEmptyString(artifact.asset_url, 'selected_app_artifact.asset_url'),
    asset_name: nonEmptyString(artifact.asset_name, 'selected_app_artifact.asset_name'),
    byte_size: artifact.byte_size,
    sha256: normalizedSha256(artifact.sha256, 'selected_app_artifact.sha256'),
    ...(artifact.signature ? { signature: nonEmptyString(artifact.signature, 'selected_app_artifact.signature') } : {}),
    ...(artifact.notarization
      ? { notarization: nonEmptyString(artifact.notarization, 'selected_app_artifact.notarization') }
      : {}),
  };
  if (!Number.isInteger(selectedAppArtifact.byte_size) || Number(selectedAppArtifact.byte_size) <= 0) {
    fail('selected_app_artifact.byte_size must be a positive integer.', 'component_compatibility_subject_invalid');
  }
  const installedAppAsar = record(source.value.installed_app_asar, 'Compatibility subject.installed_app_asar');
  const buildReceipt = record(source.value.build_receipt, 'Compatibility subject.build_receipt');
  const appAsarFile = readRegularFile(
    nonEmptyString(installedAppAsar.path, 'installed_app_asar.path'),
    'installed app.asar',
  );
  const buildReceiptFile = readRegularFile(
    nonEmptyString(buildReceipt.path, 'build_receipt.path'),
    'App build receipt',
  );
  const expectedAppAsar = normalizedSha256(installedAppAsar.sha256, 'installed_app_asar.sha256');
  const expectedBuildReceipt = normalizedSha256(buildReceipt.sha256, 'build_receipt.sha256');
  if (appAsarFile.sha256 !== expectedAppAsar) {
    fail('Installed app.asar bytes drifted from the App-owned subject binding.', 'component_compatibility_app_asar_drift', {
      expected_sha256: expectedAppAsar,
      actual_sha256: appAsarFile.sha256,
    });
  }
  if (buildReceiptFile.sha256 !== expectedBuildReceipt) {
    fail('Build receipt bytes drifted from the App-owned subject binding.', 'component_compatibility_build_receipt_drift', {
      expected_sha256: expectedBuildReceipt,
      actual_sha256: buildReceiptFile.sha256,
    });
  }
  return {
    selected_app_artifact: selectedAppArtifact,
    installed_app_asar: { path: appAsarFile.path, sha256: appAsarFile.sha256 },
    build_receipt: { path: buildReceiptFile.path, sha256: buildReceiptFile.sha256 },
  };
}

function evaluateRequirements(requirements: CompatibilityRequirement[], observations: ObservedComponent[]) {
  const observedById = new Map(observations.map((entry) => [entry.component_id, entry]));
  const coverage = requirements.map((requirement) => {
    const observed = observedById.get(requirement.component_id);
    let satisfied = false;
    let failureCode: string | null = null;
    if (requirement.kind === 'capability_id_with_versioned_schema') {
      const capability = observed?.capabilities.find((entry) => entry.capability_id === requirement.capability_id);
      failureCode = capability ? 'incompatible_capability_schema' : 'incompatible_missing_capability';
      satisfied = Boolean(
        capability
        && versionSatisfiesRange(
          capability.schema_version,
          requirement.schema_range as string,
          `Requirement ${requirement.requirement_id}`,
        )
      );
    } else if (requirement.kind === 'minimum_version') {
      failureCode = 'incompatible_minimum_version';
      const minimum = valid(requirement.version_requirement as string, SEMVER_OPTIONS);
      if (!minimum) {
        fail('minimum_version requirements must contain a valid SemVer version.', 'component_compatibility_requirement_invalid', {
          requirement_id: requirement.requirement_id,
        });
      }
      satisfied = Boolean(
        observed
        && versionSatisfiesRange(
          observed.version,
          `>=${minimum}`,
          `Requirement ${requirement.requirement_id}`,
        )
      );
    } else {
      failureCode = 'incompatible_semver_range';
      satisfied = Boolean(
        observed
        && versionSatisfiesRange(
          observed.version,
          requirement.version_requirement as string,
          `Requirement ${requirement.requirement_id}`,
        )
      );
    }
    return {
      requirement_id: requirement.requirement_id,
      component_id: requirement.component_id,
      kind: requirement.kind,
      status: satisfied ? 'satisfied' : 'unsatisfied',
      observation_ref: observed?.observation_ref ?? null,
      failure_code: satisfied ? null : failureCode,
    };
  });
  const failures = coverage
    .filter((entry) => entry.status === 'unsatisfied')
    .map((entry) => ({
      requirement_id: entry.requirement_id,
      component_id: entry.component_id,
      code: entry.failure_code,
    }));
  return { coverage, failures };
}

function validateTtl(ttlSeconds: number) {
  if (!Number.isInteger(ttlSeconds) || ttlSeconds < MIN_TTL_SECONDS || ttlSeconds > MAX_TTL_SECONDS) {
    fail(
      `Compatibility receipt TTL must be an integer from ${MIN_TTL_SECONDS} to ${MAX_TTL_SECONDS} seconds.`,
      'component_compatibility_ttl_invalid',
      { ttl_seconds: ttlSeconds },
    );
  }
}

function assertSourceDigest(source: JsonRecord, label: string) {
  const file = readRegularFile(nonEmptyString(source.path, `${label}.path`), label);
  const expected = normalizedSha256(source.sha256, `${label}.sha256`);
  if (file.sha256 !== expected) {
    fail(`${label} bytes drifted after receipt production.`, 'component_compatibility_source_drift', {
      label,
      expected_sha256: expected,
      actual_sha256: file.sha256,
    });
  }
}

function verifyReceiptSidecar(source: ParsedJsonSource) {
  const sidecar = readRegularFile(`${source.path}.sha256`, 'Component compatibility receipt SHA-256 sidecar');
  const expected = `${source.sha256.slice('sha256:'.length)}  ${path.basename(source.path)}\n`;
  if (sidecar.bytes.toString('utf8') !== expected) {
    fail(
      'Component compatibility receipt SHA-256 sidecar does not bind the receipt bytes.',
      'component_compatibility_receipt_digest_mismatch',
      { receipt_file: source.path, sha256_file: sidecar.path },
    );
  }
  return sidecar.path;
}

export function verifyAppComponentCompatibilityReceipt(receiptFile: string, clock: ReceiptClock = {}) {
  const source = readJsonSource(receiptFile, 'Component compatibility receipt');
  const sha256File = verifyReceiptSidecar(source);
  assertIdentity(source.value, 'schema', RECEIPT_SCHEMA, 'Component compatibility receipt');
  assertIdentity(source.value, 'owner', 'one-person-lab', 'Component compatibility receipt');
  assertIdentity(source.value, 'producer_role', 'opl_framework', 'Component compatibility receipt');
  assertIdentity(source.value, 'contract_ref', CONTRACT_REF, 'Component compatibility receipt');
  assertIdentity(
    source.value,
    'producer_contract_ref',
    PRODUCER_CONTRACT_REF,
    'Component compatibility receipt',
  );
  assertIdentity(
    source.value,
    'receipt_ref',
    pathToFileURL(source.path).href,
    'Component compatibility receipt',
  );
  const producerIdentity = verifyProducerIdentity(source.value.producer_identity);
  const now = (clock.now ?? (() => new Date()))();
  const issuedAt = new Date(nonEmptyString(source.value.issued_at, 'Component compatibility receipt.issued_at'));
  const expiresAt = new Date(nonEmptyString(source.value.expires_at, 'Component compatibility receipt.expires_at'));
  if (
    !Number.isFinite(issuedAt.getTime())
    || !Number.isFinite(expiresAt.getTime())
    || expiresAt.getTime() <= issuedAt.getTime()
    || now.getTime() >= expiresAt.getTime()
  ) {
    fail('Component compatibility receipt is invalid or expired.', 'component_compatibility_receipt_expired');
  }
  const requirements = stringArray(source.value.requirements, 'Component compatibility receipt.requirements');
  const observations = stringArray(
    source.value.observed_components,
    'Component compatibility receipt.observed_components',
  );
  const coverage = stringArray(source.value.coverage, 'Component compatibility receipt.coverage');
  const failures = stringArray(source.value.failures, 'Component compatibility receipt.failures');
  if (observations.length === 0) {
    fail('Component compatibility receipt observations must not be empty.', 'component_compatibility_observation_invalid');
  }
  const requirementIds = requirements.map((value, index) =>
    nonEmptyString(record(value, `Receipt requirement[${index}]`).requirement_id, `Receipt requirement[${index}].requirement_id`)
  );
  const coverageIds = coverage.map((value, index) =>
    nonEmptyString(record(value, `Receipt coverage[${index}]`).requirement_id, `Receipt coverage[${index}].requirement_id`)
  );
  if (
    requirementIds.length === 0
    || requirementIds.length !== new Set(requirementIds).size
    || coverageIds.length !== new Set(coverageIds).size
    || requirementIds.length !== coverageIds.length
    || requirementIds.some((id) => !coverageIds.includes(id))
  ) {
    fail('Component compatibility receipt coverage is incomplete.', 'component_compatibility_coverage_incomplete');
  }
  const status = source.value.status;
  const coverageStatuses = coverage.map((value, index) =>
    nonEmptyString(record(value, `Receipt coverage[${index}]`).status, `Receipt coverage[${index}].status`)
  );
  if (
    (status === 'compatible' && failures.length !== 0)
    || (status === 'compatible' && coverageStatuses.some((entry) => entry !== 'satisfied'))
    || (status === 'incompatible' && failures.length === 0)
    || !['compatible', 'incompatible'].includes(String(status))
  ) {
    fail('Component compatibility receipt status and failures disagree.', 'component_compatibility_status_invalid');
  }
  const sources = record(source.value.sources, 'Component compatibility receipt.sources');
  assertSourceDigest(record(sources.requirements, 'Receipt requirements source'), 'Receipt requirements source');
  assertSourceDigest(record(sources.subject, 'Receipt subject source'), 'Receipt subject source');
  const subject = record(source.value.subject, 'Component compatibility receipt.subject');
  assertSourceDigest(record(subject.installed_app_asar, 'Receipt installed app.asar'), 'Receipt installed app.asar');
  assertSourceDigest(record(subject.build_receipt, 'Receipt build receipt'), 'Receipt build receipt');
  return {
    receipt_file: source.path,
    receipt_sha256: source.sha256,
    sha256_file: sha256File,
    producer_identity: producerIdentity,
    status,
    issued_at: issuedAt.toISOString(),
    expires_at: expiresAt.toISOString(),
    requirement_count: requirements.length,
    failure_count: failures.length,
  };
}

export function writeAppComponentCompatibilityReceipt(
  options: AppCompatibilityReceiptOptions,
  clock: ReceiptClock = {},
) {
  const ttlSeconds = options.ttlSeconds ?? 900;
  validateTtl(ttlSeconds);
  const requirementsSource = readJsonSource(options.requirementsFile, 'Compatibility requirements');
  const subjectSource = readJsonSource(options.subjectFile, 'Compatibility subject');
  const requirements = parseRequirements(requirementsSource);
  const subject = parseSubject(subjectSource);
  const now = (clock.now ?? (() => new Date()))();
  if (!Number.isFinite(now.getTime())) {
    fail('Compatibility receipt clock returned an invalid time.', 'component_compatibility_clock_invalid');
  }
  const generatedAt = now.toISOString();
  const producerIdentity = buildProducerIdentity(clock.producerEntrypointFile);
  const observations = buildFrameworkObservations(generatedAt);
  const { coverage, failures } = evaluateRequirements(requirements, observations);
  const requestedOutputFile = path.resolve(options.outputFile);
  const requestedParent = path.dirname(requestedOutputFile);
  if (!fs.existsSync(requestedParent) || !fs.statSync(requestedParent).isDirectory()) {
    fail('Compatibility receipt output parent directory must already exist.', 'component_compatibility_output_invalid', {
      output_parent: requestedParent,
    });
  }
  const outputFile = path.join(fs.realpathSync(requestedParent), path.basename(requestedOutputFile));
  const sha256File = `${outputFile}.sha256`;
  if (fs.existsSync(outputFile) || fs.existsSync(sha256File)) {
    fail('Compatibility receipt output and SHA-256 sidecar must not already exist.', 'component_compatibility_output_exists', {
      output_file: outputFile,
      sha256_file: sha256File,
    });
  }
  const receipt = {
    schema: RECEIPT_SCHEMA,
    owner: 'one-person-lab',
    producer_role: 'opl_framework',
    contract_ref: CONTRACT_REF,
    producer_contract_ref: PRODUCER_CONTRACT_REF,
    producer_identity: producerIdentity,
    receipt_ref: pathToFileURL(outputFile).href,
    generated_at: generatedAt,
    issued_at: generatedAt,
    expires_at: new Date(now.getTime() + ttlSeconds * 1_000).toISOString(),
    freshness: {
      status: 'fresh',
      generated_at: generatedAt,
      max_age_seconds: ttlSeconds,
    },
    status: failures.length === 0 ? 'compatible' : 'incompatible',
    sources: {
      requirements: {
        path: requirementsSource.path,
        sha256: requirementsSource.sha256,
        owner: 'one-person-lab-app',
        schema: REQUIREMENTS_SCHEMA,
      },
      subject: {
        path: subjectSource.path,
        sha256: subjectSource.sha256,
        owner: 'one-person-lab-app',
        schema: SUBJECT_SCHEMA,
      },
    },
    subject,
    requirements,
    observed_components: observations,
    coverage,
    failures,
    authority_boundary: {
      compatibility_only: true,
      selected_artifact_binding_is_subject_evidence_only: true,
      may_require_exact_cross_component_version_or_sha: false,
      may_require_same_cohort: false,
      may_define_package_currentness: false,
      may_claim_release_ready: false,
      may_claim_install_ready: false,
    },
  };
  const receiptBytes = `${JSON.stringify(receipt, null, 2)}\n`;
  const receiptSha256 = sha256Bytes(receiptBytes);
  const suffix = `${process.pid}.${Date.now()}`;
  const temporaryReceipt = `${outputFile}.${suffix}.tmp`;
  const temporarySha256 = `${sha256File}.${suffix}.tmp`;
  let receiptInstalled = false;
  let sidecarInstalled = false;
  try {
    fs.writeFileSync(temporaryReceipt, receiptBytes, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    fs.writeFileSync(
      temporarySha256,
      `${receiptSha256.slice('sha256:'.length)}  ${path.basename(outputFile)}\n`,
      { encoding: 'utf8', flag: 'wx', mode: 0o600 },
    );
    fs.renameSync(temporaryReceipt, outputFile);
    receiptInstalled = true;
    fs.renameSync(temporarySha256, sha256File);
    sidecarInstalled = true;
  } catch (error) {
    for (const temporary of [temporaryReceipt, temporarySha256]) {
      if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
    }
    if (sidecarInstalled && fs.existsSync(sha256File)) fs.unlinkSync(sha256File);
    if (receiptInstalled && fs.existsSync(outputFile)) fs.unlinkSync(outputFile);
    throw error;
  }
  const verification = verifyAppComponentCompatibilityReceipt(outputFile, { now: () => now });
  return verification;
}
