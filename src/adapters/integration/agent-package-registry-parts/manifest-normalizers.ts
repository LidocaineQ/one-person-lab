import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { FrameworkContractError, isRecord } from '../../../kernel/contract-validation.ts';
import { recordList, stringList, stringValue } from '../../../kernel/json-record.ts';
import { resolveFirstPartyPackageCatalog } from '../agent-package-first-party.ts';
import { canonicalAgentPackageId } from '../agent-package-identity.ts';
import { MANIFEST_REQUIRED_FIELDS, REGISTRY_REQUIRED_FIELDS } from './constants.ts';
import {
  assertChannelProviderEntrypointsContentLocked,
  normalizePackageEntrypoints,
} from './channel-provider-entrypoint-contract.ts';
import {
  assertExplicitExternalRegistryClaim,
  assertNoForbiddenFields,
  assertStringValue,
  missingFields,
  uniqueStrings,
  validateUrlLike,
} from './shared.ts';
import type {
  AgentPackageAppContributions,
  AgentPackageAppContributionUiSlot,
  AgentPackageAppContributionViewType,
  AgentPackageCapabilityDependency,
  AgentPackageCapabilityProvider,
  AgentPackageConfiguredCodexPluginCarrierDescriptor,
  AgentPackageManagedVersionCatalogSource,
  AgentPackageDistributionPayload,
  AgentPackageManifest,
  AgentPackageManagedPolicySurfaceConfig,
  AgentPackageOrdinaryUserSource,
  AgentPackagePresentation,
  AgentPackageProfileSurfaceConfig,
  AgentPackageRegistryDocument,
  AgentPackageRegistryEntry,
  AgentPackageRole,
} from './types.ts';

const AGENT_PACKAGE_ROLES = new Set<AgentPackageRole>([
  'standard_agent',
  'capability_package',
  'workflow_profile',
]);

const LOCALE_ID_PATTERN = /^[A-Za-z]{2,8}(?:-[A-Za-z0-9]{1,8})*$/;
const APP_CONTRIBUTION_ID_PATTERN = /^[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?$/;
const APP_CONTRIBUTION_REF_PATTERN =
  /^[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?(?:#[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?)?$/;
const APP_CONTRIBUTION_VIEW_TYPES = new Set<AgentPackageAppContributionViewType>([
  'list_detail',
  'timeline',
  'approval_diff',
  'task_board',
  'artifact_view',
  'activity_log',
]);
const APP_CONTRIBUTION_BADGE_TONES = new Set([
  'neutral',
  'info',
  'success',
  'warning',
  'critical',
] as const);
const APP_CONTRIBUTION_UI_SLOTS = new Set<AgentPackageAppContributionUiSlot>([
  'composer.palette',
  'runtime.detail',
  'settings.section',
]);
const APP_CONTRIBUTION_UI_KINDS = new Set(['view', 'command_group'] as const);
const APP_CONTRIBUTION_UI_TRUST_TIERS = new Set([
  'declarative',
  'trusted_first_party_renderer',
] as const);
const APP_CONTRIBUTION_UI_SCOPES = new Set(['root', 'work_item'] as const);
const APP_CONTRIBUTION_MAX_ITEMS = 100;

function appContributionInvalid(
  message: string,
  manifestUrl: string,
  details: Record<string, unknown> = {},
): never {
  throw new FrameworkContractError('contract_shape_invalid', message, {
    manifest_url: manifestUrl,
    ...details,
    failure_code: 'agent_package_app_contributions_invalid',
  });
}

function assertContributionKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  field: string,
  manifestUrl: string,
) {
  const unexpected = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unexpected.length > 0) {
    appContributionInvalid('App contribution contains unsupported fields.', manifestUrl, {
      field,
      unsupported_fields: unexpected,
    });
  }
}

function normalizeContributionId(value: unknown, field: string, manifestUrl: string) {
  const normalized = stringValue(value);
  if (
    !normalized
    || normalized.length > 128
    || !APP_CONTRIBUTION_ID_PATTERN.test(normalized)
  ) {
    appContributionInvalid('App contribution id is invalid.', manifestUrl, {
      field,
      value,
    });
  }
  return normalized;
}

function normalizeContributionRef(value: unknown, field: string, manifestUrl: string) {
  const normalized = stringValue(value);
  if (
    !normalized
    || normalized.length > 257
    || !APP_CONTRIBUTION_REF_PATTERN.test(normalized)
  ) {
    appContributionInvalid('App contribution ref must be a stable data or action identity.', manifestUrl, {
      field,
      value,
    });
  }
  return normalized;
}

function normalizeContributionLocalizedText(
  value: unknown,
  field: string,
  manifestUrl: string,
) {
  if (!isRecord(value) || Object.keys(value).length === 0) {
    appContributionInvalid('App contribution localized text must be a non-empty locale map.', manifestUrl, {
      field,
    });
  }
  const entries = Object.entries(value).map(([locale, text]) => {
    const normalizedText = stringValue(text);
    if (
      !LOCALE_ID_PATTERN.test(locale)
      || !normalizedText
      || normalizedText.length > 2000
    ) {
      appContributionInvalid('App contribution localized text is invalid.', manifestUrl, {
        field,
        locale,
      });
    }
    return [locale, normalizedText] as const;
  });
  return Object.fromEntries(entries);
}

function contributionRecords(
  value: unknown,
  field: string,
  manifestUrl: string,
) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > APP_CONTRIBUTION_MAX_ITEMS) {
    appContributionInvalid('App contribution collection must be a bounded array.', manifestUrl, {
      field,
    });
  }
  const entries = recordList(value);
  if (entries.length !== value.length) {
    appContributionInvalid('App contribution collection entries must be objects.', manifestUrl, {
      field,
    });
  }
  return entries;
}

function contributionIdList(
  value: unknown,
  field: string,
  manifestUrl: string,
) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > APP_CONTRIBUTION_MAX_ITEMS) {
    appContributionInvalid('App contribution id list must be a bounded array.', manifestUrl, {
      field,
    });
  }
  const ids = value.map((entry, index) =>
    normalizeContributionId(entry, `${field}[${index}]`, manifestUrl));
  if (new Set(ids).size !== ids.length) {
    appContributionInvalid('App contribution id list must be unique.', manifestUrl, {
      field,
    });
  }
  return ids;
}

function assertUniqueContributionIds(
  ids: string[],
  field: string,
  manifestUrl: string,
) {
  if (new Set(ids).size !== ids.length) {
    appContributionInvalid('App contribution ids must be unique within their collection.', manifestUrl, {
      field,
    });
  }
}

