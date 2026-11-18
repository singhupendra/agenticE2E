import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { isRole, ROLES, type Role } from './roles.js';

/**
 * SPEC-014: API tokens. Only SHA-256 hashes are stored (tokens are 256-bit random, so a fast hash is sufficient and
 * standard practice). Errors and logs never include a token or a hash.
 */
export const TOKEN_PREFIX = 'ae2e_';
export const TOKEN_RE = /^ae2e_[A-Za-z0-9_-]{43}$/;
const HASH_RE = /^sha256:[0-9a-f]{64}$/;
export const TOKEN_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export class TokenError extends Error { constructor(message: string) { super(message); this.name = 'TokenError'; } }

export interface TokenEntry { name: string; role: Role; hash: string }
export interface Principal { name: string; role: Role }

export function generateToken(): string { return TOKEN_PREFIX + randomBytes(32).toString('base64url'); }
export function hashToken(token: string): string { return 'sha256:' + createHash('sha256').update(token, 'utf8').digest('hex'); }

function validateEntry(raw: unknown, where: string): TokenEntry {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new TokenError(`${where}: each token must be an object { name, role, hash }`);
  const { name, role, hash, ...rest } = raw as Record<string, unknown>;
  if (typeof name !== 'string' || !TOKEN_NAME_RE.test(name)) throw new TokenError(`${where}: invalid token name (letters, digits, . _ -; max 64)`);
  const label = `${where} token "${name}"`;
  if (Object.keys(rest).length) throw new TokenError(`${label}: unknown field(s) ${Object.keys(rest).join(', ')}`);
  if (!isRole(role)) throw new TokenError(`${label}: role must be one of ${ROLES.join(', ')}`);
  if (typeof hash !== 'string') throw new TokenError(`${label}: hash is required (sha256:<64 hex>)`);
  if (hash.startsWith(TOKEN_PREFIX)) throw new TokenError(`${label}: looks like a raw token; store only its hash (run \`agentic-e2e token hash\` and paste the output), and treat the exposed token as compromised`);
  if (!HASH_RE.test(hash)) throw new TokenError(`${label}: hash must look like sha256:<64 lowercase hex chars>`);
  return { name, role, hash };
}

function checkUnique(entries: TokenEntry[], where: string): TokenEntry[] {
  const names = new Set<string>(), hashes = new Set<string>();
  for (const e of entries) {
    if (names.has(e.name)) throw new TokenError(`${where}: duplicate token name "${e.name}"`);
    if (hashes.has(e.hash)) throw new TokenError(`${where}: token "${e.name}" has the same token as another entry`);
    names.add(e.name); hashes.add(e.hash);
  }
  return entries;
}

/** `AGENTIC_E2E_API_TOKENS="name:role:sha256:<hex>,…"` */
export function parseTokenEnv(value: string | undefined, where = 'AGENTIC_E2E_API_TOKENS'): TokenEntry[] {
  const items = (value ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  return checkUnique(items.map((item, i) => {
    const [name, role, ...hashParts] = item.split(':');
    return validateEntry({ name, role, hash: hashParts.join(':') }, `${where}[${i}]`);
  }), where);
}

/** `{ "tokens": [{ "name", "role", "hash" }] }` */
export function parseTokensFile(data: unknown, where: string): TokenEntry[] {
  const tokens = (data as { tokens?: unknown } | null)?.tokens;
  if (!data || typeof data !== 'object' || Array.isArray(data) || !Array.isArray(tokens)) throw new TokenError(`${where} must be a JSON object { "tokens": [ { "name", "role", "hash" } ] }`);
  const extra = Object.keys(data).filter((k) => k !== 'tokens');
  if (extra.length) throw new TokenError(`${where}: unknown key(s) ${extra.join(', ')}`);
  return checkUnique(tokens.map((t, i) => validateEntry(t, `${where}[${i}]`)), where);
}

export function readTokensFileRaw(file: string): unknown {
  if (!fs.existsSync(file)) throw new TokenError(`API tokens file not found: ${file}`);
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { throw new TokenError(`${file} is not valid JSON`); }
}

export function loadTokensFile(file: string, opts: { onWarn?: (m: string) => void } = {}): TokenEntry[] {
  const abs = path.resolve(file);
  const data = readTokensFileRaw(abs);
  if (process.platform !== 'win32' && (fs.statSync(abs).mode & 0o077) !== 0) {
    opts.onWarn?.(`The API tokens file is readable by other users; run chmod 600 on it (${path.basename(abs)})`);
  }
  return parseTokensFile(data, path.basename(abs));
}

export class TokenRegistry {
  private readonly entries: { name: string; role: Role; digest: Buffer }[];
  constructor(entries: TokenEntry[]) {
    this.entries = checkUnique(entries, 'API tokens').map((e) => ({ name: e.name, role: e.role, digest: Buffer.from(e.hash.slice('sha256:'.length), 'hex') }));
  }
  get size() { return this.entries.length; }

  static fromSources(opts: { file?: string; env?: string; onWarn?: (m: string) => void }): TokenRegistry {
    return new TokenRegistry([...parseTokenEnv(opts.env), ...(opts.file ? loadTokensFile(opts.file, { onWarn: opts.onWarn }) : [])]);
  }

  /** Constant work per entry; never throws on garbage input. */
  verify(token: string | undefined | null): Principal | null {
    if (typeof token !== 'string' || token.length === 0 || token.length > 512) return null;
    const digest = createHash('sha256').update(token, 'utf8').digest();
    let found: Principal | null = null;
    for (const e of this.entries) if (timingSafeEqual(digest, e.digest) && !found) found = { name: e.name, role: e.role };
    return found;
  }
}
