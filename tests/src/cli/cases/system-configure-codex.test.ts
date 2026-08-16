import { assert, fs, os, path, test } from '../helpers.ts';
import {
  OPL_GATEWAY_BASE_URL,
  OPL_GATEWAY_LEGACY_BASE_URLS,
  readBundledCodexDefaultProfile,
} from '../../../../src/kernel/local-codex-defaults.ts';
import {
  runCliWithStdin,
} from './system-install-fixtures.ts';

const codexDefaultProfile = readBundledCodexDefaultProfile();

function assertBundledCodexModel(
  bootstrap: { model: string; reasoning_effort: string },
  config: string,
) {
  assert.equal(bootstrap.model, codexDefaultProfile.model);
  assert.equal(bootstrap.reasoning_effort, codexDefaultProfile.model_reasoning_effort);
  assert.equal(config.includes(`model = ${JSON.stringify(codexDefaultProfile.model)}`), true);
  assert.equal(
    config.includes(
      `model_reasoning_effort = ${JSON.stringify(codexDefaultProfile.model_reasoning_effort)}`,
    ),
    true,
  );
}

test('system configure-codex writes the product endpoint and App-owned install fallback without leaking the API key', () => {
  const homeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'opl-configure-codex-home-'));
  const apiKey = 'secret-stdin-key';

  try {
    const output = runCliWithStdin(
      ['system', 'configure-codex', '--api-key-stdin'],
      `${apiKey}\n`,
      {
        HOME: homeRoot,
        CODEX_HOME: path.join(homeRoot, 'codex-home'),
        OPL_STATE_DIR: path.join(homeRoot, 'opl-state'),
      },
    ) as {
      codex_config: {
        status: string;
        config_path: string;
        default_profile: {
          model_provider: string;
          model: string;
          model_reasoning_effort: string;
          provider_name: string;
          base_url: string;
          base_url_role: string;
          model_profile_role: string;
        };
        bootstrap: {
          model_provider: string;
          model: string;
          reasoning_effort: string;
          provider_base_url: string;
          api_key_present: boolean;
          management_receipt: {
            selection_mode: string;
            provider_route: string;
            owned_keys: string[];
            backup_path: string | null;
          };
          management_receipt_path: string;
        };
      };
    };

    assert.equal(output.codex_config.status, 'completed');
    assert.equal(output.codex_config.default_profile.model_provider, 'oplgateway');
    assert.equal(output.codex_config.default_profile.provider_name, 'OPL Gateway');
    assert.equal(output.codex_config.default_profile.model, codexDefaultProfile.model);
    assert.equal(
      output.codex_config.default_profile.model_reasoning_effort,
      codexDefaultProfile.model_reasoning_effort,
    );
    assert.equal(output.codex_config.default_profile.base_url, 'https://gateway.medopl.com/v1');
    assert.equal(output.codex_config.default_profile.base_url_role, codexDefaultProfile.base_url_role);
    assert.equal(output.codex_config.default_profile.model_profile_role, codexDefaultProfile.model_profile_role);
    assert.equal(output.codex_config.bootstrap.model_provider, 'oplgateway');
    assert.equal(output.codex_config.bootstrap.api_key_present, true);
    assert.equal(output.codex_config.bootstrap.management_receipt.selection_mode, 'auto');
    assert.equal(output.codex_config.bootstrap.management_receipt.provider_route, 'direct_gateway');
    assert.equal(output.codex_config.bootstrap.management_receipt.backup_path, null);
    assert.equal(fs.existsSync(output.codex_config.bootstrap.management_receipt_path), true);
    assert.equal(JSON.stringify(output).includes(apiKey), false);

    const config = fs.readFileSync(output.codex_config.config_path, 'utf8');
    assert.match(config, /model_provider = "oplgateway"/);
    assert.match(config, /\[model_providers\.oplgateway\]/);
    assert.match(config, /name = "OPL Gateway"/);
    assertBundledCodexModel(output.codex_config.bootstrap, config);
    assert.match(config, /base_url = "https:\/\/gateway\.medopl\.com\/v1"/);
    assert.match(config, /experimental_bearer_token = "secret-stdin-key"/);
  } finally {
    fs.rmSync(homeRoot, { recursive: true, force: true });
  }
});

