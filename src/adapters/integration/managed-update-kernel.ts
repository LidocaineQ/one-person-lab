import { readOplUpdateChannel, readOplWorkspaceRoot } from '../../kernel/system-preferences.ts';
import type { FrameworkContracts } from '../../kernel/types.ts';
import { resolveCodexVersion } from './system-installation/engine-helpers.ts';
import { buildOplModules } from './system-installation/modules.ts';
import { canonicalAgentPackageId } from './agent-package-identity.ts';
import {
  readFirstPartyPackageOwnerCurrentness,
  type FirstPartyPackageOwnerCurrentness,
} from './agent-package-registry.ts';
import {
  managedUpdateComponentReceiptLedgerFilePath,
} from './managed-update-component-receipts.ts';
import { managedUpdateLockFilePath, MANAGED_UPDATE_LOCK_STALE_AFTER_SECONDS } from './managed-update-lock.ts';
import {
  bindOwnerReceiptProjection,
  COMPONENT_RECEIPT_REQUIRED_FIELDS,
  componentReceipt,
  condition,
  controlledCommand,
  filterManagedUpdateComponents,
  KERNEL_LIFECYCLE,
  MANAGED_UPDATE_OWNER_ACTIONS,
  MANAGED_UPDATE_KERNEL_ID,
  managedUpdateComponent,
  managedUpdateOperationMode,
  managedUpdateReceiptWritePolicy,
  manualCommand,
  noAutoApply,
  noReloadGuidance,
  ownerExecutionBoundary,
  ownerRoute,
  readOnlyCommand,
  STATE_VOCABULARY,
  statusDetail,
  summarizeManagedUpdateComponents,
  type ManagedUpdateComponent,
  type ManagedUpdateComponentState,
  type ManagedUpdateCondition,
  type ManagedUpdateConditionStatus,
  type ManagedUpdateKernelInput,
  type ManagedUpdateProviderId,
  type ManagedUpdateReceiptStatusDetail,
  type ManagedUpdateReloadGuidance,
} from './managed-update-owner-boundary.ts';
import { buildInstallationCarrierComponent } from './managed-update-kernel-parts/installation-carrier.ts';
import { buildRuntimeSubstrateComponent } from './managed-update-kernel-parts/runtime-substrate.ts';
import { asRecord, booleanValue, stringValue } from './managed-update-kernel-parts/shared.ts';

function requestedComponentId(componentId: string | undefined) {
  const requested = componentId?.trim();
  return requested || null;
}

function shouldBuildComponent(requested: string | null, componentId: string) {
  return !requested || requested === componentId;
}

function buildManagedUpdateRuntimeEnvironment(operation: ManagedUpdateKernelInput['operation']) {
  return {
    core_engines: {
      codex: resolveCodexVersion({
        preferOfflineLatestLookup: operation === 'status',
      }),
    },
  };
}

function moduleState(module: Record<string, unknown>): ManagedUpdateComponentState {
  const installed = booleanValue(module, 'installed') === true;
  const healthStatus = stringValue(module, 'health_status');
  const recommendedAction = stringValue(module, 'recommended_action');
  const installOrigin = stringValue(module, 'install_origin');
  const git = asRecord(module.git);
  const dirty = booleanValue(git, 'dirty') === true;
  const syncStatus = stringValue(git, 'sync_status');
  if (!installed || healthStatus === 'missing') {
    return 'skipped_manual_required';
  }
  if (
    dirty
    || healthStatus === 'dirty'
    || healthStatus === 'invalid_checkout'
    || installOrigin === 'env_override'
    || installOrigin === 'sibling_workspace'
    || syncStatus === 'ahead'
    || syncStatus === 'diverged'
    || syncStatus === 'no_upstream'
    || syncStatus === 'unknown'
  ) {
    return 'skipped_manual_required';
  }
  if (recommendedAction === 'update') {
    return 'update_available';
  }
  return 'current';
}

