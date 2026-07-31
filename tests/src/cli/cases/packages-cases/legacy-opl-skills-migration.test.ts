import {
  assert,
  fs,
  formatJsonPayload,
  os,
  path,
  removeFixtureTree,
  test,
} from './helpers.ts';
import {
  runConfiguredCodexPluginCarrierWithLegacyOplSkillsMigration,
} from '../../../../../src/modules/connect/agent-package-registry-parts/legacy-opl-skills-migration.ts';
import type { CodexPluginCommandRunner } from '../../../../../src/modules/connect/agent-package-registry-parts/configured-codex-plugin-carrier.ts';

const skillIds = ['develop-and-deliver', 'task-mode-gate', 'recover-codex-tasks'];
const descriptor = {
  packageId: 'opl-flow',
  carrier: {
    kind: 'codex_plugin_manager' as const,
    pluginId: 'opl-flow@opl-flow-local',
    marketplaceSource: 'opl-flow-local',
  },
  executor: {
    route: 'codex_cli' as const,
    requiredSkillIds: ['opl-flow', 'coordinate-concurrent-tasks', ...skillIds],
  },
  publicationRef: null,
};

function fixture(label: string, source = 'gaofeng21cn/opl-skills') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `opl-flow-skill-migration-${label}-`));
  const agentsRoot = path.join(root, '.agents');
  const skillsRoot = path.join(agentsRoot, 'skills');
  const lockPath = path.join(agentsRoot, '.skill-lock.json');
  const pluginSource = path.join(root, 'plugin-source');
  for (const skillId of [...skillIds, 'unrelated-skill']) {
    fs.mkdirSync(path.join(skillsRoot, skillId), { recursive: true });
    fs.writeFileSync(path.join(skillsRoot, skillId, 'SKILL.md'), `# ${skillId}\n`);
  }
  for (const skillId of descriptor.executor.requiredSkillIds) {
    fs.mkdirSync(path.join(pluginSource, 'skills', skillId), { recursive: true });
    fs.writeFileSync(path.join(pluginSource, 'skills', skillId, 'SKILL.md'), `# ${skillId}\n`);
  }
  const skills = Object.fromEntries([...skillIds, 'unrelated-skill'].map((skillId) => [skillId, {
    source: skillId === 'unrelated-skill' ? 'example/unrelated' : source,
    sourceType: 'github',
    sourceUrl: skillId === 'unrelated-skill'
      ? 'https://github.com/example/unrelated.git'
      : 'https://github.com/gaofeng21cn/opl-skills.git',
    skillPath: `skills/${skillId}/SKILL.md`,
  }]));
  fs.mkdirSync(agentsRoot, { recursive: true });
  fs.writeFileSync(lockPath, formatJsonPayload({ version: 3, skills, dismissed: {} }));
  return {
    root,
    agentsRoot,
    skillsRoot,
    lockPath,
    pluginSource,
    env: { HOME: root },
  };
}

function runnerFor(input: {
  pluginSource: string;
  beforeAdd?: () => void;
  addFailure?: boolean;
  omitSkill?: string;
}): CodexPluginCommandRunner {
  let installed = false;
  return ({ args }) => {
    const command = args.join(' ');
    if (command === 'plugin marketplace list --json') {
      return { status: 0, stdout: '{"marketplaces":[]}', stderr: '', error: null };
    }
    if (command === 'plugin marketplace add opl-flow-local --json') {
      return { status: 0, stdout: '{}', stderr: '', error: null };
    }
    if (command === 'plugin add opl-flow@opl-flow-local --json') {
      input.beforeAdd?.();
      if (input.addFailure) return { status: 2, stdout: '', stderr: 'failed', error: null };
      installed = true;
      return { status: 0, stdout: '{}', stderr: '', error: null };
    }
    if (command === 'plugin list --json') {
      if (input.omitSkill) {
        fs.rmSync(path.join(input.pluginSource, 'skills', input.omitSkill), { recursive: true, force: true });
      }
      return {
        status: 0,
        stdout: JSON.stringify({
          installed: installed ? [{
            pluginId: descriptor.carrier.pluginId,
            version: '0.1.30',
            installed: true,
            enabled: true,
            source: { path: input.pluginSource },
            marketplaceSource: { source: descriptor.carrier.marketplaceSource },
          }] : [],
        }),
        stderr: '',
        error: null,
      };
    }
    return { status: 2, stdout: '', stderr: `unexpected:${command}`, error: null };
  };
}

test('OPL Flow migration removes exact legacy OPL Skills projections before native exposure', () => {
  const state = fixture('success');
  try {
    const execution = runConfiguredCodexPluginCarrierWithLegacyOplSkillsMigration({
      descriptor,
      action: 'update',
      env: state.env,
      runner: runnerFor({
        pluginSource: state.pluginSource,
        beforeAdd: () => {
          for (const skillId of skillIds) assert.equal(fs.existsSync(path.join(state.skillsRoot, skillId)), false);
          const lock = JSON.parse(fs.readFileSync(state.lockPath, 'utf8'));
          for (const skillId of skillIds) assert.equal(Object.hasOwn(lock.skills, skillId), false);
        },
      }),
    });
    assert.equal(execution.carrier.executor.status, 'callable');
    assert.equal(execution.legacySkillMigration.status, 'migrated');
    assert.equal(execution.legacySkillMigration.writes_performed, true);
    assert.ok(execution.legacySkillMigration.backup_root);
    for (const skillId of skillIds) {
      assert.equal(fs.existsSync(path.join(state.skillsRoot, skillId)), false);
      assert.equal(fs.existsSync(path.join(execution.legacySkillMigration.backup_root!, 'skills', skillId)), true);
    }
    const lock = JSON.parse(fs.readFileSync(state.lockPath, 'utf8'));
    assert.deepEqual(Object.keys(lock.skills), ['unrelated-skill']);
  } finally {
    removeFixtureTree(state.root);
  }
});