test('system configure-codex keeps collision protection for non-reserved provider ids', () => {
  const homeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'opl-configure-codex-custom-collision-'));
  const codexHome = path.join(homeRoot, 'codex-home');

  try {
    fs.mkdirSync(codexHome, { recursive: true });
    fs.writeFileSync(
      path.join(codexHome, 'config.toml'),
      [
        'model_provider = "custom"',
        'model = "custom-model"',
        '',
        '[model_providers.custom]',
        'name = "Custom Provider"',
        'base_url = "https://custom-provider.example.test/v1"',
        'experimental_bearer_token = "existing-custom-key"',
        '',
        '[model_providers.acme]',
        'name = "Acme"',
        'base_url = "https://acme.example.test/v1"',
        'experimental_bearer_token = "acme-key"',
        '',
      ].join('\n'),
      'utf8',
    );

    const output = runCliWithStdin(
      ['system', 'configure-codex', '--api-key-stdin'],
      'new-opl-key\n',
      {
        HOME: homeRoot,
        CODEX_HOME: codexHome,
        OPL_STATE_DIR: path.join(homeRoot, 'opl-state'),
        OPL_CODEX_MODEL_PROVIDER: 'acme',
      },
    ) as any;

    assert.equal(output.codex_config.bootstrap.management_receipt.provider_id, 'acme_2');
    const config = fs.readFileSync(path.join(codexHome, 'config.toml'), 'utf8');
    assert.match(config, /\[model_providers\.acme\]/);
    assert.match(config, /base_url = "https:\/\/acme\.example\.test\/v1"/);
    assert.match(config, /experimental_bearer_token = "acme-key"/);
    assert.match(config, /\[model_providers\.acme_2\]/);
  } finally {
    fs.rmSync(homeRoot, { recursive: true, force: true });
  }
});

test('system configure-codex keeps environment overrides over bundled model profile', () => {
  const homeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'opl-configure-codex-override-home-'));

  try {
    const output = runCliWithStdin(
      ['system', 'configure-codex', '--api-key-stdin'],
      'override-key\n',
      {
        HOME: homeRoot,
        CODEX_HOME: path.join(homeRoot, 'codex-home'),
        OPL_STATE_DIR: path.join(homeRoot, 'opl-state'),
        OPL_CODEX_MODEL: 'gpt-5.6',
        OPL_CODEX_REASONING_EFFORT: 'high',
      },
    ) as {
      codex_config: {
        config_path: string;
        bootstrap: {
          model: string;
          reasoning_effort: string;
          provider_base_url: string;
        };
      };
    };

    assert.equal(output.codex_config.bootstrap.model, 'gpt-5.6');
    assert.equal(output.codex_config.bootstrap.reasoning_effort, 'high');
    assert.equal(output.codex_config.bootstrap.provider_base_url, 'https://gateway.medopl.com/v1');

    const config = fs.readFileSync(output.codex_config.config_path, 'utf8');
    assert.match(config, /model = "gpt-5\.6"/);
    assert.match(config, /model_reasoning_effort = "high"/);
    assert.match(config, /base_url = "https:\/\/gateway\.medopl\.com\/v1"/);
  } finally {
    fs.rmSync(homeRoot, { recursive: true, force: true });
  }
});

test('system configure-codex preserves an existing custom provider and registers OPL Gateway as inactive', () => {
  const homeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'opl-configure-codex-switch-home-'));
  const codexHome = path.join(homeRoot, 'codex-home');

  try {
    fs.mkdirSync(codexHome, { recursive: true });
    fs.writeFileSync(
      path.join(codexHome, 'config.toml'),
      [
        'model_provider = "custom"',
        'model = "custom-model"',
        '',
        '[model_providers.custom]',
        'name = "custom"',
        'base_url = "https://custom-provider.example.test/v1"',
        'experimental_bearer_token = "existing-custom-key"',
        '',
      ].join('\n'),
      'utf8',
    );

    const output = runCliWithStdin(
      ['system', 'configure-codex', '--api-key-stdin'],
      'opl-gateway-key\n',
      {
        HOME: homeRoot,
        CODEX_HOME: codexHome,
        OPL_STATE_DIR: path.join(homeRoot, 'opl-state'),
      },
    ) as {
      codex_config: {
        status: string;
        config_path: string;
        bootstrap: {
          model: string;
          provider_base_url: string;
          api_key_present: boolean;
          management_receipt: {
            selection_mode: string;
            provider_route: string;
            backup_path: string | null;
          };
        };
      };
    };

    assert.equal(output.codex_config.status, 'completed');
    assert.equal(output.codex_config.bootstrap.model, 'custom-model');
    assert.equal(output.codex_config.bootstrap.provider_base_url, 'https://gateway.medopl.com/v1');
    assert.equal(output.codex_config.bootstrap.api_key_present, true);
    assert.equal(output.codex_config.bootstrap.management_receipt.selection_mode, 'inactive_provider');
    assert.equal(output.codex_config.bootstrap.management_receipt.provider_route, 'inactive_provider');
    assert.equal(fs.existsSync(output.codex_config.bootstrap.management_receipt.backup_path!), true);

    const config = fs.readFileSync(output.codex_config.config_path, 'utf8');
    assert.match(config, /model_provider = "custom"/);
    assert.match(config, /model = "custom-model"/);
    assert.match(config, /\[model_providers\.custom\]/);
    assert.match(config, /base_url = "https:\/\/custom-provider\.example\.test\/v1"/);
    assert.match(config, /\[model_providers\.oplgateway\]/);
    assert.match(config, /name = "OPL Gateway"/);
    assert.match(config, /base_url = "https:\/\/gateway\.medopl\.com\/v1"/);
    assert.match(config, /experimental_bearer_token = "opl-gateway-key"/);
  } finally {
    fs.rmSync(homeRoot, { recursive: true, force: true });
  }
});

