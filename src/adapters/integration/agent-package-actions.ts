export type AgentPackageAppActionId =
  | 'agent_package_install'
  | 'agent_package_update'
  | 'agent_package_repair'
  | 'agent_package_uninstall'
  | 'agent_package_preferences_set';

export type AgentPackageActionTaskKind =
  | 'install'
  | 'uninstall'
  | 'repair'
  | 'configure';

export type AgentPackageActionCatalogEntry = {
  action_id: AgentPackageAppActionId;
  stable_id: string;
  label: string;
  section_id: 'capabilities';
  task_kind: AgentPackageActionTaskKind;
  taxonomy: string;
  delegated_surface: string;
  payload_fields: string[];
  mutates: string;
  dry_run_supported: boolean;
  confirmation_required: boolean;
  danger_level: 'low' | 'medium';
  impact: string;
  follow_up_action_ids: string[];
  verify_action_id?: string;
};

const AGENT_PACKAGE_ACTION_CATALOG = [
  {
    action_id: 'agent_package_install',
    stable_id: 'install_agent_package',
    label: 'Install agent package',
    section_id: 'capabilities',
    task_kind: 'install',
    taxonomy: 'settings.capabilities.agent_package.install',
    delegated_surface: 'opl packages install <package_id>',
    payload_fields: ['package_id'],
    mutates: 'native_package_carrier',
    dry_run_supported: true,
    confirmation_required: true,
    danger_level: 'medium',
    impact: 'Delegates installation to the Package native carrier and returns fresh carrier readback.',
    follow_up_action_ids: [],
  },
  {
    action_id: 'agent_package_update',
    stable_id: 'update_agent_package',
    label: 'Update agent package',
    section_id: 'capabilities',
    task_kind: 'install',
    taxonomy: 'settings.capabilities.agent_package.update',
    delegated_surface: 'opl packages update <package_id>',
    payload_fields: ['package_id'],
    mutates: 'native_package_carrier',
    dry_run_supported: true,
    confirmation_required: true,
    danger_level: 'medium',
    impact: 'Updates the native carrier from the Package owner route without owning the Package release truth.',
    follow_up_action_ids: [],
  },
  {
    action_id: 'agent_package_repair',
    stable_id: 'repair_agent_package',
    label: 'Repair agent package',
    section_id: 'capabilities',
    task_kind: 'repair',
    taxonomy: 'settings.capabilities.agent_package.repair',
    delegated_surface: 'opl packages repair --package-id <package_id>',
    payload_fields: ['package_id'],
    mutates: 'native_package_carrier',
    dry_run_supported: true,
    confirmation_required: true,
    danger_level: 'medium',
    impact: 'Repairs the native carrier from its owner route and returns fresh physical readback.',
    follow_up_action_ids: [],
  },
  {
    action_id: 'agent_package_uninstall',
    stable_id: 'uninstall_agent_package',
    label: 'Uninstall agent package',
    section_id: 'capabilities',
    task_kind: 'uninstall',
    taxonomy: 'settings.capabilities.agent_package.uninstall',
    delegated_surface: 'opl packages uninstall --package-id <package_id>',
    payload_fields: ['package_id'],
    mutates: 'native_package_carrier',
    dry_run_supported: true,
    confirmation_required: true,
    danger_level: 'medium',
    impact: 'Removes the Package through its native carrier without deleting domain truth or user preferences.',
    follow_up_action_ids: [],
  },
  {
    action_id: 'agent_package_preferences_set',
    stable_id: 'set_agent_package_preferences',
    label: 'Set agent package preferences',
    section_id: 'capabilities',
    task_kind: 'configure',
    taxonomy: 'settings.capabilities.agent_package.preferences',
    delegated_surface: 'opl app action execute --action agent_package_preferences_set',
    payload_fields: ['package_id', 'exposure_action', 'shortcut_id', 'visible', 'sort_order'],
    mutates: 'opl_agent_package_preferences',
    dry_run_supported: true,
    confirmation_required: false,
    danger_level: 'low',
    impact: 'Persists package exposure or Home shortcut user preferences without changing package core, carrier materialization, or agent domain semantics.',
    follow_up_action_ids: [],
    verify_action_id: 'agent_package_preferences_set',
  },
] as const satisfies readonly AgentPackageActionCatalogEntry[];

function findAgentPackageAction(actionId: string): AgentPackageActionCatalogEntry | null {
  return AGENT_PACKAGE_ACTION_CATALOG.find((entry) => entry.action_id === actionId) ?? null;
}

export function agentPackageDelegatedSurface(actionId: string) {
  return findAgentPackageAction(actionId)?.delegated_surface ?? null;
}

export function listAgentPackageSettingsActions() {
  return AGENT_PACKAGE_ACTION_CATALOG
    .map((entry) => ({
      ...entry,
      payload_fields: [...entry.payload_fields],
      follow_up_action_ids: [...entry.follow_up_action_ids],
    }));
}