export function normalizeAppContributions(
  value: unknown,
  manifestUrl: string,
): AgentPackageAppContributions | null {
  if (value === undefined || value === null) return null;
  if (!isRecord(value)) {
    appContributionInvalid('app_contributions must be an object.', manifestUrl);
  }
  assertContributionKeys(
    value,
    ['schema_version', 'navigation', 'views', 'commands', 'badges', 'ui'],
    'app_contributions',
    manifestUrl,
  );
  if (value.schema_version !== 'opl-app-contributions.v1') {
    appContributionInvalid(
      'app_contributions must use schema_version opl-app-contributions.v1.',
      manifestUrl,
      { schema_version: value.schema_version },
    );
  }

  const navigation = contributionRecords(
    value.navigation,
    'app_contributions.navigation',
    manifestUrl,
  ).map((entry, index) => {
    const field = `app_contributions.navigation[${index}]`;
    assertContributionKeys(
      entry,
      ['navigation_id', 'label_i18n', 'view_id', 'icon_id', 'sort_order'],
      field,
      manifestUrl,
    );
    if (
      entry.sort_order !== undefined
      && (
        !Number.isInteger(entry.sort_order)
        || Number(entry.sort_order) < -10000
        || Number(entry.sort_order) > 10000
      )
    ) {
      appContributionInvalid('App navigation sort_order must be a bounded integer.', manifestUrl, {
        field: `${field}.sort_order`,
      });
    }
    return {
      navigation_id: normalizeContributionId(entry.navigation_id, `${field}.navigation_id`, manifestUrl),
      label_i18n: normalizeContributionLocalizedText(entry.label_i18n, `${field}.label_i18n`, manifestUrl),
      view_id: normalizeContributionId(entry.view_id, `${field}.view_id`, manifestUrl),
      ...(entry.icon_id === undefined
        ? {}
        : { icon_id: normalizeContributionId(entry.icon_id, `${field}.icon_id`, manifestUrl) }),
      ...(entry.sort_order === undefined ? {} : { sort_order: Number(entry.sort_order) }),
    };
  });

  const views = contributionRecords(
    value.views,
    'app_contributions.views',
    manifestUrl,
  ).map((entry, index) => {
    const field = `app_contributions.views[${index}]`;
    assertContributionKeys(
      entry,
      [
        'view_id',
        'view_type',
        'title_i18n',
        'data_ref',
        'command_ids',
        'badge_ids',
        'empty_state_i18n',
      ],
      field,
      manifestUrl,
    );
    const viewType = stringValue(entry.view_type);
    if (!viewType || !APP_CONTRIBUTION_VIEW_TYPES.has(viewType as AgentPackageAppContributionViewType)) {
      appContributionInvalid('App contribution view_type is unsupported.', manifestUrl, {
        field: `${field}.view_type`,
        view_type: entry.view_type,
      });
    }
    return {
      view_id: normalizeContributionId(entry.view_id, `${field}.view_id`, manifestUrl),
      view_type: viewType as AgentPackageAppContributionViewType,
      title_i18n: normalizeContributionLocalizedText(entry.title_i18n, `${field}.title_i18n`, manifestUrl),
      data_ref: normalizeContributionRef(entry.data_ref, `${field}.data_ref`, manifestUrl),
      command_ids: contributionIdList(entry.command_ids, `${field}.command_ids`, manifestUrl),
      badge_ids: contributionIdList(entry.badge_ids, `${field}.badge_ids`, manifestUrl),
      ...(entry.empty_state_i18n === undefined
        ? {}
        : {
            empty_state_i18n: normalizeContributionLocalizedText(
              entry.empty_state_i18n,
              `${field}.empty_state_i18n`,
              manifestUrl,
            ),
          }),
    };
  });

  const commands = contributionRecords(
    value.commands,
    'app_contributions.commands',
    manifestUrl,
  ).map((entry, index) => {
    const field = `app_contributions.commands[${index}]`;
    assertContributionKeys(
      entry,
      ['command_id', 'label_i18n', 'action_ref', 'confirmation_required'],
      field,
      manifestUrl,
    );
    if (
      entry.confirmation_required !== undefined
      && typeof entry.confirmation_required !== 'boolean'
    ) {
      appContributionInvalid('App command confirmation_required must be a boolean.', manifestUrl, {
        field: `${field}.confirmation_required`,
      });
    }
    return {
      command_id: normalizeContributionId(entry.command_id, `${field}.command_id`, manifestUrl),
      label_i18n: normalizeContributionLocalizedText(entry.label_i18n, `${field}.label_i18n`, manifestUrl),
      action_ref: normalizeContributionRef(entry.action_ref, `${field}.action_ref`, manifestUrl),
      confirmation_required: entry.confirmation_required === true,
    };
  });

  const badges = contributionRecords(
    value.badges,
    'app_contributions.badges',
    manifestUrl,
  ).map((entry, index) => {
    const field = `app_contributions.badges[${index}]`;
    assertContributionKeys(
      entry,
      ['badge_id', 'label_i18n', 'data_ref', 'tone'],
      field,
      manifestUrl,
    );
    const tone = entry.tone === undefined ? null : stringValue(entry.tone);
    if (
      tone !== null
      && !APP_CONTRIBUTION_BADGE_TONES.has(
        tone as typeof APP_CONTRIBUTION_BADGE_TONES extends Set<infer T> ? T : never,
      )
    ) {
      appContributionInvalid('App contribution badge tone is unsupported.', manifestUrl, {
        field: `${field}.tone`,
        tone: entry.tone,
      });
    }
    return {
      badge_id: normalizeContributionId(entry.badge_id, `${field}.badge_id`, manifestUrl),
      label_i18n: normalizeContributionLocalizedText(entry.label_i18n, `${field}.label_i18n`, manifestUrl),
      data_ref: normalizeContributionRef(entry.data_ref, `${field}.data_ref`, manifestUrl),
      ...(tone === null
        ? {}
        : { tone: tone as 'neutral' | 'info' | 'success' | 'warning' | 'critical' }),
    };
  });

  const ui = contributionRecords(
    value.ui,
    'app_contributions.ui',
    manifestUrl,
  ).map((entry, index) => {
    const field = `app_contributions.ui[${index}]`;
    assertContributionKeys(
      entry,
      [
        'contribution_id',
        'slot',
        'contribution_kind',
        'trust_tier',
        'scope',
        'sort_order',
        'view_id',
        'command_ids',
      ],
      field,
      manifestUrl,
    );
    const slot = stringValue(entry.slot);
    const contributionKind = stringValue(entry.contribution_kind);
    const trustTier = stringValue(entry.trust_tier);
    const scope = stringValue(entry.scope);
    if (!slot || !APP_CONTRIBUTION_UI_SLOTS.has(slot as AgentPackageAppContributionUiSlot)) {
      appContributionInvalid('App UI contribution slot is unsupported.', manifestUrl, {
        field: `${field}.slot`,
        slot: entry.slot,
      });
    }
    if (!contributionKind || !APP_CONTRIBUTION_UI_KINDS.has(contributionKind as 'view' | 'command_group')) {
      appContributionInvalid('App UI contribution kind is unsupported.', manifestUrl, {
        field: `${field}.contribution_kind`,
        contribution_kind: entry.contribution_kind,
      });
    }
    if (!trustTier || !APP_CONTRIBUTION_UI_TRUST_TIERS.has(
      trustTier as 'declarative' | 'trusted_first_party_renderer',
    )) {
      appContributionInvalid('App UI contribution trust tier is unsupported.', manifestUrl, {
        field: `${field}.trust_tier`,
        trust_tier: entry.trust_tier,
      });
    }
    if (!scope || !APP_CONTRIBUTION_UI_SCOPES.has(scope as 'root' | 'work_item')) {
      appContributionInvalid('App UI contribution scope is unsupported.', manifestUrl, {
        field: `${field}.scope`,
        scope: entry.scope,
      });
    }
    const viewId = entry.view_id === undefined
      ? null
      : normalizeContributionId(entry.view_id, `${field}.view_id`, manifestUrl);
    const commandIds = contributionIdList(entry.command_ids, `${field}.command_ids`, manifestUrl);
    if (
      (contributionKind === 'view' && (viewId === null || commandIds.length > 0))
      || (contributionKind === 'command_group' && (viewId !== null || commandIds.length === 0))
    ) {
      appContributionInvalid(
        'App UI view placements require only view_id; command_group placements require only command_ids.',
        manifestUrl,
        { field },
      );
    }
    if (
      entry.sort_order !== undefined
      && (
        !Number.isInteger(entry.sort_order)
        || Number(entry.sort_order) < -10000
        || Number(entry.sort_order) > 10000
      )
    ) {
      appContributionInvalid('App UI contribution sort_order must be a bounded integer.', manifestUrl, {
        field: `${field}.sort_order`,
      });
    }
    return {
      contribution_id: normalizeContributionId(
        entry.contribution_id,
        `${field}.contribution_id`,
        manifestUrl,
      ),
      slot: slot as AgentPackageAppContributionUiSlot,
      contribution_kind: contributionKind as 'view' | 'command_group',
      trust_tier: trustTier as 'declarative' | 'trusted_first_party_renderer',
      scope: scope as 'root' | 'work_item',
      sort_order: entry.sort_order === undefined ? 0 : Number(entry.sort_order),
      ...(viewId === null ? {} : { view_id: viewId }),
      ...(commandIds.length === 0 ? {} : { command_ids: commandIds }),
    };
  });

  assertUniqueContributionIds(
    navigation.map((entry) => entry.navigation_id),
    'app_contributions.navigation.navigation_id',
    manifestUrl,
  );
  assertUniqueContributionIds(
    views.map((entry) => entry.view_id),
    'app_contributions.views.view_id',
    manifestUrl,
  );
  assertUniqueContributionIds(
    commands.map((entry) => entry.command_id),
    'app_contributions.commands.command_id',
    manifestUrl,
  );
  assertUniqueContributionIds(
    badges.map((entry) => entry.badge_id),
    'app_contributions.badges.badge_id',
    manifestUrl,
  );
  assertUniqueContributionIds(
    ui.map((entry) => entry.contribution_id),
    'app_contributions.ui.contribution_id',
    manifestUrl,
  );

  const viewIds = new Set(views.map((entry) => entry.view_id));
  const commandIds = new Set(commands.map((entry) => entry.command_id));
  const badgeIds = new Set(badges.map((entry) => entry.badge_id));
  const missingNavigationViewIds = navigation
    .map((entry) => entry.view_id)
    .filter((viewId) => !viewIds.has(viewId));
  const missingCommandIds = views
    .flatMap((entry) => entry.command_ids)
    .filter((commandId) => !commandIds.has(commandId));
  const missingBadgeIds = views
    .flatMap((entry) => entry.badge_ids)
    .filter((badgeId) => !badgeIds.has(badgeId));
  const missingUiViewIds = ui
    .map((entry) => entry.view_id)
    .filter((viewId): viewId is string => typeof viewId === 'string')
    .filter((viewId) => !viewIds.has(viewId));
  const missingUiCommandIds = ui
    .flatMap((entry) => entry.command_ids ?? [])
    .filter((commandId) => !commandIds.has(commandId));
  if (
    missingNavigationViewIds.length > 0
    || missingCommandIds.length > 0
    || missingBadgeIds.length > 0
    || missingUiViewIds.length > 0
    || missingUiCommandIds.length > 0
  ) {
    appContributionInvalid('App contribution references must resolve inside the contribution.', manifestUrl, {
      missing_view_ids: uniqueStrings(missingNavigationViewIds),
      missing_command_ids: uniqueStrings(missingCommandIds),
      missing_badge_ids: uniqueStrings(missingBadgeIds),
      missing_ui_view_ids: uniqueStrings(missingUiViewIds),
      missing_ui_command_ids: uniqueStrings(missingUiCommandIds),
    });
  }
  if (navigation.length + views.length + commands.length + badges.length + ui.length === 0) {
    appContributionInvalid('app_contributions must expose at least one contribution.', manifestUrl);
  }

  return {
    schema_version: 'opl-app-contributions.v1',
    navigation,
    views,
    commands,
    badges,
    ...(ui.length === 0 ? {} : { ui }),
  };
}

function normalizeLocalizedText(
  value: unknown,
  field: string,
  manifestUrl: string,
) {
  if (!isRecord(value) || Object.keys(value).length === 0) {
    throw new FrameworkContractError('contract_shape_invalid', 'Agent package presentation localized text must be a non-empty locale map.', {
      manifest_url: manifestUrl,
      field,
      failure_code: 'agent_package_presentation_invalid',
    });
  }
  const localized = Object.entries(value).map(([locale, text]) => {
    const normalizedText = stringValue(text);
    if (!LOCALE_ID_PATTERN.test(locale) || !normalizedText) {
      throw new FrameworkContractError('contract_shape_invalid', 'Agent package presentation locale or localized text is invalid.', {
        manifest_url: manifestUrl,
        field,
        locale,
        failure_code: 'agent_package_presentation_invalid',
      });
    }
    return [locale, normalizedText] as const;
  });
  return Object.fromEntries(localized);
}

