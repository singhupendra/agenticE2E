import path from 'node:path';
import type { Command } from 'commander';
import { findConfigFile, loadConfig } from '../../core/config.js';
import { ConfigError } from '../../core/config-check.js';

/** SPEC-014 FR-19: `config validate` / `config show`. */
export function registerConfigCommands(program: Command, setExit: (code: number) => void) {
  const cfg = program.command('config').description('validate or print the effective configuration (file + env + defaults)');

  cfg.command('validate').description('check the config file strictly (unknown keys, types, ranges) and exit non-zero on problems')
    .option('--config <file>', 'path to agentic-e2e.config.(ts|js|json)')
    .action(async (o: { config?: string }) => {
      const file = findConfigFile(process.cwd(), o.config);
      try {
        await loadConfig({ configFile: o.config });
        console.log(`Configuration OK (${file ? path.basename(file) : 'no config file; defaults + environment'})`);
      } catch (e) {
        if (!(e instanceof ConfigError)) throw e;
        console.error(`${e.issues.length} configuration problem${e.issues.length === 1 ? '' : 's'}${file ? ` in ${path.basename(file)}` : ''}:`);
        for (const i of e.issues) console.error(`  - ${i}`);
        setExit(1);
      }
    });

  cfg.command('show').description('print the effective configuration as JSON (secret-bearing fields elided)')
    .option('--config <file>', 'path to agentic-e2e.config.(ts|js|json)')
    .action(async (o: { config?: string }) => {
      const c = await loadConfig({ configFile: o.config });
      const shown = {
        ...c,
        ...(c.credentialsFile ? { credentialsFile: '(set)' } : {}),
        server: { ...c.server, ...(c.server.tokensFile ? { tokensFile: '(set)' } : {}), ...(process.env.AGENTIC_E2E_API_TOKENS ? { tokensEnv: '(set)' } : {}) },
      };
      console.log(JSON.stringify(shown, null, 2));
    });
}
