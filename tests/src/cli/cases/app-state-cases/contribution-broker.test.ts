import { pathToFileURL } from 'node:url';

import {
  assert,
  fs,
  os,
  path,
  runCli,
  runCliFailure,
  test,
} from '../../helpers.ts';
import {
  parseAppContributionArgs,
  runAppContribution,
} from '../../../../../src/modules/console/app-contribution-broker.ts';
import type { InstalledPackageDescriptor } from '../../../../../src/modules/connect/agent-package-registry-parts/installed-codex-plugin-directory.ts';
import { formatJsonPayload } from '../../../../../src/kernel/json-file.ts';
import { createFakeCodexFixture } from '../../helpers-parts/fixtures.ts';

const requestSchema = 'opl-package-app-contribution-request.v1';
const responseSchema = 'opl-package-app-contribution-response.v1';

function writeContributionFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'opl-app-contribution-package-'));
  const command = path.join(root, 'bin', 'contribution');
  fs.mkdirSync(path.dirname(command), { recursive: true });
  fs.writeFileSync(
    command,
    `#!/usr/bin/env node
let input = '';
process.stdin.on('data', (chunk) => { input += chunk; });
process.stdin.on('end', () => {
  const request = JSON.parse(input);
  process.stdout.write(JSON.stringify({
    schema_version: '${responseSchema}',
    ok: true,
    ref: request.ref,
    operation: request.operation,
    result: { owner_echo: request.input, source: 'fixture-owner' },
  }));
});
`,
    { encoding: 'utf8', mode: 0o755 },
  );
  const manifest = {
    surface_kind: 'opl_agent_package_manifest.v1',
    package_id: 'future.contribution.package',
    agent_id: 'future-contribution-package',
    display_name: 'Future Contribution Package',
    publisher: 'fixture-owner',
    version: '1.0.0',
    source: 'third_party',
    carrier_source_role: 'codex_plugin_default_carrier_not_package_truth',
    codex_surface: {
      plugin_id: 'future-contribution-package',
      required_skill_ids: ['future-contribution-package'],
      app_contribution_abi: {
        schema_version: 'opl-package-app-contribution-cli.v1',
        transport: 'stdin_json_stdout_json',
        argv: ['./bin/contribution'],
        request_schema: requestSchema,
        response_schema: responseSchema,
      },
    },
    capability_dependencies: [],
    skill_packs: [],
    entrypoints: [],
    health_check: {},
    permissions: [],
    update_channel: 'manifest_url',
    rollback_ref: 'native-carrier-owned',
    app_contributions: {
      schema_version: 'opl-app-contributions.v1',
      navigation: [{
        navigation_id: 'future.home',
        label_i18n: { 'en-US': 'Future' },
        view_id: 'future.view',
      }],
      views: [{
        view_id: 'future.view',
        view_type: 'activity_log',
        title_i18n: { 'en-US': 'Future data' },
        data_ref: 'future.data.v1#current',
        command_ids: ['future.write'],
        badge_ids: [],
      }],
      commands: [{
        command_id: 'future.write',
        label_i18n: { 'en-US': 'Write future data' },
        action_ref: 'future.data.v1#write',
        confirmation_required: false,
      }, {
        command_id: 'future.write.alias',
        label_i18n: { 'en-US': 'Write future data alias' },
        action_ref: 'future.data.v1#write',
        confirmation_required: true,
      }],
      badges: [],
    },
  };
  fs.writeFileSync(path.join(root, 'opl-package.json'), formatJsonPayload(manifest));
  const descriptor = {
    manifest,
    manifestPath: path.join(root, 'opl-package.json'),
    sourcePath: root,
    pluginId: 'future-contribution-package@fixture-marketplace',
    marketplaceSource: root,
    enabled: true,
    carrier: {
      packageId: manifest.package_id,
      carrier: {
        kind: 'codex_plugin_manager',
        pluginId: 'future-contribution-package@fixture-marketplace',
        marketplaceSource: root,
      },
      executor: { route: 'codex_cli', requiredSkillIds: ['future-contribution-package'] },
      publicationRef: null,
    },
    carrier_readback: {
      kind: 'local',
      identity: 'future-contribution-package@fixture-marketplace',
      source_ref: root,
      version: '1.0.0',
      enabled: true,
      lifecycle_authority: 'carrier_owned',
    },
    readiness: {
      installed: true,
      physical_status: 'available',
      callability: 'callable',
      legacy_lifecycle_state_present: false,
    },
  } as unknown as InstalledPackageDescriptor;
  return { root, descriptor, manifest };
}

function fakeCodexList(sourcePath: string) {
  return createFakeCodexFixture(`
if [[ "$1" == "plugin" && "$2" == "list" && "$3" == "--json" ]]; then
  cat <<'JSON'
${JSON.stringify({
  installed: [{
    pluginId: 'future-contribution-package@fixture-marketplace',
    version: '1.0.0',
    installed: true,
    enabled: true,
    source: { source: 'local', path: sourcePath },
    marketplaceSource: { sourceType: 'local', source: sourcePath },
  }],
})}
JSON
  exit 0
fi
exit 2
`);
}