function normalizePresentation(
  value: unknown,
  manifestUrl: string,
): AgentPackagePresentation | null {
  if (value === undefined || value === null) return null;
  if (!isRecord(value) || !Array.isArray(value.home_shortcuts)) {
    throw new FrameworkContractError('contract_shape_invalid', 'Agent package presentation must declare home_shortcuts.', {
      manifest_url: manifestUrl,
      failure_code: 'agent_package_presentation_invalid',
    });
  }
  const rawShortcuts = recordList(value.home_shortcuts);
  if (rawShortcuts.length !== value.home_shortcuts.length) {
    throw new FrameworkContractError('contract_shape_invalid', 'Agent package presentation shortcuts must be objects.', {
      manifest_url: manifestUrl,
      failure_code: 'agent_package_presentation_invalid',
    });
  }
  const homeShortcuts = rawShortcuts.map((entry, index) => {
    const shortcutId = assertStringValue(entry.shortcut_id, `presentation.home_shortcuts[${index}].shortcut_id`);
    if (typeof entry.default_visible !== 'boolean' || typeof entry.user_configurable !== 'boolean' || !isRecord(entry.route)) {
      throw new FrameworkContractError('contract_shape_invalid', 'Agent package presentation shortcut flags and route are invalid.', {
        manifest_url: manifestUrl,
        shortcut_id: shortcutId,
        failure_code: 'agent_package_presentation_invalid',
      });
    }
    if (entry.route.route_kind !== 'agent_package_shortcut' || entry.route.executor !== 'codex_cli') {
      throw new FrameworkContractError('contract_shape_invalid', 'Agent package presentation route must use the generic Codex CLI shortcut route.', {
        manifest_url: manifestUrl,
        shortcut_id: shortcutId,
        failure_code: 'agent_package_presentation_invalid',
      });
    }
    return {
      shortcut_id: shortcutId,
      label_i18n: normalizeLocalizedText(entry.label_i18n, `presentation.home_shortcuts[${index}].label_i18n`, manifestUrl),
      default_visible: entry.default_visible,
      user_configurable: entry.user_configurable,
      route: {
        route_kind: 'agent_package_shortcut' as const,
        executor: 'codex_cli' as const,
        codex_visible_entry: assertStringValue(
          entry.route.codex_visible_entry,
          `presentation.home_shortcuts[${index}].route.codex_visible_entry`,
        ),
      },
    };
  });
  const duplicateShortcutIds = homeShortcuts
    .map((entry) => entry.shortcut_id)
    .filter((shortcutId, index, values) => values.indexOf(shortcutId) !== index);
  if (duplicateShortcutIds.length > 0) {
    throw new FrameworkContractError('contract_shape_invalid', 'Agent package presentation shortcut ids must be unique.', {
      manifest_url: manifestUrl,
      duplicate_shortcut_ids: uniqueStrings(duplicateShortcutIds),
      failure_code: 'agent_package_presentation_invalid',
    });
  }
  return {
    display_name_i18n: normalizeLocalizedText(value.display_name_i18n, 'presentation.display_name_i18n', manifestUrl),
    description_i18n: normalizeLocalizedText(value.description_i18n, 'presentation.description_i18n', manifestUrl),
    session_routing_summary_i18n: normalizeLocalizedText(
      value.session_routing_summary_i18n,
      'presentation.session_routing_summary_i18n',
      manifestUrl,
    ),
    home_shortcuts: homeShortcuts,
  };
}

function normalizeAgentPackageRole(value: unknown, field: string): AgentPackageRole | null {
  const role = stringValue(value);
  if (!role) return null;
  if (!AGENT_PACKAGE_ROLES.has(role as AgentPackageRole)) {
    throw new FrameworkContractError('contract_shape_invalid', 'Agent package registry role is invalid.', {
      field,
      role,
      allowed_roles: [...AGENT_PACKAGE_ROLES],
      failure_code: 'agent_package_registry_role_invalid',
    });
  }
  return role as AgentPackageRole;
}

function normalizeCodexDefaultExposure(
  codexSurface: Record<string, unknown>,
  manifestUrl: string,
) {
  const value = codexSurface.codex_default_exposure;
  if (value === undefined) return true;
  if (typeof value !== 'boolean') {
    throw new FrameworkContractError('contract_shape_invalid', 'Agent package codex_default_exposure must be a boolean when declared.', {
      manifest_url: manifestUrl,
      codex_default_exposure: value,
      failure_code: 'agent_package_codex_default_exposure_invalid',
    });
  }
  return value;
}

function normalizeCapabilityDependencies(
  value: unknown,
  manifestUrl: string,
): AgentPackageCapabilityDependency[] {
  if (!Array.isArray(value)) {
    throw new FrameworkContractError('contract_shape_invalid', 'Agent package manifest capability_dependencies must be an array.', {
      manifest_url: manifestUrl,
      failure_code: 'invalid_package_manifest',
    });
  }
  const entries = recordList(value);
  if (entries.length !== value.length) {
    throw new FrameworkContractError('contract_shape_invalid', 'Agent package capability dependencies must be objects.', {
      manifest_url: manifestUrl,
      failure_code: 'agent_package_capability_dependency_invalid',
    });
  }
  const dependencies = entries.map((entry, index) => {
    const packageId = canonicalManifestIdentity(entry.package_id, `capability_dependencies[${index}].package_id`);
    if (typeof entry.required !== 'boolean') {
      throw new FrameworkContractError('contract_shape_invalid', 'Agent package capability dependency required must be a boolean.', {
        manifest_url: manifestUrl,
        package_id: packageId,
        dependency_index: index,
        failure_code: 'agent_package_capability_dependency_invalid',
      });
    }
    const required = entry.required;
    const dependencyKind = entry.dependency_kind === undefined && required
      ? 'hard_runtime_dependency'
      : entry.dependency_kind;
    const expectedDependencyKind: AgentPackageCapabilityDependency['dependency_kind'] = required
      ? 'hard_runtime_dependency'
      : 'optional_enhancement';
    if (dependencyKind !== expectedDependencyKind) {
      throw new FrameworkContractError('contract_shape_invalid', 'Agent package capability dependency required and dependency_kind must agree.', {
        manifest_url: manifestUrl,
        package_id: packageId,
        dependency_index: index,
        required,
        expected_dependency_kind: expectedDependencyKind,
        actual_dependency_kind: dependencyKind,
        failure_code: 'agent_package_capability_dependency_invalid',
      });
    }
    const versionRequirement = stringValue(entry.version_requirement) ?? '*';
    const capabilityAbi = assertStringValue(
      entry.capability_abi,
      `capability_dependencies[${index}].capability_abi`,
    );
    const consumerProfileId = entry.consumer_profile_id === undefined
      ? null
      : assertStringValue(
          entry.consumer_profile_id,
          `capability_dependencies[${index}].consumer_profile_id`,
        );
    const requiredExportIds = uniqueStrings(stringList(entry.required_export_ids));
    const requiredModuleIds = uniqueStrings(stringList(entry.required_module_ids));
    if (requiredExportIds.length === 0 || requiredModuleIds.length === 0) {
      throw new FrameworkContractError('contract_shape_invalid', 'Capability dependencies must declare required_export_ids and required_module_ids.', {
        manifest_url: manifestUrl,
        package_id: packageId,
        dependency_index: index,
        failure_code: 'agent_package_capability_dependency_invalid',
      });
    }
    const bootstrapManifestRef = stringValue(entry.bootstrap_manifest_url)
      ?? stringValue(entry.manifest_url);
    return {
      package_id: packageId,
      required,
      dependency_kind: expectedDependencyKind,
      version_requirement: versionRequirement,
      capability_abi: capabilityAbi,
      consumer_profile_id: consumerProfileId,
      required_export_ids: requiredExportIds,
      required_module_ids: requiredModuleIds,
      bootstrap_manifest_url: bootstrapManifestRef
        ? resolveManifestRelativeSource(bootstrapManifestRef, manifestUrl)
        : null,
      dependency_source: normalizeManagedVersionCatalogSource(entry.dependency_source, manifestUrl),
    };
  });
  const duplicatePackageIds = dependencies
    .map((entry) => entry.package_id)
    .filter((packageId, index, values) => values.indexOf(packageId) !== index);
  if (duplicatePackageIds.length > 0) {
    throw new FrameworkContractError('contract_shape_invalid', 'Capability dependency package ids must be unique.', {
      manifest_url: manifestUrl,
      duplicate_package_ids: uniqueStrings(duplicatePackageIds),
      failure_code: 'agent_package_capability_dependency_invalid',
    });
  }
  return dependencies;
}

function normalizeCapabilityConsumerProfiles(
  value: unknown,
  exports: AgentPackageCapabilityProvider['exports'],
  moduleExportIds: string[],
): AgentPackageCapabilityProvider['consumer_profiles'] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) {
    throw new FrameworkContractError('contract_shape_invalid', 'Capability provider consumer_profiles must be an array.', {
      failure_code: 'agent_package_capability_consumer_profile_invalid',
    });
  }
  const rawProfiles = recordList(value);
  if (rawProfiles.length !== value.length) {
    throw new FrameworkContractError('contract_shape_invalid', 'Capability provider consumer profiles must be objects.', {
      failure_code: 'agent_package_capability_consumer_profile_invalid',
    });
  }
  const exportIds = new Set(exports.map((entry) => entry.export_id));
  const availableModuleIds = new Set(moduleExportIds);
  const profiles = rawProfiles.map((entry, index) => {
    const profileId = assertStringValue(entry.profile_id, `consumer_profiles[${index}].profile_id`);
    const consumerAgentId = canonicalManifestIdentity(
      entry.consumer_agent_id,
      `consumer_profiles[${index}].consumer_agent_id`,
    );
    const requiredExportIds = uniqueStrings(stringList(entry.required_export_ids));
    const requiredModuleIds = uniqueStrings(stringList(entry.required_module_ids));
    const missingExportIds = requiredExportIds.filter((exportId) => !exportIds.has(exportId));
    const missingModuleIds = requiredModuleIds.filter((moduleId) => !availableModuleIds.has(moduleId));
    if (
      requiredExportIds.length === 0
      || requiredModuleIds.length === 0
      || missingExportIds.length > 0
      || missingModuleIds.length > 0
    ) {
      throw new FrameworkContractError('contract_shape_invalid', 'Capability consumer profile must reference exported Skills and modules.', {
        profile_id: profileId,
        consumer_agent_id: consumerAgentId,
        missing_required_export_ids: missingExportIds,
        missing_required_module_ids: missingModuleIds,
        failure_code: 'agent_package_capability_consumer_profile_invalid',
      });
    }
    return {
      profile_id: profileId,
      consumer_agent_id: consumerAgentId,
      required_export_ids: requiredExportIds,
      required_module_ids: requiredModuleIds,
    };
  });
  const duplicateProfileIds = profiles
    .map((entry) => entry.profile_id)
    .filter((profileId, index, values) => values.indexOf(profileId) !== index);
  if (duplicateProfileIds.length > 0) {
    throw new FrameworkContractError('contract_shape_invalid', 'Capability consumer profile ids must be unique.', {
      duplicate_profile_ids: uniqueStrings(duplicateProfileIds),
      failure_code: 'agent_package_capability_consumer_profile_invalid',
    });
  }
  return profiles;
}

