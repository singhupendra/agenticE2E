import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Redactor } from '../redact.js';
import type { Journey } from '../types.js';

export const AUDIT_FILE = 'audit.jsonl';
export type AuditAction = 'discover' | 'generate' | 'heal.patch_applied' | 'journeys.status_changed' | (string & {});

export interface AuditEntry {
  at: string;
  actor: string;
  action: AuditAction;
  site?: string;
  correlationId?: string;
  details: Record<string, unknown>;
  /** hash of the previous entry (64 zeros for the first) */
  prev: string;
  /** sha256(prev + canonical entry without `hash`) */
  hash: string;
}

const GENESIS = '0'.repeat(64);
const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');
const entryHash = (e: Omit<AuditEntry, 'hash'>) => sha256(e.prev + JSON.stringify([e.at, e.actor, e.action, e.site ?? null, e.correlationId ?? null, e.details]));

/** `cli:<os user>`; never throws (os.userInfo can fail in odd containers). */
export function cliActor(): string {
  try { return `cli:${os.userInfo().username}`; } catch { return 'cli:unknown'; }
}

function lastHash(file: string): string {
  if (!fs.existsSync(file)) return GENESIS;
  const size = fs.statSync(file).size;
  if (!size) return GENESIS;
  const fd = fs.openSync(file, 'r');
  try {
    // Entries are small; read a tail window large enough to hold the last full line.
    for (let win = 8192; ; win *= 4) {
      const len = Math.min(size, win);
      const buf = Buffer.alloc(len);
      fs.readSync(fd, buf, 0, len, size - len);
      const lines = buf.toString('utf8').trimEnd().split('\n');
      if (lines.length > 1 || len === size) return (JSON.parse(lines.at(-1)!) as AuditEntry).hash;
    }
  } finally {
    fs.closeSync(fd);
  }
}

/** SPEC-013 FR-23..25: append-only, hash-chained audit log at `<dataDir>/audit.jsonl`. */
export class AuditLog {
  readonly file: string;
  private readonly actor: string;
  private readonly correlationId?: string;
  private readonly redactor: Redactor;
  constructor(opts: { file: string; actor: string; correlationId?: string; redactor?: Redactor }) {
    this.file = opts.file;
    this.actor = opts.actor;
    this.correlationId = opts.correlationId;
    this.redactor = opts.redactor ?? Redactor.empty();
  }

  append(action: AuditAction, o: { site?: string; details?: Record<string, unknown>; actor?: string } = {}): AuditEntry {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const base: Omit<AuditEntry, 'hash'> = this.redactor.redactDeep({
      at: new Date().toISOString(), actor: o.actor ?? this.actor, action, ...(o.site ? { site: o.site } : {}),
      ...(this.correlationId ? { correlationId: this.correlationId } : {}), details: o.details ?? {}, prev: lastHash(this.file),
    });
    const entry: AuditEntry = { ...base, hash: entryHash(base) };
    fs.appendFileSync(this.file, JSON.stringify(entry) + '\n', { flag: 'a' });
    return entry;
  }
}

function parseLines(file: string): AuditEntry[] {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l) as AuditEntry);
}

/** Entries oldest-first, optionally for one site; `limit` keeps the newest n. */
export function readAuditLog(file: string, o: { site?: string; limit?: number } = {}): AuditEntry[] {
  let entries = parseLines(file);
  if (o.site) entries = entries.filter((e) => e.site === o.site);
  return o.limit ? entries.slice(-o.limit) : entries;
}

/** Recomputes the chain. `brokenAt` is the 1-based line of the first entry that does not verify. */
export function verifyAuditLog(file: string): { ok: boolean; entries: number; brokenAt?: number; reason?: string } {
  if (!fs.existsSync(file)) return { ok: true, entries: 0 };
  const lines = fs.readFileSync(file, 'utf8').split('\n').filter((l) => l.trim());
  let prev = GENESIS;
  for (let i = 0; i < lines.length; i++) {
    let e: AuditEntry;
    try { e = JSON.parse(lines[i]) as AuditEntry; } catch { return { ok: false, entries: lines.length, brokenAt: i + 1, reason: 'not valid JSON' }; }
    if (e.prev !== prev) return { ok: false, entries: lines.length, brokenAt: i + 1, reason: 'previous-hash mismatch (an entry was removed or reordered)' };
    const { hash, ...rest } = e;
    if (entryHash(rest) !== hash) return { ok: false, entries: lines.length, brokenAt: i + 1, reason: 'hash mismatch (the entry was modified)' };
    prev = hash;
  }
  return { ok: true, entries: lines.length };
}

/** Status changes between two journey lists (`null` = journey absent on that side). */
export function journeyStatusChanges(before: Journey[], after: Journey[]): { id: string; from: string | null; to: string | null }[] {
  const b = new Map(before.map((j) => [j.id, j.status]));
  const a = new Map(after.map((j) => [j.id, j.status]));
  const out: { id: string; from: string | null; to: string | null }[] = [];
  for (const [id, from] of b) if (a.get(id) !== from) out.push({ id, from, to: a.get(id) ?? null });
  for (const [id, to] of a) if (!b.has(id)) out.push({ id, from: null, to });
  return out;
}
