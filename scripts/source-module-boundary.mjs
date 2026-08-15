#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs as parseNodeArgs } from 'node:util';

import { isJsonObject, readJsonFile } from './script-json-boundary.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = parseCliOptions(process.argv.slice(2));
if (args.help) {
  printHelp();
  process.exit(0);
}
const targetRoot = args.root ? path.resolve(args.root) : repoRoot;
const contractPath = args.contract
  ? path.resolve(args.contract)
  : path.join(targetRoot, 'contracts', 'opl-framework', 'source-module-map.json');
const policyPath = args.policy
  ? path.resolve(args.policy)
  : path.join(targetRoot, 'contracts', 'opl-framework', 'module-dependency-policy.json');

const failures = [];
const contract = readJson(contractPath);
const layout = readPhysicalLayout(contract);
const rootTsPolicy = readRootTsPolicy(layout);
const sourceUnits = readSourceUnits(contract);
const targetRoots = readTargetRoots(contract);
const legacyRoots = readLegacyRoots(contract);
const dependencyPolicy = readModuleDependencyPolicy(readOptionalJson(policyPath), sourceUnits);
const expectedModuleEntrypoints = [];
const missingModuleEntrypoints = [];

for (const unit of sourceUnits) {
  const matchingSourceFiles = listUnitSourceFiles(unit.physical_root);
  if (matchingSourceFiles.length === 0) failures.push(`${unit.unit_id}: source unit matched zero TypeScript files`);
  for (const expectedEntrypoint of unit.public_entrypoints.filter((entry) => !entry.includes('*'))) {
    expectedModuleEntrypoints.push(expectedEntrypoint);
    if (!existsRelative(expectedEntrypoint)) missingModuleEntrypoints.push(expectedEntrypoint);
  }
}

if (missingModuleEntrypoints.length > 0) {
  failures.push(...missingModuleEntrypoints.map((entrypoint) => `${entrypoint}: source-unit entrypoint is missing`));
}
for (const root of targetRoots) {
  if (!existsRelative(root.path)) failures.push(`${root.path}: target source root is missing`);
}
for (const legacy of legacyRoots) {
  if (legacy.must_be_absent && existsRelative(legacy.path)) failures.push(`${legacy.path}: retired source root must be absent`);
}

const targetCliExists = existsRelative(layout.targetCliEntrypoint);
const legacyCliExists = existsRelative(layout.legacyCliEntrypoint);
const targetMode = args.enforceTarget || layout.stage === 'target' || targetCliExists;
const rootTsFiles = listTopLevelTsFiles(contract.source_root ?? 'src');
const exceptionByPath = new Map(rootTsPolicy.allowedTransitionExceptions.map((entry) => [entry.path, entry]));
const allowedRootTsFiles = [];
const unclassifiedRootTsFiles = [];
const retiredExceptionViolations = [];

for (const rootTsFile of rootTsFiles) {
  const exception = exceptionByPath.get(rootTsFile);
  if (!exception) {
    unclassifiedRootTsFiles.push(rootTsFile);
    continue;
  }
  allowedRootTsFiles.push(rootTsFile);
  if (exception.retire_when === 'target_cli_entrypoint_exists' && targetCliExists) {
    retiredExceptionViolations.push(rootTsFile);
  }
}

if (targetMode && !targetCliExists) {
  failures.push(`${layout.targetCliEntrypoint}: target CLI entrypoint is missing`);
}
if (!targetMode && !targetCliExists && !legacyCliExists) {
  failures.push(`${layout.targetCliEntrypoint}: target CLI entrypoint is missing and ${layout.legacyCliEntrypoint} is not available as a transition entrypoint`);
}
if (targetMode && unclassifiedRootTsFiles.length > 0) {
  failures.push(...unclassifiedRootTsFiles.map((file) =>
    `${file}: root-level src/*.ts is not an explicit entrypoint/kernel transition exception`
  ));
}
if (targetMode && retiredExceptionViolations.length > 0) {
  failures.push(...retiredExceptionViolations.map((file) =>
    `${file}: legacy CLI entrypoint must be retired after ${layout.targetCliEntrypoint} exists`
  ));
}