function normalizeManagedVersionCatalogSource(
  value: unknown,
  manifestUrl: string,
): AgentPackageManagedVersionCatalogSource | null {
  if (value === undefined || value === null) return null;
  if (!isRecord(value)
    || value.kind !== 'managed_version_catalog'
    || (value.transport !== 'json_url' && value.transport !== 'opl_oci_channel')
    || value.digest_authority !== 'manifest_and_content_digest') {
    throw new FrameworkContractError('contract_shape_invalid', 'Managed package update source must declare a digest-authoritative version catalog.', {
      failure_code: 'agent_package_managed_version_catalog_invalid',
    });
  }
  const catalogRef = assertStringValue(value.catalog_ref, 'managed_version_catalog.catalog_ref');
  return {
    kind: 'managed_version_catalog' as const,
    transport: value.transport as AgentPackageManagedVersionCatalogSource['transport'],
    catalog_ref: value.transport === 'json_url'
      ? resolveManifestRelativeSource(catalogRef, manifestUrl)
      : catalogRef,
    digest_authority: 'manifest_and_content_digest' as const,
  };
}

function normalizeCapabilityProvider(value: unknown): AgentPackageCapabilityProvider | null {
  if (value === undefined || value === null) return null;
  if (!isRecord(value) || !Array.isArray(value.exports)) {
    throw new FrameworkContractError('contract_shape_invalid', 'Capability provider must declare an exports array.', {
      failure_code: 'agent_package_capability_provider_invalid',
    });
  }
  const capabilityAbi = assertStringValue(value.capability_abi, 'capability_provider.capability_abi');
  const rawExports = recordList(value.exports);
  if (rawExports.length !== value.exports.length) {
    throw new FrameworkContractError('contract_shape_invalid', 'Capability provider exports must be objects.', {
      failure_code: 'agent_package_capability_provider_invalid',
    });
  }
  const exports = rawExports.map((entry, index) => {
    const installMode = stringValue(entry.install_mode);
    if (installMode !== 'core_required' && installMode !== 'optional_named_specialty') {
      throw new FrameworkContractError('contract_shape_invalid', 'Capability provider export install_mode is invalid.', {
        export_index: index,
        install_mode: installMode,
        failure_code: 'agent_package_capability_provider_invalid',
      });
    }
    return {
      export_id: assertStringValue(entry.export_id, `capability_provider.exports[${index}].export_id`),
      skill_id: assertStringValue(entry.skill_id, `capability_provider.exports[${index}].skill_id`),
      install_mode: installMode as 'core_required' | 'optional_named_specialty',
    };
  });
  for (const field of ['export_id', 'skill_id'] as const) {
    const duplicateValues = exports
      .map((entry) => entry[field])
      .filter((entry, index, values) => values.indexOf(entry) !== index);
    if (duplicateValues.length > 0) {
      throw new FrameworkContractError('contract_shape_invalid', `Capability provider ${field} values must be unique.`, {
        duplicate_values: uniqueStrings(duplicateValues),
        failure_code: 'agent_package_capability_provider_invalid',
      });
    }
  }
  const moduleExportIds = uniqueStrings(stringList(value.module_export_ids));
  const consumerProfiles = normalizeCapabilityConsumerProfiles(
    value.consumer_profiles,
    exports,
    moduleExportIds,
  );
  return {
    capability_abi: capabilityAbi,
    exports,
    module_export_ids: moduleExportIds,
    consumer_profiles: consumerProfiles,
  };
}

function normalizedRelativePath(value: unknown, field: string) {
  const raw = assertStringValue(value, field);
  const normalized = path.normalize(raw);
  if (path.isAbsolute(raw) || normalized === '.' || normalized === '..' || normalized.startsWith(`..${path.sep}`)) {
    throw new FrameworkContractError('contract_shape_invalid', `${field} must stay within its declared package or Codex home root.`, {
      field,
      value: raw,
      failure_code: 'agent_package_profile_path_invalid',
    });
  }
  return normalized;
}

function normalizeProfileSurface(value: unknown): AgentPackageProfileSurfaceConfig | null {
  if (value === undefined || value === null) return null;
  if (!isRecord(value) || !isRecord(value.runtime_profile)) {
    throw new FrameworkContractError('contract_shape_invalid', 'Agent package profile_surface must declare runtime_profile.', {
      failure_code: 'agent_package_profile_surface_invalid',
    });
  }
  if (value.existing_profile_policy !== 'semantic_merge_required') {
    throw new FrameworkContractError('contract_shape_invalid', 'Agent package profile_surface must fail closed to semantic merge for existing profiles.', {
      failure_code: 'agent_package_profile_surface_invalid',
      field: 'profile_surface.existing_profile_policy',
    });
  }
  if (value.runtime_profile.target_id !== 'user_agents_profile') {
    throw new FrameworkContractError('contract_shape_invalid', 'Agent package runtime profile must target the canonical user profile id.', {
      failure_code: 'agent_package_profile_surface_invalid',
      field: 'profile_surface.runtime_profile.target_id',
    });
  }
  const authoringSources = recordList(value.authoring_sources ?? []);
  if (!Array.isArray(value.authoring_sources) || authoringSources.length !== value.authoring_sources.length) {
    throw new FrameworkContractError('contract_shape_invalid', 'Agent package profile_surface.authoring_sources must be an array of objects.', {
      failure_code: 'agent_package_profile_surface_invalid',
    });
  }
  if (!Array.isArray(value.merge_context_paths)) {
    throw new FrameworkContractError('contract_shape_invalid', 'Agent package profile_surface.merge_context_paths must be an array.', {
      failure_code: 'agent_package_profile_surface_invalid',
    });
  }
  return {
    runtime_profile: {
      source_path: normalizedRelativePath(value.runtime_profile.source_path, 'profile_surface.runtime_profile.source_path'),
      target_id: 'user_agents_profile',
    },
    authoring_sources: authoringSources.map((entry, index) => {
      if (entry.target_id !== 'user_taste_source') {
        throw new FrameworkContractError('contract_shape_invalid', 'Agent package authoring source must target the canonical user authoring id.', {
          failure_code: 'agent_package_profile_surface_invalid',
          field: `profile_surface.authoring_sources[${index}].target_id`,
        });
      }
      return {
        source_path: normalizedRelativePath(entry.source_path, `profile_surface.authoring_sources[${index}].source_path`),
        target_id: 'user_taste_source' as const,
      };
    }),
    merge_context_paths: stringList(value.merge_context_paths).map((entry, index) =>
      normalizedRelativePath(entry, `profile_surface.merge_context_paths[${index}]`)),
    existing_profile_policy: 'semantic_merge_required',
  };
}

function normalizeManagedPolicySurface(value: unknown): AgentPackageManagedPolicySurfaceConfig | null {
  if (value === undefined || value === null) return null;
  if (!isRecord(value) || value.policy_kind !== 'opl_flow_workflow_policy') {
    throw new FrameworkContractError('contract_shape_invalid', 'Agent package managed_policy_surface must declare a supported policy kind.', {
      failure_code: 'agent_package_managed_policy_surface_invalid',
    });
  }
  return {
    policy_kind: 'opl_flow_workflow_policy',
    source_path: normalizedRelativePath(value.source_path, 'managed_policy_surface.source_path'),
    schema_path: normalizedRelativePath(value.schema_path, 'managed_policy_surface.schema_path'),
  };
}

function normalizeDistributionPayload(value: unknown): AgentPackageDistributionPayload | null {
  if (value === undefined || value === null) {
    return null;
  }
  if (!isRecord(value)) {
    throw new FrameworkContractError('contract_shape_invalid', 'Agent package distribution_payload must be a JSON object.', {
      failure_code: 'agent_package_distribution_payload_invalid',
    });
  }
  if (
    value.live_download_proof !== false
    || value.installed_reload_proof !== false
    || value.moving_tag !== 'latest-stable'
    || value.promotion_policy !== 'daily_candidate_gates_then_promote_latest_stable'
    || value.install_truth !== 'resolved_digest_lock'
  ) {
    throw new FrameworkContractError('contract_shape_invalid', 'OPL Package OCI distribution must use candidate/latest-stable and digest-lock install truth.', {
      failure_code: 'agent_package_distribution_policy_invalid',
      required: {
        live_download_proof: false,
        installed_reload_proof: false,
        moving_tag: 'latest-stable',
        promotion_policy: 'daily_candidate_gates_then_promote_latest_stable',
        install_truth: 'resolved_digest_lock',
      },
    });
  }
  const payloadDigestRef = assertStringValue(value.payload_digest_ref, 'distribution_payload.payload_digest_ref');
  if (!/^sha256:[0-9a-f]{64}$/.test(payloadDigestRef)) {
    throw new FrameworkContractError('contract_shape_invalid', 'Agent package install truth must be a SHA-256 digest ref.', {
      failure_code: 'agent_package_distribution_digest_required',
      payload_digest_ref: payloadDigestRef,
    });
  }
  const requiredSkillPackLockRefs = stringList(value.required_skill_pack_lock_refs);
  return {
    payload_kind: assertStringValue(value.payload_kind, 'distribution_payload.payload_kind'),
    payload_ref: assertStringValue(value.payload_ref, 'distribution_payload.payload_ref'),
    payload_digest_ref: payloadDigestRef,
    required_skill_pack_lock_refs: requiredSkillPackLockRefs,
    proof_status: assertStringValue(value.proof_status, 'distribution_payload.proof_status'),
    live_download_proof: false,
    installed_reload_proof: false,
    oci_ref: assertStringValue(value.oci_ref, 'distribution_payload.oci_ref'),
    oci_media_type: assertStringValue(value.oci_media_type, 'distribution_payload.oci_media_type'),
    immutable_tag: assertStringValue(value.immutable_tag, 'distribution_payload.immutable_tag'),
    moving_tag: 'latest-stable',
    promotion_policy: 'daily_candidate_gates_then_promote_latest_stable',
    install_truth: 'resolved_digest_lock',
  };
}