for (const legacyProviderId of ['gflab', 'gflabtoken']) {
  test(`system configure-codex reuses the inactive legacy ${legacyProviderId} provider without migrating its identity`, () => {
    const homeRoot = fs.mkdtempSync(path.join(os.tmpdir(), `opl-configure-codex-${legacyProviderId}-`));
    const codexHome = path.join(homeRoot, 'codex-home');

    try {
      fs.mkdirSync(codexHome, { recursive: true });
      fs.writeFileSync(
        path.join(codexHome, 'config.toml'),
        [
          'model_provider = "custom"',
          'model = "custom-model"',
          '',
          '[model_providers.custom]',
          'name = "Custom Provider"',
          'base_url = "https://custom-provider.example.test/v1"',
          'experimental_bearer_token = "existing-custom-key"',
          '',
          `[model_providers.${JSON.stringify(legacyProviderId)}]`,
          `name = "${legacyProviderId}"`,
          `base_url = "${OPL_GATEWAY_LEGACY_BASE_URLS[0]}"`,
          'experimental_bearer_token = "existing-opl-key"',
          '',
        ].join('\n'),
        'utf8',
      );

      const output = runCliWithStdin(
        ['system', 'configure-codex', '--api-key-stdin'],
        'replacement-opl-key\n',
        {
          HOME: homeRoot,
          CODEX_HOME: codexHome,
          OPL_STATE_DIR: path.join(homeRoot, 'opl-state'),
        },
      ) as {
        codex_config: {
          bootstrap: {
            model_provider: string;
            provider_base_url: string;
            management_receipt: {
              provider_id: string;
              selection_mode: string;
            };
          };
        };
      };

      assert.equal(output.codex_config.bootstrap.provider_base_url, OPL_GATEWAY_LEGACY_BASE_URLS[0]);
      assert.equal(output.codex_config.bootstrap.model_provider, legacyProviderId);
      assert.equal(output.codex_config.bootstrap.management_receipt.provider_id, legacyProviderId);
      assert.equal(output.codex_config.bootstrap.management_receipt.selection_mode, 'inactive_provider');
      const config = fs.readFileSync(path.join(codexHome, 'config.toml'), 'utf8');
      assert.match(config, /model_provider = "custom"/);
      assert.match(config, new RegExp(`\\[model_providers\\."${legacyProviderId}"\\]`));
      assert.doesNotMatch(config, new RegExp(`\\[model_providers\\.${legacyProviderId}\\]`));
      assert.match(config, new RegExp(`^name = "${legacyProviderId}"$`, 'm'));
      assert.match(config, /base_url = "https:\/\/gflabtoken\.cn\/v1"/);
      assert.doesNotMatch(config, /\[model_providers\.oplgateway\]/);
      assert.doesNotMatch(config, /^name = "OPL Gateway"$/m);
      assert.match(config, /experimental_bearer_token = "replacement-opl-key"/);
    } finally {
      fs.rmSync(homeRoot, { recursive: true, force: true });
    }
  });
}

