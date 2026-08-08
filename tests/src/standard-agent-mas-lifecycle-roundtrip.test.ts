import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

import { canonicalJsonBytes } from '../../src/kernel/canonical-json.ts';
import { parseJsonText } from '../../src/kernel/json-file.ts';
import { resolveStandardAgent } from '../../src/kernel/standard-agent-registry.ts';
import {
  runStandardAgentAction,
  runStandardAgentQualificationProvisioning,
} from '../../src/modules/runway/standard-agent-action-runtime.ts';
import { runStandardAgentHandlerSandbox } from '../../src/modules/runway/standard-agent-handler-sandbox.ts';

const checkout = process.env.OPL_MAS_ROUNDTRIP_CHECKOUT;
const sourceWorkspace = process.env.OPL_MAS_ROUNDTRIP_WORKSPACE;
const studyId = process.env.OPL_MAS_ROUNDTRIP_STUDY_ID;
const sourceUserAuthority = process.env.OPL_MAS_ROUNDTRIP_USER_AUTHORITY;
const sourceRevisionIntake = process.env.OPL_MAS_ROUNDTRIP_REVISION_INTAKE;
const actionId = process.env.OPL_MAS_ROUNDTRIP_ACTION_ID ?? 'bounded_analysis_campaign';
const expectedOperationCount = Number(process.env.OPL_MAS_ROUNDTRIP_EXPECTED_OPERATION_COUNT ?? '11');
const enabled = Boolean(
  checkout && sourceWorkspace && studyId && sourceUserAuthority && sourceRevisionIntake,
);
const qualificationEnabled = Boolean(checkout);

function sha256(bytes: string | Buffer) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

function copyFile(sourceRoot: string, targetRoot: string, relative: string) {
  const source = path.join(sourceRoot, relative);
  assert.equal(fs.statSync(source).isFile(), true, `missing round-trip source: ${relative}`);
  const target = path.join(targetRoot, relative);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.copyFileSync(source, target);
  return target;
}

function writeJson(file: string, value: unknown) {
  const bytes = canonicalJsonBytes(value);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, bytes);
  return { file, ref: pathToFileURL(file).href, bytes, sha256: sha256(bytes) };
}

function packageUseBinding() {
  return {
    surface_kind: 'opl_agent_package_use_binding.v1',
    use_boundary_id: 'package-use:mas-real-lifecycle-roundtrip',
    root_package: {
      package_id: 'mas',
      package_version: 'roundtrip',
      owner_language_version: { scheme: 'pep440', value: '0.0.0' },
      package_lock_ref: 'opl://agent-package-lock/mas/roundtrip',
      manifest_sha256: '1'.repeat(64),
      content_digest: `sha256:${'2'.repeat(64)}`,
      source_artifact_ref: 'oci://opl/mas@sha256:roundtrip',
      artifact_digest: `sha256:${'3'.repeat(64)}`,
      source_kind: 'first_party_managed_cohort',
    },
    provider_packages: [],
    dependency_closure_digest: '4'.repeat(64),
    core_skill_tree_digest: null,
    skill_tree_digest: null,
  };
}

