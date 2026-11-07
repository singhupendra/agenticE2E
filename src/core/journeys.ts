import { z } from 'zod';
import type { Journey } from './types.js';

export const journeySchema = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9_-]*$/, 'id must be lowercase letters, digits, - or _'),
  name: z.string().min(1),
  goal: z.string().min(1),
  priority: z.enum(['high', 'medium', 'low']),
  tags: z.array(z.string()).default([]),
  steps: z.array(z.string().min(1)).min(1),
  status: z.enum(['proposed', 'selected', 'approved', 'rejected']),
  rank: z.number().optional(),
  rationale: z.string().optional(),
});

/** Validate user-edited journeys (CLI --edit, REST PUT). */
export function parseJourneys(input: unknown): Journey[] {
  const parsed = z.array(journeySchema).safeParse(input);
  if (!parsed.success) throw new Error('Invalid journeys: ' + parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '));
  const ids = new Set<string>();
  for (const j of parsed.data) {
    if (ids.has(j.id)) throw new Error(`Invalid journeys: duplicate id "${j.id}"`);
    ids.add(j.id);
  }
  return parsed.data as Journey[];
}

export function setStatus(journeys: Journey[], ids: string[], status: Journey['status']): Journey[] {
  const known = new Set(journeys.map((j) => j.id));
  const unknown = ids.filter((i) => !known.has(i));
  if (unknown.length) throw new Error(`Unknown journey id(s): ${unknown.join(', ')}`);
  return journeys.map((j) => (ids.includes(j.id) ? { ...j, status } : j));
}