test('generic broker reads a dynamically installed descriptor contribution without lifecycle state', () => {
  const fixture = writeContributionFixture();
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opl-app-contribution-state-'));
  try {
    const output = runAppContribution({
      packageId: fixture.manifest.package_id,
      ref: 'future.data.v1#current',
      operation: 'read',
      input: { cursor: 'before-now' },
      confirmed: false,
    }, {
      discover: () => new Map([[fixture.manifest.package_id, fixture.descriptor]]),
    }) as any;
    assert.equal(output.opl_app_contribution.package_id, fixture.manifest.package_id);
    assert.equal(output.opl_app_contribution.response.result.owner_echo.cursor, 'before-now');
    assert.equal(output.opl_app_contribution.carrier_readback.lifecycle_authority, 'carrier_owned');
    assert.equal(output.opl_app_contribution.readiness.legacy_lifecycle_state_present, false);
    assert.equal(fs.existsSync(path.join(stateDir, 'agent-package-locks.json')), false);
    assert.equal(fs.existsSync(path.join(stateDir, 'agent-package-lifecycle-ledger.json')), false);
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
});

test('generic broker rejects undeclared refs and confirmation-gates owner actions before invocation', () => {
  const fixture = writeContributionFixture();
  try {
    assert.throws(
      () => runAppContribution({
        packageId: fixture.manifest.package_id,
        ref: 'future.data.v1#unknown',
        operation: 'read',
        input: {},
        confirmed: false,
      }, { discover: () => new Map([[fixture.manifest.package_id, fixture.descriptor]]) }),
      /not declared/,
    );
    assert.throws(
      () => runAppContribution({
        packageId: fixture.manifest.package_id,
        ref: 'future.data.v1#write',
        operation: 'execute',
        input: { value: 'new' },
        confirmed: false,
      }, { discover: () => new Map([[fixture.manifest.package_id, fixture.descriptor]]) }),
      /requires explicit --confirm/,
    );
    const executed = runAppContribution({
      packageId: fixture.manifest.package_id,
      ref: 'future.data.v1#write',
      operation: 'execute',
      input: { value: 'new' },
      confirmed: true,
    }, { discover: () => new Map([[fixture.manifest.package_id, fixture.descriptor]]) }) as any;
    assert.equal(executed.opl_app_contribution.confirmation_required, true);
    assert.equal(executed.opl_app_contribution.response.result.owner_echo.value, 'new');
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('CLI contribution routes discover arbitrary installed Package ids without a registry cache', () => {
  const fixture = writeContributionFixture();
  const codex = fakeCodexList(fixture.root);
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opl-app-contribution-cli-state-'));
  try {
    const output = runCli([
      'app', 'contribution', 'read',
      '--package-id', fixture.manifest.package_id,
      '--ref', 'future.data.v1#current',
      '--input', '{"source":"cli"}',
    ], {
      OPL_CODEX_PLUGIN_BIN: codex.codexPath,
      OPL_STATE_DIR: stateDir,
    }) as any;
    assert.equal(output.opl_app_contribution.package_id, fixture.manifest.package_id);
    assert.equal(output.opl_app_contribution.response.result.owner_echo.source, 'cli');

    const confirmation = runCliFailure([
      'app', 'contribution', 'execute',
      '--package-id', fixture.manifest.package_id,
      '--ref', 'future.data.v1#write',
      '--input', '{"source":"cli"}',
    ], {
      OPL_CODEX_PLUGIN_BIN: codex.codexPath,
      OPL_STATE_DIR: stateDir,
    });
    assert.equal(confirmation.payload.error.code, 'cli_usage_error');
    assert.equal(confirmation.payload.error.details.failure_code, 'agent_package_app_contribution_confirmation_required');
    assert.equal(fs.existsSync(path.join(stateDir, 'agent-package-registry-cache.json')), false);
    assert.equal(fs.existsSync(path.join(stateDir, 'agent-package-locks.json')), false);
    assert.equal(fs.existsSync(path.join(stateDir, 'agent-package-lifecycle-ledger.json')), false);
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
    fs.rmSync(codex.fixtureRoot, { recursive: true, force: true });
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
});

test('contribution parser only accepts the Package-owned request shape', () => {
  assert.deepEqual(
    parseAppContributionArgs([
      '--package-id', 'future.contribution.package',
      '--ref', 'future.data.v1#current',
      '--input', '{}',
    ], 'read'),
    {
      packageId: 'future.contribution.package',
      ref: 'future.data.v1#current',
      operation: 'read',
      input: {},
      confirmed: false,
    },
  );
  assert.throws(
    () => parseAppContributionArgs([
      '--package-id', 'future.contribution.package',
      '--ref', 'future.data.v1#current',
      '--confirm',
    ], 'read'),
    /Unknown app contribution read option/,
  );
});