function nativeManagedCheckout(checkoutRoot: string, workspaceRoot: string) {
  const sourceRoot = fs.realpathSync.native(checkoutRoot);
  const installedVersion = `0.2.25-${'b'.repeat(64)}`;
  const pluginId = 'med-autoscience@med-autoscience';
  const marketplaceSource = 'gaofeng21cn/med-autoscience';
  const manifestSha256 = `sha256:${sha256(fs.readFileSync(path.join(sourceRoot, 'opl-package.json')))}`;
  return {
    agent: resolveStandardAgent('mas')!,
    package_id: 'mas',
    workspace_root: fs.realpathSync.native(workspaceRoot),
    checkout_root: sourceRoot,
    package_status: {
      installed_package_count: 1,
      launch_allowed: true,
      launch_blocked_reason: null,
      runtime_source_readiness: { operational_ready: true, checkout_path: sourceRoot },
      configured_carrier: {
        surface_kind: 'opl_configured_codex_plugin_carrier_readback.v1',
        package_id: 'mas',
        carrier: {
          kind: 'codex_plugin_manager',
          plugin_id: pluginId,
          marketplace_source: marketplaceSource,
          observed_sources: [{
            plugin_id: pluginId,
            marketplace_source: marketplaceSource,
            installed_version: installedVersion,
            enabled: true,
            plugin_source_path: sourceRoot,
            source_tree_sha256: `sha256:${'c'.repeat(64)}`,
          }],
          precedence: 'exact_single_source',
        },
        executor: { route: 'codex_cli', required_skill_ids: ['med-autoscience'], status: 'callable' },
        publication_ref: 'ghcr.io/gaofeng21cn/one-person-lab-packages/mas:latest-stable',
        status: 'installed',
        installed_version: installedVersion,
        enabled: true,
        plugin_source_path: sourceRoot,
        operation: 'list',
        native_command: ['plugin', 'list', '--json'],
        native_action_dispatched: true,
        reason: null,
      },
      installed_carrier_readback: {
        kind: 'codex_plugin_manager',
        identity: pluginId,
        source_ref: sourceRoot,
        version: installedVersion,
        enabled: true,
        lifecycle_authority: 'carrier_owned',
      },
      installed_readiness: {
        installed: true,
        physical_status: 'available',
        callability: 'callable',
      },
    },
    package_use_binding: null,
    use_boundary_id: null,
    runtime_source_kind: 'installed_native_carrier',
    native_runtime: {
      package_version: '0.2.25',
      carrier_installed_version: installedVersion,
      manifest_sha256: manifestSha256,
      plugin_selector: pluginId,
      marketplace_source: marketplaceSource,
      plugin_source_path: sourceRoot,
      source_tree_sha256: `sha256:${'c'.repeat(64)}`,
    },
  };
}

