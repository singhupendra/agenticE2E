import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { FIXTURE_PASSWORD, FIXTURE_USER } from './fixture-site.js';

/** Write a credentials file (mode 0600) in a fresh temp dir; returns its path. */
export function writeCreds(content: unknown, opts: { mode?: number; dir?: string; name?: string } = {}): string {
  const dir = opts.dir ?? fs.mkdtempSync(path.join(os.tmpdir(), 'creds-'));
  const file = path.join(dir, opts.name ?? 'credentials.json');
  fs.writeFileSync(file, typeof content === 'string' ? content : JSON.stringify(content, null, 2), { mode: opts.mode ?? 0o600 });
  fs.chmodSync(file, opts.mode ?? 0o600);
  return file;
}

/** A credentials document for the fixture site (keyed by its host:port). */
export function fixtureCreds(host: string, extra: Record<string, unknown> = {}) {
  return {
    [host]: {
      users: { member: { username: FIXTURE_USER, password: FIXTURE_PASSWORD, pin: '48151623' } },
      login: { loginUrl: '/login', usernameSelector: 'input[name=email]', passwordSelector: 'input[name=password]', submitSelector: 'button[type=submit]', checkUrl: '/account', successUrl: '/account' },
      ...extra,
    },
  };
}