function buildCapabilityPackagesComponent(
  modules: Record<string, unknown>[],
  channel: string,
  ownerCurrentness: FirstPartyPackageOwnerCurrentness[],
): ManagedUpdateComponent {
  const ownerCurrentnessByPackageId = new Map(
    ownerCurrentness.map((entry) => [entry.package_id, entry]),
  );
  const defaultModules = modules.filter((entry) => booleanValue(entry, 'default_install') === true);
  const moduleStates = defaultModules.map((entry) => ({
    module_id: stringValue(entry, 'module_id'),
    package_id: canonicalAgentPackageId(stringValue(entry, 'module_id')),
    label: stringValue(entry, 'label'),
    state: moduleState(entry),
    install_origin: stringValue(entry, 'install_origin'),
    checkout_path: stringValue(entry, 'checkout_path'),
    managed_checkout_path: stringValue(entry, 'managed_checkout_path'),
    source_policy: entry.source_policy ?? null,
    git: entry.git ?? null,
  })).map((entry) => {
    const owner = entry.package_id
      ? ownerCurrentnessByPackageId.get(entry.package_id) ?? null
      : null;
    return {
      ...entry,
      state: owner?.status === 'update_available'
        ? 'update_available' as const
        : entry.state,
      owner_channel_ref: null,
      owner_currentness: owner,
    };
  });
  const targetStates = moduleStates;
  const failedWithRepairCount = targetStates.filter((entry) => entry.state === 'failed_with_repair').length;
  const nativeUpdateCount = targetStates.filter((entry) => entry.state === 'update_available').length;
  const updateCount = nativeUpdateCount;
  const manualCount = targetStates.filter((entry) => entry.state === 'skipped_manual_required').length;
  const cleanManagedTargetsCount = nativeUpdateCount;
  const state: ManagedUpdateComponentState = failedWithRepairCount > 0
      ? 'failed_with_repair'
      : updateCount > 0
        ? 'update_available'
        : manualCount > 0
          ? 'skipped_manual_required'
          : 'current';
  const action = failedWithRepairCount > 0
      ? 'install'
      : updateCount > 0
        ? 'update'
        : manualCount > 0
          ? 'manual_review'
          : 'none';
  const postApplyHooks = ['reconcile_packages'];
  const cleanManagedScopeSafe = cleanManagedTargetsCount > 0;
  const autoApplyEligible = cleanManagedScopeSafe && action !== 'none';
  const packageApplyCommand = 'opl connect modules --json';
  const blockedReasons = [
    ...(manualCount > 0 ? ['manual_required_targets_are_detect_only_and_skipped'] : []),
  ];
  const reloadRecommended = autoApplyEligible;
  const reloadGuidance: ManagedUpdateReloadGuidance = reloadRecommended
    ? {
      reload_required: false,
      reload_recommended: true,
      reload_targets: ['one_person_lab_app'],
      command_ref: 'Reload One Person Lab App',
      reason: 'The App may retain the previous native module projection until reload.',
    }
    : noReloadGuidance();
  const detail = statusDetail({
    component_state: state,
    auto_apply_eligible: autoApplyEligible,
    app_background_safe: cleanManagedScopeSafe,
    clean_managed_targets_count: cleanManagedTargetsCount,
    manual_required_targets_count: manualCount,
    post_apply_status: action === 'none' ? 'skipped' : 'not_run',
    reload_status: reloadRecommended ? 'recommended' : manualCount > 0 ? 'manual_required' : 'not_required',
  });
  const route = ownerRoute({
    owner: 'installed-package-owner-descriptors',
    authority_surface: 'Installed owner descriptors and native carrier state over protected runtime source roots',
    route_kind: 'clean_managed_package_executor',
    readback_ref: 'opl connect modules --json',
    apply_owner: 'opl_connect_native_package_carrier',
    forbidden_claims: [
      'capability_package_currentness_is_domain_ready',
      'managed_update_kernel_is_package_manager',
    ],
  });

  return managedUpdateComponent({
    lifecycle_owner: 'opl_packages',
    component_id: 'opl_packages',
    provider_id: 'capability_packages',
    adapter_id: 'capability_packages_adapter',
    component_class: 'opl_packages',
    coordination_role: 'executable_target',
    policy_id: 'ordinary_user_non_development_silent_background',
    owner_route: route,
    owner_execution_boundary: ownerExecutionBoundary(route, {
      owner_executor_id: 'opl_connect_native_package_carrier',
      executor_kind: 'clean_managed_package_executor',
      runner_can_execute: true,
      allowed_operations: ['apply', 'repair'],
      receipt_projection: 'component_receipt_with_owner_route',
      diagnostic_only: false,
      notes: [
        'Runner may reconcile clean content-addressed native module carriers, but it never overwrites developer checkout content or owns domain truth.',
      ],
    }),
    label: 'OPL Packages',
    state,
    channel,
    current: {
      currentness_authority: 'native_git_checkout',
      shared_snapshot_role: 'explicit_full_offline_integration_qa_compatibility_only',
      default_modules_count: defaultModules.length,
      managed_module_count: targetStates.length,
      projection_source: 'native_module_directory',
      module_states: moduleStates,
    },
    target: state === 'current'
      ? null
      : {
        source: 'Native Git checkout target selected by Framework module source policy',
        content_identity: 'git_head_sha_or_source_fingerprint',
      },
    conditions: [
      condition(
        'Ready',
        state === 'current' ? 'True' : 'False',
        state === 'current'
          ? 'CapabilityPackagesCurrent'
          : 'CapabilityPackageMaintenanceAvailable',
        state === 'current'
          ? 'Native module carriers match their Git checkout state.'
          : 'Native module maintenance or manual review is required.',
      ),
      condition(
        'DeveloperCheckoutProtected',
        manualCount > 0 ? 'False' : 'True',
        manualCount > 0 ? 'ManualSourceVisible' : 'CleanManagedRootsOnly',
        manualCount > 0
          ? 'At least one native module has an unavailable, dirty, or user-managed source.'
          : 'Silent module maintenance is limited to clean managed Git roots.',
      ),
    ],
    lifecycle: KERNEL_LIFECYCLE,
    postApplyHooks,
    auto_apply: {
      mode: cleanManagedScopeSafe ? 'auto_apply' : 'manual_required',
      eligible: autoApplyEligible,
      app_background_safe: cleanManagedScopeSafe,
      scope: 'native_git_checkout_modules_only',
      command_ref: autoApplyEligible ? packageApplyCommand : null,
      blocked_reasons: blockedReasons,
    },
    status_detail: detail,
    post_apply_guidance: {
      required: autoApplyEligible,
      command_refs: autoApplyEligible
        ? ['opl connect modules --json']
        : [],
      reload_guidance: reloadGuidance,
    },
    plan: {
      action,
      summary: action === 'none'
        ? 'No managed capability package maintenance is required.'
        : action === 'manual_review'
          ? 'Manual review is required before OPL can update one or more native module roots.'
          : manualCount > 0
            ? 'Reconcile eligible clean Git targets and leave manual targets unchanged.'
            : 'Reconcile native module carriers against Git checkout state.',
      command_refs: action === 'manual_review'
        ? [
          manualCommand(
            'inspect_packages',
            'opl connect modules --json',
            'Inspect native module state and manual source or checkout-availability blockers.',
          ),
        ]
        : action === 'none'
          ? [
            readOnlyCommand(
              'inspect_packages',
              'opl connect modules --json',
              'Read the native module carrier projection.',
            ),
          ]
          : [
            controlledCommand(
              'update_packages',
              packageApplyCommand,
              'Delegate clean Git checkout updates to their native module owners.',
            ),
          ],
    },
    receipt: componentReceipt({
      component_id: 'opl_packages',
      sourceManifestRef: 'opl://packages/native-git-checkout',
      postApplyHooks,
      apply_mode: cleanManagedScopeSafe ? 'auto_apply' : 'manual_required',
      status_detail: detail,
      reload_guidance: reloadGuidance,
      repair_action: state === 'failed_with_repair' ? 'reconcile_managed_modules' : null,
      contentIdentityFields: ['digest', 'sha256', 'source_fingerprint', 'git_head_sha'],
    }),
    authority_boundary: {
      can_silently_update_clean_managed_modules: true,
      can_overwrite_dirty_checkout: false,
      can_overwrite_developer_checkout: false,
      can_write_domain_truth: false,
      can_create_owner_receipt: false,
      can_claim_quality_or_export_verdict: false,
    },
    notes: [
      'Managed module currentness is derived from the native Git checkout carrier.',
      'Developer checkout content remains protected; only clean managed module roots are eligible.',
      'Shared manifests are compatibility-only Full, offline, integration, or QA snapshot inputs, never Package currentness authority.',
      'Module freshness does not claim domain readiness, artifact authority, quality verdict, or export readiness.',
    ],
  });
}