test('OPL round-trips real MAS lifecycle schema and Python authority handler', {
  skip: enabled ? false : 'set OPL_MAS_ROUNDTRIP_* to run the cross-repository contract test',
}, async () => {
  const masCheckout = fs.realpathSync.native(checkout!);
  const sourceRoot = fs.realpathSync.native(sourceWorkspace!);
  const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'opl-mas-real-lifecycle-roundtrip-'));
  let workspaceRoot = path.join(fixtureRoot, 'workspace');
  const stateRoot = path.join(fixtureRoot, 'state');
  const previousStateRoot = process.env.OPL_STATE_DIR;
  const studyRoot = `studies/${studyId}`;
  const projectionPaths = [
    'workspace_index.json',
    'runtime/artifacts/study_lifecycle_control/latest.json',
    'reports/latest_status.json',
    'reports/studies_index.json',
    `${studyRoot}/control/lifecycle.json`,
    `${studyRoot}/control/stage_index.json`,
    `${studyRoot}/submission/STATUS.json`,
    `${studyRoot}/publication/current_package/STATUS.json`,
  ];

  try {
    process.env.OPL_STATE_DIR = stateRoot;
    fs.mkdirSync(workspaceRoot, { recursive: true });
    workspaceRoot = fs.realpathSync.native(workspaceRoot);
    for (const relative of projectionPaths) copyFile(sourceRoot, workspaceRoot, relative);
    for (const relative of [
      `${studyRoot}/artifacts/controller/lifecycle_control/history`,
      'runtime/artifacts/study_lifecycle_control/history',
    ]) {
      assert.equal(fs.statSync(path.join(sourceRoot, relative)).isDirectory(), true);
      fs.mkdirSync(path.join(workspaceRoot, relative), { recursive: true });
    }

    const authorityTarget = path.join(workspaceRoot, studyRoot, 'control', 'roundtrip-user-authority.json');
    fs.mkdirSync(path.dirname(authorityTarget), { recursive: true });
    fs.copyFileSync(fs.realpathSync.native(sourceUserAuthority!), authorityTarget);
    const authorityBytes = fs.readFileSync(authorityTarget);
    const authorityRecord = parseJsonText(authorityBytes.toString('utf8')) as Record<string, unknown>;
    assert.equal(authorityRecord.study_id, studyId);

    const intakeRecord = parseJsonText(
      fs.readFileSync(fs.realpathSync.native(sourceRevisionIntake!), 'utf8'),
    ) as Record<string, unknown>;
    intakeRecord.user_authority_ref = pathToFileURL(authorityTarget).href;
    intakeRecord.user_authority_sha256 = `sha256:${sha256(authorityBytes)}`;
    const intake = writeJson(
      path.join(workspaceRoot, studyRoot, 'control', 'roundtrip-revision-intake.json'),
      intakeRecord,
    );
    assert.equal(intakeRecord.first_owning_stage_id, actionId);

    const profileBytes = Buffer.from('developer_supervisor_mode: true\n', 'utf8');
    const profileFile = path.join(workspaceRoot, 'control', 'roundtrip-profile.yaml');
    fs.mkdirSync(path.dirname(profileFile), { recursive: true });
    fs.writeFileSync(profileFile, profileBytes);
    const lifecycleFile = path.join(workspaceRoot, studyRoot, 'control', 'lifecycle.json');
    const lifecycleBytes = fs.readFileSync(lifecycleFile);
    const lifecycle = parseJsonText(lifecycleBytes.toString('utf8')) as Record<string, unknown>;
    const recordedAt = String(authorityRecord.recorded_at);
    const runId = 'mas-real-lifecycle-roundtrip';
    let handlerCalls = 0;
    let stageCalls = 0;
    const authorityOutputs: Record<string, any>[] = [];
    const packageBinding = packageUseBinding();

    const result = await runStandardAgentAction({
      domainId: 'mas',
      actionId,
      workspaceRoot,
      payload: {
        study_id: studyId,
        lifecycle_admission: {
          surface_kind: 'opl_domain_lifecycle_admission',
          version: 'opl-domain-lifecycle-admission.v1',
          mode: 'reactivation_request',
          reactivation_request: {
            user_authority_ref: pathToFileURL(authorityTarget).href,
            user_authority_sha256: `sha256:${sha256(authorityBytes)}`,
            reviewer_revision_intake_ref: intake.ref,
            reviewer_revision_intake_sha256: `sha256:${intake.sha256}`,
            current_lifecycle_ref: pathToFileURL(lifecycleFile).href,
            current_lifecycle_sha256: `sha256:${sha256(lifecycleBytes)}`,
            profile_ref: pathToFileURL(profileFile).href,
            profile_sha256: `sha256:${sha256(profileBytes)}`,
            observed_lifecycle_state: lifecycle.lifecycle_state,
            observed_lifecycle_generation: lifecycle.generation,
            explicit_user_wakeup: true,
            allow_stopped_relaunch: false,
            requested_at: recordedAt,
            reason_code: 'reviewer_revision_reactivation',
            reason_summary: 'Run the real MAS lifecycle authority contract round-trip.',
          },
        },
      },
      runId,
    }, {
      resolveManagedCheckout: async () => ({
        agent: resolveStandardAgent('mas')!,
        package_id: 'mas',
        workspace_root: fs.realpathSync.native(workspaceRoot),
        checkout_root: masCheckout,
        package_status: {
          installed_package_count: 1,
          launch_allowed: true,
          runtime_source_readiness: { operational_ready: true, checkout_path: masCheckout },
        },
        package_use_binding: packageBinding,
        use_boundary_id: packageBinding.use_boundary_id,
      }) as never,
      compileStageManifest: (() => ({})) as never,
      recordLedger: ((input: Record<string, unknown>) => ({
        ledger_entry: { run_id: input.runId, status: input.status },
        recorded_event: { event_type: 'standard_agent_action_run_recorded' },
      })) as never,
      runHandler: ((input: Parameters<typeof runStandardAgentHandlerSandbox>[0]) => {
        handlerCalls += 1;
        const request = input.request as Record<string, any>;
        assert.equal(Object.hasOwn(request.authority_context, 'profile_ref'), false);
        if (request.user_authority.authority_bytes_base64 !== undefined) {
          assert.deepEqual(
            Buffer.from(request.user_authority.authority_bytes_base64, 'base64'),
            authorityBytes,
          );
          assert.deepEqual(
            Buffer.from(request.reviewer_revision_intake.intake_bytes_base64, 'base64'),
            intake.bytes,
          );
        }
        for (const target of request.projection_inventory.targets) {
          if (target.bytes_base64 !== undefined) {
            assert.deepEqual(
              Buffer.from(target.bytes_base64, 'base64'),
              fs.readFileSync(new URL(target.ref)),
            );
          }
        }
        const receipt = runStandardAgentHandlerSandbox(input);
        const authorityOutput = receipt.output as Record<string, any>;
        authorityOutputs.push(authorityOutput);
        for (const operation of authorityOutput.opl_host_materialization_request.operations) {
          const relative = String(operation.target_relative_path);
          fs.mkdirSync(path.dirname(path.join(workspaceRoot, relative)), { recursive: true });
        }
        return receipt;
      }) as never,
      runStageRuntime: async (args: string[]) => {
        if (args[0] === 'attempt') {
          stageCalls += 1;
          return {
            family_runtime_stage_run: {
              stage_run_input: { workflow_id: 'wf-mas-real-lifecycle-roundtrip' },
              blocked_reason: null,
              temporal_start: { start_status: 'started' },
            },
          };
        }
        return { family_runtime_stage_run_query: { status: 'running' } };
      },
    });

    assert.equal(result.standard_agent_action_run.execution_kind, 'stage_binding');
    if (result.standard_agent_action_run.execution_kind !== 'stage_binding') {
      assert.fail('expected a lifecycle-gated Stage action result');
    }
    assert.equal(
      result.standard_agent_action_run.domain_lifecycle_admission.status,
      'admitted_by_current_reactivation_receipt',
    );
    assert.equal(handlerCalls, 1);
    assert.equal(stageCalls, 1);
    const authorityOutput = authorityOutputs[0];
    assert.ok(authorityOutput);
    assert.equal(authorityOutput.status, 'authorized');
    assert.equal(authorityOutput.opl_host_materialization_request.domain_id, 'medautoscience');
    assert.equal(authorityOutput.opl_host_materialization_request.operations.length, expectedOperationCount);
    const afterLifecycle = parseJsonText(fs.readFileSync(lifecycleFile, 'utf8')) as Record<string, unknown>;
    assert.equal(afterLifecycle.lifecycle_state, 'active');
    assert.equal(afterLifecycle.generation, Number(lifecycle.generation) + 1);
    const receiptTargets = authorityOutput.opl_host_materialization_request.operations
      .map((operation: Record<string, unknown>) => String(operation.target_relative_path))
      .filter((relative: string) => /reactivation[_-]receipt/u.test(relative));
    assert.equal(receiptTargets.length, 1);
    assert.equal(fs.statSync(path.join(workspaceRoot, receiptTargets[0]!)).isFile(), true);
  } finally {
    if (previousStateRoot === undefined) delete process.env.OPL_STATE_DIR;
    else process.env.OPL_STATE_DIR = previousStateRoot;
    fs.rmSync(fixtureRoot, { recursive: true, force: true });
  }
});

