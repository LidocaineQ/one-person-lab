import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { parseArgs as parseNodeArgs } from 'node:util';

import { countLines } from './source-line-count.mjs';
import { readJsonFile } from './script-json-boundary.mjs';

const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const CODE_EXTENSIONS = new Set(['.js', '.jsx', '.mjs', '.cjs', '.ts', '.tsx', '.mts', '.cts', '.py', '.sh', '.bash', '.zsh', '.rs', '.go']);
const IGNORED_PARTS = new Set(['node_modules', 'dist', 'build', 'coverage', '.venv', '__pycache__']);
const IGNORED_SUFFIXES = ['.min.js'];

const args = parseCliOptions(process.argv.slice(2));
if (args.help) {
  printHelp();
  process.exit(0);
}

const strictRequested = args.strict || legacyStrictEnvRequested(process.env.OPL_LINE_BUDGET_STRICT);
const targetRoot = args.root ? path.resolve(args.root) : repoRoot;
const contractPath = args.baseline
  ? path.resolve(args.baseline)
  : path.join(targetRoot, 'contracts', 'opl-framework', 'source-structure-budget.json');
const contract = loadContract(contractPath);

process.chdir(targetRoot);

const trackedFiles = spawnSync('git', ['ls-files'], { encoding: 'utf8' });
if (trackedFiles.status !== 0) {
  process.stderr.write(trackedFiles.stderr || 'line budget: git ls-files failed\n');
  process.exit(trackedFiles.status ?? 1);
}

const oversize = [];
const findings = [...contract.findings];
for (const relativePath of trackedFiles.stdout.split('\n').filter(Boolean)) {
  if (!isCodeFile(relativePath)) continue;
  const absolutePath = path.join(targetRoot, relativePath);
  if (!fs.existsSync(absolutePath)) continue;
  const lineCount = countLines(fs.readFileSync(absolutePath, 'utf8'));
  if (lineCount <= contract.defaultLimit) continue;
  oversize.push([relativePath, lineCount]);
  findings.push(
    `${relativePath}: ${lineCount} lines exceeds the ${contract.defaultLimit} line advisory; inspect maintenance risk and split only when a natural boundary exists`,
  );
}

oversize.sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]));

if (args.mode === 'list') {
  if (args.format === 'json') {
    writeJsonSummary({ findings, oversize, strictRequested });
  } else {
    for (const [relativePath, lineCount] of oversize) {
      process.stdout.write(`${String(lineCount).padStart(6, ' ')} ${relativePath}\n`);
    }
  }
  process.exit(0);
}

if (args.format === 'json') {
  writeJsonSummary({ findings, oversize, strictRequested });
  process.exit(0);
}

if (findings.length > 0) {
  process.stderr.write(`line budget advisory (${findings.length} finding${findings.length === 1 ? '' : 's'}):\n`);
  process.stderr.write(findings.map((finding) => `- ${finding}`).join('\n'));
  process.stderr.write('\n');
}

function isCodeFile(relativePath) {
  const parts = relativePath.split('/');
  if (parts.some((part) => IGNORED_PARTS.has(part))) return false;
  if (IGNORED_SUFFIXES.some((suffix) => relativePath.endsWith(suffix))) return false;
  return CODE_EXTENSIONS.has(path.extname(relativePath));
}

function parseCliOptions(argv) {
  try {
    const { values } = parseNodeArgs({
      args: argv,
      options: {
        list: { type: 'boolean', default: false },
        strict: { type: 'boolean', default: false },
        root: { type: 'string' },
        baseline: { type: 'string' },
        format: { type: 'string', default: 'text' },
        help: { type: 'boolean', default: false },
      },
      strict: true,
      allowPositionals: false,
    });
    const parsed = {
      mode: values.list ? 'list' : 'check',
      root: values.root ?? null,
      baseline: values.baseline ?? null,
      format: values.format,
      help: values.help === true,
      strict: values.strict === true,
    };
    if (!['text', 'json'].includes(parsed.format)) {
      process.stderr.write('line budget: --format must be text or json\n');
      process.exit(1);
    }
    return parsed;
  } catch (error) {
    process.stderr.write(`line budget: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  }
}

function printHelp() {
  process.stdout.write([
    'Usage: node scripts/line-budget.mjs [options]',
    '',
    'Options:',
    '  --root <path>       Repo root to inspect.',
    '  --baseline <path>   Source structure budget contract.',
    '  --list              Print oversized tracked files.',
    '  --strict            Legacy compatibility alias; findings remain advisory.',
    '  --format <text|json> Output text or machine JSON. Default: text.',
    '  --help              Print this help.',
    '',
  ].join('\n'));
}

function writeJsonSummary(input) {
  process.stdout.write(`${JSON.stringify({
    surface_kind: 'opl_line_budget_check',
    status: input.findings.length === 0 ? 'ok' : 'advisory',
    mode: args.mode,
    enforcement: 'advisory_only',
    strict_requested: input.strictRequested,
    strict: false,
    root: targetRoot,
    contract: path.relative(targetRoot, contractPath),
    baseline: path.relative(targetRoot, contractPath),
    default_limit: contract.defaultLimit,
    oversize_count: input.oversize.length,
    finding_count: input.findings.length,
    failure_count: 0,
    oversize_files: input.oversize.map(([relativePath, lineCount]) => ({
      path: relativePath,
      line_count: lineCount,
    })),
    findings: input.findings,
    failures: [],
  }, null, 2)}\n`);
}

function legacyStrictEnvRequested(value) {
  return value === '1' || value === 'true' || value === 'yes';
}

function loadContract(file) {
  const findings = [];
  if (!fs.existsSync(file)) {
    findings.push(`${path.relative(targetRoot, file)}: source structure budget contract is missing; using the default advisory threshold`);
    return { defaultLimit: 1000, findings };
  }

  let parsed;
  try {
    parsed = readJsonFile(file);
  } catch (error) {
    findings.push(`${path.relative(targetRoot, file)}: source structure budget contract is not valid JSON: ${error.message}`);
    return { defaultLimit: 1000, findings };
  }

  const defaultLimit = positiveInteger(parsed.default_limit) ?? 1000;
  if (positiveInteger(parsed.default_limit) === null) {
    findings.push(`${path.relative(targetRoot, file)}: default_limit must be a positive integer; using 1000`);
  }
  if (parsed.contract_kind !== 'opl_source_structure_budget.v1') {
    findings.push(`${path.relative(targetRoot, file)}: contract_kind should be opl_source_structure_budget.v1`);
  }
  if (parsed.baseline_policy?.mode !== 'advisory_inventory_only') {
    findings.push(`${path.relative(targetRoot, file)}: baseline_policy.mode should be advisory_inventory_only; line-count findings still remain advisory`);
  }

  return { defaultLimit, findings };
}

function positiveInteger(value) {
  return Number.isInteger(value) && value > 0 ? value : null;
}
