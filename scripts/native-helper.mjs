#!/usr/bin/env node

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const PROTOCOL_VERSION = 'opl_native_helper.v1';
const IMPLEMENTATION_VERSION = 'node-stdlib.v1';
const SOURCE_OF_TRUTH_RULE =
  'OPL persists native helper indexes for fast lookup, then dereferences domain-owned durable truth before acting.';
const DEFAULT_MAX_FILES = 10_000;
const DEFAULT_MAX_JSON_BYTES = 5 * 1024 * 1024;
const helperId = process.argv[2] ?? 'opl-doctor-native';

let request = {};
try {
  const input = fs.readFileSync(0, 'utf8').trim();
  if (input) {
    request = JSON.parse(input);
  }
  if (!request || typeof request !== 'object' || Array.isArray(request)) {
    throw helperError('invalid_request_shape', 'native helper input must be a JSON object');
  }
  const payload = runHelper(helperId, request);
  writeResponse({
    helper_id: helperId,
    request_id: optionalString(request, 'request_id'),
    ok: true,
    result: payload,
    errors: [],
  });
} catch (error) {
  const detail = error?.code && error?.message
    ? error
    : helperError('helper_failed', error instanceof Error ? error.message : String(error));
  writeResponse({
    helper_id: helperId,
    request_id: optionalString(request, 'request_id'),
    ok: false,
    result: null,
    errors: [{ code: detail.code, message: detail.message }],
  });
  process.exitCode = 1;
}

function writeResponse({ helper_id, request_id, ok, result, errors }) {
  process.stdout.write(`${JSON.stringify({
    protocol_version: PROTOCOL_VERSION,
    helper_id,
    helper_version: IMPLEMENTATION_VERSION,
    binary_version: process.version,
    implementation: 'node',
    ok,
    request_id: request_id ?? null,
    result,
    errors,
  })}\n`);
}

function runHelper(id, input) {
  switch (id) {
    case 'opl-sysprobe':
      return buildSystemProbe();
    case 'opl-doctor-native':
      return buildDoctorSnapshot();
    case 'opl-runtime-watch':
      return buildRuntimeWatch(input);
    case 'opl-artifact-indexer':
      return buildArtifactIndex(input);
    case 'opl-state-indexer':
      return buildStateIndex(input);
    default:
      throw helperError('unknown_helper', `unknown helper_id: ${id}`);
  }
}

function buildSystemProbe() {
  return {
    surface_kind: 'native_system_probe',
    source_of_truth_rule: SOURCE_OF_TRUTH_RULE,
    os: process.platform,
    arch: process.arch,
    current_dir: process.cwd(),
    path_entries: (process.env.PATH ?? '').split(path.delimiter).filter(Boolean),
    toolchain: {
      node: true,
      node_version: process.version,
      implementation: 'node',
    },
  };
}

function buildDoctorSnapshot() {
  return {
    surface_kind: 'native_doctor_snapshot',
    source_of_truth_rule: SOURCE_OF_TRUTH_RULE,
    system_probe: buildSystemProbe(),
    checks: [{
      check_id: 'json_stdio_protocol',
      status: 'ok',
      detail: 'helper accepted JSON input and emitted a single JSON response',
    }],
  };
}

function buildArtifactIndex(input) {
  const workspaceRoot = requiredPath(input, 'workspace_root');
  const maxDepth = optionalNumber(input, 'max_depth') ?? 8;
  const limits = scanLimits(input);
  const artifactRoots = pathList(input, 'artifact_roots') ?? [
    path.join(workspaceRoot, 'artifacts'),
    path.join(workspaceRoot, 'manuscript'),
  ];
  const extensions = stringList(input, 'artifact_extensions') ?? [
    'json', 'md', 'txt', 'pdf', 'docx', 'pptx', 'xlsx', 'html',
  ];
  const report = newScanReport(limits);
  for (const root of artifactRoots) {
    scanFiles(root, workspaceRoot, maxDepth, (file) => extensionMatches(file, extensions), limits, [], report);
  }
  report.files.sort((left, right) => left.relative_path.localeCompare(right.relative_path));
  return {
    surface_kind: 'native_artifact_manifest',
    source_of_truth_rule: SOURCE_OF_TRUTH_RULE,
    workspace_root: workspaceRoot,
    summary: {
      total_files_count: report.files.length,
      total_bytes: report.files.reduce((total, file) => total + file.bytes, 0),
      truncated: report.truncated,
      max_files: report.max_files,
    },
    files: report.files,
  };
}

