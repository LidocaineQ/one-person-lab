import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { readJsonFileResult } from '../../kernel/json-file.ts';

const CODE_EXTENSIONS = new Set([
  '.js',
  '.jsx',
  '.mjs',
  '.cjs',
  '.ts',
  '.tsx',
  '.mts',
  '.cts',
  '.py',
  '.sh',
  '.bash',
  '.zsh',
  '.rs',
  '.go',
]);
const IGNORED_PARTS = new Set(['node_modules', 'dist', 'build', 'coverage', '.venv', '__pycache__']);
const IGNORED_SUFFIXES = ['.min.js'];

type SourceStructureContract = {
  contract_kind?: string;
  surface_kind?: string;
  owner?: string;
  purpose?: string;
  state?: string;
  machine_boundary?: string;
  default_limit?: number;
  advisory_near_limit?: number;
  baseline_policy?: {
    mode?: string;
    default_developer_behavior?: string;
    compatibility_entrypoints?: string[];
  };
  reasonable_refactor_policy?: Record<string, unknown>;
  reviewed_baselines?: unknown[];
};

type SourceFileCount = {
  path: string;
  line_count: number;
  over_default_limit: boolean;
  near_limit: boolean;
  reviewed_baseline_limit: number | null;
  reviewed_baseline_status: 'not_applicable';
};

type SourceStructureFinding = {
  finding_kind:
    | 'contract_invalid'
    | 'oversized_file';
  path: string;
  line_count: number | null;
  limit: number | null;
  strict_blocks: boolean;
  message: string;
};

type SourceStructureReadbackOptions = {
  repoRoot?: string;
  contractPath?: string;
  strict?: boolean;
};

function currentSourceRoot() {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
}

function positiveInteger(value: unknown) {
  return Number.isInteger(value) && Number(value) > 0 ? Number(value) : null;
}

function countLines(content: string) {
  if (content.length === 0) {
    return 0;
  }
  return content.endsWith('\n') ? content.split('\n').length - 1 : content.split('\n').length;
}

function isCodeFile(relativePath: string) {
  const parts = relativePath.split('/');
  if (parts.some((part) => IGNORED_PARTS.has(part))) {
    return false;
  }
  if (IGNORED_SUFFIXES.some((suffix) => relativePath.endsWith(suffix))) {
    return false;
  }
  return CODE_EXTENSIONS.has(path.extname(relativePath));
}

function readJsonContract(contractPath: string) {
  const failures: SourceStructureFinding[] = [];
  const result = readJsonFileResult(contractPath);
  if (result.status === 'missing') {
    failures.push({
      finding_kind: 'contract_invalid',
      path: path.basename(contractPath),
      line_count: null,
      limit: null,
      strict_blocks: false,
      message: 'source structure budget contract is missing',
    });
    return { contract: null, failures };
  }

  if (result.status === 'invalid_json') {
    failures.push({
      finding_kind: 'contract_invalid',
      path: path.basename(contractPath),
      line_count: null,
      limit: null,
      strict_blocks: false,
      message: `source structure budget contract is not valid JSON: ${result.error}`,
    });
    return { contract: null, failures };
  }

  return {
    contract: result.payload as SourceStructureContract,
    failures,
  };
}

function loadContract(contractPath: string) {
  const { contract, failures } = readJsonContract(contractPath);
  const defaultLimit = positiveInteger(contract?.default_limit) ?? 1000;
  const advisoryNearLimit = positiveInteger(contract?.advisory_near_limit) ?? Math.max(1, defaultLimit - 150);

  if (!contract) {
    return {
      contract,
      defaultLimit,
      advisoryNearLimit,
      failures,
    };
  }

  if (contract.contract_kind !== 'opl_source_structure_budget.v1') {
    failures.push({
      finding_kind: 'contract_invalid',
      path: contractPath,
      line_count: null,
      limit: null,
      strict_blocks: false,
      message: 'contract_kind must be opl_source_structure_budget.v1',
    });
  }
  if (positiveInteger(contract.default_limit) === null) {
    failures.push({
      finding_kind: 'contract_invalid',
      path: contractPath,
      line_count: null,
      limit: null,
      strict_blocks: false,
      message: 'default_limit must be a positive integer',
    });
  }
  if (contract.baseline_policy?.mode !== 'advisory_inventory_only') {
    failures.push({
      finding_kind: 'contract_invalid',
      path: contractPath,
      line_count: null,
      limit: null,
      strict_blocks: false,
      message: 'baseline_policy.mode should be advisory_inventory_only',
    });
  }
  if (Array.isArray(contract.reviewed_baselines) && contract.reviewed_baselines.length > 0) {
    failures.push({
      finding_kind: 'contract_invalid',
      path: contractPath,
      line_count: null,
      limit: null,
      strict_blocks: false,
      message: 'reviewed_baselines is retired and must remain empty',
    });
  }

  return {
    contract,
    defaultLimit,
    advisoryNearLimit,
    failures,
  };
}

function listTrackedFiles(repoRoot: string) {
  const result = spawnSync('git', ['ls-files'], { cwd: repoRoot, encoding: 'utf8' });
  if (result.status !== 0) {
    throw new Error(result.stderr || 'source structure readback: git ls-files failed');
  }
  return result.stdout.split('\n').filter(Boolean);
}

