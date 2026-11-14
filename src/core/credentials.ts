import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import type { SecretEntry } from './redact.js';
import { normalizeSite } from './storage.js';

export const DEFAULT_CREDENTIALS_FILE = '.agentic-e2e/credentials.json';
export const AUTH_USER_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export class CredentialsError extends Error {
  readonly statusCode = 400;
  constructor(message: string) { super(message); this.name = 'CredentialsError'; }
}

const loginHintsSchema = z.object({
  loginUrl: z.string().optional(),
  usernameSelector: z.string().optional(),
  passwordSelector: z.string().optional(),
  submitSelector: z.string().optional(),
  /** substring or /regex/ the URL must match after login */
  successUrl: z.string().optional(),
  /** text that must be visible after login */
  successText: z.string().optional(),
  /** a protected page used to check that a stored session is still valid */
  checkUrl: z.string().optional(),
}).strict();
export type LoginHints = z.infer<typeof loginHintsSchema>;

const userSchema = z.object({ username: z.string().min(1), password: z.string().min(1) }).catchall(z.string());
const siteSchema = z.object({
  users: z.record(z.string(), userSchema).refine((u) => Object.keys(u).length > 0, 'needs at least one user'),
  login: loginHintsSchema.optional(),
  defaultUser: z.string().optional(),
}).strict();

export interface ResolvedUser { name: string; username: string; password: string; fields: Record<string, string> }

/** Replace ${VAR} in every string. Never includes a value in an error. */
function interpolate(value: unknown, env: Record<string, string | undefined>, where: string): unknown {
  if (typeof value === 'string') {
    return value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_m, name: string) => {
      const v = env[name];
      if (v === undefined || v === '') throw new CredentialsError(`Environment variable ${name} (used at ${where}) is not set`);
      return v;
    });
  }
  if (Array.isArray(value)) return value.map((v, i) => interpolate(v, env, `${where}[${i}]`));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, interpolate(v, env, `${where}.${k}`)]));
  return value;
}

function siteKey(key: string): string {
  try {
    return normalizeSite(/^[a-z]+:\/\//i.test(key) ? key : `http://${key}`).id;
  } catch {
    throw new CredentialsError(`Invalid site key ${JSON.stringify(key)} in the credentials file (use a host, host:port or URL)`);
  }
}

export class CredentialStore {
  constructor(public readonly file: string, public readonly configured: boolean, private sites: Map<string, z.infer<typeof siteSchema>>) {}
  static empty(file = DEFAULT_CREDENTIALS_FILE): CredentialStore { return new CredentialStore(file, false, new Map()); }

  private site(site: string) { return this.sites.get(site); }
  hasSite(site: string): boolean { return this.sites.has(site); }
  userNames(site: string): string[] { return Object.keys(this.site(site)?.users ?? {}); }
  loginHints(site: string): LoginHints { return this.site(site)?.login ?? {}; }

  /** Select a user: explicit name, else defaultUser, else the only user. */
  getUser(site: string, name?: string): ResolvedUser {
    const s = this.site(site);
    if (!s) throw new CredentialsError(`No credentials for site ${site} in ${this.configured ? this.file : 'the credentials file (none found)'}`);
    const names = Object.keys(s.users);
    const pick = name ?? s.defaultUser ?? (names.length === 1 ? names[0] : undefined);
    if (!pick) throw new CredentialsError(`Site ${site} has several users (${names.join(', ')}); choose one with --user <name> or set "defaultUser"`);
    const u = s.users[pick];
    if (!u) throw new CredentialsError(`Unknown user "${pick}" for site ${site}. Known users: ${names.join(', ')}`);
    const { username, password, ...fields } = u;
    return { name: pick, username, password, fields };
  }

  /** Every secret value of every site/user with the placeholder that replaces it in prompts and stored data. */
  secretEntries(): SecretEntry[] {
    const out: SecretEntry[] = [];
    for (const s of this.sites.values()) {
      for (const u of Object.values(s.users)) {
        for (const [k, v] of Object.entries(u)) out.push({ value: v, placeholder: `{{${k}}}` });
      }
    }
    return out;
  }
}

function trackedByGit(file: string): boolean {
  const r = spawnSync('git', ['ls-files', '--error-unmatch', '--', path.basename(file)], { cwd: path.dirname(file), stdio: 'ignore' });
  return r.status === 0; // 1 = untracked, 128 = not a repo (or git missing): both fine
}

export interface LoadOptions {
  file: string;
  /** true when the path was given by the user (a missing file is then an error) */
  explicit?: boolean;
  env?: Record<string, string | undefined>;
  onWarn?: (message: string) => void;
}

export function loadCredentials(opts: LoadOptions): CredentialStore {
  const file = path.resolve(opts.file);
  if (!fs.existsSync(file)) {
    if (opts.explicit) throw new CredentialsError(`Credentials file not found: ${file}`);
    return CredentialStore.empty(file);
  }
  if (trackedByGit(file)) {
    throw new CredentialsError(`Refusing to use ${file}: it is tracked by git, so its secrets are (or were) in version control. Run \`git rm --cached ${path.basename(file)}\`, add it to .gitignore, and rotate the credentials it contains.`);
  }
  if (process.platform !== 'win32' && (fs.statSync(file).mode & 0o077) !== 0) {
    opts.onWarn?.(`${file} is readable by other users; run: chmod 600 ${JSON.stringify(file)}`);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    throw new CredentialsError(`${file} is not valid JSON`); // the parser message can quote file content
  }
  const interpolated = interpolate(raw, opts.env ?? process.env, path.basename(file));
  if (!interpolated || typeof interpolated !== 'object' || Array.isArray(interpolated)) throw new CredentialsError(`${file} must be a JSON object keyed by site`);
  const sites = new Map<string, z.infer<typeof siteSchema>>();
  for (const [key, value] of Object.entries(interpolated)) {
    const parsed = siteSchema.safeParse(value);
    if (!parsed.success) {
      // zod issue messages never include the offending value; paths + messages only.
      throw new CredentialsError(`Invalid credentials for "${key}": ${parsed.error.issues.map((i) => `${i.path.join('.') || '(site)'}: ${i.message}`).join('; ')}`);
    }
    for (const n of Object.keys(parsed.data.users)) if (!AUTH_USER_RE.test(n)) throw new CredentialsError(`Invalid user name ${JSON.stringify(n)} for "${key}" (letters, digits, . _ -)`);
    sites.set(siteKey(key), parsed.data);
  }
  return new CredentialStore(file, true, sites);
}
