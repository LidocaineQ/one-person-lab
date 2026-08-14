import { assert, test } from '../../helpers.ts';
import { buildAppUiContributionsProjection } from '../../../../../src/modules/console/app-state-ui-contributions.ts';

function packageStatus(input: {
  installed?: boolean;
  exposureStatus?: string;
  contributionId: string;
  sortOrder: number;
}) {
  return {
    presence: { installed: input.installed !== false },
    capability_exposure: { status: input.exposureStatus ?? 'visible' },
    app_contributions: {
      schema_version: 'opl-app-contributions.v1',
      navigation: [],
      views: [{
        view_id: 'activity',
        view_type: 'activity_log',
        title_i18n: { 'en-US': 'Activity' },
        data_ref: 'example.activity.v1#current',
        command_ids: ['refresh'],
        badge_ids: ['health'],
      }],
      commands: [{
        command_id: 'refresh',
        label_i18n: { 'en-US': 'Refresh' },
        action_ref: 'example.activity.v1#refresh',
        confirmation_required: false,
      }],
      badges: [{
        badge_id: 'health',
        label_i18n: { 'en-US': 'Healthy' },
        data_ref: 'example.activity.v1#health',
        tone: 'success',
      }],
      ui: [{
        contribution_id: input.contributionId,
        slot: 'runtime.detail',
        contribution_kind: 'view',
        trust_tier: 'declarative',
        scope: 'work_item',
        sort_order: input.sortOrder,
        view_id: 'activity',
      }],
    },
  } as any;
}

test('Framework resolves installed Package UI contributions into stable slots', () => {
  const projection = buildAppUiContributionsProjection({
    'z-package': packageStatus({ contributionId: 'later', sortOrder: 20 }),
    'a-package': packageStatus({ contributionId: 'first', sortOrder: 10 }),
    'disabled-package': packageStatus({
      exposureStatus: 'disabled',
      contributionId: 'disabled',
      sortOrder: 0,
    }),
    'uninstalled-package': packageStatus({
      installed: false,
      contributionId: 'uninstalled',
      sortOrder: 0,
    }),
  });

  assert.equal(projection.contribution_count, 2);
  assert.deepEqual(
    projection.slots['runtime.detail'].map((entry) => entry.contribution_key),
    ['a-package:first', 'z-package:later'],
  );
  assert.equal((projection.entries[0].view as any).view_type, 'activity_log');
  assert.equal((projection.entries[0].commands[0] as any).command_id, 'refresh');
  assert.equal((projection.entries[0].badges[0] as any).badge_id, 'health');
  assert.equal(projection.authority_boundary.arbitrary_code_allowed, false);
});

test('Framework emits stable empty slots when no Package contributes UI', () => {
  const projection = buildAppUiContributionsProjection({});

  assert.equal(projection.contribution_count, 0);
  assert.deepEqual(Object.keys(projection.slots), [
    'composer.palette',
    'runtime.detail',
    'settings.section',
  ]);
  assert.deepEqual(projection.entries, []);
});
