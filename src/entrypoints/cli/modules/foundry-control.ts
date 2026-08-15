import { FrameworkContractError } from '../../../kernel/contract-validation.ts';
import {
  FoundryControlService,
  FoundryKernel,
  type CandidateCompiler,
  type DesignerPort,
  type EvaluationExecutor,
} from '../../../authority/evolution/index.ts';
import {
  ContentAddressedCandidateCompiler,
  FileFoundryObjectStore,
  foundryStoragePaths,
  LedgerFoundryEventStore,
  LedgerFoundryOperationResultJournal,
  LedgerVersionRegistry,
} from '../../../authority/evidence/index.ts';
import {
  DefaultHostedAgentRuntimeBindingResolver,
  HostedFoundryActivationRuntime,
} from '../../../adapters/execution/index.ts';
import { configuredFoundryOwnerGate } from '../../../adapters/execution/foundry-owner-gate.ts';

function deferred(operation: string): never {
  throw new FrameworkContractError(
    'contract_shape_invalid',
    `Foundry ${operation} requires the durable workflow worker.`,
    {
      failure_code: 'foundry_workflow_worker_required',
      operation,
    },
  );
}

const deferredDesigner: DesignerPort = {
  producer_id: 'foundry-control:deferred-designer',
  design: async () => deferred('design'),
  diagnose: async () => deferred('diagnose'),
};

const deferredEvaluator: EvaluationExecutor = {
  evaluator_id: 'foundry-control:deferred-evaluator',
  evaluate: async () => deferred('evaluation'),
  canary: async () => deferred('canary'),
};

const deferredCompiler: CandidateCompiler = {
  materialize: async () => deferred('materialize'),
};

function createPersistentFoundryMutationControl(rootOverride?: string) {
  const compiler = new ContentAddressedCandidateCompiler(rootOverride);
  const versions = new LedgerVersionRegistry(rootOverride);
  const storage = foundryStoragePaths(rootOverride);
  return new FoundryControlService(new FoundryKernel({
    designer: deferredDesigner,
    evaluator: deferredEvaluator,
    compiler,
    objects: new FileFoundryObjectStore(rootOverride),
    events: new LedgerFoundryEventStore(rootOverride),
    operationResults: new LedgerFoundryOperationResultJournal(rootOverride),
    versions,
    activationRuntime: new HostedFoundryActivationRuntime({
      resolver: new DefaultHostedAgentRuntimeBindingResolver({
        root_override: rootOverride,
        registry_factory: () => versions,
      }),
      candidate_directory: (candidateDigest) => compiler.candidateDirectory(candidateDigest),
      workspace_root: storage.root,
    }),
    ownerGate: configuredFoundryOwnerGate(),
  }));
}

function createPersistentFoundryReadControl(rootOverride?: string) {
  return new FoundryControlService(new FoundryKernel({
    designer: deferredDesigner,
    evaluator: deferredEvaluator,
    compiler: deferredCompiler,
    objects: new FileFoundryObjectStore(rootOverride, { readOnly: true }),
    events: new LedgerFoundryEventStore(rootOverride, { readOnly: true }),
    versions: new LedgerVersionRegistry(rootOverride, { readOnly: true }),
  }));
}

export function createPersistentFoundryControl(rootOverride?: string) {
  const readControl = createPersistentFoundryReadControl(rootOverride);
  let mutationControl: FoundryControlService | null = null;
  const writer = () => mutationControl ??= createPersistentFoundryMutationControl(rootOverride);
  return {
    startRun: (input: Parameters<FoundryControlService['startRun']>[0]) => writer().startRun(input),
    inspectRun: readControl.inspectRun.bind(readControl),
    submitOwnerDecision: (
      input: Parameters<FoundryControlService['submitOwnerDecision']>[0],
      options?: Parameters<FoundryControlService['submitOwnerDecision']>[1],
    ) => writer().submitOwnerDecision(input, options),
    cancelRun: (input: Parameters<FoundryControlService['cancelRun']>[0]) => writer().cancelRun(input),
    listVersions: readControl.listVersions.bind(readControl),
    rollbackActivation: (input: Parameters<FoundryControlService['rollbackActivation']>[0]) => (
      writer().rollbackActivation(input)
    ),
  };
}
