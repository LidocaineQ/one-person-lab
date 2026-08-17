import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { parseJsonText } from '../../src/kernel/json-file.ts';
import { discoverTestRoots } from '../../scripts/test-lanes.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..', '..');
const packageJson = parseJsonText(
  fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8'),
) as { scripts?: Record<string, string> };

const structuralGatePatterns = [
  /OPL_QUALITY_DETAILS_COMPARE_REF/,
  /compare_ref="\$\{OPL_QUALITY_DETAILS_COMPARE_REF:-origin\/main\}"/,
  /OPL_QUALITY_DETAILS_TIMEOUT_SECONDS/,
  /quality_details_timeout_seconds="\$\{OPL_QUALITY_DETAILS_TIMEOUT_SECONDS:-240\}"/,
  /run_quality_details_with_timeout\(\)/,
  /node \.\/scripts\/run-quality-details-with-timeout\.mjs/,
  /sentrux gate \./,
  /Compare ref \$\{compare_ref\} is unavailable; using HEAD\^ for quality details\./,
  /Sentrux baseline regression reported structural drift/,
  /OPL quality details exceeded \$\{quality_details_timeout_seconds\}s in the local structure gate/,
  /Structural quality findings are advisory/,
  /use it to select a natural refactor boundary rather than blocking unrelated work/,
  /sentrux check \./,
];