function buildStateIndex(input) {
  const workspaceRoots = pathList(input, 'workspace_roots')
    ?? (input.workspace_root ? [requiredPath(input, 'workspace_root')] : null);
  if (!workspaceRoots?.length) {
    throw helperError('missing_workspace_roots', 'workspace_roots[] or workspace_root is required');
  }
  const maxDepth = optionalNumber(input, 'max_depth') ?? 8;
  const limits = scanLimits(input);
  const maxJsonBytes = positiveNumber(input, 'max_json_bytes', DEFAULT_MAX_JSON_BYTES);
  const excludedDirNames = stringList(input, 'excluded_dir_names') ?? [];
  const previous = new Map(
    (Array.isArray(input.previous_json_validation) ? input.previous_json_validation : [])
      .filter((entry) => entry && typeof entry === 'object' && typeof entry.path === 'string')
      .map((entry) => [entry.path, entry]),
  );
  const roots = [];
  const jsonEntries = [];
  let reusedJsonCount = 0;
  for (const root of workspaceRoots) {
    const report = newScanReport(limits);
    scanFiles(root, root, maxDepth, () => true, limits, excludedDirNames, report);
    report.files.sort((left, right) => left.relative_path.localeCompare(right.relative_path));
    for (const file of report.files.filter((entry) => entry.path.endsWith('.json'))) {
      const prior = previous.get(file.path);
      if (prior && prior.bytes === file.bytes && prior.modified_unix_ms === file.modified_unix_ms) {
        jsonEntries.push(prior);
        reusedJsonCount += 1;
      } else {
        jsonEntries.push(validateJsonFile(file, maxJsonBytes));
      }
    }
    roots.push({
      root,
      file_count: report.files.length,
      total_bytes: report.files.reduce((total, file) => total + file.bytes, 0),
      truncated: report.truncated,
      max_files: report.max_files,
      fingerprint: stableFingerprint(report.files),
    });
  }
  return {
    surface_kind: 'native_state_index',
    source_of_truth_rule: SOURCE_OF_TRUTH_RULE,
    roots,
    json_validation: {
      surface_kind: 'large_json_validation_index',
      checked_files_count: jsonEntries.length,
      invalid_files_count: jsonEntries.filter((entry) => !entry.valid && !entry.skipped).length,
      skipped_files_count: jsonEntries.filter((entry) => entry.skipped).length,
      reused_files_count: reusedJsonCount,
      max_json_bytes: maxJsonBytes,
      files: jsonEntries,
    },
  };
}

function buildRuntimeWatch(input) {
  const watchRoots = pathList(input, 'watch_roots')
    ?? (input.workspace_root ? [requiredPath(input, 'workspace_root')] : null);
  if (!watchRoots?.length) {
    throw helperError('missing_watch_roots', 'watch_roots[] or workspace_root is required');
  }
  const maxDepth = optionalNumber(input, 'max_depth') ?? 6;
  const limits = scanLimits(input);
  const excludedDirNames = stringList(input, 'excluded_dir_names') ?? [];
  const roots = watchRoots.map((root) => {
    const report = newScanReport(limits);
    scanFiles(root, root, maxDepth, () => true, limits, excludedDirNames, report);
    return {
      root,
      file_count: report.files.length,
      truncated: report.truncated,
      max_files: report.max_files,
      fingerprint: stableFingerprint(report.files),
    };
  });
  return {
    surface_kind: 'runtime_health_snapshot_index',
    source_of_truth_rule: SOURCE_OF_TRUTH_RULE,
    mode: 'snapshot',
    roots,
  };
}

