import { assert, runCli, test } from '../../helpers.ts';
import {
  buildReadyAgentRepo,
  configureReadyMagMorphology,
  configureReadyRcaMorphology,
  retargetReadyRepo,
  retargetReadyRepoToMag,
  writeProductionAcceptance,
} from '../agents-conformance-fixtures.ts';

test('agents conformance reads production acceptance evidence as domain-owned refs only', () => {
  const masRepo = buildReadyAgentRepo();
  retargetReadyRepo(masRepo, 'med-autoscience', 'Med Auto Science');

  const magRepo = buildReadyAgentRepo();
  retargetReadyRepoToMag(magRepo);
  configureReadyMagMorphology(magRepo);
  writeProductionAcceptance(magRepo, 'mag-production-acceptance.json', {
    evidence_tail_status: 'closed_by_domain_owned_acceptance_receipt',
    domain_owner: 'med-autogrant',
    closure_evidence: { accepted_return_shape: 'owner_receipt' },
    refs: {
      owner_receipt_refs: ['receipt:mag/production-default-caller'],
      doc_refs: ['docs/status.md#production-acceptance'],
      next_verification_command_refs: ['mag production acceptance --json'],
    },
    authority_boundary: { domain_ready_claimed: false },
  });

  const rcaRepo = buildReadyAgentRepo();
  retargetReadyRepo(rcaRepo, 'redcube-ai', 'RedCube AI');
  configureReadyRcaMorphology(rcaRepo);
  writeProductionAcceptance(rcaRepo, 'rca-production-acceptance.json', {
    evidence_tail_status: 'domain_owned_typed_blocker_with_next_verification_ref',
    domain_owner: 'redcube-ai',
    closure_evidence: {
      accepted_return_shape: 'typed_blocker',
      typed_blocker_kind: 'live_visual_soak_pending',
    },
    refs: {
      typed_blocker_refs: ['blocker:rca/live-visual-soak'],
      next_verification_command_refs: ['rca acceptance verify --json'],
    },
    authority_boundary: { domain_ready_claimed: false },
  });

  const report = runCli([
    'agents',
    'conformance',
    '--agent',
    `mas=${masRepo}`,
    '--agent',
    `mag=${magRepo}`,
    '--agent',
    `rca=${rcaRepo}`,
  ]).standard_domain_agent_conformance;
  const [mas, mag, rca] = report.reports;

  assert.equal(report.status, 'passed');
  assert.equal(report.authority_boundary.conformance_report_can_claim_domain_ready, false);
  assert.equal(mas.evidence_tail_classification.status, 'production_evidence_tail_present');
  assert.equal(mag.evidence_tail_classification.status, 'closed');
  assert.equal(mag.evidence_tail_classification.tail_items[0].evidence_ref, 'receipt:mag/production-default-caller');
  assert.equal(rca.evidence_tail_classification.status, 'domain_owned_typed_blocker_reported');
  assert.equal(rca.evidence_tail_classification.tail_items[0].authority_boundary.typed_blocker_kind, 'live_visual_soak_pending');
});