test('system configure-codex treats oplgateway as the OPL-owned stable id and updates it in place', () => {
  const homeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'opl-configure-codex-oplgateway-collision-'));
  const codexHome = path.join(homeRoot, 'codex-home');

  try {
    fs.mkdirSync(codexHome, { recursive: true });
    fs.writeFileSync(
      path.join(codexHome, 'config.toml'),
      [
        'model_provider = "custom"',
        'model = "custom-model"',
        '',
        '[model_providers.custom]',
        'name = "Custom Provider"',
        'base_url = "https://custom-provider.example.test/v1"',
        'experimental_bearer_token = "existing-custom-key"',
        '',
        '[model_providers."oplgateway"]',
        'name = "Stale OPL Gateway"',
        'base_url = "https://third-party.example.test/v1"',
        'experimental_bearer_token = "third-party-key"',
        '',
      ].join('\n'),
      'utf8',
    );

    const output = runCliWithStdin(
      ['system', 'configure-codex', '--api-key-stdin'],
      'new-opl-key\n',
      {
        HOME: homeRoot,
        CODEX_HOME: codexHome,
        OPL_STATE_DIR: path.join(homeRoot, 'opl-state'),
      },
    ) as {
      codex_config: {
        bootstrap: {
          model_provider: string;
          management_receipt: {
            provider_id: string;
            selection_mode: string;
          };
        };
      };
    };

    assert.equal(output.codex_config.bootstrap.model_provider, 'oplgateway');
    assert.equal(output.codex_config.bootstrap.management_receipt.provider_id, 'oplgateway');
    assert.equal(output.codex_config.bootstrap.management_receipt.selection_mode, 'inactive_provider');
    const config = fs.readFileSync(path.join(codexHome, 'config.toml'), 'utf8');
    assert.match(config, /\[model_providers\."oplgateway"\]/);
    assert.doesNotMatch(config, /\[model_providers\.oplgateway\]/);
    assert.match(config, /name = "OPL Gateway"/);
    assert.match(config, new RegExp(`base_url = ${JSON.stringify(OPL_GATEWAY_BASE_URL)}`));
    assert.match(config, /experimental_bearer_token = "new-opl-key"/);
    assert.doesNotMatch(config, /third-party\.example\.test|third-party-key/);
  } finally {
    fs.rmSync(homeRoot, { recursive: true, force: true });
  }
});

test('system configure-codex preserves model and reasoning values changed after the last OPL receipt', () => {
  const homeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'opl-configure-codex-local-override-home-'));
  const codexHome = path.join(homeRoot, 'codex-home');
  const stateDir = path.join(homeRoot, 'opl-state');

  try {
    const env = {
      HOME: homeRoot,
      CODEX_HOME: codexHome,
      OPL_STATE_DIR: stateDir,
    };
    runCliWithStdin(['system', 'configure-codex', '--api-key-stdin'], 'first-key\n', env);
    const configPath = path.join(codexHome, 'config.toml');
    const managedConfig = fs.readFileSync(configPath, 'utf8');
    fs.writeFileSync(
      configPath,
      managedConfig
        .replace(
          `model = ${JSON.stringify(codexDefaultProfile.model)}`,
          'model = "user-fixed-model"',
        )
        .replace(
          `model_reasoning_effort = ${JSON.stringify(codexDefaultProfile.model_reasoning_effort)}`,
          'model_reasoning_effort = "high"',
        ),
      'utf8',
    );

    const output = runCliWithStdin(
      ['system', 'configure-codex', '--api-key-stdin'],
      'second-key\n',
      env,
    ) as {
      codex_config: {
        bootstrap: {
          model: string;
          reasoning_effort: string;
          management_receipt: { selection_mode: string };
        };
      };
    };

    assert.equal(output.codex_config.bootstrap.model, 'user-fixed-model');
    assert.equal(output.codex_config.bootstrap.reasoning_effort, 'high');
    assert.equal(output.codex_config.bootstrap.management_receipt.selection_mode, 'local_override');
    const config = fs.readFileSync(configPath, 'utf8');
    assert.match(config, /model = "user-fixed-model"/);
    assert.match(config, /model_reasoning_effort = "high"/);
    assert.match(config, /experimental_bearer_token = "second-key"/);
  } finally {
    fs.rmSync(homeRoot, { recursive: true, force: true });
  }
});

