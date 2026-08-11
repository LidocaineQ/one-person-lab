export type LocalCodexDefaults = {
  config_path: string;
  model_provider: string | null;
  model: string;
  reasoning_effort: string | null;
  provider_name: string | null;
  provider_base_url: string | null;
  provider_api_key: string | null;
  opl_gateway_configured: boolean;
  selected_provider_api_key_present: boolean;
};

export type LocalCodexModelAccessSource =
  | 'opl_gateway'
  | 'codex_login'
  | 'custom_provider'
  | 'env_api_key'
  | 'missing';

export type LocalCodexAccessState = {
  config_path: string;
  auth_path: string;
  config_found: boolean;
  auth_found: boolean;
  api_key_present: boolean;
  opl_gateway_configured: boolean;
  codex_login_present: boolean;
  env_api_key_present: boolean;
  model_access_ready: boolean;
  model_access_source: LocalCodexModelAccessSource;
  provider_base_url: string | null;
  model: string | null;
  reasoning_effort: string | null;
};