function readHeadSha(repoRoot: string) {
  const result = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: repoRoot, encoding: 'utf8' });
  if (result.status !== 0) {
    return null;
  }
  return result.stdout.trim() || null;
}

function sourceFileCount(
  repoRoot: string,
  relativePath: string,
  defaultLimit: number,
  advisoryNearLimit: number,
): SourceFileCount | null {
  if (!isCodeFile(relativePath)) {
    return null;
  }
  const absolutePath = path.join(repoRoot, relativePath);
  if (!fs.existsSync(absolutePath)) {
    return null;
  }
  const lineCount = countLines(fs.readFileSync(absolutePath, 'utf8'));

  return {
    path: relativePath,
    line_count: lineCount,
    over_default_limit: lineCount > defaultLimit,
    near_limit: lineCount >= advisoryNearLimit,
    reviewed_baseline_limit: null,
    reviewed_baseline_status: 'not_applicable',
  };
}

export function buildSourceStructureOperatorReadback(
  options: SourceStructureReadbackOptions = {},
) {
  const repoRoot = path.resolve(options.repoRoot ?? currentSourceRoot());
  const contractPath = path.resolve(
    options.contractPath
      ?? path.join(repoRoot, 'contracts', 'opl-framework', 'source-structure-budget.json'),
  );
  const contractModel = loadContract(contractPath);
  const trackedFiles = listTrackedFiles(repoRoot);
  const sourceFiles = trackedFiles
    .map((relativePath) =>
      sourceFileCount(
        repoRoot,
        relativePath,
        contractModel.defaultLimit,
        contractModel.advisoryNearLimit,
      ))
    .filter((entry): entry is SourceFileCount => entry !== null);
  const oversizedFiles = sourceFiles
    .filter((entry) => entry.over_default_limit)
    .sort((left, right) => right.line_count - left.line_count || left.path.localeCompare(right.path));
  const nearLimitFiles = sourceFiles
    .filter((entry) => entry.near_limit && !entry.over_default_limit)
    .sort((left, right) => right.line_count - left.line_count || left.path.localeCompare(right.path));
  const findings: SourceStructureFinding[] = [...contractModel.failures];

  for (const file of oversizedFiles) {
    findings.push({
      finding_kind: 'oversized_file',
      path: file.path,
      line_count: file.line_count,
      limit: contractModel.defaultLimit,
      strict_blocks: false,
      message:
        `${file.path}: ${file.line_count} lines exceeds the ${contractModel.defaultLimit} line advisory; inspect maintenance risk and split only when a natural boundary exists`,
    });
  }

  return {
    version: 'g2',
    source_structure_operator_readback: {
      surface_kind: 'opl_source_structure_operator_readback',
      readback_role:
        'operator_source_structure_guard_not_completion_audit_not_readiness_or_quality_verdict',
      owner: 'one-person-lab',
      repo_root: repoRoot,
      head_sha: readHeadSha(repoRoot),
      contract_ref:
        `contracts/opl-framework/source-structure-budget.json#${contractModel.contract?.contract_kind ?? 'missing'}`,
      contract_surface_kind: contractModel.contract?.surface_kind ?? 'opl_source_structure_budget',
      validator_refs: [
        'scripts/line-budget.mjs',
        'npm run line-budget',
        'npm run line-budget:strict',
        './scripts/verify.sh line-budget:strict',
        './scripts/verify.sh structure:strict',
      ],
      mode: options.strict ? 'strict_readback' : 'advisory_readback',
      enforcement_mode: 'advisory_only',
      strict_requested: options.strict === true,
      default_limit: contractModel.defaultLimit,
      advisory_near_limit: contractModel.advisoryNearLimit,
      baseline_policy: contractModel.contract?.baseline_policy ?? {
        mode: 'missing_contract',
      },
      reviewed_baseline_count: 0,
      tracked_source_file_count: sourceFiles.length,
      oversized_file_count: oversizedFiles.length,
      near_limit_file_count: nearLimitFiles.length,
      strict_blocking_finding_count: 0,
      strict_ratchet_passed: true,
      advisory_passed: true,
      status: findings.length === 0
        ? 'source_structure_guard_clean'
        : 'source_structure_guard_findings_require_maintenance',
      oversized_files: oversizedFiles,
      near_limit_files: nearLimitFiles,
      findings,
      strict_entrypoints: contractModel.contract?.baseline_policy?.compatibility_entrypoints ?? [
        'scripts/line-budget.mjs --strict',
        'OPL_LINE_BUDGET_STRICT=1 node scripts/line-budget.mjs',
        'npm run line-budget:strict',
        './scripts/verify.sh line-budget:strict',
        './scripts/verify.sh structure:strict',
      ],
      authority_boundary: {
        can_claim_domain_ready: false,
        can_claim_app_release_ready: false,
        can_claim_production_ready: false,
        can_claim_quality_verdict: false,
        can_claim_plan_completion: false,
        can_authorize_physical_delete: false,
        can_write_owner_receipt: false,
        can_create_second_source_truth: false,
      },
      false_ready_guard: {
        line_budget_clean_can_claim_ready: false,
        strict_ratchet_passed_can_claim_ready: false,
        source_structure_readback_can_claim_goal_complete: false,
        docs_or_tests_can_replace_live_evidence: false,
        findings_are_maintenance_signal_not_domain_blocker: true,
      },
    },
  };
}