test('system configure-codex completes a plugin-only Codex config created during first-run install', () => {
  const homeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'opl-configure-codex-plugin-home-'));
  const codexHome = path.join(homeRoot, 'codex-home');
  const configPath = path.join(codexHome, 'config.toml');
  const apiKey = 'secret-plugin-key';

  try {
    fs.mkdirSync(codexHome, { recursive: true });
    fs.writeFileSync(
      configPath,
      [
        '[marketplaces.med-autoscience-local]',
        'source_type = "local"',
        'source = "/Users/test/med-autoscience"',
        '',
        '[plugins."med-autoscience@med-autoscience-local"]',
        'enabled = true',
        '',
      ].join('\n'),
      'utf8',
    );

    const output = runCliWithStdin(
      ['system', 'configure-codex', '--api-key-stdin'],
      `${apiKey}\n`,
      {
        HOME: homeRoot,
        CODEX_HOME: codexHome,
        OPL_STATE_DIR: path.join(homeRoot, 'opl-state'),
      },
    ) as {
      codex_config: {
        status: string;
        bootstrap: {
          model: string;
          reasoning_effort: string;
          provider_base_url: string;
          api_key_present: boolean;
        };
      };
    };

    assert.equal(output.codex_config.status, 'completed');
    assert.equal(output.codex_config.bootstrap.provider_base_url, 'https://gateway.medopl.com/v1');
    assert.equal(output.codex_config.bootstrap.api_key_present, true);
    assert.equal(JSON.stringify(output).includes(apiKey), false);

    const config = fs.readFileSync(configPath, 'utf8');
    assert.match(config, /model_provider = "oplgateway"/);
    assertBundledCodexModel(output.codex_config.bootstrap, config);
    assert.match(config, /base_url = "https:\/\/gateway\.medopl\.com\/v1"/);
    assert.match(config, /experimental_bearer_token = "secret-plugin-key"/);
    assert.match(config, /\[marketplaces\.med-autoscience-local\]/);
    assert.match(config, /\[plugins\."med-autoscience@med-autoscience-local"\]/);
  } finally {
    fs.rmSync(homeRoot, { recursive: true, force: true });
  }
});

test('system configure-codex does not sync packaged Full companion skills', () => {
  const homeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'opl-configure-codex-full-skills-home-'));
  const runtimeHome = path.join(homeRoot, 'Library', 'Application Support', 'OPL', 'runtime', 'current');
  const packagedSkillsRoot = path.join(runtimeHome, 'skills');
  const toolBin = path.join(runtimeHome, 'bin');
  const codexHome = path.join(homeRoot, 'codex-home');

  try {
    for (const skillId of [
      'officecli',
      'officecli-docx',
      'officecli-pptx',
      'officecli-xlsx',
      'officecli-academic-paper',
      'officecli-data-dashboard',
      'officecli-financial-model',
      'officecli-pitch-deck',
      'ui-ux-pro-max',
      'mineru-document-extractor',
    ]) {
      fs.mkdirSync(path.join(packagedSkillsRoot, skillId), { recursive: true });
      fs.writeFileSync(
        path.join(packagedSkillsRoot, skillId, 'SKILL.md'),
        `---\nname: ${skillId}\ndescription: packaged ${skillId}\n---\n\n# ${skillId}\n`,
        'utf8',
      );
    }
    fs.mkdirSync(toolBin, { recursive: true });
    fs.writeFileSync(
      path.join(toolBin, 'officecli'),
      '#!/usr/bin/env bash\nif [ "${1:-}" = "--version" ]; then echo "1.0.70-test"; else echo officecli; fi\n',
      { mode: 0o755 },
    );
    fs.writeFileSync(
      path.join(toolBin, 'mineru-open-api'),
      '#!/usr/bin/env bash\nif [ "${1:-}" = "version" ]; then echo "mineru-open-api version v0.1.3-test"; else echo mineru-open-api; fi\n',
      { mode: 0o755 },
    );

    const output = runCliWithStdin(
      ['system', 'configure-codex', '--api-key-stdin'],
      'secret-full-key\n',
      {
        HOME: homeRoot,
        CODEX_HOME: codexHome,
        OPL_STATE_DIR: path.join(homeRoot, 'opl-state'),
        OPL_FULL_RUNTIME_HOME: runtimeHome,
        OPL_PACKAGED_SKILLS_ROOT: packagedSkillsRoot,
        OPL_COMPANION_DISABLE_REMOTE_INSTALL: '1',
        PATH: `${toolBin}:/usr/bin:/bin`,
      },
    ) as any;

    assert.equal(output.codex_config.status, 'completed');
    assert.equal(Object.hasOwn(output.codex_config, 'companion_skill_sync'), false);
    for (const skillId of [
      'officecli',
      'officecli-docx',
      'officecli-pptx',
      'officecli-xlsx',
      'officecli-academic-paper',
      'officecli-data-dashboard',
      'officecli-financial-model',
      'officecli-pitch-deck',
      'ui-ux-pro-max',
      'mineru-document-extractor',
    ]) {
      assert.equal(fs.existsSync(path.join(codexHome, 'skills', skillId, 'SKILL.md')), false);
    }
  } finally {
    fs.rmSync(homeRoot, { recursive: true, force: true });
  }
});
