import fs from 'node:fs';
import path from 'node:path';

import { FrameworkContractError, isRecord } from './contract-validation.ts';
import { parseJsonText } from './json-file.ts';

export const AGENT_PLUGIN_MANIFEST_SCHEMA_1_0_0 =
  'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json';
export const AGENT_PLUGIN_MANIFEST_SCHEMA_REF =
  'contracts/opl-framework/agent-plugin-manifest-1.0.0.schema.json';

const STANDARD_FIELDS = new Set([
  '$schema',
  'name',
  'version',
  'description',
  'author',
  'homepage',
  'repository',
  'license',
  'keywords',
  'extensions',
]);
const AUTHOR_FIELDS = new Set(['name', 'email', 'url']);
const PLUGIN_NAME = /^(?!.*(?:--|\.\.))[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/;

export type AgentPluginManifestKind = 'agent_plugins_1_0' | 'codex_legacy';

export type ResolvedAgentPluginManifest = {
  pluginRoot: string;
  manifestPath: string;
  kind: AgentPluginManifestKind;
  manifest: Record<string, unknown>;
  ignoredTopLevelFields: string[];
  conformanceErrors: string[];
};

function stringValue(value: unknown) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function regularFile(filePath: string) {
  try {
    const stat = fs.lstatSync(filePath);
    return stat.isFile() && !stat.isSymbolicLink();
  } catch {
    return false;
  }
}

function manifestFailure(message: string, details: Record<string, unknown>): never {
  throw new FrameworkContractError('contract_shape_invalid', message, {
    ...details,
    failure_code: 'agent_plugin_manifest_invalid',
  });
}

function readManifestObject(filePath: string) {
  let parsed: unknown;
  try {
    parsed = parseJsonText(fs.readFileSync(filePath, 'utf8'));
  } catch (error) {
    return manifestFailure('Agent Plugin manifest is not valid JSON.', {
      manifest_path: filePath,
      error: error instanceof Error ? error.message : String(error),
    });
  }
  if (!isRecord(parsed)) {
    return manifestFailure('Agent Plugin manifest must contain an object root.', {
      manifest_path: filePath,
    });
  }
  return parsed;
}

function standardManifestConformance(manifest: Record<string, unknown>) {
  const fatalErrors: string[] = [];
  const ignoredTopLevelFields = Object.keys(manifest)
    .filter((field) => !STANDARD_FIELDS.has(field))
    .sort();
  const conformanceErrors = ignoredTopLevelFields.map((field) => `unknown_top_level_field:${field}`);
  if (manifest.$schema !== AGENT_PLUGIN_MANIFEST_SCHEMA_1_0_0) {
    fatalErrors.push('unsupported_or_missing_schema');
  }
  const name = stringValue(manifest.name);
  if (!name || name.length > 64 || !PLUGIN_NAME.test(name)) {
    fatalErrors.push('invalid_plugin_name');
  }
  for (const field of ['version', 'description', 'homepage', 'repository', 'license']) {
    if (manifest[field] !== undefined && typeof manifest[field] !== 'string') {
      fatalErrors.push(`invalid_${field}_type`);
    }
  }
  if (manifest.keywords !== undefined
    && (!Array.isArray(manifest.keywords) || manifest.keywords.some((value) => typeof value !== 'string'))) {
    fatalErrors.push('invalid_keywords_type');
  }
  if (manifest.author !== undefined) {
    if (!isRecord(manifest.author)) {
      fatalErrors.push('invalid_author_type');
    } else {
      for (const [field, value] of Object.entries(manifest.author)) {
        if (!AUTHOR_FIELDS.has(field) || typeof value !== 'string') {
          fatalErrors.push(`invalid_author_field:${field}`);
        }
      }
    }
  }
  if (manifest.extensions !== undefined && !isRecord(manifest.extensions)) {
    conformanceErrors.push('non_object_extensions_ignored');
  }
  return { fatalErrors, conformanceErrors, ignoredTopLevelFields };
}

function readResolvedManifest(input: {
  pluginRoot: string;
  manifestPath: string;
  kind: AgentPluginManifestKind;
  expectedName?: string;
}): ResolvedAgentPluginManifest {
  const manifest = readManifestObject(input.manifestPath);
  const conformance = input.kind === 'agent_plugins_1_0'
    ? standardManifestConformance(manifest)
    : { fatalErrors: [], conformanceErrors: [], ignoredTopLevelFields: [] };
  if (input.kind === 'agent_plugins_1_0' && conformance.fatalErrors.length > 0) {
    manifestFailure('Agent Plugins 1.0 manifest failed its fatal core contract.', {
      manifest_path: input.manifestPath,
      conformance_errors: conformance.fatalErrors,
      schema_ref: AGENT_PLUGIN_MANIFEST_SCHEMA_REF,
    });
  }
  const observedName = stringValue(manifest.name);
  if (!observedName) {
    manifestFailure('Agent Plugin manifest must declare a non-empty name.', {
      manifest_path: input.manifestPath,
    });
  }
  if (input.expectedName && observedName !== input.expectedName) {
    manifestFailure('Agent Plugin manifest name does not match the requested plugin identity.', {
      manifest_path: input.manifestPath,
      expected_name: input.expectedName,
      observed_name: observedName,
    });
  }
  return {
    pluginRoot: input.pluginRoot,
    manifestPath: input.manifestPath,
    kind: input.kind,
    manifest,
    ignoredTopLevelFields: conformance.ignoredTopLevelFields,
    conformanceErrors: conformance.conformanceErrors,
  };
}

/**
 * Agent Plugins roots are resolved successor-first across the whole candidate
 * set. A present standard manifest is never masked by a legacy Codex manifest.
 */
export function resolveAgentPluginManifest(
  pluginRoots: string[],
  options: { expectedName?: string } = {},
): ResolvedAgentPluginManifest | null {
  const roots = [...new Set(pluginRoots.map((root) => path.resolve(root)))];
  for (const pluginRoot of roots) {
    const manifestPath = path.join(pluginRoot, 'plugin.json');
    if (fs.existsSync(manifestPath)) {
      if (!regularFile(manifestPath)) {
        manifestFailure('Agent Plugins 1.0 manifest must be a regular non-symlink file.', {
          manifest_path: manifestPath,
        });
      }
      return readResolvedManifest({
        pluginRoot,
        manifestPath,
        kind: 'agent_plugins_1_0',
        expectedName: options.expectedName,
      });
    }
  }
  for (const pluginRoot of roots) {
    const manifestPath = path.join(pluginRoot, '.codex-plugin', 'plugin.json');
    if (fs.existsSync(manifestPath)) {
      if (!regularFile(manifestPath)) {
        manifestFailure('Legacy Codex Plugin manifest must be a regular non-symlink file.', {
          manifest_path: manifestPath,
        });
      }
      return readResolvedManifest({
        pluginRoot,
        manifestPath,
        kind: 'codex_legacy',
        expectedName: options.expectedName,
      });
    }
  }
  return null;
}

export function agentPluginSkillsRelativeRoot(resolved: ResolvedAgentPluginManifest) {
  if (resolved.kind === 'agent_plugins_1_0') return './skills';
  return stringValue(resolved.manifest.skills) ?? './skills';
}

export function agentPluginOpenAiInterface(manifest: Record<string, unknown>) {
  const extensions = isRecord(manifest.extensions) ? manifest.extensions : null;
  const openAi = extensions && isRecord(extensions['com.openai']) ? extensions['com.openai'] : null;
  if (openAi && isRecord(openAi.interface)) return openAi.interface;
  return isRecord(manifest.interface) ? manifest.interface : null;
}

/**
 * The normative text makes unknown top-level fields and the entire contents of
 * unimplemented extension namespaces non-fatal even though the closed schema
 * cannot express those client-loading exceptions.
 */
export function agentPluginCoreSchemaPayload(resolved: ResolvedAgentPluginManifest) {
  const payload = Object.fromEntries(
    Object.entries(resolved.manifest).filter(([field]) => STANDARD_FIELDS.has(field)),
  );
  if (payload.extensions !== undefined) {
    if (isRecord(payload.extensions)) payload.extensions = {};
    else delete payload.extensions;
  }
  return payload;
}

export function normalizeAgentPluginName(value: string) {
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9.-]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/\.{2,}/g, '.')
    .replace(/^[.-]+|[.-]+$/g, '');
  return normalized && normalized.length <= 64 && PLUGIN_NAME.test(normalized)
    ? normalized
    : 'new-domain-agent';
}