const crossModuleImports = inspectCrossUnitImports(sourceUnits, targetRoots, dependencyPolicy);
if (crossModuleImports.deep_import_violations.enforced && crossModuleImports.deep_import_violations.count > 0) {
  failures.push(`cross_module_imports: ${crossModuleImports.deep_import_violations.count} deep cross-module import(s) violate public entrypoint rule`);
}
if (crossModuleImports.forbidden_dependency_violations.count > 0) {
  failures.push(...crossModuleImports.forbidden_dependency_violations.items.map((entry) =>
    `${entry.from_module_id}->${entry.to_module_id}: forbidden module dependency used by ${entry.count} import(s)`
  ));
}
if (crossModuleImports.dependency_cycles.enforced && crossModuleImports.dependency_cycles.count > 0) {
  failures.push(`module_dependency_cycles: ${crossModuleImports.dependency_cycles.count} cyclic module component(s) violate dependency cycle policy`);
}
const summary = {
  status: failures.length === 0 ? 'ok' : 'failed',
  contract: relativeFromRoot(contractPath),
  module_dependency_policy: dependencyPolicy.path,
  layout_stage: layout.stage,
  enforcement: {
    mode: targetMode ? 'target' : 'transition',
    forced: args.enforceTarget,
    target_activation_path: layout.targetActivationPath,
    target_activation_exists: existsRelative(layout.targetActivationPath),
  },
  module_entrypoints: {
    expected_count: expectedModuleEntrypoints.length,
    missing: missingModuleEntrypoints,
    mismatched: [],
    unexpected_module_roots: [],
  },
  cli_entrypoint: {
    target: layout.targetCliEntrypoint,
    target_exists: targetCliExists,
    legacy: layout.legacyCliEntrypoint,
    legacy_exists: legacyCliExists,
  },
  root_ts: {
    top_level_count: rootTsFiles.length,
    target_top_level_ts_count: rootTsPolicy.targetTopLevelTsCount,
    allowed_transition_exception_count: allowedRootTsFiles.length,
    unclassified_transition_count: unclassifiedRootTsFiles.length,
    unclassified_transition_files: targetMode || failures.length > 0 ? unclassifiedRootTsFiles : [],
    retired_exception_violations: retiredExceptionViolations,
  },
  source_units: sourceUnits,
  target_roots: targetRoots,
  legacy_roots: legacyRoots,
  cross_module_imports: crossModuleImports,
  failures,
};

process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
if (failures.length > 0) {
  process.stderr.write(`source module boundary check failed (${failures.length} issue${failures.length === 1 ? '' : 's'}):\n`);
  process.stderr.write(failures.map((failure) => `- ${failure}`).join('\n'));
  process.stderr.write('\n');
  process.exit(1);
}

