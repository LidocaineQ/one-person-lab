import crypto from 'node:crypto';

import {
  assert,
  fs,
  os,
  path,
  removeFixtureTree,
  repoRoot,
  runCli,
  runCliAsync,
  runCliFailure,
  test,
} from '../../helpers.ts';
import { formatJsonPayload, parseJsonText } from '../../../../../src/kernel/json-file.ts';

export { repoRoot };

export function sha256Fixture(value: string) {
  return `sha256:${crypto.createHash('sha256').update(value).digest('hex')}`;
}

export function distributionPayload(input: { digest?: string; immutableTag?: string } = {}) {
  const immutableTag = input.immutableTag ?? '1.2.3';
  return {
    payload_kind: 'ghcr_oci_opl_package',
    payload_ref: `ghcr.io/example-org/opl-agent-third-party-research:${immutableTag}`,
    payload_digest_ref: input.digest ?? 'sha256:2222222222222222222222222222222222222222222222222222222222222222',
    required_skill_pack_lock_refs: [
      'opl://agent-package-lock/third-party-research-required-skills/1.2.3/fixture',
    ],
    proof_status: 'non_live_contract_fixture',
    live_download_proof: false,
    installed_reload_proof: false,
    oci_ref: 'ghcr.io/example-org/opl-agent-third-party-research:latest-stable',
    oci_media_type: 'application/vnd.oci.image.manifest.v1+json',
    immutable_tag: immutableTag,
    moving_tag: 'latest-stable',
    promotion_policy: 'daily_candidate_gates_then_promote_latest_stable',
    install_truth: 'resolved_digest_lock',
  };
}

export function agentPackageManifest(input: {
  pluginSourcePath?: string;
  pluginPayloadManifestUrl?: string;
  packageId?: string;
  agentId?: string;
  pluginId?: string;
  permissions?: unknown[];
  distributionPayload?: Record<string, unknown> | null;
  profileSurface?: Record<string, unknown> | null;
} = {}) {
  const pluginId = input.pluginId ?? 'third-party-research';
  return {
    surface_kind: 'opl_agent_package_manifest.v1',
    package_id: input.packageId ?? 'third.party.research',
    agent_id: input.agentId ?? 'third-party-research',
    display_name: 'Third Party Research',
    publisher: 'example-org',
    version: '1.2.3',
    source: 'third_party',
    carrier_source_role: 'codex_plugin_default_carrier_not_package_truth',
    codex_surface: {
      plugin_ids: [pluginId],
      required_skill_ids: [pluginId],
      optional_skill_ids: ['officecli-docx'],
      ...(input.pluginSourcePath ? { plugin_source_path: input.pluginSourcePath } : {}),
      ...(input.pluginPayloadManifestUrl ? { plugin_payload_manifest_url: input.pluginPayloadManifestUrl } : {}),
    },
    ...(input.profileSurface ? { profile_surface: input.profileSurface } : {}),
    capability_dependencies: [],
    skill_packs: [
      {
        id: `${pluginId}-required-skills`,
        source: 'github:example/third-party-research-skills',
        version: '1.2.3',
        lock_sha: 'sha256:fixture',
        install_mode: 'bundled_required',
      },
    ],
    entrypoints: [
      {
        shortcut_id: 'research',
        label: 'Research',
        required_skill_ids: [pluginId],
        shortcut_eligible: true,
      },
    ],
    health_check: {
      kind: 'opl_package_receipt',
      required_surfaces: ['plugin_registry', 'required_skill_ids'],
    },
    permissions: input.permissions ?? [],
    ...(input.distributionPayload === null ? {} : { distribution_payload: input.distributionPayload ?? distributionPayload() }),
    update_channel: 'manifest_url',
    rollback_ref: 'package-receipt-ref:previous',
  };
}

export function registryPayload(baseUrl: string, input: { packageId?: string } = {}) {
  return {
    registry_id: 'test-agent-registry',
    discovery_only: true,
    install_authority_allowed: false,
    entries: [
      {
        package_id: input.packageId ?? 'third.party.research',
        display_name: 'Third Party Research',
        publisher: 'example-org',
        source: 'third_party',
        manifest_url: `${baseUrl}/manifest.json`,
        version_source_ref: `${baseUrl}/manifest.json#/version`,
        trust_tier: 'third_party_verified',
        codex_visible_entry: 'third-party-research',
        required_skill_ids: ['third-party-research'],
        optional_skill_ids: ['officecli-docx'],
        home_shortcut_ids: ['research'],
        display_policy: 'refs_only_no_domain_verdict',
        ordinary_user_source: {
          kind: 'ghcr_oci_artifact_latest_stable',
          registry: 'ghcr.io',
          artifact_ref: 'ghcr.io/example-org/opl-agent-third-party-research',
          ordinary_user_ref: 'ghcr.io/example-org/opl-agent-third-party-research:latest-stable',
          immutable_version_ref_pattern: 'ghcr.io/example-org/opl-agent-third-party-research:<semver>',
          candidate_ref: 'ghcr.io/example-org/opl-agent-third-party-research:candidate',
          latest_stable_role: 'ordinary_user_latest_stable_pointer_after_candidate_gates',
          latest_stable_is_only_ordinary_user_channel: true,
          daily_candidate_build_gate: 'daily_candidate_build_must_pass_before_promote_latest_stable',
          install_truth: ['immutable_version_tag', 'oci_digest', 'package_lock_receipt'],
          latest_stable_is_install_truth: false,
          developer_checkout_auto_apply_allowed: false,
        },
      },
    ],
  };
}

export {
  assert,
  fs,
  os,
  path,
  removeFixtureTree,
  runCli,
  runCliAsync,
  runCliFailure,
  test,
  formatJsonPayload,
  parseJsonText,
};
