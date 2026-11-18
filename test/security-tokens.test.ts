import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { generateToken, hashToken, parseTokenEnv, parseTokensFile, loadTokensFile, TokenRegistry, TokenError } from '../src/core/security/tokens.js';
import { roleAtLeast, ROLES } from '../src/core/security/roles.js';

describe('SPEC-014 tokens', () => {
  it('AC-1: generates distinct, well-formed tokens and sha256 hashes', () => {
    const a = generateToken(), b = generateToken();
    expect(a).toMatch(/^ae2e_[A-Za-z0-9_-]{43}$/);
    expect(a).not.toBe(b);
    expect(hashToken(a)).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(hashToken(a)).toBe(hashToken(a));
  });

  it('AC-2: verifies the right token and rejects wrong/empty ones', () => {
    const t = generateToken();
    const reg = new TokenRegistry([{ name: 'ci', role: 'operator', hash: hashToken(t) }]);
    expect(reg.verify(t)).toEqual({ name: 'ci', role: 'operator' });
    expect(reg.verify(generateToken())).toBeNull();
    expect(reg.verify('')).toBeNull();
    expect(reg.verify(undefined)).toBeNull();
    expect(reg.size).toBe(1);
  });

  it('parses env entries name:role:sha256:hex, comma separated', () => {
    const t1 = generateToken(), t2 = generateToken();
    const entries = parseTokenEnv(` ci:operator:${hashToken(t1)} , alice:admin:${hashToken(t2)} `);
    expect(entries.map((e) => [e.name, e.role])).toEqual([['ci', 'operator'], ['alice', 'admin']]);
    expect(parseTokenEnv('')).toEqual([]);
  });

  it('AC-3: rejects raw tokens with a hint and never echoes them', () => {
    const t = generateToken();
    let err: Error | undefined;
    try { parseTokenEnv(`ci:operator:${t}`); } catch (e) { err = e as Error; }
    expect(err).toBeInstanceOf(TokenError);
    expect(err!.message).toMatch(/token hash/);
    expect(err!.message).not.toContain(t);
    expect(() => parseTokensFile({ tokens: [{ name: 'ci', role: 'viewer', hash: t }] }, 'tokens.json')).toThrow(/token hash/);
  });

  it('AC-4: helpful errors for bad role, bad hash, duplicates — naming the entry, not the hash', () => {
    const h = hashToken(generateToken());
    expect(() => parseTokensFile({ tokens: [{ name: 'ci', role: 'root', hash: h }] }, 'tokens.json')).toThrow(/ci.*role.*viewer, operator, admin/s);
    expect(() => parseTokensFile({ tokens: [{ name: 'ci', role: 'viewer', hash: 'sha256:xyz' }] }, 'tokens.json')).toThrow(/ci.*hash/s);
    expect(() => parseTokensFile({ tokens: [{ name: 'ci', role: 'viewer', hash: h }, { name: 'ci', role: 'admin', hash: hashToken(generateToken()) }] }, 'tokens.json')).toThrow(/duplicate.*ci/i);
    expect(() => parseTokensFile({ tokens: [{ name: 'a', role: 'viewer', hash: h }, { name: 'b', role: 'admin', hash: h }] }, 'tokens.json')).toThrow(/same token/i);
    expect(() => parseTokensFile({ tokens: [{ name: 'bad name', role: 'viewer', hash: h }] }, 'tokens.json')).toThrow(/name/);
    expect(() => parseTokensFile({ nope: 1 }, 'tokens.json')).toThrow(/tokens\.json/);
    try { parseTokensFile({ tokens: [{ name: 'ci', role: 'root', hash: h }] }, 'tokens.json'); } catch (e) { expect((e as Error).message).not.toContain(h); }
  });

  it('AC-5: warns when the tokens file is group/other readable; missing file is an error', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tok-'));
    const f = path.join(dir, 'tokens.json');
    fs.writeFileSync(f, JSON.stringify({ tokens: [{ name: 'ci', role: 'viewer', hash: hashToken(generateToken()) }] }));
    fs.chmodSync(f, 0o644);
    const warns: string[] = [];
    expect(loadTokensFile(f, { onWarn: (m) => warns.push(m) })).toHaveLength(1);
    expect(warns.join()).toMatch(/chmod 600/);
    expect(() => loadTokensFile(path.join(dir, 'missing.json'))).toThrow(TokenError);
    fs.writeFileSync(f, '{not json');
    expect(() => loadTokensFile(f)).toThrow(/not valid JSON/);
  });

  it('fromSources merges env and file and detects cross-source duplicates', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tok-'));
    const f = path.join(dir, 'tokens.json');
    const t1 = generateToken(), t2 = generateToken();
    fs.writeFileSync(f, JSON.stringify({ tokens: [{ name: 'file', role: 'viewer', hash: hashToken(t1) }] }), { mode: 0o600 });
    const reg = TokenRegistry.fromSources({ file: f, env: `envtok:admin:${hashToken(t2)}` });
    expect(reg.size).toBe(2);
    expect(reg.verify(t1)?.name).toBe('file');
    expect(reg.verify(t2)?.role).toBe('admin');
    expect(TokenRegistry.fromSources({}).size).toBe(0);
    expect(() => TokenRegistry.fromSources({ file: f, env: `file:admin:${hashToken(t2)}` })).toThrow(/duplicate/i);
  });

  it('roles are ordered viewer < operator < admin', () => {
    expect(ROLES).toEqual(['viewer', 'operator', 'admin']);
    expect(roleAtLeast('admin', 'operator')).toBe(true);
    expect(roleAtLeast('operator', 'operator')).toBe(true);
    expect(roleAtLeast('viewer', 'operator')).toBe(false);
  });
});
