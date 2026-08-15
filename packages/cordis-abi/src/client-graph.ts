import { createHash } from 'node:crypto';

import { canonicalJsonBytes } from './json.ts';

export const OPL_CLIENT_GRAPH_VERSION = 'opl-host-derived-client-graph.v1' as const;

export type OplClientContribution = Readonly<{
  contribution_id: string;
  package_id: string;
  package_version: string;
  client_entry: string;
  client_integrity: string;
  injects: readonly string[];
  provides: readonly string[];
  slots: readonly string[];
  actions: readonly string[];
  trust: 'first_party';
}>;

export type OplHostDerivedClientGraph = Readonly<{
  version: typeof OPL_CLIENT_GRAPH_VERSION;
  profile_id: string;
  host_snapshot_id: string;
  graph_digest: string;
  contributions: readonly OplClientContribution[];
  authority_boundary: Readonly<{
    graph_owner: 'framework_host';
    product_profile_owner: 'opl_app';
    client_discovery: false;
    client_package_install: false;
    client_package_currentness: false;
    client_product_truth: false;
  }>;
}>;

export function buildHostDerivedClientGraph(input: {
  profile_id: string;
  host_snapshot_id: string;
  contributions: readonly OplClientContribution[];
}): OplHostDerivedClientGraph {
  const contributions = [...input.contributions]
    .map((entry) => Object.freeze({
      ...entry,
      injects: [...entry.injects].sort(),
      provides: [...entry.provides].sort(),
      slots: [...entry.slots].sort(),
      actions: [...entry.actions].sort(),
    }))
    .sort((left, right) => left.contribution_id.localeCompare(right.contribution_id));
  const unsigned = {
    version: OPL_CLIENT_GRAPH_VERSION,
    profile_id: input.profile_id,
    host_snapshot_id: input.host_snapshot_id,
    contributions,
    authority_boundary: {
      graph_owner: 'framework_host' as const,
      product_profile_owner: 'opl_app' as const,
      client_discovery: false as const,
      client_package_install: false as const,
      client_package_currentness: false as const,
      client_product_truth: false as const,
    },
  };
  const graph_digest = `sha256:${createHash('sha256').update(canonicalJsonBytes(unsigned)).digest('hex')}`;
  return Object.freeze({ ...unsigned, graph_digest });
}
