import type { Journey, Priority } from '../types.js';
import { TAG_RE } from './options.js';

/** SPEC-012 FR-12, FR-14..16. */
export const SUITE_TAGS = ['smoke', 'regression', 'critical'] as const;
export const DESTRUCTIVE_TAG = 'destructive';
export const READ_ONLY_TAG = 'read-only';

const DEFAULTS: Record<Priority, string[]> = { high: ['smoke', 'critical', 'regression'], medium: ['regression'], low: ['regression'] };

/** Lenient normalisation for LLM output: lower-case, spaces → '-', drop what still is not a valid tag, de-duplicate. */
export function normalizeTags(tags: readonly string[] | undefined): string[] {
  const out = (tags ?? []).map((t) => t.trim().toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '')).filter((t) => TAG_RE.test(t));
  return [...new Set(out)];
}

/** Planner tags plus suite defaults by priority when the LLM gave no suite tag. */
export function withDefaultTags(priority: Priority, tags: readonly string[] | undefined): string[] {
  const norm = normalizeTags(tags);
  if (norm.some((t) => (SUITE_TAGS as readonly string[]).includes(t))) return norm;
  return [...new Set([...norm, ...DEFAULTS[priority]])];
}

const DESTRUCTIVE_RE = /\b(delete|remove|destroy|deactivate|unsubscribe|log\s?-?out|sign\s?-?out|terminate|cancel\s+(my\s+|your\s+|the\s+)?(subscription|account|plan|membership|order|booking)|close\s+(my\s+|your\s+|the\s+)?account|purchase|pay|payment|checkout|check\s?-?out|place\s+(an\s+|the\s+|my\s+)?order|refund|transfer)\b/i;

/** Destructive journeys are skipped in read-only environments (FR-11/12). */
export function isDestructiveJourney(j: Pick<Journey, 'name' | 'goal' | 'steps' | 'tags'>): boolean {
  if (j.tags.includes(DESTRUCTIVE_TAG)) return true;
  if (j.tags.includes(READ_ONLY_TAG)) return false;
  return DESTRUCTIVE_RE.test([j.name, j.goal, ...j.steps].join('\n'));
}

export interface JourneyFilter { grep?: string; tag?: string[] }

function textMatcher(pattern: string): (s: string) => boolean {
  const m = /^\/(.+)\/([a-z]*)$/.exec(pattern);
  if (m) {
    let re: RegExp;
    try { re = new RegExp(m[1], m[2]); } catch (e) { throw new Error(`Invalid --grep regex ${pattern}: ${(e as Error).message}`, { cause: e }); }
    return (s) => re.test(s);
  }
  const needle = pattern.toLowerCase();
  return (s) => s.toLowerCase().includes(needle);
}

export const hasFilter = (f: JourneyFilter) => !!f.grep || !!f.tag?.length;

/** Keep `ids` (order preserved) whose journey matches grep (id, name or a tag) AND has any of `tag`. Tests without a stored journey match on id only. */
export function filterJourneyIds(ids: string[], journeys: Journey[], f: JourneyFilter): string[] {
  if (!hasFilter(f)) return ids;
  const byId = new Map(journeys.map((j) => [j.id, j]));
  const grep = f.grep ? textMatcher(f.grep) : null;
  const want = new Set((f.tag ?? []).map((t) => t.trim().toLowerCase()));
  return ids.filter((id) => {
    const j = byId.get(id);
    const tags = j?.tags ?? [];
    if (grep && ![id, j?.name ?? '', ...tags].some(grep)) return false;
    return !want.size || tags.some((t) => want.has(t));
  });
}

function strictTags(tags: readonly string[]): string[] {
  const out = tags.map((t) => t.trim().toLowerCase());
  const bad = out.filter((t) => !TAG_RE.test(t));
  if (bad.length) throw new Error(`Invalid tag${bad.length === 1 ? '' : 's'}: ${bad.map((b) => JSON.stringify(b)).join(', ')} (use lowercase letters, digits, - or _)`);
  return out;
}

/** FR-15: edit tags of `ids` (empty = every journey). Throws on unknown ids or invalid tags before changing anything. */
export function editTags(journeys: Journey[], ids: string[], edit: { add?: string[]; remove?: string[]; set?: string[] }): Journey[] {
  const known = journeys.map((j) => j.id);
  const unknown = ids.filter((i) => !known.includes(i));
  if (unknown.length) throw new Error(`Unknown journey id(s): ${unknown.join(', ')}. Valid ids: ${known.join(', ') || '(none)'}`);
  const add = strictTags(edit.add ?? []), remove = new Set(strictTags(edit.remove ?? [])), set = edit.set ? strictTags(edit.set) : null;
  const target = new Set(ids.length ? ids : known);
  return journeys.map((j) => {
    if (!target.has(j.id)) return j;
    const base = set ?? j.tags;
    return { ...j, tags: [...new Set([...base, ...add])].filter((t) => !remove.has(t)) };
  });
}

export interface TagEdit { id: string; tags: string[] }

/** `journeys --add-tags checkout=critical,smoke '*'=regression`: parse `id=tag,tag` pairs (`*` = every journey). */
export function parseTagEdits(pairs: readonly string[] | undefined): TagEdit[] {
  return (pairs ?? []).map((p) => {
    const m = /^([^=]+)=(.+)$/.exec(p);
    const tags = m ? m[2].split(',').map((t) => t.trim()).filter(Boolean) : [];
    if (!m || !m[1].trim() || !tags.length) throw new Error(`Invalid tag edit "${p}": expected id=tag[,tag...] (use * for every journey)`);
    return { id: m[1].trim(), tags };
  });
}

/** FR-15: apply `--set-tags`, then `--add-tags`, then `--remove-tags`. Throws before returning anything on a bad id/tag. */
export function applyTagEdits(journeys: Journey[], edits: { add?: readonly string[]; remove?: readonly string[]; set?: readonly string[] }): Journey[] {
  let out = journeys;
  const steps: [keyof typeof edits, readonly string[] | undefined][] = [['set', edits.set], ['add', edits.add], ['remove', edits.remove]];
  for (const [kind, pairs] of steps) {
    for (const e of parseTagEdits(pairs)) out = editTags(out, e.id === '*' ? [] : [e.id], { [kind]: e.tags });
  }
  return out;
}
