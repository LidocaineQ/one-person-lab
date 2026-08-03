import type { ResolveRequestInput } from '../../../kernel/types.ts';
import type {
  AgentExecutorCliInput,
  CommandSpec,
  DomainLaunchStrategy,
  LaunchDomainCliInput,
  ProductEntryCliInput,
  ResumeCliInput,
  SessionLedgerCliInput,
  SkillPacksCliInput,
  StartCliInput,
} from './types.ts';
import { parseCommandInput, parseCommandOptions } from './command-registry.ts';
import { buildUsageError } from './runtime-helpers.ts';

const PRODUCT_ENTRY_AGENT_HANDLE_MAP = {
  mas: {
    preferredFamily: 'mas',
  },
  mag: {
    preferredFamily: 'mag',
  },
  rca: {
    preferredFamily: 'rca',
  },
  'general-task': {
    preferredFamily: undefined,
  },
} as const;

function parseKeyValueArgs(
  args: string[],
  spec: Pick<CommandSpec, 'usage' | 'examples'>,
): ResolveRequestInput {
  const values = parseCommandOptions(args, spec, {
    intent: { type: 'string' },
    target: { type: 'string' },
    goal: { type: 'string' },
    'preferred-family': { type: 'string' },
    'request-kind': { type: 'string' },
  });

  if (!values.intent || !values.target || !values.goal) {
    throw buildUsageError(
      'domain select-entry and domain explain-boundary require --intent, --target, and --goal.',
      spec,
      { required: ['--intent', '--target', '--goal'] },
    );
  }

  return {
    intent: values.intent as string,
    target: values.target as string,
    goal: values.goal as string,
    preferredFamily: values['preferred-family'] as string | undefined,
    requestKind: values['request-kind'] as string | undefined,
  };
}

function parseProductEntryArgs(
  args: string[],
  spec: Pick<CommandSpec, 'usage' | 'examples'>,
): ProductEntryCliInput {
  const parsedInput = parseCommandInput(args, spec, {
    'dry-run': { type: 'boolean' },
    goal: { type: 'string' },
    intent: { type: 'string' },
    target: { type: 'string' },
    'preferred-family': { type: 'string' },
    'request-kind': { type: 'string' },
    model: { type: 'string' },
    provider: { type: 'string' },
    'reasoning-effort': { type: 'string' },
    'workspace-path': { type: 'string' },
    skills: { type: 'string', multiple: true },
  }, true);
  const values = parsedInput.values;
  const positionalGoalParts = parsedInput.positionals;
  const parsed: Omit<ProductEntryCliInput, 'goal' | 'dryRun'> = {
    intent: (values.intent as string | undefined) ?? 'create',
    target: (values.target as string | undefined) ?? 'deliverable',
    skills: ((values.skills as string[] | undefined) ?? []).flatMap((value) =>
      value.split(',').map((entry) => entry.trim()).filter(Boolean)),
  };
  const explicitGoal = values.goal as string | undefined;
  const dryRun = values['dry-run'] === true;
  if (values['preferred-family'] !== undefined) parsed.preferredFamily = values['preferred-family'] as string;
  if (values['request-kind'] !== undefined) parsed.requestKind = values['request-kind'] as string;
  if (values.model !== undefined) parsed.model = values.model as string;
  if (values.provider !== undefined) parsed.provider = values.provider as string;
  if (values['reasoning-effort'] !== undefined) parsed.reasoningEffort = values['reasoning-effort'] as string;
  if (values['workspace-path'] !== undefined) parsed.workspacePath = values['workspace-path'] as string;

  if (explicitGoal && positionalGoalParts.length > 0) {
    throw buildUsageError(
      'Use either a positional request or --goal for the product-entry request, not both.',
      spec,
      {
        positional_request: positionalGoalParts.join(' '),
      },
    );
  }

  const goal = (explicitGoal ?? positionalGoalParts.join(' ')).trim();

  if (!goal) {
    throw buildUsageError(
      'Product-entry requests require a plain-language request, either as positional text or via --goal.',
      spec,
      {
        required: ['<request...> or --goal <text>'],
      },
    );
  }

  const normalizedGoal = normalizeProductEntryGoalWithAgentHandle(goal, parsed.preferredFamily, spec);

  return {
    ...parsed,
    goal: normalizedGoal.goal,
    preferredFamily: normalizedGoal.preferredFamily,
    dryRun,
  };
}

