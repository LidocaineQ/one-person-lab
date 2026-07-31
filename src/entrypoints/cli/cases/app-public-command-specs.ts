import type { FrameworkContracts } from '../../../kernel/types.ts';
import {
  parseRegisteredCommandOptions,
  type CommandSpec,
} from '../modules/support.ts';

export function buildPublicAppCommandSpecs(
  getContracts: () => FrameworkContracts,
): Record<string, CommandSpec> {
  const commandSpecs: Record<string, CommandSpec> = {
    'app state': {
      usage: 'opl app state [--profile runtime|fast|full]',
      summary: 'Read the canonical OPL App state projection for GUI pages without page-local probing.',
      examples: [
        'opl app state --profile fast',
        'opl app state --profile runtime --json',
        'opl app state --profile full --json',
      ],
      group: 'app',
      handler: async (args) => {
        const { parseAppStateArgs } = await import('../../../modules/console/app-state-profile.ts');
        const input = parseAppStateArgs(args);
        if (input.profile === 'runtime') {
          const { buildOplRuntimeAppState } = await import('../../../modules/console/app-runtime-state.ts');
          return buildOplRuntimeAppState();
        }
        const { buildOplAppState } = await import('../../../modules/console/app-state.ts');
        return buildOplAppState({ profile: input.profile });
      },
    },
    'app action execute': {
      usage: 'opl app action execute --action <action_id> [--payload <json>] [--dry-run]',
      summary: 'Execute App mutations through the OPL-owned action boundary instead of page-local commands.',
      examples: [
        'opl app action execute --action developer_supervisor --payload \'{"developerSupervisorEnabled":"on"}\' --dry-run',
        'opl app action execute --action provider_scheduler_status --dry-run',
      ],
      group: 'app',
      handler: async (args) => {
        const { parseAppActionExecuteArgs } = await import(
          '../../../modules/console/app-state-parts/action-execute-parser.ts'
        );
        const options = parseAppActionExecuteArgs(args);
        const { runOplAppActionExecute } = await import(
          '../../../modules/console/app-state-parts/action-execute.ts'
        );
        return runOplAppActionExecute(getContracts(), options);
      },
    },
    'app contribution read': {
      usage: 'opl app contribution read --package-id <package_id> --ref <data_ref> [--input <json>|--input-stdin]',
      summary: 'Read a descriptor-declared App contribution through its installed Package-owned JSON ABI.',
      examples: [
        'opl app contribution read --package-id <package_id> --ref <data_ref> --json',
      ],
      group: 'app',
      handler: async (args) => {
        const { parseAppContributionArgs, runAppContribution } = await import(
          '../../../modules/console/app-contribution-broker.ts'
        );
        return runAppContribution(parseAppContributionArgs(args, 'read'));
      },
    },
    'app contribution execute': {
      usage: 'opl app contribution execute --package-id <package_id> --ref <action_ref> [--input <json>|--input-stdin] [--confirm]',
      summary: 'Execute a descriptor-declared App contribution through its Package-owned JSON ABI.',
      examples: [
        'opl app contribution execute --package-id <package_id> --ref <action_ref> --input <json> --confirm --json',
      ],
      group: 'app',
      handler: async (args) => {
        const { parseAppContributionArgs, runAppContribution } = await import(
          '../../../modules/console/app-contribution-broker.ts'
        );
        return runAppContribution(parseAppContributionArgs(args, 'execute'));
      },
    },
    'app view read': {
      usage: 'opl app view read --item-id <canonical-item-id> --view-id <view-id> [--if-revision <n>]',
      summary: 'Read one descriptor-declared, item-scoped JSON detail view without accepting arbitrary paths.',
      examples: [
        'opl app view read --item-id <canonical-item-id> --view-id scientific-reasoning --json',
        'opl app view read --item-id <canonical-item-id> --view-id scientific-reasoning --if-revision 4 --json',
      ],
      group: 'app',
      handler: async (args) => {
        const { buildDomainDetailViewReadback, parseAppViewReadArgs } = await import(
          '../../../modules/console/domain-detail-view.ts'
        );
        return buildDomainDetailViewReadback(parseAppViewReadArgs(args));
      },
    },
    'app compatibility receipt': {
      usage:
        'opl app compatibility receipt --requirements-file <path> --subject-file <path> --output <path> [--ttl-seconds <n>]',
      summary:
        'Produce a short-lived Framework compatibility receipt from App-owned requirements and Framework-owned observations.',
      examples: [
        'opl app compatibility receipt --requirements-file app-compatibility-requirements.json --subject-file installed-app-subject.json --output /tmp/opl-component-compatibility-receipt.json --ttl-seconds 900 --json',
      ],
      group: 'app',
      handler: async (args) => {
        const spec = commandSpecs['app compatibility receipt'];
        const options = parseRegisteredCommandOptions('app compatibility receipt', args, spec);
        const { writeAppComponentCompatibilityReceipt } = await import(
          '../../../modules/console/app-compatibility-receipt.ts'
        );
        return {
          version: 'g2',
          app_component_compatibility_receipt: writeAppComponentCompatibilityReceipt({
            requirementsFile: String(options['requirements-file']),
            subjectFile: String(options['subject-file']),
            outputFile: String(options.output),
            ttlSeconds: Number(options['ttl-seconds']),
          }),
        };
      },
    },
  };
  return commandSpecs;
}