const qualityDetailsTimeoutHelperPatterns = [
  /const \[timeoutRaw, qualityDetailsBin, compareRef, limit, focus\] = process\.argv\.slice\(2\)/,
  /spawnSync\(/,
  /timeout: timeoutSeconds \* 1000/,
  /killSignal: 'SIGKILL'/,
  /result\.error\?\.code === 'ETIMEDOUT'/,
  /process\.exit\(124\)/,
  /'quality',\s*'details',\s*'--root',\s*'\.'/,
  /'--compare-ref',\s*compareRef/,
];

const verifyWorkflowTriggerPatterns = [
  /on:\n\s+workflow_dispatch:\n\s+schedule:\n\s+- cron: '7 19 \* \* 0'/,
  /concurrency:\n\s+group: \$\{\{ github\.workflow \}\}-\$\{\{ github\.ref \}\}/,
  /cancel-in-progress: true/,
];

const sourceCiWorkflowPatterns = [
  /name: CI/,
  /push:\n\s+branches: \[main\]/,
  /pull_request:\n\s+branches: \[main\]/,
  /runs-on: ubuntu-latest/,
  /npm run build/,
  /npm run typecheck/,
  /npm run lint/,
  /npm test/,
];

const verifyWorkflowBuildAndJsLanePatterns = [
  /npm ci/,
  /npm run build/,
  /npm run typecheck/,
  /npm run test:fast/,
  /npm run test:read-model-gates/,
  /npm run test:regression/,
  /npm run test:integration/,
  /npm run test:fresh-install/,
  /FORCE_JAVASCRIPT_ACTIONS_TO_NODE24: 'true'/,
  /javascript:\n\s+name: \$\{\{ matrix\.name \}\}/,
  /timeout-minutes: \$\{\{ matrix\.timeout_minutes \}\}/,
  /strategy:\n\s+fail-fast: false\n\s+matrix:\n\s+include:/,
  /run: \$\{\{ matrix\.command \}\}/,
];

const verifyWorkflowNativeAndStructurePatterns = [
  /\.\/scripts\/verify\.sh native/,
  /\.\/scripts\/verify\.sh lint/,
  /\.\/scripts\/verify\.sh structure/,
  /\.\/scripts\/install-sentrux-ci\.sh/,
  /OPL_QUALITY_DETAILS_TIMEOUT_SECONDS: '240'/,
  /fetch-depth: 0/,
  /git fetch --no-tags origin \+main:refs\/remotes\/origin\/main/,
];

const qualityDetailsActionPatterns = [
  /actions\/setup-node@v6/,
  /node-version: '24'/,
  /npm ci --prefix "\$GITHUB_ACTION_PATH\/\.\.\/\.\.\/\.\."/,
  /node "\$GITHUB_ACTION_PATH\/emit-quality-details\.mjs"/,
  /OPL_QUALITY_DETAILS_COMPARE_REF/,
  /OPL_QUALITY_DETAILS_TIMEOUT_SECONDS/,
  /timeout-seconds/,
];

const qualityDetailsActionScriptPatterns = [
  /const qualityRoot = fs\.realpathSync\(rootInput\)/,
  /execFileSync\('git', \['-C', qualityRoot, 'fetch', '--no-tags', 'origin'/,
  /execFileSync\('git', \['-C', qualityRoot, 'rev-parse', '--verify'/,
  /compareArgs\.push\('--compare-ref', compareRef\)/,
  /function runOplQualityDetails\(args, outputFile\)/,
  /child\.kill\('SIGTERM'\)/,
  /status: 124/,
  /function writeDiagnostic\(status, reason\)/,
  /diagnostic:/,
  /qualityDetailsArgs\('markdown', markdownLimit\)/,
  /qualityDetailsArgs\('json', jsonLimit\)/,
];

const expectedTestScripts = {
  'test:smoke': 'node ./scripts/test-lanes.mjs run smoke',
  'test:fast': 'node ./scripts/test-lanes.mjs run fast',
  'test:meta': 'node ./scripts/test-lanes.mjs run meta',
  'test:read-model-gates': 'node ./scripts/test-lanes.mjs run read-model-gates',
  'test:regression': 'node ./scripts/test-lanes.mjs run regression',
  'test:integration': 'node ./scripts/test-lanes.mjs run integration',
  'test:stage-run-mag-integration': 'node ./scripts/test-lanes.mjs run stage-run-mag-integration',
  'test:artifact': 'node ./scripts/test-lanes.mjs run artifact',
  'test:fresh-install': 'node ./scripts/test-lanes.mjs run fresh-install',
  'test:native': './scripts/verify.sh native',
  'test:structure': './scripts/verify.sh structure',
  'test:full': 'npm run test:artifact && npm run test:fast && npm run test:fresh-install && npm run test:structure && npm run typecheck && npm run lint && npm run test:read-model-gates && npm run test:meta && npm run test:regression && npm run test:integration && npm run test:native',
  test: 'npm run test:smoke',
};

function read(relativePath: string) {
  return fs.readFileSync(path.join(repoRoot, relativePath), 'utf8');
}

function assertFilePatterns(relativePath: string, patterns: RegExp[]) {
  const content = read(relativePath);
  for (const pattern of patterns) {
    assert.match(content, pattern);
  }
}

test('local structural quality gate emits compare-ref quality details on Sentrux failures', () => {
  assertFilePatterns('scripts/run-structural-quality-gate.sh', structuralGatePatterns);
  assertFilePatterns('scripts/run-quality-details-with-timeout.mjs', qualityDetailsTimeoutHelperPatterns);
  const shell = read('scripts/run-structural-quality-gate.sh');
  assert.doesNotMatch(shell, /spawnSync\(/);
  assert.doesNotMatch(shell, /<<'NODE'/);
});

test('GitHub verification workflow runs weekly or manually without per-change duplication', () => {
  const workflow = read('.github/workflows/verify.yml');
  assertFilePatterns('.github/workflows/verify.yml', verifyWorkflowTriggerPatterns);
  assert.doesNotMatch(workflow, /^  push:/m);
  assert.doesNotMatch(workflow, /^  pull_request:/m);
});

test('GitHub source CI keeps the per-change gate focused on source validation', () => {
  const workflow = read('.github/workflows/ci.yml');
  assertFilePatterns('.github/workflows/ci.yml', sourceCiWorkflowPatterns);
  assert.doesNotMatch(
    workflow,
    /cargo test|native:|test:fast|test:integration|test:regression|test:fresh-install|electron-builder|docker build|publish|release/,
  );
});

test('GitHub verification workflow runs build and JavaScript test gates', () => {
  assertFilePatterns('.github/workflows/verify.yml', verifyWorkflowBuildAndJsLanePatterns);
  const workflow = read('.github/workflows/verify.yml');
  assert.equal(
    [...workflow.matchAll(/uses: actions\/checkout@/g)].length,
    [...workflow.matchAll(/fetch-depth: 0/g)].length,
    'Every Verify checkout must retain history for source identity and ancestry gates.',
  );
});

test('GitHub verification workflow runs native and local structure gates', () => {
  assertFilePatterns('.github/workflows/verify.yml', verifyWorkflowNativeAndStructurePatterns);
});

test('canonical native verification keeps fixture smoke in the same isolated environment', () => {
  assertFilePatterns('scripts/verify.sh', [
    /npm run native:family-smoke -- --fixture --require-real-workspaces/,
  ]);
});

test('quality details action stays reusable without a duplicate advisory workflow', () => {
  assert.equal(
    fs.existsSync(path.join(repoRoot, '.github/workflows/sentrux-advisory.yml')),
    false,
  );
  assertFilePatterns('.github/actions/quality-details/action.yml', qualityDetailsActionPatterns);
  assertFilePatterns('.github/actions/quality-details/emit-quality-details.mjs', qualityDetailsActionScriptPatterns);
});

test('native helper qualification stays on the Node standard-library smoke gate', () => {
  const workflow = read('.github/workflows/verify.yml');
  assert.match(workflow, /name: Native helper lane/);
  assert.match(workflow, /npm ci/);
  assert.match(workflow, /\.\/scripts\/verify\.sh native/);
  assert.doesNotMatch(workflow, /rust-toolchain|cargo|native-helper-prebuild/);
});

test('lint remains independent while legacy line-budget strict naming is an advisory alias', () => {
  assert.equal(packageJson.scripts?.lint, 'node ./scripts/lint.mjs');
  assert.equal(packageJson.scripts?.['line-budget'], 'node ./scripts/line-budget.mjs');
  assert.equal(packageJson.scripts?.['line-budget:strict'], 'node ./scripts/line-budget.mjs');
  assert.equal(fs.existsSync(path.join(repoRoot, 'scripts/line-budget.mjs')), true);
});

test('line-budget contract is advisory-only and has no per-file lock ledger', () => {
  const contractPath = path.join(repoRoot, 'contracts/opl-framework/source-structure-budget.json');
  const contract = parseJsonText(fs.readFileSync(contractPath, 'utf8')) as {
    contract_kind?: string;
    default_limit?: number;
    baseline_policy?: { mode?: string };
    reasonable_refactor_policy?: {
      mode?: string;
      preferred_split_boundaries?: string[];
      characterization_first?: string[];
      completion_policy?: string;
    };
    reviewed_baselines?: Array<Record<string, unknown>>;
  };
  const script = read('scripts/line-budget.mjs');

  assert.equal(contract.contract_kind, 'opl_source_structure_budget.v1');
  assert.equal(contract.default_limit, 1000);
  assert.equal(contract.baseline_policy?.mode, 'advisory_inventory_only');
  assert.equal(contract.reasonable_refactor_policy?.mode, 'line_budget_as_signal_not_splitter');
  assert.ok(contract.reasonable_refactor_policy?.preferred_split_boundaries?.includes('test_scenario'));
  assert.ok(contract.reasonable_refactor_policy?.characterization_first?.includes('runtime_authority'));
  assert.equal(
    contract.reasonable_refactor_policy?.completion_policy,
    'selected_batch_verified_or_no_safe_high_value_candidate',
  );
  assert.deepEqual(contract.reviewed_baselines, []);
  assert.match(script, /source-structure-budget\.json/);
  assert.match(script, /line budget advisory/);
  assert.match(script, /--strict/);
  assert.match(script, /OPL_LINE_BUDGET_STRICT/);
  assert.match(script, /enforcement: 'advisory_only'/);
  assert.match(script, /split only when a natural boundary exists/);
  const findingsBranchStart = script.indexOf('if (findings.length > 0) {');
  const firstHelperStart = script.indexOf('\nfunction isCodeFile', findingsBranchStart);
  assert.notEqual(findingsBranchStart, -1);
  assert.notEqual(firstHelperStart, -1);
  assert.doesNotMatch(script.slice(findingsBranchStart, firstHelperStart), /process\.exit\(/);
  assert.doesNotMatch(script, /ratchet baseline blocks growth/);
});

test('reasonable refactor patrol keeps selection evidence-led and fork bodies excluded', () => {
  const contract = parseJsonText(
    read('contracts/opl-framework/reasonable-refactor-patrol.json'),
  ) as {
    contract_kind?: string;
    owner?: string;
    state?: string;
    scope?: {
      excluded_repositories?: string[];
      excluded_path_prefixes?: Record<string, string[]>;
    };
    execution_policy?: Record<string, unknown>;
    forbidden_patterns?: string[];
  };

  assert.equal(contract.contract_kind, 'opl_reasonable_refactor_patrol.v1');
  assert.equal(contract.owner, 'one-person-lab');
  assert.equal(contract.state, 'active_contract');
  assert.equal(contract.execution_policy?.mode, 'wide_probe_narrow_mutate');
  assert.equal(contract.execution_policy?.fixed_candidate_quota, false);
  assert.equal(contract.execution_policy?.fixed_selected_package_quota, false);
  assert.equal(contract.execution_policy?.fixed_line_budget_percentage, false);
  assert.equal(contract.execution_policy?.single_package_policy, 'allowed_when_it_is_the_highest_value_coherent_executable_batch');
  assert.ok((contract as any).candidate?.required_authority_fields?.includes('source_provenance_class'));
  assert.equal((contract as any).provenance_policy?.no_caller_is, 'investigation_signal_only');
  assert.ok(contract.forbidden_patterns?.includes('delete_user_requested_or_externally_learned_reserve'));
  assert.equal(
    (contract as any).provenance_policy?.known_protected_reserve_capabilities?.[0]?.owner_surface,
    'src/adapters/integration/opl-connect-reference-ncbi.ts',
  );
  assert.deepEqual(contract.scope?.excluded_repositories, ['opl-aion-shell']);
  assert.deepEqual(
    contract.scope?.excluded_path_prefixes?.['one-person-lab-app'],
    ['shells/aionui/', '_external/hermes-agent/'],
  );
  assert.ok(contract.forbidden_patterns?.includes('codex_ops_kit_default_methodology'));
  assert.ok(contract.forbidden_patterns?.includes('fixed_subagent_choreography'));
  assert.equal(
    packageJson.scripts?.['refactor:patrol:contract'],
    'node ./scripts/refactor-patrol-state.mjs contract',
  );
  assert.equal(
    packageJson.scripts?.['refactor:patrol:validate'],
    'node ./scripts/refactor-patrol-state.mjs validate',
  );
});

test('package.json exposes repo hygiene check and cleanup entrypoints', () => {
  assert.equal(packageJson.scripts?.['repo:hygiene'], 'scripts/repo-hygiene.sh');
  assert.equal(packageJson.scripts?.['repo:hygiene:fix'], 'scripts/repo-hygiene.sh --fix');
});

test('test lane discovery admits new roots without executing imported children separately', () => {
  const sources = new Map([
    ['tests/src/new-root.test.ts', "import './new-root-child.test.ts';\n"],
    ['tests/src/new-root-child.test.ts', "import test from 'node:test';\n"],
  ]);

  assert.deepEqual(
    discoverTestRoots([...sources.keys()], (relativePath) => sources.get(relativePath) ?? ''),
    ['tests/src/new-root.test.ts'],
  );
});

test('package.json exposes a single test lane registry for active test ownership', () => {
  const registryPath = path.join(repoRoot, 'scripts/test-lanes.mjs');
  assert.equal(fs.existsSync(registryPath), true);

  for (const [scriptName, command] of Object.entries(expectedTestScripts)) {
    assert.equal(packageJson.scripts?.[scriptName], command);
  }

  const coverage = spawnSync(process.execPath, [registryPath, 'assert-coverage'], {
    cwd: repoRoot,
    encoding: 'utf8',
    env: {
      ...process.env,
      NODE_NO_WARNINGS: '1',
    },
  });

  assert.equal(coverage.status, 0, coverage.stderr);
});

test('test:full composes the existing lanes through standard npm ordering', () => {
  assert.deepEqual(packageJson.scripts?.['test:full']?.split(' && '), [
    'npm run test:artifact',
    'npm run test:fast',
    'npm run test:fresh-install',
    'npm run test:structure',
    'npm run typecheck',
    'npm run lint',
    'npm run test:read-model-gates',
    'npm run test:meta',
    'npm run test:regression',
    'npm run test:integration',
    'npm run test:native',
  ]);
  assert.doesNotMatch(
    read('scripts/test-lanes.mjs'),
    /buildUniqueFullLanePlan|duplicateTestImportClosure|Execution planning is only available/,
  );
});