test('OPL materializes and replays real MAS qualification provisioning bytes', {
  skip: qualificationEnabled ? false : 'set OPL_MAS_ROUNDTRIP_CHECKOUT to run the qualification ABI test',
}, async () => {
  const masCheckout = fs.realpathSync.native(checkout!);
  const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'opl-mas-real-qualification-roundtrip-'));
  const checkoutRoot = path.join(fixtureRoot, 'mas-checkout');
  let workspaceRoot = path.join(fixtureRoot, 'workspace');
  const previousStateRoot = process.env.OPL_STATE_DIR;

  try {
    process.env.OPL_STATE_DIR = path.join(fixtureRoot, 'state');
    fs.mkdirSync(checkoutRoot, { recursive: true });
    fs.cpSync(path.join(masCheckout, 'src'), path.join(checkoutRoot, 'src'), { recursive: true });
    fs.cpSync(path.join(masCheckout, 'contracts'), path.join(checkoutRoot, 'contracts'), { recursive: true });
    fs.copyFileSync(path.join(masCheckout, 'opl-package.json'), path.join(checkoutRoot, 'opl-package.json'));
    fs.cpSync(fs.realpathSync.native(path.join(process.cwd(), 'python')), path.join(checkoutRoot, 'python'), { recursive: true });
    fs.mkdirSync(workspaceRoot, { recursive: true });
    workspaceRoot = fs.realpathSync.native(workspaceRoot);
    const authorityRecord = {
      surface_kind: 'mas_qualification_work_item_provisioning_authority',
      schema_version: 1,
      authority_ref: 'mas-qualification-authority:real-roundtrip',
      domain_owner: 'MedAutoScience',
      domain_id: 'medautoscience',
      canonical_workspace_root: workspaceRoot,
      qualification_scope: 'standard_agent_full_vm_qualification',
      issued_at: '2026-08-08T00:00:00Z',
      single_use: true,
      qualification_only: true,
      provisions_work_item: true,
      authorizes_stage_body: false,
      authorizes_business_action: false,
      authorizes_publication: false,
      authorizes_submission: false,
      provider_completion_is_domain_completion: false,
    };
    const authorityBytes = canonicalJsonBytes(authorityRecord);
    const authoritySha256 = sha256(authorityBytes);
    const payload = {
      surface_kind: 'mas_qualification_work_item_provisioning_authority_request',
      schema_version: 1,
      authority_context: {
        action_id: 'qualification_work_item_provisioning_authority_evaluate',
        handler_call_ref: 'opl-handler-call:real-qualification-roundtrip',
        owner_ledger_ref: 'opl-owner-ledger:real-qualification-roundtrip',
      },
      qualification_authority: {
        authority_sha256: authoritySha256,
        authority_bytes_base64: authorityBytes.toString('base64'),
        authority_byte_size: authorityBytes.byteLength,
        record: authorityRecord,
      },
      current_workspace_index: {
        exists: false,
        workspace_index_ref: 'workspace_index.json',
        workspace_index_sha256: null,
        workspace_index_bytes_base64: null,
        workspace_index_byte_size: null,
        record: null,
      },
    };
    let handlerCalls = 0;
    const dependencies = {
      resolveManagedCheckout: async () => nativeManagedCheckout(checkoutRoot, workspaceRoot) as never,
      runHandler: ((input: Parameters<typeof runStandardAgentHandlerSandbox>[0]) => {
        handlerCalls += 1;
        return runStandardAgentHandlerSandbox(input);
      }) as never,
      recordLedger: ((input: Record<string, unknown>) => ({
        ledger_entry: { run_id: input.runId, status: input.status },
        recorded_event: { event_type: 'standard_agent_action_run_recorded' },
      })) as never,
    };
    const input = {
      domainId: 'mas',
      actionId: 'qualification_work_item_provisioning_authority_evaluate',
      workspaceRoot,
      payload,
      runId: 'mas-real-qualification-roundtrip',
    };

    const first = await runStandardAgentQualificationProvisioning(input, dependencies);
    const replay = await runStandardAgentQualificationProvisioning(input, dependencies);
    const firstRun = first.standard_agent_action_run as Record<string, any>;
    const replayRun = replay.standard_agent_action_run as Record<string, any>;
    const studyId = `qualification-${authoritySha256}`;
    const receiptPath = path.join(
      workspaceRoot,
      'studies',
      studyId,
      'artifacts',
      'controller',
      'qualification',
      'provisioning-receipt.json',
    );

    assert.equal(handlerCalls, 1);
    assert.equal(firstRun.execution_kind, 'handler_ref');
    assert.equal(firstRun.result.study_identity.study_id, studyId);
    assert.deepEqual(
      firstRun.result.mas_qualification_work_item_cas_mutation_authorization.satisfied_gate_ids,
      [],
    );
    assert.equal(firstRun.host_materialization.receipt_ref, replayRun.host_materialization.receipt_ref);
    assert.equal(fs.statSync(path.join(workspaceRoot, 'workspace_index.json')).isFile(), true);
    assert.equal(fs.statSync(path.join(workspaceRoot, 'studies', studyId, 'control', 'lifecycle.json')).isFile(), true);
    assert.equal(fs.statSync(receiptPath).isFile(), true);
  } finally {
    if (previousStateRoot === undefined) delete process.env.OPL_STATE_DIR;
    else process.env.OPL_STATE_DIR = previousStateRoot;
    fs.rmSync(fixtureRoot, { recursive: true, force: true });
  }
});