function normalizeOrdinaryUserSource(value: unknown, sourceLabel: string): AgentPackageOrdinaryUserSource | null {
  if (value === undefined || value === null) {
    return null;
  }
  if (!isRecord(value)) {
    throw new FrameworkContractError('contract_shape_invalid', 'Agent package ordinary_user_source must be a JSON object.', {
      source: sourceLabel,
      failure_code: 'agent_package_ordinary_source_invalid',
    });
  }
  if (
    value.kind !== 'ghcr_oci_artifact_latest_stable'
    || value.registry !== 'ghcr.io'
    || value.latest_stable_is_only_ordinary_user_channel !== true
    || value.latest_stable_is_install_truth !== false
    || value.latest_stable_role !== 'ordinary_user_latest_stable_pointer_after_candidate_gates'
    || value.daily_candidate_build_gate !== 'daily_candidate_build_must_pass_before_promote_latest_stable'
    || value.developer_checkout_auto_apply_allowed !== false
  ) {
    throw new FrameworkContractError('contract_shape_invalid', 'OPL Package ordinary user source must use GHCR latest-stable after candidate gates without treating the moving tag as install truth.', {
      source: sourceLabel,
      failure_code: 'agent_package_ordinary_source_policy_invalid',
    });
  }
  const installTruth = stringList(value.install_truth);
  for (const required of ['immutable_version_tag', 'oci_digest', 'package_lock_receipt']) {
    if (!installTruth.includes(required)) {
      throw new FrameworkContractError('contract_shape_invalid', 'Agent package ordinary user source must declare immutable tag, OCI digest, and package lock receipt as install truth.', {
        source: sourceLabel,
        failure_code: 'agent_package_ordinary_source_install_truth_invalid',
        missing_install_truth: required,
      });
    }
  }
  const ordinaryUserRef = assertStringValue(value.ordinary_user_ref, `${sourceLabel}.ordinary_user_ref`);
  if (!ordinaryUserRef.endsWith(':latest-stable')) {
    throw new FrameworkContractError('contract_shape_invalid', 'OPL Package ordinary user ref must be the latest-stable tag.', {
      source: sourceLabel,
      failure_code: 'agent_package_ordinary_source_latest_stable_ref_required',
      ordinary_user_ref: ordinaryUserRef,
    });
  }
  const artifactRef = assertStringValue(value.artifact_ref, `${sourceLabel}.artifact_ref`);
  const immutableVersionRefPattern = assertStringValue(
    value.immutable_version_ref_pattern,
    `${sourceLabel}.immutable_version_ref_pattern`,
  );
  const candidateRef = assertStringValue(value.candidate_ref, `${sourceLabel}.candidate_ref`);
  if (ordinaryUserRef !== `${artifactRef}:latest-stable`
    || candidateRef !== `${artifactRef}:candidate`
    || immutableVersionRefPattern !== `${artifactRef}:<semver>`) {
    throw new FrameworkContractError('contract_shape_invalid', 'OPL Package channel refs must share one canonical OCI artifact repository.', {
      source: sourceLabel,
      failure_code: 'agent_package_ordinary_source_repository_mismatch',
    });
  }
  return {
    kind: 'ghcr_oci_artifact_latest_stable',
    registry: 'ghcr.io',
    artifact_ref: artifactRef,
    ordinary_user_ref: ordinaryUserRef,
    immutable_version_ref_pattern: immutableVersionRefPattern,
    candidate_ref: candidateRef,
    latest_stable_role: 'ordinary_user_latest_stable_pointer_after_candidate_gates',
    latest_stable_is_only_ordinary_user_channel: true,
    daily_candidate_build_gate: 'daily_candidate_build_must_pass_before_promote_latest_stable',
    install_truth: installTruth,
    latest_stable_is_install_truth: false,
    developer_checkout_auto_apply_allowed: false,
  };
}

export function normalizeRegistryEntry(entry: Record<string, unknown>, index: number): AgentPackageRegistryEntry {
  const declaredPackageId = stringValue(entry.package_id);
  const packageId = declaredPackageId
    ? canonicalManifestIdentity(declaredPackageId, `registry.entries.${index}.package_id`)
    : null;
  if (resolveFirstPartyPackageCatalog(packageId)) {
    throw new FrameworkContractError('contract_shape_invalid', 'External registries cannot claim canonical first-party package identities.', {
      entry_index: index,
      package_id: packageId,
      failure_code: 'agent_package_registry_first_party_identity_collision',
    });
  }
  const missing = missingFields(entry, REGISTRY_REQUIRED_FIELDS);
  assertNoForbiddenFields(entry, `registry.entries.${index}`);
  if (missing.length > 0) {
    throw new FrameworkContractError('contract_shape_invalid', 'Agent package registry entry is missing required fields.', {
      entry_index: index,
      missing_fields: missing,
    });
  }
  if ('latest_version' in entry) {
    throw new FrameworkContractError('contract_shape_invalid', 'Agent package registry entries must not duplicate package version truth.', {
      entry_index: index,
      forbidden_field: 'latest_version',
      canonical_field: 'version_source_ref',
      failure_code: 'agent_package_registry_latest_version_retired',
    });
  }
  const manifestUrl = stringValue(entry.manifest_url)!;
  const versionSourceRef = stringValue(entry.version_source_ref)!;
  if (manifestUrl.startsWith('opl+oci://') || versionSourceRef.startsWith('opl+oci://')) {
    throw new FrameworkContractError('contract_shape_invalid', 'Agent package registry entries must use manifest sources supported by explicit package selection.', {
      entry_index: index,
      manifest_url: manifestUrl,
      version_source_ref: versionSourceRef,
      supported_schemes: ['https', 'http', 'file', 'local_path'],
      failure_code: 'agent_package_registry_manifest_scheme_unsupported',
    });
  }
  validateUrlLike(manifestUrl, `entries.${index}.manifest_url`);
  validateUrlLike(versionSourceRef, `entries.${index}.version_source_ref`);
  const displayName = stringValue(entry.display_name)!;
  const source = assertExplicitExternalRegistryClaim(entry.source, {
    field: 'source',
    sourceLabel: `registry.entries.${index}`,
    failureCode: 'agent_package_registry_source_invalid',
  });
  const trustTier = assertExplicitExternalRegistryClaim(entry.trust_tier, {
    field: 'trust_tier',
    sourceLabel: `registry.entries.${index}`,
    failureCode: 'agent_package_registry_trust_tier_invalid',
  });
  const packageRole = normalizeAgentPackageRole(entry.package_role, `entries.${index}.package_role`);
  const selectedVersion = stringValue(entry.selected_version);
  const stableVersion = stringValue(entry.stable_version);
  const manifestValidation = stringValue(entry.manifest_validation) ?? 'deferred';
  if (!['deferred', 'fetched_manifest', 'catalog_inline_manifest'].includes(manifestValidation)) {
    throw new FrameworkContractError('contract_shape_invalid', 'Agent package registry manifest validation state is invalid.', {
      entry_index: index,
      manifest_validation: manifestValidation,
      failure_code: 'agent_package_registry_manifest_validation_invalid',
    });
  }
  return {
    package_id: packageId!,
    display_name: displayName,
    publisher: stringValue(entry.publisher)!,
    description: stringValue(entry.description) ?? `${displayName} package.`,
    tags: uniqueStrings([...stringList(entry.tags), ...(packageRole ? [packageRole] : [])]),
    package_role: packageRole,
    source,
    manifest_url: manifestUrl,
    version_source_ref: versionSourceRef,
    selected_version: selectedVersion,
    stable_version: stableVersion,
    manifest_validation: manifestValidation as AgentPackageRegistryEntry['manifest_validation'],
    trust_tier: trustTier,
    starter_default: entry.starter_default === true,
    codex_visible_entry: stringValue(entry.codex_visible_entry),
    required_skill_ids: stringList(entry.required_skill_ids),
    optional_skill_ids: stringList(entry.optional_skill_ids),
    home_shortcut_ids: stringList(entry.home_shortcut_ids),
    presentation: null,
    display_policy: stringValue(entry.display_policy),
    ordinary_user_source: normalizeOrdinaryUserSource(entry.ordinary_user_source, `registry.entries.${index}.ordinary_user_source`),
    configured_codex_plugin_carrier: normalizeConfiguredCodexPluginCarrier(
      entry.configured_codex_plugin_carrier,
      {
        packageId: packageId!,
        requiredSkillIds: stringList(entry.required_skill_ids),
        manifestUrl,
      },
    ),
  };
}

export function normalizeRegistryDocument(
  payload: unknown,
  registryUrl: string,
  registrySha256: string,
): AgentPackageRegistryDocument {
  if (!isRecord(payload) || !Array.isArray(payload.entries)) {
    throw new FrameworkContractError('contract_shape_invalid', 'Agent package registry must contain an entries array.', {
      registry_url: registryUrl,
      required: ['entries'],
    });
  }
  const entries = recordList(payload.entries).map(normalizeRegistryEntry);
  if (entries.length !== payload.entries.length) {
    throw new FrameworkContractError('contract_shape_invalid', 'Agent package registry entries must be JSON objects.', {
      registry_url: registryUrl,
      entry_count: payload.entries.length,
      valid_entry_count: entries.length,
    });
  }
  const duplicatePackageIds = entries
    .map((entry) => entry.package_id)
    .filter((packageId, index, values) => values.indexOf(packageId) !== index);
  if (duplicatePackageIds.length > 0) {
    throw new FrameworkContractError('contract_shape_invalid', 'Agent package registry package_id values must be unique.', {
      registry_url: registryUrl,
      duplicate_package_ids: uniqueStrings(duplicatePackageIds),
    });
  }
  return {
    registry_url: registryUrl,
    registry_sha256: registrySha256,
    entries,
  };
}

