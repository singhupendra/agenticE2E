import { z } from 'zod';

export const journeyProposalSchema = z.object({
  journeys: z.array(z.object({
    name: z.string().min(1),
    goal: z.string().min(1),
    priority: z.enum(['high', 'medium', 'low']),
    tags: z.array(z.string()).optional(),
    steps: z.array(z.string().min(1)).min(1),
    requiresAuth: z.boolean().optional(),
    user: z.string().optional(),
  })).min(1),
});

export const journeyRankingSchema = z.object({
  ranked: z.array(z.object({ id: z.string(), rationale: z.string().default('') })),
});

export const codeSchema = z.object({ code: z.string().min(1) });

export const healSchema = z.object({
  verdict: z.enum(['test_breakage', 'app_bug', 'flaky_or_environment']),
  reason: z.string().min(1),
  code: z.string().optional(),
});

/** SPEC-009: where the login form is. Selectors only; the model never sees (or returns) credential values. */
export const loginFormSchema = z.object({
  usernameSelector: z.string().min(1),
  passwordSelector: z.string().min(1),
  submitSelector: z.string().min(1),
});