function normalizeProductEntryGoalWithAgentHandle(
  goal: string,
  preferredFamily: string | undefined,
  spec: Pick<CommandSpec, 'usage' | 'examples'>,
) {
  const trimmedGoal = goal.trim();
  const match = trimmedGoal.match(/^@([a-z0-9-]+)(?:\s+(.+))?$/i);
  if (!match) {
    return {
      goal: trimmedGoal,
      preferredFamily,
    };
  }

  const handle = match[1]?.toLowerCase() ?? '';
  const mapped = PRODUCT_ENTRY_AGENT_HANDLE_MAP[handle as keyof typeof PRODUCT_ENTRY_AGENT_HANDLE_MAP];
  if (!mapped) {
    throw buildUsageError(`Unknown product-entry agent handle: @${handle}.`, spec, {
      agent_handle: `@${handle}`,
      allowed_handles: Object.keys(PRODUCT_ENTRY_AGENT_HANDLE_MAP).map((entry) => `@${entry}`),
    });
  }

  if (preferredFamily) {
    throw buildUsageError(
      'Use either an @agent handle or --preferred-family for product-entry stage selection, not both.',
      spec,
      {
        preferred_family: preferredFamily,
        agent_handle: `@${handle}`,
      },
    );
  }

  const strippedGoal = (match[2] ?? '').trim();
  if (!strippedGoal) {
    throw buildUsageError(`Agent handle @${handle} requires a goal after the handle.`, spec, {
      agent_handle: `@${handle}`,
    });
  }

  return {
    goal: strippedGoal,
    preferredFamily: mapped.preferredFamily,
  };
}

function parsePositiveInteger(
  token: string,
  value: string,
  spec: Pick<CommandSpec, 'usage' | 'examples'>,
) {
  const parsed = Number.parseInt(value, 10);

  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw buildUsageError(`Option ${token} requires a positive integer.`, spec, {
      option: token,
      value,
    });
  }

  return parsed;
}

function parsePort(
  token: string,
  value: string,
  spec: Pick<CommandSpec, 'usage' | 'examples'>,
) {
  const parsed = Number.parseInt(value, 10);

  if (!Number.isInteger(parsed) || parsed < 0 || parsed > 65535) {
    throw buildUsageError(`Option ${token} requires an integer port between 0 and 65535.`, spec, {
      option: token,
      value,
    });
  }

  return parsed;
}

function parseResumeArgs(
  args: string[],
  spec: Pick<CommandSpec, 'usage' | 'examples'>,
): ResumeCliInput {
  const [sessionId, ...rest] = args;

  if (!sessionId) {
    throw buildUsageError('resume requires a session id.', spec, {
      required: ['session_id'],
    });
  }

  if (rest.length > 0) {
    throw buildUsageError(`Unexpected positional argument: ${rest[0]}.`, spec, {
      token: rest[0],
    });
  }

  return {
    sessionId,
  };
}

function parseSessionLedgerArgs(
  args: string[],
  spec: Pick<CommandSpec, 'usage' | 'examples'>,
): SessionLedgerCliInput {
  const parsed: SessionLedgerCliInput = {};
  const limit = parseCommandOptions(args, spec, {
    limit: { type: 'string' },
  }).limit as string | undefined;
  if (limit !== undefined) {
    parsed.limit = parsePositiveInteger('--limit', limit, spec);
  }
  return parsed;
}

function parseStartArgs(
  args: string[],
  spec: Pick<CommandSpec, 'usage' | 'examples'>,
): StartCliInput {
  const parsed: StartCliInput = {};
  const values = parseCommandOptions(args, spec, {
    project: { type: 'string' },
    mode: { type: 'string' },
  });
  if (values.project !== undefined) {
    parsed.projectId = values.project as string;
  }
  if (values.mode !== undefined) {
    parsed.modeId = values.mode as string;
  }
  return parsed;
}

function parseLaunchDomainArgs(
  args: string[],
  spec: Pick<CommandSpec, 'usage' | 'examples'>,
): LaunchDomainCliInput {
  const parsed: LaunchDomainCliInput = {};
  const values = parseCommandOptions(args, spec, {
    project: { type: 'string' },
    path: { type: 'string' },
    strategy: { type: 'string' },
    'dry-run': { type: 'boolean' },
  });
  const strategy = values.strategy as string | undefined;
  if (strategy && !['auto', 'open_url', 'spawn_command'].includes(strategy)) {
    throw buildUsageError('Option --strategy must be one of auto, open_url, or spawn_command.', spec, {
      option: '--strategy',
      value: strategy,
    });
  }
  if (values.project !== undefined) {
    parsed.projectId = values.project as string;
  }
  if (values.path !== undefined) {
    parsed.workspacePath = values.path as string;
  }
  if (strategy !== undefined) {
    parsed.strategy = strategy as DomainLaunchStrategy;
  }
  if (values['dry-run'] === true) {
    parsed.dryRun = true;
  }
  return parsed;
}