function normalizeSkillPackRefs(skillPacks: Record<string, unknown>[]) {
  return skillPacks.flatMap((pack) => {
    const packId = stringValue(pack.id);
    const source = stringValue(pack.source);
    const version = stringValue(pack.version);
    return packId ? [`${packId}${source ? `@${source}` : ''}${version ? `#${version}` : ''}`] : [];
  });
}

function canonicalManifestIdentity(value: unknown, field: string) {
  const declared = assertStringValue(value, field).toLowerCase();
  const canonical = canonicalAgentPackageId(declared);
  if (canonical !== declared) {
    throw new FrameworkContractError('contract_shape_invalid', 'Agent package identity fields must use canonical package ids.', {
      field,
      declared_id: declared,
      canonical_id: canonical,
      failure_code: 'agent_package_identity_not_canonical',
    });
  }
  return declared;
}

function resolveManifestRelativeSource(value: string, manifestUrl: string) {
  if (
    value.startsWith('http://')
    || value.startsWith('https://')
    || value.startsWith('file:')
    || path.isAbsolute(value)
  ) {
    return value;
  }
  if (manifestUrl.startsWith('http://') || manifestUrl.startsWith('https://')) {
    return new URL(value, manifestUrl).toString();
  }
  const manifestPath = manifestUrl.startsWith('file:') ? fileURLToPath(manifestUrl) : manifestUrl;
  return path.resolve(path.dirname(manifestPath), value);
}

function normalizePackageVersion(value: unknown) {
  const version = assertStringValue(value, 'version');
  if (!/^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.test(version)) {
    throw new FrameworkContractError('contract_shape_invalid', 'Agent package version must use SemVer.', {
      version,
      failure_code: 'agent_package_semver_required',
    });
  }
  return version;
}

function normalizeOwnerLanguageVersion(value: unknown) {
  if (value === undefined || value === null) return null;
  if (!isRecord(value) || value.scheme !== 'pep440' || !stringValue(value.value)) {
    throw new FrameworkContractError('contract_shape_invalid', 'Agent package owner_language_version must declare a supported scheme and value.', {
      failure_code: 'agent_package_owner_language_version_invalid',
    });
  }
  return { scheme: 'pep440' as const, value: stringValue(value.value)! };
}

function normalizeCarrierSourceAuthority(
  payload: Record<string, unknown>,
  codexSurface: Record<string, unknown>,
  manifestUrl: string,
) {
  const sourceCommit = stringValue(payload.source_commit);
  const carrierSourceCommit = stringValue(codexSurface.carrier_source_commit);
  const invalidFields = [
    sourceCommit !== null && !/^[0-9a-f]{40}$/.test(sourceCommit) ? 'source_commit' : null,
    carrierSourceCommit !== null && !/^[0-9a-f]{40}$/.test(carrierSourceCommit) ? 'codex_surface.carrier_source_commit' : null,
  ].filter((entry): entry is string => entry !== null);
  if (invalidFields.length > 0 || (sourceCommit !== null && carrierSourceCommit !== null && sourceCommit !== carrierSourceCommit)) {
    throw new FrameworkContractError('contract_shape_invalid', 'Agent package manifest carrier source commit authority is invalid or conflicting.', {
      manifest_url: manifestUrl,
      source_commit: sourceCommit,
      carrier_source_commit: carrierSourceCommit,
      invalid_fields: invalidFields,
      failure_code: 'agent_package_manifest_carrier_source_commit_invalid',
    });
  }
  return { sourceCommit, carrierSourceCommit };
}

function normalizeConfiguredCodexPluginCarrier(
  value: unknown,
  input: {
    packageId: string;
    requiredSkillIds: string[];
    manifestUrl: string;
  },
): AgentPackageConfiguredCodexPluginCarrierDescriptor | null {
  if (value === undefined || value === null) return null;
  if (!isRecord(value)) {
    throw new FrameworkContractError(
      'contract_shape_invalid',
      'Configured Codex Plugin Manager carrier must declare its native carrier and Codex CLI executor route.',
      {
        package_id: input.packageId,
        manifest_url: input.manifestUrl,
        failure_code: 'configured_codex_plugin_carrier_descriptor_invalid',
      },
    );
  }
  const normalizedCarrier = isRecord(value.carrier) ? value.carrier : null;
  const normalizedExecutor = isRecord(value.executor) ? value.executor : null;
  const kind = value.kind ?? normalizedCarrier?.kind;
  const executorRoute = value.executor_route ?? normalizedExecutor?.route;
  if (kind !== 'codex_plugin_manager' || executorRoute !== 'codex_cli') {
    throw new FrameworkContractError(
      'contract_shape_invalid',
      'Configured Codex Plugin Manager carrier must declare its native carrier and Codex CLI executor route.',
      {
        package_id: input.packageId,
        manifest_url: input.manifestUrl,
        failure_code: 'configured_codex_plugin_carrier_descriptor_invalid',
      },
    );
  }
  const declaredPackageId = stringValue(value.packageId);
  if (declaredPackageId && declaredPackageId !== input.packageId) {
    throw new FrameworkContractError(
      'contract_shape_invalid',
      'Configured Codex Plugin Manager carrier package identity must match its manifest.',
      {
        package_id: input.packageId,
        carrier_package_id: declaredPackageId,
        manifest_url: input.manifestUrl,
        failure_code: 'configured_codex_plugin_carrier_descriptor_invalid',
      },
    );
  }
  const pluginSelector = assertStringValue(
    value.plugin_selector ?? normalizedCarrier?.pluginId,
    'codex_surface.configured_codex_plugin_carrier.plugin_selector',
  );
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*@[A-Za-z0-9][A-Za-z0-9._-]*$/.test(pluginSelector)) {
    throw new FrameworkContractError(
      'contract_shape_invalid',
      'Configured Codex Plugin Manager plugin selector is invalid.',
      {
        package_id: input.packageId,
        plugin_selector: pluginSelector,
        manifest_url: input.manifestUrl,
        failure_code: 'configured_codex_plugin_carrier_descriptor_invalid',
      },
    );
  }
  const marketplaceSourceValue = value.marketplace_source ?? normalizedCarrier?.marketplaceSource;
  const marketplaceSource = marketplaceSourceValue === undefined || marketplaceSourceValue === null
    ? null
    : assertStringValue(
        marketplaceSourceValue,
        'codex_surface.configured_codex_plugin_carrier.marketplace_source',
      );
  if (marketplaceSource?.startsWith('-') || marketplaceSource?.includes('\0')) {
    throw new FrameworkContractError(
      'contract_shape_invalid',
      'Configured Codex Plugin Manager marketplace source is invalid.',
      {
        package_id: input.packageId,
        marketplace_source: marketplaceSource,
        manifest_url: input.manifestUrl,
        failure_code: 'configured_codex_plugin_carrier_descriptor_invalid',
      },
    );
  }
  const normalizedRequiredSkills = stringList(normalizedExecutor?.requiredSkillIds);
  if (normalizedExecutor && (
    normalizedRequiredSkills.length !== input.requiredSkillIds.length
    || normalizedRequiredSkills.some((skillId) => !input.requiredSkillIds.includes(skillId))
  )) {
    throw new FrameworkContractError(
      'contract_shape_invalid',
      'Configured Codex Plugin Manager executor Skills must match the normalized Package manifest.',
      {
        package_id: input.packageId,
        manifest_url: input.manifestUrl,
        failure_code: 'configured_codex_plugin_carrier_descriptor_invalid',
      },
    );
  }
  return {
    packageId: input.packageId,
    carrier: {
      kind: 'codex_plugin_manager',
      pluginId: pluginSelector,
      marketplaceSource,
    },
    executor: {
      route: 'codex_cli',
      requiredSkillIds: [...input.requiredSkillIds],
    },
    publicationRef: value.publication_ref === undefined
      && value.publicationRef === undefined
      ? null
      : value.publication_ref === null || value.publicationRef === null
      ? null
      : assertStringValue(
          value.publication_ref ?? value.publicationRef,
          'codex_surface.configured_codex_plugin_carrier.publication_ref',
        ),
  };
}

