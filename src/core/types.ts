export type ScreenshotMode = 'off' | 'on-failure' | 'every-step' | 'end-of-journey';
export type Priority = 'high' | 'medium' | 'low';
export type JourneyStatus = 'proposed' | 'selected' | 'approved' | 'rejected';

export interface Journey {
  id: string;
  name: string;
  goal: string;
  priority: Priority;
  tags: string[];
  steps: string[];
  status: JourneyStatus;
  rank?: number;
  rationale?: string;
  /** SPEC-009: the journey needs the logged-in session (set by the planner in auth mode). */
  requiresAuth?: boolean;
  /** SPEC-009: name of the credentials-file user the journey runs as (a name, never a secret). */
  user?: string;
}

export interface ElementInfo {
  role: string;
  name: string;
  tag: string;
  testId?: string;
  href?: string;
  type?: string;
}
export interface FormField { label: string; role: string; type?: string; name?: string; testId?: string; required?: boolean }
export interface FormInfo { name?: string; action?: string; method?: string; fields: FormField[]; submit?: string }
export interface PageModel {
  url: string;
  path: string;
  title: string;
  depth: number;
  headings: string[];
  ariaSnapshot: string;
  elements: ElementInfo[];
  forms: FormInfo[];
  navLinks: { text: string; href: string }[];
  screenshot?: string;
}

export interface SiteMeta { id: string; origin: string; url: string; discoveredAt?: string; updatedAt?: string }

export interface FailureSnapshot { url: string; title: string; ariaSnapshot: string; html: string; screenshot?: string }
export interface TestResult {
  journeyId: string;
  file: string;
  status: 'passed' | 'failed' | 'skipped' | 'timedOut';
  durationMs: number;
  error?: string;
  tracePath?: string;
  screenshots: string[];
  failure?: FailureSnapshot;
}
export interface RunRecord {
  id: string;
  kind: 'run' | 'heal-rerun';
  startedAt: string;
  finishedAt: string;
  screenshots: ScreenshotMode;
  fullPage: boolean;
  results: TestResult[];
}

export type HealVerdict = 'test_breakage' | 'app_bug' | 'flaky_or_environment';
export interface HealAttempt {
  n: number;
  verdict?: HealVerdict;
  reason: string;
  accepted: boolean;
  rejection?: string;
  passed?: boolean;
  error?: string;
}
export interface HealRecord {
  id: string;
  journeyId: string;
  at: string;
  outcome: 'healed' | 'failed' | 'app_bug' | 'flaky_or_environment';
  verdict?: HealVerdict;
  reason: string;
  originalError: string;
  attempts: HealAttempt[];
  diff?: string;
  /** SPEC-006: error of the final re-run when the heal ended `failed` (absent when aborted by an error or when nothing was re-run). */
  lastError?: string;
  /** SPEC-006: diff original -> last re-run-but-failing patch, kept as the non-active version `candidate-<n>`. */
  candidateDiff?: string;
}

export interface ProgressEvent {
  type: 'info' | 'stage' | 'warn' | 'error' | 'done' | 'result';
  stage?: string;
  message: string;
  data?: unknown;
}
export type ProgressFn = (e: ProgressEvent) => void;