function parseSkillPackArgs(
  args: string[],
  spec: Pick<CommandSpec, 'usage' | 'examples'>,
): SkillPacksCliInput {
  const parsed: SkillPacksCliInput = {
    domains: [],
    quiet: false,
  };
  const values = parseCommandOptions(args, spec, {
    domain: { type: 'string', multiple: true },
    home: { type: 'string' },
    scope: { type: 'string' },
    'target-workspace': { type: 'string' },
    'target-quest': { type: 'string' },
    'target-root': { type: 'string' },
    mode: { type: 'string' },
    quiet: { type: 'boolean' },
  });
  const scope = values.scope as string | undefined;
  const mode = values.mode as string | undefined;
  if (scope && scope !== 'codex' && scope !== 'workspace' && scope !== 'quest') {
    throw buildUsageError('Option --scope requires codex, workspace, or quest.', spec, { option: '--scope', value: scope });
  }
  if (mode && mode !== 'observe' && mode !== 'ask_to_apply' && mode !== 'managed') {
    throw buildUsageError('Option --mode requires observe, ask_to_apply, or managed.', spec, { option: '--mode', value: mode });
  }
  parsed.domains = (values.domain as string[] | undefined) ?? [];
  parsed.quiet = values.quiet === true;
  if (values.home !== undefined) parsed.home = values.home as string;
  if (scope !== undefined) parsed.scope = scope as SkillPacksCliInput['scope'];
  if (values['target-workspace'] !== undefined) parsed.targetWorkspace = values['target-workspace'] as string;
  if (values['target-quest'] !== undefined) parsed.targetQuest = values['target-quest'] as string;
  if (values['target-root'] !== undefined) parsed.targetRoot = values['target-root'] as string;
  if (mode !== undefined) parsed.companionMode = mode as SkillPacksCliInput['companionMode'];
  return parsed;
}

function parseExecutorOption(
  args: string[],
  spec: Pick<CommandSpec, 'usage' | 'examples'>,
) {
  if (args.length === 0) {
    return undefined;
  }
  if (args.length !== 2 || args[0] !== '--executor') {
    throw buildUsageError('executor doctor accepts only --executor <kind>.', spec, {
      received: args,
    });
  }
  return args[1];
}

function parseExecutorRequestPath(
  args: string[],
  spec: Pick<CommandSpec, 'usage' | 'examples'>,
) {
  if (args.length !== 2 || args[0] !== '--request') {
    throw buildUsageError('executor run requires --request <request.json>.', spec, {
      required: ['--request'],
    });
  }
  return args[1];
}

function parseExecutorExecArgs(
  args: string[],
  spec: Pick<CommandSpec, 'usage' | 'examples'>,
): AgentExecutorCliInput {
  const parsedInput = parseCommandInput(args, spec, {
    executor: { type: 'string' },
    cd: { type: 'string' },
    model: { type: 'string' },
    provider: { type: 'string' },
    'reasoning-effort': { type: 'string' },
  }, true);
  const values = parsedInput.values;
  const prompt = parsedInput.positionals.join(' ').trim();
  if (!prompt) {
    throw buildUsageError('opl exec requires a prompt.', spec, {
      required: ['<prompt...>'],
    });
  }

  const parsed: Omit<AgentExecutorCliInput, 'prompt'> = {};
  if (values.executor !== undefined) parsed.executorKind = values.executor as string;
  if (values.cd !== undefined) parsed.cwd = values.cd as string;
  if (values.model !== undefined) parsed.model = values.model as string;
  if (values.provider !== undefined) parsed.provider = values.provider as string;
  if (values['reasoning-effort'] !== undefined) {
    parsed.reasoningEffort = values['reasoning-effort'] as string;
  }
  return { ...parsed, prompt };
}

export {
  parseExecutorExecArgs,
  parseExecutorOption,
  parseExecutorRequestPath,
  parseKeyValueArgs,
  parseLaunchDomainArgs,
  parseProductEntryArgs,
  parseResumeArgs,
  parseSkillPackArgs,
  parseSessionLedgerArgs,
  parseStartArgs,
};