test('OPL Flow migration restores legacy directories and lock bytes when native exposure fails', () => {
  const state = fixture('rollback');
  const before = fs.readFileSync(state.lockPath);
  try {
    assert.throws(
      () => runConfiguredCodexPluginCarrierWithLegacyOplSkillsMigration({
        descriptor,
        action: 'install',
        env: state.env,
        runner: runnerFor({ pluginSource: state.pluginSource, addFailure: true }),
      }),
      (error: any) => error?.details?.failure_code === 'configured_codex_plugin_carrier_action_failed',
    );
    assert.deepEqual(fs.readFileSync(state.lockPath), before);
    for (const skillId of skillIds) assert.equal(fs.existsSync(path.join(state.skillsRoot, skillId)), true);
  } finally {
    removeFixtureTree(state.root);
  }
});

test('OPL Flow migration rolls back when native readback is not callable', () => {
  const state = fixture('readback-rollback');
  const before = fs.readFileSync(state.lockPath);
  try {
    assert.throws(
      () => runConfiguredCodexPluginCarrierWithLegacyOplSkillsMigration({
        descriptor,
        action: 'repair',
        env: state.env,
        runner: runnerFor({ pluginSource: state.pluginSource, omitSkill: 'task-mode-gate' }),
      }),
      (error: any) => error?.details?.failure_code === 'opl_flow_legacy_skill_native_readback_failed',
    );
    assert.deepEqual(fs.readFileSync(state.lockPath), before);
    for (const skillId of skillIds) assert.equal(fs.existsSync(path.join(state.skillsRoot, skillId)), true);
  } finally {
    removeFixtureTree(state.root);
  }
});

test('OPL Flow migration fails closed for a different source owner without dispatching native action', () => {
  const state = fixture('source-conflict', 'example/other-skills');
  const before = fs.readFileSync(state.lockPath);
  let dispatched = false;
  try {
    assert.throws(
      () => runConfiguredCodexPluginCarrierWithLegacyOplSkillsMigration({
        descriptor,
        action: 'update',
        env: state.env,
        runner: (input) => {
          dispatched = true;
          return runnerFor({ pluginSource: state.pluginSource })(input);
        },
      }),
      (error: any) => error?.details?.failure_code === 'opl_flow_legacy_skill_source_conflict',
    );
    assert.equal(dispatched, false);
    assert.deepEqual(fs.readFileSync(state.lockPath), before);
  } finally {
    removeFixtureTree(state.root);
  }
});

test('OPL Flow migration validates without writes in dry-run mode', () => {
  const state = fixture('dry-run');
  const before = fs.readFileSync(state.lockPath);
  try {
    const execution = runConfiguredCodexPluginCarrierWithLegacyOplSkillsMigration({
      descriptor,
      action: 'install',
      dryRun: true,
      env: state.env,
      runner: runnerFor({ pluginSource: state.pluginSource }),
    });
    assert.equal(execution.legacySkillMigration.status, 'validated_no_write');
    assert.equal(execution.legacySkillMigration.writes_performed, false);
    assert.deepEqual(fs.readFileSync(state.lockPath), before);
    for (const skillId of skillIds) assert.equal(fs.existsSync(path.join(state.skillsRoot, skillId)), true);
  } finally {
    removeFixtureTree(state.root);
  }
});

test('fresh Flow-only home skips legacy migration and still exposes the native carrier', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'opl-flow-skill-migration-fresh-'));
  const pluginSource = path.join(root, 'plugin-source');
  try {
    for (const skillId of descriptor.executor.requiredSkillIds) {
      fs.mkdirSync(path.join(pluginSource, 'skills', skillId), { recursive: true });
      fs.writeFileSync(path.join(pluginSource, 'skills', skillId, 'SKILL.md'), `# ${skillId}\n`);
    }
    const execution = runConfiguredCodexPluginCarrierWithLegacyOplSkillsMigration({
      descriptor,
      action: 'install',
      env: { HOME: root },
      runner: runnerFor({ pluginSource }),
    });
    assert.equal(execution.legacySkillMigration.status, 'not_required');
    assert.equal(execution.carrier.executor.status, 'callable');
  } finally {
    removeFixtureTree(root);
  }
});

test('OPL Flow 0.1.29 descriptor does not retire Skills that it does not bundle', () => {
  const state = fixture('old-flow');
  const before = fs.readFileSync(state.lockPath);
  const oldDescriptor = {
    ...descriptor,
    executor: {
      ...descriptor.executor,
      requiredSkillIds: ['opl-flow', 'coordinate-concurrent-tasks'],
    },
  };
  try {
    const execution = runConfiguredCodexPluginCarrierWithLegacyOplSkillsMigration({
      descriptor: oldDescriptor,
      action: 'update',
      env: state.env,
      runner: runnerFor({ pluginSource: state.pluginSource }),
    });
    assert.equal(execution.legacySkillMigration.status, 'not_required');
    assert.deepEqual(fs.readFileSync(state.lockPath), before);
    for (const skillId of skillIds) assert.equal(fs.existsSync(path.join(state.skillsRoot, skillId)), true);
  } finally {
    removeFixtureTree(state.root);
  }
});