export function normalizeManifest(payload: unknown, manifestUrl: string): AgentPackageManifest {
  if (!isRecord(payload)) {
    throw new FrameworkContractError('contract_shape_invalid', 'Agent package manifest must be a JSON object.', {
      manifest_url: manifestUrl,
    });
  }
  assertNoForbiddenFields(payload, 'manifest');
  const missing = missingFields(payload, MANIFEST_REQUIRED_FIELDS);
  if (missing.length > 0) {
    throw new FrameworkContractError('contract_shape_invalid', 'Agent package manifest is missing required fields.', {
      manifest_url: manifestUrl,
      missing_fields: missing,
      failure_code: 'invalid_package_manifest',
    });
  }
  if (payload.surface_kind !== 'opl_agent_package_manifest.v1') {
    throw new FrameworkContractError('contract_shape_invalid', 'Agent package manifest surface_kind must be opl_agent_package_manifest.v1.', {
      manifest_url: manifestUrl,
      failure_code: 'invalid_package_manifest',
    });
  }
  if (payload.carrier_source_role !== 'codex_plugin_default_carrier_not_package_truth') {
    throw new FrameworkContractError('contract_shape_invalid', 'Agent package manifest carrier_source_role must keep Codex plugin as carrier, not package truth.', {
      manifest_url: manifestUrl,
      failure_code: 'invalid_package_manifest',
    });
  }
  const declaredPackageRole = stringValue(payload.package_role);
  if (declaredPackageRole && declaredPackageRole !== 'standard_agent') {
    throw new FrameworkContractError('contract_shape_invalid', 'Agent package manifest declares an incompatible package role.', {
      manifest_url: manifestUrl,
      declared_role: declaredPackageRole,
      expected_role: 'standard_agent',
      failure_code: 'agent_package_manifest_role_invalid',
    });
  }
  const packageId = canonicalManifestIdentity(payload.package_id, 'package_id');
  const capabilityDependencies = normalizeCapabilityDependencies(payload.capability_dependencies, manifestUrl);
  const capabilityProvider = normalizeCapabilityProvider(payload.capability_provider);
  const healthCheck = isRecord(payload.health_check) ? payload.health_check : {};
  if (!isRecord(payload.codex_surface)) {
    throw new FrameworkContractError('contract_shape_invalid', 'Agent package manifest codex_surface must be a JSON object.', {
      manifest_url: manifestUrl,
      failure_code: 'invalid_package_manifest',
    });
  }
  const rawSkillPacks = payload.skill_packs ?? [];
  const rawEntrypoints = payload.entrypoints ?? [];
  const rawPermissions = payload.permissions ?? [];
  const skillPacks = recordList(rawSkillPacks);
  const entrypoints = normalizePackageEntrypoints(rawEntrypoints, manifestUrl);
  if (!Array.isArray(rawSkillPacks) || skillPacks.length !== rawSkillPacks.length) {
    throw new FrameworkContractError('contract_shape_invalid', 'Agent package manifest skill_packs must be an array of objects.', {
      manifest_url: manifestUrl,
      failure_code: 'invalid_package_manifest',
    });
  }
  if (!Array.isArray(rawEntrypoints) || entrypoints.length !== rawEntrypoints.length) {
    throw new FrameworkContractError('contract_shape_invalid', 'Agent package manifest entrypoints must be an array of objects.', {
      manifest_url: manifestUrl,
      failure_code: 'invalid_package_manifest',
    });
  }
  if (!Array.isArray(rawPermissions)) {
    throw new FrameworkContractError('contract_shape_invalid', 'Agent package manifest permissions must be an array.', {
      manifest_url: manifestUrl,
      failure_code: 'invalid_package_manifest',
    });
  }
  const requiredSkillIds = uniqueStrings(stringList(payload.codex_surface.required_skill_ids));
  if (requiredSkillIds.length === 0) {
    throw new FrameworkContractError('contract_shape_invalid', 'Agent package manifest must declare codex_surface.required_skill_ids.', {
      manifest_url: manifestUrl,
      failure_code: 'invalid_package_manifest',
    });
  }
  if (capabilityProvider) {
    const providerCoreSkillIds = capabilityProvider.exports
      .filter((entry) => entry.install_mode === 'core_required')
      .map((entry) => entry.skill_id);
    if (
      providerCoreSkillIds.length === 0
      || providerCoreSkillIds.length !== requiredSkillIds.length
      || providerCoreSkillIds.some((skillId) => !requiredSkillIds.includes(skillId))
    ) {
      throw new FrameworkContractError('contract_shape_invalid', 'Capability provider required_skill_ids must exactly match core_required exports.', {
        required_skill_ids: requiredSkillIds,
        provider_core_skill_ids: providerCoreSkillIds,
        failure_code: 'agent_package_capability_provider_core_mismatch',
      });
    }
  }
  const pluginId = stringValue(payload.codex_surface.plugin_id)
    ?? stringList(payload.codex_surface.plugin_ids)[0]
    ?? null;
  const pluginSourcePath = stringValue(payload.codex_surface.plugin_source_path)
    ?? stringValue(payload.codex_surface.local_plugin_source_path)
    ?? stringValue(payload.codex_surface.plugin_root);
  const pluginPayloadManifestRef = stringValue(payload.codex_surface.plugin_payload_manifest_url)
    ?? stringValue(payload.codex_surface.remote_payload_manifest_url);
  const pluginPayloadManifestUrl = pluginPayloadManifestRef
    ? resolveManifestRelativeSource(pluginPayloadManifestRef, manifestUrl)
    : null;
  if (pluginPayloadManifestUrl) {
    validateUrlLike(pluginPayloadManifestUrl, 'codex_surface.plugin_payload_manifest_url');
  }
  const distributionPayload = normalizeDistributionPayload(payload.distribution_payload);
  const carrierAuthority = normalizeCarrierSourceAuthority(payload, payload.codex_surface, manifestUrl);
  const codexVisibleEntry = pluginId
    ?? stringValue(payload.codex_surface.codex_visible_entry)
    ?? stringValue(payload.agent_id)!;
  return {
    package_id: packageId,
    agent_id: canonicalManifestIdentity(payload.agent_id, 'agent_id'),
    package_role: 'standard_agent',
    display_name: stringValue(payload.display_name)!,
    publisher: stringValue(payload.publisher)!,
    version: normalizePackageVersion(payload.version),
    owner_language_version: normalizeOwnerLanguageVersion(payload.owner_language_version),
    source: stringValue(payload.source)!,
    source_repo: stringValue(payload.source_repo),
    source_commit: carrierAuthority.sourceCommit,
    carrier_source_commit: carrierAuthority.carrierSourceCommit,
    verified_payload_source_commit: null,
    codex_surface: payload.codex_surface,
    codex_default_exposure: normalizeCodexDefaultExposure(payload.codex_surface, manifestUrl),
    skill_packs: skillPacks,
    entrypoints,
    health_check: healthCheck,
    permissions: rawPermissions,
    distribution_payload: distributionPayload,
    update_channel: stringValue(payload.update_channel) ?? 'manifest_url',
    codex_visible_entry: codexVisibleEntry,
    required_skill_ids: requiredSkillIds,
    optional_skill_refs: uniqueStrings([
      ...stringList(payload.codex_surface.optional_skill_ids),
      ...normalizeSkillPackRefs(skillPacks.filter((pack) => stringValue(pack.install_mode) !== 'bundled_required')),
    ]),
    presentation: normalizePresentation(payload.presentation, manifestUrl),
    plugin_id: pluginId,
    plugin_source_path: pluginSourcePath,
    plugin_payload_manifest_url: pluginPayloadManifestUrl,
    plugin_payload_manifest_sha256: null,
    plugin_payload_cache_path: null,
    profile_surface: normalizeProfileSurface(payload.profile_surface),
    managed_policy_surface: normalizeManagedPolicySurface(payload.managed_policy_surface),
    capability_dependencies: capabilityDependencies,
    capability_provider: capabilityProvider,
    content_digest: distributionPayload?.payload_digest_ref ?? null,
    content_lock_canonicalization: null,
    content_lock_paths: [],
    configured_codex_plugin_carrier: normalizeConfiguredCodexPluginCarrier(
      payload.codex_surface.configured_codex_plugin_carrier,
      { packageId, requiredSkillIds, manifestUrl },
    ),
    app_contributions: normalizeAppContributions(payload.app_contributions, manifestUrl),
  };
}

