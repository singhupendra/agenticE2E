import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CredentialsError, loadCredentials } from '../src/core/credentials.js';
import { resolveConfig } from '../src/core/config.js';
import { writeCreds } from './helpers/credentials.js';

const DOC = {
  'shop.example.com': {
    users: { alice: { username: 'alice@x.test', password: 'pw-alice-123', otp: '999111' }, bob: { username: 'bob@x.test', password: 'pw-bob-456' } },
    login: { loginUrl: '/signin', successText: 'Dashboard' },
  },
  'http://localhost:3000': { users: { solo: { username: 'u', password: 'only-pass' } }, defaultUser: 'solo' },
};

describe('credentials loading (SPEC-009)', () => {
  it('AC-1: lists user names only and resolves a user', () => {
    const c = loadCredentials({ file: writeCreds(DOC), explicit: true });
    expect(c.configured).toBe(true);
    expect(c.userNames('shop.example.com')).toEqual(['alice', 'bob']);
    expect(c.hasSite('shop.example.com')).toBe(true);
    const u = c.getUser('shop.example.com', 'alice');
    expect(u).toMatchObject({ name: 'alice', username: 'alice@x.test', password: 'pw-alice-123', fields: { otp: '999111' } });
    expect(c.loginHints('shop.example.com')).toMatchObject({ loginUrl: '/signin', successText: 'Dashboard' });
  });

  it('normalises site keys like storage (URL, host:port, case)', () => {
    const c = loadCredentials({ file: writeCreds(DOC), explicit: true });
    expect(c.hasSite('localhost_3000')).toBe(true);
    expect(c.userNames('localhost_3000')).toEqual(['solo']);
    expect(loadCredentials({ file: writeCreds({ 'HTTPS://Shop.Example.COM/': { users: { a: { username: 'u1', password: 'p1pp' } } } }), explicit: true }).hasSite('shop.example.com')).toBe(true);
  });

  it('AC-2: ${ENV_VAR} interpolation from env; unset var errors naming the variable only', () => {
    const file = writeCreds({ 'a.test': { users: { u: { username: '${E2E_T_USER}', password: '${E2E_T_PW}' } } } });
    const c = loadCredentials({ file, explicit: true, env: { E2E_T_USER: 'env-user', E2E_T_PW: 'env-secret-pw' } });
    expect(c.getUser('a.test', 'u')).toMatchObject({ username: 'env-user', password: 'env-secret-pw' });
    let msg = '';
    try { loadCredentials({ file, explicit: true, env: { E2E_T_USER: 'env-user' } }); } catch (e) { msg = (e as Error).message; }
    expect(msg).toContain('E2E_T_PW');
    expect(msg).not.toContain('env-user');
  });

  it('AC-3: unknown site / unknown user / ambiguous user give clear errors with names only', () => {
    const c = loadCredentials({ file: writeCreds(DOC), explicit: true });
    expect(() => c.getUser('nope.test')).toThrow(/no credentials.*nope\.test/i);
    expect(() => c.getUser('shop.example.com', 'carol')).toThrow(/unknown user.*carol.*alice, bob/i);
    expect(() => c.getUser('shop.example.com')).toThrow(/several users.*alice, bob.*--user/i);
    expect(c.getUser('localhost_3000').name).toBe('solo'); // defaultUser / only user
    for (const call of [() => c.getUser('shop.example.com', 'carol'), () => c.getUser('shop.example.com')]) {
      try { call(); } catch (e) { expect((e as Error).message).not.toMatch(/pw-alice|pw-bob|alice@x/); }
    }
  });

  it('rejects malformed files without echoing values', () => {
    expect(() => loadCredentials({ file: writeCreds('{ not json pw-secret-zzz'), explicit: true })).toThrow(CredentialsError);
    try { loadCredentials({ file: writeCreds({ 'a.test': { users: { u: { username: 'x' } } } }), explicit: true }); } catch (e) { expect((e as Error).message).toMatch(/password/); }
    try { loadCredentials({ file: writeCreds('{ not json pw-secret-zzz'), explicit: true }); } catch (e) { expect((e as Error).message).not.toContain('pw-secret-zzz'); }
  });

  it('AC-4: refuses a credentials file tracked by git; allows untracked and outside-repo files', () => {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'creds-repo-'));
    execFileSync('git', ['init', '-q'], { cwd: repo });
    const tracked = writeCreds(DOC, { dir: repo });
    execFileSync('git', ['add', 'credentials.json'], { cwd: repo });
    let err: unknown;
    try { loadCredentials({ file: tracked, explicit: true }); } catch (e) { err = e; }
    expect(err).toBeInstanceOf(CredentialsError);
    expect((err as Error).message).toMatch(/tracked by git/);
    expect((err as Error).message).toContain('git rm --cached');
    const untracked = writeCreds(DOC, { dir: repo, name: 'other.json' });
    expect(loadCredentials({ file: untracked, explicit: true }).configured).toBe(true);
    expect(loadCredentials({ file: writeCreds(DOC), explicit: true }).configured).toBe(true); // outside any repo
  });

  it('AC-5: warns when permissions are broader than 0600, not otherwise', () => {
    const warns: string[] = [];
    loadCredentials({ file: writeCreds(DOC, { mode: 0o644 }), explicit: true, onWarn: (m) => warns.push(m) });
    expect(warns.join('\n')).toMatch(/chmod 600/);
    expect(warns.join('\n')).not.toMatch(/pw-alice/);
    const quiet: string[] = [];
    loadCredentials({ file: writeCreds(DOC, { mode: 0o600 }), explicit: true, onWarn: (m) => quiet.push(m) });
    expect(quiet).toEqual([]);
  });

  it('AC-6: missing default file = not configured; missing explicit file = error', () => {
    const missing = path.join(os.tmpdir(), 'definitely-missing-creds.json');
    const c = loadCredentials({ file: missing, explicit: false });
    expect(c.configured).toBe(false);
    expect(c.userNames('a.test')).toEqual([]);
    expect(() => loadCredentials({ file: missing, explicit: true })).toThrow(/not found/i);
  });

  it('AC-6: config precedence CLI > env > config file; resolved against cwd', () => {
    const cwd = '/work';
    expect(resolveConfig({ cwd }).credentialsFile).toBeUndefined();
    expect(resolveConfig({ cwd, file: { credentialsFile: 'f.json' } }).credentialsFile).toBe('/work/f.json');
    expect(resolveConfig({ cwd, file: { credentialsFile: 'f.json' }, env: { AGENTIC_E2E_CREDENTIALS: 'e.json' } }).credentialsFile).toBe('/work/e.json');
    expect(resolveConfig({ cwd, file: { credentialsFile: 'f.json' }, env: { AGENTIC_E2E_CREDENTIALS: 'e.json' }, cli: { credentialsFile: 'c.json' } }).credentialsFile).toBe('/work/c.json');
    expect(resolveConfig({ cwd }).auth).toBe(false);
    expect(resolveConfig({ cwd, cli: { auth: true, authUser: 'alice' } })).toMatchObject({ auth: true, authUser: 'alice' });
  });

  it('exposes every secret value (all sites, all fields) with placeholders for the redactor', () => {
    const c = loadCredentials({ file: writeCreds(DOC), explicit: true });
    const vals = c.secretEntries();
    expect(vals).toEqual(expect.arrayContaining([
      { value: 'pw-alice-123', placeholder: '{{password}}' },
      { value: 'alice@x.test', placeholder: '{{username}}' },
      { value: '999111', placeholder: '{{otp}}' },
      { value: 'only-pass', placeholder: '{{password}}' },
    ]));
  });
});