function scanFiles(root, base, maxDepth, accepts, limits, excludedDirNames, report, depth = 0) {
  if (report.truncated || depth > maxDepth || !fs.existsSync(root)) return;
  let stat;
  try {
    stat = fs.lstatSync(root);
  } catch (error) {
    throw helperError('metadata_failed', `${root}: ${error.message}`);
  }
  if (stat.isSymbolicLink()) return;
  if (stat.isFile()) {
    if (!accepts(root)) return;
    if (report.files.length >= limits.max_files) {
      report.truncated = true;
      return;
    }
    report.files.push(fileEntry(root, base, stat));
    return;
  }
  if (!stat.isDirectory()) return;
  let entries;
  try {
    entries = fs.readdirSync(root, { withFileTypes: true })
      .sort((left, right) => left.name.localeCompare(right.name));
  } catch (error) {
    throw helperError('read_dir_failed', `${root}: ${error.message}`);
  }
  for (const entry of entries) {
    if (report.truncated) return;
    if (entry.isDirectory() && shouldSkipDir(entry.name, excludedDirNames)) continue;
    scanFiles(path.join(root, entry.name), base, maxDepth, accepts, limits, excludedDirNames, report, depth + 1);
  }
}

function fileEntry(filePath, base, stat) {
  return {
    path: filePath,
    relative_path: path.relative(base, filePath) || path.basename(filePath),
    bytes: stat.size,
    modified_unix_ms: Math.trunc(stat.mtimeMs),
  };
}

function validateJsonFile(file, maxJsonBytes) {
  if (file.bytes > maxJsonBytes) {
    return {
      ...file,
      valid: false,
      skipped: true,
      error: null,
      skip_reason: `file exceeds max_json_bytes (${maxJsonBytes})`,
    };
  }
  try {
    JSON.parse(fs.readFileSync(file.path, 'utf8'));
    return { ...file, valid: true, skipped: false, error: null };
  } catch (error) {
    return {
      ...file,
      valid: false,
      skipped: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function stableFingerprint(files) {
  const hash = crypto.createHash('sha256');
  for (const file of [...files].sort((left, right) => left.relative_path.localeCompare(right.relative_path))) {
    hash.update(`${file.relative_path}\0${file.bytes}\0${file.modified_unix_ms ?? ''}\n`);
  }
  return hash.digest('hex');
}

function shouldSkipDir(name, excludedDirNames) {
  return new Set(['.git', '.venv', 'node_modules', 'target', '.worktrees', ...excludedDirNames]).has(name);
}

function extensionMatches(filePath, extensions) {
  const extension = path.extname(filePath).replace(/^\./, '').toLowerCase();
  return extensions.some((candidate) => candidate.toLowerCase() === extension);
}

function newScanReport(limits) {
  return { files: [], truncated: false, max_files: limits.max_files };
}

function scanLimits(input) {
  return { max_files: positiveNumber(input, 'max_files', DEFAULT_MAX_FILES) };
}

function pathList(input, key) {
  if (!Array.isArray(input[key])) return null;
  const values = input[key].filter((value) => typeof value === 'string' && value.trim()).map((value) => value.trim());
  return values.length ? values : null;
}

function stringList(input, key) {
  const values = pathList(input, key)?.map((value) => value.replace(/^\./, ''));
  return values?.length ? values : null;
}

function requiredPath(input, key) {
  const value = optionalString(input, key);
  if (!value) throw helperError(`missing_${key}`, `${key} is required`);
  return value;
}

function optionalString(input, key) {
  return typeof input?.[key] === 'string' ? input[key] : null;
}

function optionalNumber(input, key) {
  if (input?.[key] === undefined) return null;
  return positiveNumber(input, key, null);
}

function positiveNumber(input, key, fallback) {
  if (input?.[key] === undefined) return fallback;
  if (!Number.isSafeInteger(input[key]) || input[key] <= 0) {
    throw helperError('invalid_limit', `${key} must be a positive integer`);
  }
  return input[key];
}

function helperError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}