export function normalizeCapabilityPackageManifest(payload: unknown, manifestUrl: string): AgentPackageManifest {
  if (!isRecord(payload) || payload.surface_kind !== 'opl_capability_package_manifest.v2') {
    throw new FrameworkContractError('contract_shape_invalid', 'Capability package manifest must use opl_capability_package_manifest.v2.', {
      manifest_url: manifestUrl,
      failure_code: 'invalid_capability_package_manifest',
    });
  }
  if (
    payload.package_role !== 'capability_package'
    && payload.package_role !== 'framework_capability_package'
  ) {
    throw new FrameworkContractError('contract_shape_invalid', 'Capability package manifest package_role must identify a Framework capability package.', {
      manifest_url: manifestUrl,
      package_role: payload.package_role,
      failure_code: 'invalid_capability_package_manifest',
    });
  }
  if (!isRecord(payload.capability_abi) || !isRecord(payload.exports) || !isRecord(payload.content_lock)) {
    throw new FrameworkContractError('contract_shape_invalid', 'Capability package manifest must declare ABI, exports, and content lock.', {
      manifest_url: manifestUrl,
      failure_code: 'invalid_capability_package_manifest',
    });
  }
  if (payload.exports.optional_skills_installed_by_default !== true
    || payload.exports.default_materialization_policy !== 'all_exported_skills') {
    throw new FrameworkContractError('contract_shape_invalid', 'Capability package must materialize every declared Skill while keeping specialty readiness non-blocking.', {
      manifest_url: manifestUrl,
      failure_code: 'capability_package_default_materialization_invalid',
    });
  }
  const packageId = canonicalManifestIdentity(payload.package_id, 'package_id');
  const coreSkillIds = uniqueStrings(stringList(payload.exports.core_skill_ids));
  const entrypoints = normalizePackageEntrypoints(payload.entrypoints, manifestUrl);
  if (
    coreSkillIds.length === 0
    && !entrypoints.some((entry) => entry.kind === 'channel_provider')
  ) {
    throw new FrameworkContractError('contract_shape_invalid', 'Capability package must export at least one core skill unless it provides a channel provider entrypoint.', {
      manifest_url: manifestUrl,
      failure_code: 'invalid_capability_package_manifest',
    });
  }
  const specialtySkillIds = uniqueStrings(stringList(payload.exports.specialty_skill_ids));
  const allSkillIds = [...coreSkillIds, ...specialtySkillIds];
  if (new Set(allSkillIds).size !== allSkillIds.length) {
    throw new FrameworkContractError('contract_shape_invalid', 'Capability package core and specialty skill ids must not overlap.', {
      manifest_url: manifestUrl,
      failure_code: 'capability_package_export_overlap',
    });
  }
  const capabilityAbi = assertStringValue(payload.capability_abi.id, 'capability_abi.id');
  if (payload.content_lock.algorithm !== 'sha256') {
    throw new FrameworkContractError('contract_shape_invalid', 'Capability package content lock algorithm must be sha256.', {
      manifest_url: manifestUrl,
      failure_code: 'invalid_capability_package_manifest',
    });
  }
  const contentLockCanonicalization = assertStringValue(
    payload.content_lock.canonicalization,
    'content_lock.canonicalization',
  );
  if (contentLockCanonicalization !== 'ordered_path_nul_file_bytes'
    && contentLockCanonicalization !== 'ordered_path_length_file_length_bytes') {
    throw new FrameworkContractError('contract_shape_invalid', 'Capability package content lock canonicalization is unsupported.', {
      manifest_url: manifestUrl,
      content_lock_canonicalization: contentLockCanonicalization,
      failure_code: 'invalid_capability_package_manifest',
    });
  }
  const contentDigest = assertStringValue(payload.content_lock.digest, 'content_lock.digest');
  if (!/^sha256:[0-9a-f]{64}$/.test(contentDigest)) {
    throw new FrameworkContractError('contract_shape_invalid', 'Capability package content lock digest must be sha256.', {
      manifest_url: manifestUrl,
      content_digest: contentDigest,
      failure_code: 'invalid_capability_package_manifest',
    });
  }
  const contentLockPaths = uniqueStrings(stringList(payload.content_lock.paths).map((entry, index) =>
    normalizedRelativePath(entry, `content_lock.paths[${index}]`)));
  assertChannelProviderEntrypointsContentLocked(entrypoints, contentLockPaths, manifestUrl);
  const coreModuleIds = uniqueStrings(stringList(payload.exports.core_module_ids));
  if (coreModuleIds.length === 0) {
    throw new FrameworkContractError('contract_shape_invalid', 'Capability package must export at least one core module contract id.', {
      manifest_url: manifestUrl,
      failure_code: 'invalid_capability_package_manifest',
    });
  }
  const contentSkillIds = contentLockPaths.flatMap((entry) => {
    const match = entry.match(/^skills\/([^/]+)\/SKILL\.md$/);
    return match ? [match[1]] : [];
  });
  if (
    contentSkillIds.length !== allSkillIds.length
    || contentSkillIds.some((skillId) => !allSkillIds.includes(skillId))
  ) {
    throw new FrameworkContractError('contract_shape_invalid', 'Capability package content lock must contain exactly the declared core skills.', {
      manifest_url: manifestUrl,
      core_skill_ids: coreSkillIds,
      specialty_skill_ids: specialtySkillIds,
      content_skill_ids: contentSkillIds,
      failure_code: 'capability_package_core_content_mismatch',
    });
  }
  const codexSurface = isRecord(payload.codex_surface) ? payload.codex_surface : {};
  const capabilityExports = [...coreSkillIds.map((skillId) => ({
    export_id: skillId,
    skill_id: skillId,
    install_mode: 'core_required' as const,
  })), ...specialtySkillIds.map((skillId) => ({
    export_id: skillId,
    skill_id: skillId,
    install_mode: 'optional_named_specialty' as const,
  }))];
  const consumerProfiles = normalizeCapabilityConsumerProfiles(
    payload.consumer_profiles,
    capabilityExports,
    coreModuleIds,
  );
  const carrierAuthority = normalizeCarrierSourceAuthority(payload, codexSurface, manifestUrl);
  const pluginId = stringValue(codexSurface.plugin_id) ?? packageId;
  const pluginSourceRef = stringValue(codexSurface.plugin_source_path);
  const pluginSourcePath = pluginSourceRef
    ? resolveManifestRelativeSource(pluginSourceRef, manifestUrl)
    : null;
  const pluginPayloadManifestRef = stringValue(codexSurface.plugin_payload_manifest_url);
  const pluginPayloadManifestUrl = pluginPayloadManifestRef
    ? resolveManifestRelativeSource(pluginPayloadManifestRef, manifestUrl)
    : null;
  if (pluginPayloadManifestUrl) {
    validateUrlLike(pluginPayloadManifestUrl, 'codex_surface.plugin_payload_manifest_url');
  }
  return {
    package_id: packageId,
    agent_id: null,
    package_role: 'capability_package',
    display_name: assertStringValue(payload.display_name, 'display_name'),
    publisher: assertStringValue(payload.publisher, 'publisher'),
    version: normalizePackageVersion(payload.version),
    owner_language_version: null,
    source: assertStringValue(payload.source, 'source'),
    source_repo: stringValue(payload.source_repo),
    source_commit: carrierAuthority.sourceCommit,
    carrier_source_commit: carrierAuthority.carrierSourceCommit,
    verified_payload_source_commit: null,
    codex_surface: codexSurface,
    codex_default_exposure: normalizeCodexDefaultExposure(codexSurface, manifestUrl),
    skill_packs: [],
    entrypoints,
    health_check: {},
    permissions: [],
    distribution_payload: null,
    update_channel: 'manifest_url',
    codex_visible_entry: pluginId,
    required_skill_ids: allSkillIds,
    optional_skill_refs: [assertStringValue(payload.exports.optional_skill_policy_ref, 'exports.optional_skill_policy_ref')],
    presentation: normalizePresentation(payload.presentation, manifestUrl),
    plugin_id: pluginId,
    plugin_source_path: pluginSourcePath,
    plugin_payload_manifest_url: pluginPayloadManifestUrl,
    plugin_payload_manifest_sha256: null,
    plugin_payload_cache_path: null,
    profile_surface: null,
    managed_policy_surface: null,
    capability_dependencies: [],
    capability_provider: {
      capability_abi: capabilityAbi,
      exports: capabilityExports,
      module_export_ids: coreModuleIds,
      consumer_profiles: consumerProfiles,
    },
    content_digest: contentDigest,
    content_lock_canonicalization: contentLockCanonicalization,
    content_lock_paths: contentLockPaths,
    configured_codex_plugin_carrier: normalizeConfiguredCodexPluginCarrier(
      codexSurface.configured_codex_plugin_carrier,
      { packageId, requiredSkillIds: allSkillIds, manifestUrl },
    ),
    app_contributions: normalizeAppContributions(payload.app_contributions, manifestUrl),
  };
}

export function normalizeWorkflowProfilePackageManifest(payload: unknown, manifestUrl: string): AgentPackageManifest {
  if (!isRecord(payload) || payload.surface_kind !== 'opl_workflow_profile_package_manifest.v1') {
    throw new FrameworkContractError('contract_shape_invalid', 'Workflow profile package manifest must use opl_workflow_profile_package_manifest.v1.', {
      manifest_url: manifestUrl,
      failure_code: 'invalid_workflow_profile_package_manifest',
    });
  }
  if (payload.agent_id !== undefined) {
    throw new FrameworkContractError('contract_shape_invalid', 'Workflow profile packages must not declare an Agent identity.', {
      manifest_url: manifestUrl,
      failure_code: 'workflow_profile_package_agent_identity_forbidden',
    });
  }
  if (payload.package_role !== 'workflow_profile'
    || payload.carrier_source_role !== 'codex_plugin_default_carrier_not_package_truth') {
    throw new FrameworkContractError('contract_shape_invalid', 'Workflow profile package role or carrier boundary is invalid.', {
      manifest_url: manifestUrl,
      failure_code: 'invalid_workflow_profile_package_manifest',
    });
  }
  const packageId = canonicalManifestIdentity(payload.package_id, 'package_id');
  const codexSurface = isRecord(payload.codex_surface) ? payload.codex_surface : null;
  if (!codexSurface) {
    throw new FrameworkContractError('contract_shape_invalid', 'Workflow profile package must declare codex_surface.', {
      manifest_url: manifestUrl,
      failure_code: 'invalid_workflow_profile_package_manifest',
    });
  }
  const requiredSkillIds = uniqueStrings(stringList(codexSurface.required_skill_ids));
  if (requiredSkillIds.length === 0) {
    throw new FrameworkContractError('contract_shape_invalid', 'Workflow profile package must declare required_skill_ids.', {
      manifest_url: manifestUrl,
      failure_code: 'invalid_workflow_profile_package_manifest',
    });
  }
  const pluginId = assertStringValue(codexSurface.plugin_id, 'codex_surface.plugin_id');
  const pluginPayloadManifestRef = assertStringValue(
    codexSurface.plugin_payload_manifest_url,
    'codex_surface.plugin_payload_manifest_url',
  );
  const pluginPayloadManifestUrl = resolveManifestRelativeSource(pluginPayloadManifestRef, manifestUrl);
  validateUrlLike(pluginPayloadManifestUrl, 'codex_surface.plugin_payload_manifest_url');
  const profileSurface = normalizeProfileSurface(payload.profile_surface);
  const managedPolicySurface = normalizeManagedPolicySurface(payload.managed_policy_surface);
  const carrierAuthority = normalizeCarrierSourceAuthority(payload, codexSurface, manifestUrl);
  if (!profileSurface || !managedPolicySurface) {
    throw new FrameworkContractError('contract_shape_invalid', 'Workflow profile package must declare profile and managed policy surfaces.', {
      manifest_url: manifestUrl,
      failure_code: 'invalid_workflow_profile_package_manifest',
    });
  }
  return {
    package_id: packageId,
    agent_id: null,
    package_role: 'workflow_profile',
    display_name: assertStringValue(payload.display_name, 'display_name'),
    publisher: assertStringValue(payload.publisher, 'publisher'),
    version: normalizePackageVersion(payload.version),
    owner_language_version: null,
    source: assertStringValue(payload.source, 'source'),
    source_repo: stringValue(payload.source_repo),
    source_commit: carrierAuthority.sourceCommit,
    carrier_source_commit: carrierAuthority.carrierSourceCommit,
    verified_payload_source_commit: null,
    codex_surface: codexSurface,
    codex_default_exposure: normalizeCodexDefaultExposure(codexSurface, manifestUrl),
    skill_packs: [],
    entrypoints: [],
    health_check: {},
    permissions: [],
    distribution_payload: normalizeDistributionPayload(payload.distribution_payload),
    update_channel: 'manifest_url',
    codex_visible_entry: pluginId,
    required_skill_ids: requiredSkillIds,
    optional_skill_refs: [],
    presentation: normalizePresentation(payload.presentation, manifestUrl),
    plugin_id: pluginId,
    plugin_source_path: null,
    plugin_payload_manifest_url: pluginPayloadManifestUrl,
    plugin_payload_manifest_sha256: null,
    plugin_payload_cache_path: null,
    profile_surface: profileSurface,
    managed_policy_surface: managedPolicySurface,
    capability_dependencies: [],
    capability_provider: null,
    content_digest: null,
    content_lock_canonicalization: null,
    content_lock_paths: [],
    configured_codex_plugin_carrier: normalizeConfiguredCodexPluginCarrier(
      codexSurface.configured_codex_plugin_carrier,
      { packageId, requiredSkillIds, manifestUrl },
    ),
    app_contributions: normalizeAppContributions(payload.app_contributions, manifestUrl),
  };
}

export function normalizePackageManifest(payload: unknown, manifestUrl: string): AgentPackageManifest {
  if (isRecord(payload) && payload.surface_kind === 'opl_capability_package_manifest.v2') {
    return normalizeCapabilityPackageManifest(payload, manifestUrl);
  }
  if (isRecord(payload) && payload.surface_kind === 'opl_workflow_profile_package_manifest.v1') {
    return normalizeWorkflowProfilePackageManifest(payload, manifestUrl);
  }
  return normalizeManifest(payload, manifestUrl);
}
