export type BoundWorkspaceLocator = {
  surface_kind: string;
  workspace_root: string | null;
  profile_ref: string | null;
  input_path: string | null;
};

export type DirectEntryLocator = {
  command: string | null;
  manifest_command: string | null;
  url: string | null;
  workspace_locator: BoundWorkspaceLocator | null;
};

export type WorkspaceBinding = {
  binding_id: string;
  project_scope_id: string;
  project_id: string;
  project: string;
  workspace_path: string;
  label: string | null;
  status: 'active' | 'inactive' | 'archived';
  direct_entry: DirectEntryLocator;
  created_at: string;
  updated_at: string;
  archived_at: string | null;
};

export type WorkspaceLocator = {
  project_id: string;
  absolute_path: string | null;
  source: string;
  binding: WorkspaceBinding | null;
};

export type WorkspaceBindingPort = {
  getActiveWorkspaceBinding: (projectId: string) => WorkspaceBinding | null;
  resolveWorkspaceLocator: (
    projectId: string,
    explicitWorkspacePath?: string,
  ) => WorkspaceLocator;
};

let registeredPort: WorkspaceBindingPort | null = null;

export function registerWorkspaceBindingPort(port: WorkspaceBindingPort) {
  registeredPort = port;
}

export function readWorkspaceBindingPort() {
  return registeredPort;
}

export function requireWorkspaceBindingPort() {
  if (!registeredPort) {
    throw new FrameworkContractError(
      'contract_shape_invalid',
      'OPL workspace binding port is not registered.',
      { failure_code: 'workspace_binding_port_not_registered' },
    );
  }
  return registeredPort;
}
import { FrameworkContractError } from './contract-validation.ts';
