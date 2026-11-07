import type { LLMProvider } from './llm/types.js';
import { journeyProposalSchema, journeyRankingSchema } from './llm/schemas.js';
import type { Journey, PageModel } from './types.js';

export function slugify(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 50).replace(/-+$/, '') || 'journey';
}

/** Compact, token-conscious text rendering of a page model for prompts. */
export function pageToPrompt(p: PageModel, limits = { elements: 40, aria: 1500 }): string {
  const lines = [`## ${p.path} — "${p.title}" (depth ${p.depth})`];
  if (p.headings.length) lines.push(`headings: ${p.headings.join(' | ')}`);
  if (p.navLinks.length) lines.push(`nav: ${p.navLinks.map((l) => `${l.text}→${l.href}`).join(', ')}`);
  for (const f of p.forms) {
    lines.push(`form${f.name ? ` "${f.name}"` : ''}: fields=[${f.fields.map((x) => `${x.role} "${x.label}"${x.type ? `:${x.type}` : ''}${x.testId ? ` #${x.testId}` : ''}`).join('; ')}] submit="${f.submit ?? ''}"`);
  }
  const els = p.elements.slice(0, limits.elements).map((e) => `${e.role} "${e.name}"${e.testId ? ` [testid=${e.testId}]` : ''}${e.href ? ` →${e.href}` : ''}`);
  if (els.length) lines.push(`interactive: ${els.join('; ')}`);
  if (p.ariaSnapshot) lines.push(`aria:\n${p.ariaSnapshot.slice(0, limits.aria)}`);
  return lines.join('\n');
}

const PROPOSE_SYSTEM = `You are a senior QA engineer designing end-to-end user journeys for a website, from compact models of its pages.
Propose realistic, automatable journeys (e.g. search, login, signup, add-to-cart, navigation, contact form).
Rules: only use pages/elements that appear in the models; each journey has a short name, a one-sentence goal, a priority, and 2-8 ordered concrete steps that name the visible labels/buttons involved and the expected observable outcome of the last step. Do not invent credentials; avoid journeys that need real accounts or payments unless clearly stubbed.`;

export async function proposeJourneys(llm: LLMProvider, pages: PageModel[]): Promise<Journey[]> {
  if (!pages.length) throw new Error('No pages to plan from');
  const prompt = `Site pages (${pages.length}):\n\n${pages.map((p) => pageToPrompt(p)).join('\n\n')}\n\nPropose candidate user journeys.`;
  const out = await llm.structured({ name: 'propose_journeys', description: 'Propose candidate user journeys for the site.', system: PROPOSE_SYSTEM, prompt, schema: journeyProposalSchema });
  const used = new Set<string>();
  return out.journeys.map((j) => {
    const base = slugify(j.name);
    let id = base;
    for (let i = 2; used.has(id); i++) id = `${base}-${i}`;
    used.add(id);
    return { id, name: j.name, goal: j.goal, priority: j.priority, tags: j.tags ?? [], steps: j.steps, status: 'proposed' as const };
  });
}

function matcher(pattern: string): (text: string) => boolean {
  const m = /^\/(.+)\/([a-z]*)$/.exec(pattern);
  if (m) {
    try { const re = new RegExp(m[1], m[2]); return (t) => re.test(t); } catch { /* fall through to substring */ }
  }
  const needle = pattern.toLowerCase();
  return (t) => t.toLowerCase().includes(needle);
}
const haystack = (j: Journey) => `${j.name} ${j.goal} ${j.tags.join(' ')}`;

export function applyFilters(journeys: Journey[], include: string[], exclude: string[]): Journey[] {
  const inc = include.map(matcher), exc = exclude.map(matcher);
  return journeys.filter((j) => {
    const h = haystack(j);
    if (exc.some((f) => f(h))) return false;
    return !inc.length || inc.some((f) => f(h));
  });
}

const PRIORITY_ORDER = { high: 0, medium: 1, low: 2 } as const;

export interface SelectOptions { maxJourneys: number; include: string[]; exclude: string[] }

/**
 * LLM ranks eligible journeys; we then deterministically apply filters + the max count.
 * User-approved journeys always stay selected and occupy slots first; rejected ones are never selected.
 */
export async function selectJourneys(llm: LLMProvider, journeys: Journey[], opts: SelectOptions): Promise<Journey[]> {
  const candidates = journeys.filter((j) => j.status === 'proposed' || j.status === 'selected');
  const eligible = applyFilters(candidates, opts.include, opts.exclude);
  const approved = journeys.filter((j) => j.status === 'approved');
  const slots = Math.max(0, opts.maxJourneys - approved.length);

  const rank = new Map<string, { rank: number; rationale: string }>();
  if (eligible.length && slots > 0) {
    const prompt = `Rank these candidate journeys by value for an automated regression suite (core business flows and high-traffic features first; cheap, stable, deterministic first). Return ids in order of preference — best first. You may omit journeys that are not worth automating.\n\n${eligible
      .map((j) => `- id=${j.id} [${j.priority}] ${j.name}: ${j.goal}\n    steps: ${j.steps.join(' → ')}`)
      .join('\n')}`;
    const out = await llm.structured({ name: 'rank_journeys', description: 'Rank journeys to automate.', system: 'You are a test strategist.', prompt, schema: journeyRankingSchema });
    const ids = new Set(eligible.map((j) => j.id));
    for (const r of out.ranked) if (ids.has(r.id) && !rank.has(r.id)) rank.set(r.id, { rank: rank.size + 1, rationale: r.rationale });
    if (!rank.size) {
      [...eligible].sort((a, b) => PRIORITY_ORDER[a.priority] - PRIORITY_ORDER[b.priority]).forEach((j, i) => rank.set(j.id, { rank: i + 1, rationale: 'fallback: priority order' }));
    }
  }
  const chosen = new Set([...rank.entries()].sort((a, b) => a[1].rank - b[1].rank).slice(0, slots).map(([id]) => id));
  return journeys.map((j) => {
    if (j.status === 'approved' || j.status === 'rejected') return j;
    const r = rank.get(j.id);
    const next: Journey = { ...j, status: chosen.has(j.id) ? 'selected' : 'proposed' };
    if (r) { next.rank = r.rank; next.rationale = r.rationale; } else { delete next.rank; delete next.rationale; }
    return next;
  });
}