export async function buildManagedUpdateKernelProjection(
  contracts: FrameworkContracts,
  input: ManagedUpdateKernelInput,
  deps: {
    buildOplModules?: typeof buildOplModules;
    readFirstPartyPackageOwnerCurrentness?: typeof readFirstPartyPackageOwnerCurrentness;
  } = {},
) {
  const channel = readOplUpdateChannel().channel;
  const requested = requestedComponentId(input.componentId);
  const components: ManagedUpdateComponent[] = [];

  if (shouldBuildComponent(requested, 'opl_app')) {
    components.push(buildInstallationCarrierComponent(channel));
  }
  if (shouldBuildComponent(requested, 'opl_base')) {
    components.push(buildRuntimeSubstrateComponent(buildManagedUpdateRuntimeEnvironment(input.operation), channel, {
      allowFrameworkChannelLookup: input.operation === 'check' || input.operation === 'plan',
      refreshManagedDependencyLatest: input.operation !== 'status',
    }));
  }
  if (shouldBuildComponent(requested, 'opl_packages')) {
    const refreshPackageCurrentness = input.operation === 'check'
      || input.operation === 'plan'
      || input.operation === 'apply';
    const modulesPayload = (deps.buildOplModules ?? buildOplModules)({
      profile: refreshPackageCurrentness ? 'full' : 'fast',
    }).modules;
    const modules = modulesPayload.modules as Record<string, unknown>[];
    const eligiblePackageIds = modules.flatMap((entry): string[] => {
      const state = moduleState(entry);
      return booleanValue(entry, 'installed') === true
        && stringValue(entry, 'install_origin') === 'managed_root'
        && state !== 'skipped_manual_required'
        && state !== 'failed_with_repair'
        ? [canonicalAgentPackageId(stringValue(entry, 'module_id'))]
          .filter((packageId): packageId is string => Boolean(packageId))
        : [];
    });
    const ownerCurrentness = await (
      deps.readFirstPartyPackageOwnerCurrentness ?? readFirstPartyPackageOwnerCurrentness
    )(eligiblePackageIds);
    components.push(buildCapabilityPackagesComponent(modules, channel, ownerCurrentness));
  }
  const selectedComponents = filterManagedUpdateComponents(
    components,
    requested ?? undefined,
  ).map(bindOwnerReceiptProjection);

  return {
    version: 'g2',
    managed_update: {
      surface_id: MANAGED_UPDATE_KERNEL_ID,
      operation: input.operation,
      operation_mode: managedUpdateOperationMode(input.operation),
      update_channel: channel,
      workspace_root: readOplWorkspaceRoot(),
      requested_component_id: requested,
      requested_lifecycle_owner: requested ? selectedComponents[0]?.lifecycle_owner ?? null : null,
      requested_receipt_id: input.receiptId ?? null,
      lifecycle: KERNEL_LIFECYCLE,
      state_vocabulary: STATE_VOCABULARY,
      idempotency_lock: {
        lock_id: `${MANAGED_UPDATE_KERNEL_ID}.global`,
        lock_scope: 'single_writer_for_fetch_verify_stage_activate_post_apply_write_receipt',
        read_operations: ['status', 'check', 'plan'],
        exclusive_operations: ['apply', 'repair', MANAGED_UPDATE_OWNER_ACTIONS.revert],
        status: 'not_acquired_for_projection',
        lock_file: managedUpdateLockFilePath(),
        stale_after_seconds: MANAGED_UPDATE_LOCK_STALE_AFTER_SECONDS,
        contention_policy: 'report_in_progress_or_skip_without_parallel_mutation',
      },
      summary: summarizeManagedUpdateComponents(selectedComponents),
      components: selectedComponents,
      repair_actions: selectedComponents.flatMap((component) => component.plan.command_refs),
      receipts: {
        receipt_id: input.receiptId ?? null,
        receipt_store: 'opl_managed_install_update_ledger_and_future_runtime_update_receipts',
        component_receipt_schema: 'opl_managed_update_component_receipt.v1',
        component_receipt_ledger_file: managedUpdateComponentReceiptLedgerFilePath(),
        required_fields: COMPONENT_RECEIPT_REQUIRED_FIELDS,
        write_policy: managedUpdateReceiptWritePolicy(input.operation),
      },
      authority_boundary: {
        can_mutate_app_owned_runtime_root: false,
        can_mutate_installation_carrier: false,
        can_replace_docker_webui_image: false,
        can_update_linux_package_carrier: false,
        can_claim_carrier_update_complete: false,
        can_silently_update_clean_managed_modules: false,
        can_sync_codex_plugin_skill_projection: false,
        can_mutate_user_global_homebrew: false,
        can_mutate_user_global_npm: false,
        can_mutate_system_path_tools: false,
        can_overwrite_dirty_or_developer_checkout: false,
        can_write_domain_truth: false,
        can_write_domain_memory_body: false,
        can_mutate_domain_artifact_body: false,
        can_create_owner_receipt: false,
        can_claim_quality_or_export_verdict: false,
      },
      notes: [
        'Public lifecycle ownership is limited to OPL Base, OPL App, and OPL Packages.',
        'OPL Packages delegates only clean managed module roots to their existing native owner path.',
        'OPL App replacement remains App-owned and must not be claimed by opl update apply.',
        'Real artifact fetch/verify/stage/activate remains provider-specific; this surface exposes the shared state machine and safe action refs.',
        'Package freshness and runtime maintenance do not imply domain readiness, owner receipt authority, artifact authority, quality verdict, or export readiness.',
      ],
    },
  };
}