function parseCliOptions(argv) {
  try {
    const { values } = parseNodeArgs({
      args: argv,
      options: {
        root: { type: 'string' },
        contract: { type: 'string' },
        policy: { type: 'string' },
        'enforce-target': { type: 'boolean', default: false },
        'strict-imports': { type: 'boolean', default: false },
        'strict-cycles': { type: 'boolean', default: false },
        format: { type: 'string', default: 'json' },
        help: { type: 'boolean', default: false },
      },
      strict: true,
      allowPositionals: false,
    });
    const parsed = {
      root: values.root ?? null,
      contract: values.contract ?? null,
      policy: values.policy ?? null,
      enforceTarget: values['enforce-target'] === true,
      strictImports: values['strict-imports'] === true,
      strictCycles: values['strict-cycles'] === true,
      format: values.format,
      help: values.help === true,
    };
    if (parsed.format !== 'json') {
      process.stderr.write('source module boundary: --format must be json\n');
      process.exit(1);
    }
    return parsed;
  } catch (error) {
    process.stderr.write(`source module boundary: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  }
}

function printHelp() {
  process.stdout.write([
    'Usage: node scripts/source-module-boundary.mjs [options]',
    '',
    'Options:',
    '  --root <path>          Repo root to inspect.',
    '  --contract <path>      Source module map contract. Default: contracts/opl-framework/source-module-map.json.',
    '  --policy <path>        Module dependency policy. Default: contracts/opl-framework/module-dependency-policy.json.',
    '  --enforce-target       Enforce target module layout even during transition stage.',
    '  --strict-imports       Fail on deep cross-module imports.',
    '  --strict-cycles        Fail on module dependency cycles.',
    '  --format json          Explicit machine JSON output. Default: json.',
    '  --help                 Print this help.',
    '',
  ].join('\n'));
}

function readJson(file) {
  try {
    return readJsonFile(file);
  } catch (error) {
    process.stderr.write(`source module boundary: failed to read ${file}: ${error.message}\n`);
    process.exit(1);
  }
}

function readOptionalJson(file) {
  if (!fs.existsSync(file)) {
    return null;
  }
  return readJson(file);
}

function readPhysicalLayout(contractValue) {
  const value = contractValue.physical_layout;
  if (!isJsonObject(value)) {
    failures.push('physical_layout: missing source module physical layout contract');
    return {
      stage: 'transition',
      moduleEntrypointPattern: 'src/modules/<module_id>/index.ts',
      targetCliEntrypoint: 'src/entrypoints/cli.ts',
      legacyCliEntrypoint: 'src/cli.ts',
      targetActivationPath: 'src/entrypoints/cli.ts',
      rootTsPolicy: {},
    };
  }
  const moduleEntrypointPattern = typeof value.module_entrypoint_pattern === 'string'
    ? normalizeRelativePath(value.module_entrypoint_pattern)
    : '<declared-per-source-unit>';
  const targetCliEntrypoint = readString(value.target_cli_entrypoint, 'physical_layout.target_cli_entrypoint');
  const legacyCliEntrypoint = typeof value.legacy_cli_entrypoint === 'string'
    ? normalizeRelativePath(value.legacy_cli_entrypoint)
    : 'src/cli.ts';
  return {
    stage: readString(value.stage, 'physical_layout.stage'),
    moduleEntrypointPattern,
    targetCliEntrypoint,
    legacyCliEntrypoint,
    targetActivationPath: readString(value.target_activation_path, 'physical_layout.target_activation_path'),
    rootTsPolicy: isJsonObject(value.root_ts_policy) ? value.root_ts_policy : {},
  };
}

function readRootTsPolicy(layoutValue) {
  const policy = layoutValue.rootTsPolicy;
  if (!isJsonObject(policy)) {
    failures.push('physical_layout.root_ts_policy: missing root TypeScript policy');
  }
  const allowedKinds = readStringArray(
    policy.allowed_transition_exception_kinds,
    'physical_layout.root_ts_policy.allowed_transition_exception_kinds',
  );
  const allowedKindSet = new Set(allowedKinds);
  const entries = Array.isArray(policy.allowed_transition_exceptions)
    ? policy.allowed_transition_exceptions
    : [];
  if (!Array.isArray(policy.allowed_transition_exceptions)) {
    failures.push('physical_layout.root_ts_policy.allowed_transition_exceptions must be an array');
  }
  const allowedTransitionExceptions = entries.flatMap((entry, index) => {
    if (!isJsonObject(entry)) {
      failures.push(`physical_layout.root_ts_policy.allowed_transition_exceptions.${index}: entry must be an object`);
      return [];
    }
    const exception = {
      path: readString(entry.path, `physical_layout.root_ts_policy.allowed_transition_exceptions.${index}.path`),
      kind: readString(entry.kind, `physical_layout.root_ts_policy.allowed_transition_exceptions.${index}.kind`),
      target_path: readString(entry.target_path, `physical_layout.root_ts_policy.allowed_transition_exceptions.${index}.target_path`),
      retire_when: typeof entry.retire_when === 'string' ? entry.retire_when : null,
    };
    if (!allowedKindSet.has(exception.kind)) {
      failures.push(`${exception.path}: transition exception kind must be one of ${allowedKinds.join(', ')}`);
    }
    return [exception];
  });
  return {
    targetTopLevelTsCount: readNonNegativeInteger(
      policy.target_top_level_ts_count,
      'physical_layout.root_ts_policy.target_top_level_ts_count',
    ),
    allowedTransitionExceptions,
  };
}

function readSourceUnits(contractValue) {
  if (!Array.isArray(contractValue.source_units)) {
    failures.push('source_units: source topology must contain a source_units array');
    return [];
  }
  const seen = new Set();
  return contractValue.source_units.flatMap((entry, index) => {
    if (!isJsonObject(entry)) {
      failures.push(`source_units.${index}: entry must be an object`);
      return [];
    }
    const unitId = readString(entry.unit_id, `source_units.${index}.unit_id`);
    if (seen.has(unitId)) failures.push(`${unitId}: duplicate source unit id`);
    seen.add(unitId);
    return [{
      unit_id: unitId,
      layer_id: readString(entry.layer_id, `source_units.${index}.layer_id`),
      physical_root: readString(entry.physical_root, `source_units.${index}.physical_root`),
      public_entrypoints: readStringArray(entry.public_entrypoints, `source_units.${index}.public_entrypoints`),
      source_globs: readStringArray(entry.source_globs, `source_units.${index}.source_globs`),
    }];
  });
}

function readTargetRoots(contractValue) {
  if (!Array.isArray(contractValue.target_roots)) {
    failures.push('target_roots: source topology must contain a target_roots array');
    return [];
  }
  return contractValue.target_roots.flatMap((entry, index) => {
    if (!isJsonObject(entry)) {
      failures.push(`target_roots.${index}: entry must be an object`);
      return [];
    }
    return [{
      root_id: readString(entry.root_id, `target_roots.${index}.root_id`),
      path: readString(entry.path, `target_roots.${index}.path`),
      layer_id: readString(entry.layer_id, `target_roots.${index}.layer_id`),
    }];
  });
}

function readLegacyRoots(contractValue) {
  if (!Array.isArray(contractValue.legacy_roots)) return [];
  return contractValue.legacy_roots.flatMap((entry, index) => {
    if (!isJsonObject(entry)) {
      failures.push(`legacy_roots.${index}: entry must be an object`);
      return [];
    }
    return [{
      path: readString(entry.path, `legacy_roots.${index}.path`),
      state: readString(entry.state, `legacy_roots.${index}.state`),
      must_be_absent: entry.must_be_absent === true,
      caller_zero_required: entry.caller_zero_required === true,
    }];
  });
}

function readModuleDependencyPolicy(policyValue, sourceUnitsValue) {
  const knownUnitIds = sourceUnitsValue.map((unit) => unit.unit_id);
  const knownUnitIdSet = new Set(knownUnitIds);
  const defaultPolicy = {
    path: fs.existsSync(policyPath) ? relativeFromRoot(policyPath) : null,
    source_unit_ids: knownUnitIds,
    public_entrypoint_rule: {
      cross_module_imports: 'public_entrypoint_or_host_plugin_leaf',
    },
    source_scan_scope: 'all_target_source_units',
    deep_import_failure_mode: args.strictImports ? 'strict' : 'advisory',
    dependency_cycle_failure_mode: args.strictCycles ? 'strict' : 'advisory',
    forbiddenPairs: new Map(),
  };
  if (!policyValue) {
    return defaultPolicy;
  }

  if (policyValue.version === 'module-dependency-policy.v2') {
    const dependencyPolicy = isJsonObject(policyValue.dependency_policy)
      ? policyValue.dependency_policy
      : {};
    const layerDependencies = new Map();
    for (const entry of Array.isArray(dependencyPolicy.layer_dependencies)
      ? dependencyPolicy.layer_dependencies
      : []) {
      if (!isJsonObject(entry)) continue;
      const fromLayer = readString(entry.from_layer_id, 'module_dependency_policy.layer_dependencies.from_layer_id');
      layerDependencies.set(fromLayer, new Set(readStringArray(
        entry.to_layer_ids,
        `module_dependency_policy.layer_dependencies.${fromLayer}.to_layer_ids`,
      )));
    }
    return {
      ...defaultPolicy,
      path: relativeFromRoot(policyPath),
      source_scan_scope: 'all_target_source_units',
      deep_import_failure_mode: 'strict',
      dependency_cycle_failure_mode: 'strict',
      layerDependencies,
      forbiddenPairs: readForbiddenPairs(dependencyPolicy.forbidden_dependencies, knownUnitIdSet),
    };
  }

  const publicEntrypointRule = isJsonObject(policyValue.public_entrypoint_rule) ? policyValue.public_entrypoint_rule : {};
  if (!isJsonObject(policyValue.public_entrypoint_rule)) {
    failures.push('module_dependency_policy.public_entrypoint_rule: expected object');
  }

  const dependencyPolicy = isJsonObject(policyValue.dependency_policy) ? policyValue.dependency_policy : {};
  if (!isJsonObject(policyValue.dependency_policy)) {
    failures.push('module_dependency_policy.dependency_policy: expected object');
  }
  const sourceScanScope = isJsonObject(policyValue.source_scan_scope) ? policyValue.source_scan_scope : {};
  if (!isJsonObject(policyValue.source_scan_scope)) {
    failures.push('module_dependency_policy.source_scan_scope: expected object');
  }
  const deepImportPolicy = isJsonObject(policyValue.deep_cross_module_imports)
    ? policyValue.deep_cross_module_imports
    : {};
  if (!isJsonObject(policyValue.deep_cross_module_imports)) {
    failures.push('module_dependency_policy.deep_cross_module_imports: expected object');
  }
  const dependencyCyclePolicy = isJsonObject(policyValue.module_dependency_cycles)
    ? policyValue.module_dependency_cycles
    : {};
  if (!isJsonObject(policyValue.module_dependency_cycles)) {
    failures.push('module_dependency_policy.module_dependency_cycles: expected object');
  }
  const layerDependencies = new Map();
  for (const entry of Array.isArray(dependencyPolicy.layer_dependencies) ? dependencyPolicy.layer_dependencies : []) {
    if (!isJsonObject(entry)) continue;
    const fromLayer = readString(entry.from_layer_id, 'module_dependency_policy.layer_dependencies.from_layer_id');
    layerDependencies.set(fromLayer, new Set(readStringArray(entry.to_layer_ids, `module_dependency_policy.layer_dependencies.${fromLayer}.to_layer_ids`)));
  }

  return {
    path: relativeFromRoot(policyPath),
    source_unit_ids: knownUnitIds,
    public_entrypoint_rule: {
      cross_module_imports: readString(
        publicEntrypointRule.cross_module_imports ?? publicEntrypointRule.cross_unit_imports ?? 'public_entrypoint_or_host_plugin_leaf',
        'module_dependency_policy.public_entrypoint_rule.cross_module_imports',
      ),
    },
    source_scan_scope: readString(
      sourceScanScope.checker_scope,
      'module_dependency_policy.source_scan_scope.checker_scope',
    ),
    deep_import_failure_mode: args.strictImports
      ? 'strict'
      : readFailureMode(
        deepImportPolicy.failure_mode,
        'module_dependency_policy.deep_cross_module_imports.failure_mode',
      ),
    dependency_cycle_failure_mode: args.strictCycles
      ? 'strict'
      : readFailureMode(
        dependencyCyclePolicy.failure_mode,
        'module_dependency_policy.module_dependency_cycles.failure_mode',
      ),
    forbiddenPairs: readForbiddenPairs(dependencyPolicy.forbidden_dependencies, knownUnitIdSet),
    layerDependencies,
  };
}

function readForbiddenPairs(value, knownUnitIdSet) {
  const forbidden = new Map();
  if (!Array.isArray(value)) {
    failures.push('module_dependency_policy.dependency_policy.forbidden_dependencies: expected array');
    return forbidden;
  }
  for (const [index, entry] of value.entries()) {
    if (!isJsonObject(entry)) {
      failures.push(`module_dependency_policy.dependency_policy.forbidden_dependencies.${index}: expected object`);
      continue;
    }
    const fromUnitId = readString(entry.from_unit_id ?? entry.from_module_id, `module_dependency_policy.dependency_policy.forbidden_dependencies.${index}.from_unit_id`);
    const toUnitId = readString(entry.to_unit_id ?? entry.to_module_id, `module_dependency_policy.dependency_policy.forbidden_dependencies.${index}.to_unit_id`);
    if (!knownUnitIdSet.has(fromUnitId)) {
      failures.push(`module_dependency_policy.dependency_policy.forbidden_dependencies.${index}.from_unit_id: unknown ${fromUnitId}`);
      continue;
    }
    if (!knownUnitIdSet.has(toUnitId)) {
      failures.push(`module_dependency_policy.dependency_policy.forbidden_dependencies.${index}.to_unit_id: unknown ${toUnitId}`);
      continue;
    }
    forbidden.set(`${fromUnitId}->${toUnitId}`, {
      from_module_id: fromUnitId,
      to_module_id: toUnitId,
      reason: typeof entry.reason === 'string' ? entry.reason : '',
    });
  }
  return forbidden;
}

function readFailureMode(value, field) {
  if (value === 'advisory' || value === 'strict') {
    return value;
  }
  failures.push(`${field}: expected advisory or strict`);
  return 'advisory';
}

function inspectCrossUnitImports(units, roots, policyValue) {
  if (units.length === 0) {
    failures.push('source_units: no responsibility units were declared');
  }
  const pairCounts = new Map();
  const deepImportExamples = [];
  const forbiddenImports = new Map();
  const sourceFiles = [...new Set(units.flatMap((unit) => listUnitSourceFiles(unit.physical_root)))].sort();
  const targetSourceFiles = [...new Set(roots.flatMap((root) => listUnitSourceFiles(root.path)))].sort();
  for (const file of targetSourceFiles) {
    const owners = units.filter((unit) => file === unit.physical_root || file.startsWith(`${unit.physical_root}/`));
    if (owners.length !== 1) failures.push(`${file}: target source file must belong to exactly one source unit (found ${owners.length})`);
  }

  for (const file of sourceFiles) {
    const fromUnit = sourceUnitFromPath(file, units);
    if (!fromUnit) continue;
    const text = fs.readFileSync(path.join(targetRoot, ...file.split('/')), 'utf8');
    for (const importRef of readImportSpecifiers(text)) {
      const resolved = resolveRelativeImport(file, importRef.specifier);
      if (!resolved) continue;
      const toUnit = sourceUnitFromPath(resolved, units);
      if (!toUnit || toUnit.unit_id === fromUnit.unit_id) continue;

      const pairKey = `${fromUnit.unit_id}->${toUnit.unit_id}`;
      pairCounts.set(pairKey, (pairCounts.get(pairKey) ?? 0) + 1);
      const importEntry = {
        from_module_id: fromUnit.unit_id,
        to_module_id: toUnit.unit_id,
        from_layer_id: fromUnit.layer_id,
        to_layer_id: toUnit.layer_id,
        importing_file: file,
        import_specifier: importRef.specifier,
        resolved_path: resolved,
      };
      if (policyValue.forbiddenPairs.has(pairKey)) addImportViolation(forbiddenImports, pairKey, importEntry);
      if (!isPublicSourceUnitEntrypoint(resolved, toUnit, fromUnit)) deepImportExamples.push(importEntry);
    }
  }

  if (sourceFiles.length === 0) failures.push('source_units: target source scan matched zero TypeScript files');
  const pairCountEntries = [...pairCounts.entries()].map(([pair, count]) => {
    const [fromModuleId, toModuleId] = pair.split('->');
    return { from_module_id: fromModuleId, to_module_id: toModuleId, count };
  }).sort(compareModulePairEntries);
  const dependencyCycles = findDependencyCycles(pairCountEntries);

  return {
    policy: {
      module_count: units.length,
      source_unit_count: units.length,
      source_unit_ids: units.map((unit) => unit.unit_id),
      source_scan_scope: policyValue.source_scan_scope,
      source_files_scanned: sourceFiles.length,
      deep_import_failure_mode: policyValue.deep_import_failure_mode,
      strict_imports_requested: args.strictImports,
      dependency_cycle_failure_mode: policyValue.dependency_cycle_failure_mode,
      strict_cycles_requested: args.strictCycles,
    },
    pair_counts: pairCountEntries,
    deep_import_violations: {
      count: deepImportExamples.length,
      failure_mode: policyValue.deep_import_failure_mode,
      enforced: policyValue.deep_import_failure_mode === 'strict',
      examples: deepImportExamples.slice(0, 100),
    },
    forbidden_dependency_violations: {
      count: [...forbiddenImports.values()].reduce((sum, entries) => sum + entries.length, 0),
      items: summarizeImportViolations(forbiddenImports),
    },
    dependency_cycles: {
      count: dependencyCycles.length,
      failure_mode: policyValue.dependency_cycle_failure_mode,
      enforced: policyValue.dependency_cycle_failure_mode === 'strict',
      components: dependencyCycles,
    },
    target_source_files_scanned: targetSourceFiles.length,
  };
}

function sourceUnitFromPath(relativePath, units) {
  return [...units]
    .sort((left, right) => right.physical_root.length - left.physical_root.length)
    .find((unit) => relativePath === unit.physical_root || relativePath.startsWith(`${unit.physical_root}/`)) ?? null;
}

function isPublicSourceUnitEntrypoint(relativePath, unit, fromUnit) {
  if (fromUnit.layer_id === 'entrypoints' || unit.layer_id === 'kernel') return true;
  if (relativePath.startsWith(`${unit.physical_root}/public/`)) return true;
  return unit.public_entrypoints.some((entry) => pathMatchesSimpleGlob(relativePath, entry));
}

function pathMatchesSimpleGlob(relativePath, pattern) {
  if (!pattern.includes('*')) return relativePath === pattern || relativePath === pattern.replace(/\.ts$/, '');
  const expression = new RegExp(`^${pattern.split('*').map(escapeRegExp).join('[^/]*')}$`);
  return expression.test(relativePath) || expression.test(`${relativePath}.ts`);
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function readImportSpecifiers(text) {
  const imports = [];
  const pattern = /\b(?:import|export)\s+(?:type\s+)?(?:[^'"();]*?\s+from\s*)?['"]([^'"]+)['"]/g;
  let match;
  while ((match = pattern.exec(text))) {
    imports.push({ specifier: match[1] });
  }
  return imports;
}

function resolveRelativeImport(importingFile, specifier) {
  if (!specifier.startsWith('.')) {
    return null;
  }
  return normalizeRelativePath(path.normalize(path.join(path.dirname(importingFile), specifier)))
    .replace(/\.(ts|tsx|js|jsx|mjs|cjs)$/, '');
}

function addImportViolation(violations, pairKey, importEntry) {
  const current = violations.get(pairKey) ?? [];
  current.push(importEntry);
  violations.set(pairKey, current);
}

function summarizeImportViolations(violations) {
  return [...violations.entries()]
    .map(([pair, imports]) => {
      const [fromModuleId, toModuleId] = pair.split('->');
      return {
        from_module_id: fromModuleId,
        to_module_id: toModuleId,
        count: imports.length,
        examples: imports.slice(0, 10),
      };
    })
    .sort(compareModulePairEntries);
}

function findDependencyCycles(pairCountEntries) {
  const graph = new Map();
  for (const entry of pairCountEntries) {
    if (!graph.has(entry.from_module_id)) {
      graph.set(entry.from_module_id, new Set());
    }
    if (!graph.has(entry.to_module_id)) {
      graph.set(entry.to_module_id, new Set());
    }
    graph.get(entry.from_module_id).add(entry.to_module_id);
  }

  const indexByModule = new Map();
  const lowlinkByModule = new Map();
  const stack = [];
  const onStack = new Set();
  const components = [];
  let nextIndex = 0;

  for (const moduleId of [...graph.keys()].sort()) {
    if (!indexByModule.has(moduleId)) {
      visit(moduleId);
    }
  }

  return components
    .filter((moduleIds) => moduleIds.length > 1 || graph.get(moduleIds[0])?.has(moduleIds[0]))
    .map((moduleIds) => {
      const moduleIdSet = new Set(moduleIds);
      const edges = pairCountEntries.filter((entry) =>
        moduleIdSet.has(entry.from_module_id) && moduleIdSet.has(entry.to_module_id)
      );
      return {
        module_ids: moduleIds.sort(),
        edge_count: edges.length,
        edges,
      };
    })
    .sort((left, right) => left.module_ids.join(',').localeCompare(right.module_ids.join(',')));

  function visit(moduleId) {
    indexByModule.set(moduleId, nextIndex);
    lowlinkByModule.set(moduleId, nextIndex);
    nextIndex += 1;
    stack.push(moduleId);
    onStack.add(moduleId);

    for (const targetModuleId of [...(graph.get(moduleId) ?? [])].sort()) {
      if (!indexByModule.has(targetModuleId)) {
        visit(targetModuleId);
        lowlinkByModule.set(
          moduleId,
          Math.min(lowlinkByModule.get(moduleId), lowlinkByModule.get(targetModuleId)),
        );
      } else if (onStack.has(targetModuleId)) {
        lowlinkByModule.set(
          moduleId,
          Math.min(lowlinkByModule.get(moduleId), indexByModule.get(targetModuleId)),
        );
      }
    }

    if (lowlinkByModule.get(moduleId) !== indexByModule.get(moduleId)) {
      return;
    }

    const component = [];
    while (stack.length > 0) {
      const currentModuleId = stack.pop();
      onStack.delete(currentModuleId);
      component.push(currentModuleId);
      if (currentModuleId === moduleId) {
        break;
      }
    }
    components.push(component);
  }
}

function compareModulePairEntries(left, right) {
  return `${left.from_module_id}->${left.to_module_id}`.localeCompare(`${right.from_module_id}->${right.to_module_id}`);
}

function readString(value, field) {
  if (typeof value === 'string' && value.length > 0) {
    return normalizeRelativePath(value);
  }
  failures.push(`${field}: expected non-empty string`);
  return '';
}

function readStringArray(value, field) {
  if (!Array.isArray(value)) {
    failures.push(`${field}: expected array`);
    return [];
  }
  return value.flatMap((entry, index) => {
    if (typeof entry !== 'string' || entry.length === 0) {
      failures.push(`${field}.${index}: expected non-empty string`);
      return [];
    }
    return [entry];
  });
}

function readNonNegativeInteger(value, field) {
  if (Number.isInteger(value) && value >= 0) {
    return value;
  }
  failures.push(`${field}: expected non-negative integer`);
  return 0;
}

function normalizeRelativePath(value) {
  return value.replaceAll('\\', '/').replace(/^\.\/+/, '');
}

function existsRelative(relativePath) {
  return fs.existsSync(path.join(targetRoot, ...relativePath.split('/')));
}

function listTopLevelTsFiles(sourceRoot) {
  const sourceDir = path.join(targetRoot, sourceRoot);
  if (!fs.existsSync(sourceDir)) {
    failures.push(`${sourceRoot}: source root is missing`);
    return [];
  }
  return fs.readdirSync(sourceDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.ts'))
    .map((entry) => `${sourceRoot}/${entry.name}`)
    .sort();
}

function listUnitSourceFiles(physicalRoot) {
  const directory = path.join(targetRoot, ...physicalRoot.split('/'));
  if (!fs.existsSync(directory)) return [];
  const files = [];
  collectTsFiles(directory, physicalRoot, files);
  return files;
}

function collectTsFiles(directory, relativeDirectory, files) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const relativePath = `${relativeDirectory}/${entry.name}`;
    const absolutePath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      collectTsFiles(absolutePath, relativePath, files);
      continue;
    }
    if (entry.isFile() && entry.name.endsWith('.ts')) {
      files.push(relativePath);
    }
  }
}

function relativeFromRoot(file) {
  const relative = path.relative(targetRoot, file);
  return relative.startsWith('..') ? file : normalizeRelativePath(relative);
}
