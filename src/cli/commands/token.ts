import fs from 'node:fs';
import path from 'node:path';
import type { Command } from 'commander';
import { isRole, ROLES } from '../../core/security/roles.js';
import {
  generateToken,
  hashToken,
  parseTokensFile,
  readTokensFileRaw,
  TOKEN_NAME_RE,
  TokenError,
  type TokenEntry,
} from '../../core/security/tokens.js';

function readEntries(file: string): TokenEntry[] {
  return fs.existsSync(file) ? parseTokensFile(readTokensFileRaw(file), path.basename(file)) : [];
}
function writeEntries(file: string, entries: TokenEntry[]) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ tokens: entries }, null, 2) + '\n', { mode: 0o600 });
  fs.renameSync(tmp, file);
  fs.chmodSync(file, 0o600);
}

/** SPEC-014 FR-1: create / hash / list API tokens. Raw tokens are printed once and never stored. */
export function registerTokenCommands(program: Command) {
  const tok = program.command('token').description('manage API tokens for `serve` (only hashes are stored)');

  tok
    .command('create')
    .description('create a token; prints it once (store it in your password manager / CI secret)')
    .requiredOption('--name <name>', 'who/what uses the token, e.g. ci or alice')
    .requiredOption('--role <role>', `one of ${ROLES.join(', ')}`)
    .option('--file <tokens.json>', 'append the hashed entry to this tokens file (created 0600)')
    .action((o: { name: string; role: string; file?: string }) => {
      if (!TOKEN_NAME_RE.test(o.name)) throw new TokenError('--name: letters, digits, . _ - (max 64)');
      if (!isRole(o.role)) throw new TokenError(`--role must be one of ${ROLES.join(', ')}`);
      const token = generateToken();
      const entry: TokenEntry = { name: o.name, role: o.role, hash: hashToken(token) };
      if (o.file) {
        const file = path.resolve(o.file);
        const entries = readEntries(file);
        if (entries.some((e) => e.name === o.name))
          throw new TokenError(
            `A token named "${o.name}" already exists in ${path.basename(file)}; remove it first to rotate`,
          );
        writeEntries(file, [...entries, entry]);
        console.log(`Added token "${o.name}" (${o.role}) to ${file}`);
      } else {
        console.log('Add this to the server environment (hash only; safe to store):');
        console.log(`  AGENTIC_E2E_API_TOKENS=${o.name}:${o.role}:${entry.hash}`);
        console.log('  (separate several entries with commas)');
      }
      console.log(
        `\nToken (shown once; send it as "Authorization: Bearer <token>" or paste it into the web UI):\n  ${token}`,
      );
    });

  tok
    .command('hash')
    .description('read a token on stdin and print its hash (for AGENTIC_E2E_API_TOKENS / a tokens file)')
    .action(async () => {
      const chunks: Buffer[] = [];
      for await (const c of process.stdin) chunks.push(Buffer.from(c as Buffer));
      const token = Buffer.concat(chunks).toString('utf8').trim();
      if (!token) throw new TokenError('no token on stdin');
      console.log(hashToken(token));
    });

  tok
    .command('list')
    .description('list token names and roles in a tokens file (never hashes)')
    .requiredOption('--file <tokens.json>', 'tokens file')
    .action((o: { file: string }) => {
      const entries = readEntries(path.resolve(o.file));
      if (!entries.length) return console.log('No tokens.');
      const w = Math.max(...entries.map((e) => e.name.length));
      for (const e of entries) console.log(`${e.name.padEnd(w)}  ${e.role}`);
    });
}
