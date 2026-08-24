import {
  assert,
  fs,
  path,
  test,
  fileURLToPath,
  applyDomainArtifactCasMaterialization,
  inspectStandardAgentActionRunBinding,
  inspectStandardAgentActionRunCompletion,
  inspectStandardAgentActionRunPlan,
  runStandardAgentAction,
  standardAgentLifecycleReactivationHandlerRunId,
  temporaryRoot,
  writeLifecycleContracts,
  writeLifecycleWorkspace,
  writeNativeCarrierDescriptor,
  nativeManagedCheckout,
  reactivationAdmission,
  authorityHandler,
  refusingAuthorityHandler,
} from './shared.ts';

test('lifecycle admission preserves non-materializing MAS authority failures without reserving a Stage', async () => {
  for (const status of ['typed_blocker', 'invalid_host_input'] as const) {
    const fixtureRoot = temporaryRoot(`opl-lifecycle-${status}-`);
    const checkoutRoot = path.join(fixtureRoot, 'checkout');
    const workspaceRoot = path.join(fixtureRoot, 'workspace');
    const stateRoot = path.join(fixtureRoot, 'state');
    const previousStateRoot = process.env.OPL_STATE_DIR;
    let handlerCalls = 0;
    let attemptCalls = 0;
    try {
      fs.mkdirSync(checkoutRoot, { recursive: true });
      fs.mkdirSync(workspaceRoot, { recursive: true });
      process.env.OPL_STATE_DIR = stateRoot;
      writeLifecycleContracts(checkoutRoot);
      writeNativeCarrierDescriptor(checkoutRoot);
      const refs = writeLifecycleWorkspace(workspaceRoot);
      const runId = `authority-${status}`;
      const admission = reactivationAdmission(refs);
      const childRunId = standardAgentLifecycleReactivationHandlerRunId({
        domainId: 'mas', actionId: 'launch_stage', runId, payload: admission,
      });

      await assert.rejects(runStandardAgentAction({
        domainId: 'mas', actionId: 'launch_stage', workspaceRoot,
        payload: { study_id: 'study-001', value: 1, lifecycle_admission: admission }, runId,
      }, {
        resolveManagedCheckout: async () => ({
          ...nativeManagedCheckout(checkoutRoot, workspaceRoot),
        }) as never,
        compileStageManifest: (() => ({})) as never,
        recordLedger: ((ledger: Record<string, unknown>) => ({
          ledger_entry: { run_id: ledger.runId, status: ledger.status },
          recorded_event: { event_type: 'standard_agent_action_run_recorded' },
        })) as never,
        runHandler: refusingAuthorityHandler(status, () => { handlerCalls += 1; }) as never,
        runStageRuntime: async () => {
          attemptCalls += 1;
          return {};
        },
      }), (caught: any) => {
        assert.equal(caught.details?.failure_code, status === 'typed_blocker'
          ? 'domain_lifecycle_reactivation_typed_blocker'
          : 'domain_lifecycle_reactivation_invalid_host_input');
        assert.equal(caught.details?.domain_authority_status, status);
        assert.match(caught.details?.domain_authority_result_ref, /^file:/u);
        if (status === 'typed_blocker') {
          assert.equal(caught.details?.domain_authority_blocker?.reason_code, 'stale_revision_intake');
        } else {
          assert.equal(caught.details?.domain_authority_error?.code, 'invalid_host_input');
        }
        return true;
      });
      assert.equal(handlerCalls, 1);
      assert.equal(attemptCalls, 0);
      assert.equal(inspectStandardAgentActionRunBinding({ workspaceRoot, runId }), null);
      assert.equal(inspectStandardAgentActionRunPlan({ workspaceRoot, runId }), null);
      assert.equal(inspectStandardAgentActionRunCompletion({ workspaceRoot, runId: childRunId })?.status,
        'completed');
      assert.equal(JSON.parse(fs.readFileSync(fileURLToPath(refs.lifecycle.ref), 'utf8')).lifecycle_state,
        'paused');
      assert.equal(fs.existsSync(path.join(stateRoot, 'runway', 'domain-artifact-cas')), false);
    } finally {
      if (previousStateRoot === undefined) delete process.env.OPL_STATE_DIR;
      else process.env.OPL_STATE_DIR = previousStateRoot;
      fs.rmSync(fixtureRoot, { recursive: true, force: true });
    }
  }
});
test('lifecycle admission blocks inactive Stage reservation, materializes reactivation, and replays frozen receipt', async () => {
  const fixtureRoot = temporaryRoot('opl-lifecycle-admission-');
  const checkoutRoot = path.join(fixtureRoot, 'checkout');
  const workspaceRoot = path.join(fixtureRoot, 'workspace');
  const stateRoot = path.join(fixtureRoot, 'state');
  const previousStateRoot = process.env.OPL_STATE_DIR;
  let handlerCalls = 0;
  let attemptCalls = 0;
  let crashBeforeReceipt = true;
  try {
    fs.mkdirSync(checkoutRoot, { recursive: true });
    fs.mkdirSync(workspaceRoot, { recursive: true });
    process.env.OPL_STATE_DIR = stateRoot;
    writeLifecycleContracts(checkoutRoot);
    writeNativeCarrierDescriptor(checkoutRoot);
    const refs = writeLifecycleWorkspace(workspaceRoot);
    const dependencies = {
      resolveManagedCheckout: async () => ({
        ...nativeManagedCheckout(checkoutRoot, workspaceRoot),
      }) as never,
      compileStageManifest: (() => ({})) as never,
      recordLedger: ((input: Record<string, unknown>) => ({
        ledger_entry: { run_id: input.runId, status: input.status },
        recorded_event: { event_type: 'standard_agent_action_run_recorded' },
      })) as never,
      runHandler: authorityHandler(workspaceRoot, () => { handlerCalls += 1; }) as never,
      applyDomainArtifactCas: ((input: Parameters<typeof applyDomainArtifactCasMaterialization>[0]) => {
        if (crashBeforeReceipt) {
          crashBeforeReceipt = false;
          return applyDomainArtifactCasMaterialization(input, {
            beforePersistReceipt: () => { throw new Error('simulated host receipt persistence crash'); },
          });
        }
        return applyDomainArtifactCasMaterialization(input);
      }) as never,
      runStageRuntime: async (args: string[]) => {
        if (args[0] === 'attempt') {
          attemptCalls += 1;
          return {
            family_runtime_stage_run: {
              stage_run_input: { workflow_id: 'wf-lifecycle-stage' },
              blocked_reason: null,
              temporal_start: { start_status: 'started' },
            },
          };
        }
        return { family_runtime_stage_run_query: { status: 'running' } };
      },
    };

    await assert.rejects(runStandardAgentAction({
      domainId: 'mas', actionId: 'launch_stage', workspaceRoot,
      payload: { study_id: 'study-001', value: 1 }, runId: 'inactive-stage',
    }, dependencies), /lifecycle is inactive/i);
    assert.equal(handlerCalls, 0);
    assert.equal(attemptCalls, 0);
    assert.equal(inspectStandardAgentActionRunBinding({ workspaceRoot, runId: 'inactive-stage' }), null);
    assert.equal(inspectStandardAgentActionRunPlan({ workspaceRoot, runId: 'inactive-stage' }), null);

    await assert.rejects(runStandardAgentAction({
      domainId: 'mas', actionId: 'launch_stage', workspaceRoot,
      payload: {
        study_id: 'study-001', value: 1,
        lifecycle_admission: reactivationAdmission(refs, 'f'.repeat(64)),
      },
      runId: 'stale-reactivation',
    }, dependencies), /current canonical lifecycle bytes|bytes do not match/i);
    assert.equal(handlerCalls, 0);
    assert.equal(attemptCalls, 0);
    assert.equal(inspectStandardAgentActionRunBinding({ workspaceRoot, runId: 'stale-reactivation' }), null);

    const originalPayload = {
      study_id: 'study-001', value: 1, lifecycle_admission: reactivationAdmission(refs),
    };
    const childRunId = standardAgentLifecycleReactivationHandlerRunId({
      domainId: 'mas', actionId: 'launch_stage', runId: 'reactivated-stage',
      payload: originalPayload.lifecycle_admission,
    });
    await assert.rejects(runStandardAgentAction({
      domainId: 'mas', actionId: 'launch_stage', workspaceRoot,
      payload: originalPayload, runId: 'reactivated-stage',
    }, dependencies), (error: any) => {
      assert.equal(error.details?.failure_disposition, 'unknown_success');
      assert.equal(error.details?.same_run_retry_required, true);
      return true;
    });
    assert.equal(handlerCalls, 1);
    assert.equal(attemptCalls, 0);
    assert.equal(inspectStandardAgentActionRunBinding({ workspaceRoot, runId: 'reactivated-stage' }), null);
    assert.equal(inspectStandardAgentActionRunCompletion({ workspaceRoot, runId: childRunId }), null);
    assert.equal(fs.readdirSync(path.join(stateRoot, 'runway', 'domain-artifact-cas', 'transactions')).length, 1);

    const launched = await runStandardAgentAction({
      domainId: 'mas', actionId: 'launch_stage', workspaceRoot,
      payload: originalPayload, runId: 'reactivated-stage',
    }, dependencies);
    const replayed = await runStandardAgentAction({
      domainId: 'mas', actionId: 'launch_stage', workspaceRoot,
      payload: originalPayload, runId: 'reactivated-stage',
    }, dependencies);

    assert.equal(launched.standard_agent_action_run.execution_kind, 'stage_binding');
    assert.equal(replayed.standard_agent_action_run.execution_kind, 'stage_binding');
    if (
      launched.standard_agent_action_run.execution_kind !== 'stage_binding'
      || replayed.standard_agent_action_run.execution_kind !== 'stage_binding'
    ) assert.fail('expected lifecycle-gated Stage action results');
    assert.equal(launched.standard_agent_action_run.domain_lifecycle_admission.status,
      'admitted_by_current_reactivation_receipt');
    assert.equal(replayed.standard_agent_action_run.domain_lifecycle_admission.status,
      'admitted_by_current_reactivation_receipt');
    assert.equal(handlerCalls, 1);
    assert.equal(attemptCalls, 1);
    assert.equal(fs.readdirSync(path.join(stateRoot, 'runway', 'domain-artifact-cas', 'transactions')).length, 0);
    assert.equal(JSON.parse(fs.readFileSync(fileURLToPath(refs.lifecycle.ref), 'utf8')).lifecycle_state, 'active');
    assert.equal(JSON.parse(fs.readFileSync(path.join(workspaceRoot, 'workspace_index.json'), 'utf8')).studies[0].status,
      'active');
    const plan = inspectStandardAgentActionRunPlan({ workspaceRoot, runId: 'reactivated-stage' });
    const materializedAdmission = plan?.effective_payload?.lifecycle_admission as Record<string, unknown>;
    assert.equal(materializedAdmission.mode, 'materialized_receipt');
    assert.match(String(materializedAdmission.domain_authority_result_sha256), /^sha256:[a-f0-9]{64}$/u);
    assert.match(String(materializedAdmission.materialization_receipt_sha256), /^sha256:[a-f0-9]{64}$/u);
    assert.equal(JSON.stringify(plan?.effective_payload).includes('reactivation_request'), false);
    const childPlan = inspectStandardAgentActionRunPlan({ workspaceRoot, runId: childRunId });
    const externalChildPayload = structuredClone(childPlan?.effective_payload ?? {});
    delete externalChildPayload.workspace_root;
    await assert.rejects(runStandardAgentAction({
      domainId: 'mas',
      actionId: 'reactivate_study',
      workspaceRoot,
      payload: externalChildPayload,
      runId: childRunId,
    }, dependencies), (error: any) => {
      assert.equal(error.details?.failure_code,
        'standard_agent_internal_action_external_invocation_forbidden');
      return true;
    });
    assert.equal(handlerCalls, 1);
  } finally {
    if (previousStateRoot === undefined) delete process.env.OPL_STATE_DIR;
    else process.env.OPL_STATE_DIR = previousStateRoot;
    fs.rmSync(fixtureRoot, { recursive: true, force: true });
  }
});
