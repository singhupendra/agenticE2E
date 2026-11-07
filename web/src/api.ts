import type { ModelInfo, ProviderId } from '../../src/core/llm/models';
import type { HealRecord, Journey, ProgressEvent, ScreenshotMode } from '../../src/core/types';

export interface Settings {
  screenshots: ScreenshotMode; fullPage: boolean; maxJourneys: number; maxPages: number; maxDepth: number;
  healAttempts: number; provider: ProviderId; model: string; awsProfile?: string | null; requireApproval: boolean; include: string[]; exclude: string[]; headless: boolean;
}
export interface SiteSummary { id: string; origin: string; url: string; journeys: number; tests: number; runs: number; lastRun: { id: string; passed: number; total: number } | null }
export interface RunSummary { id: string; kind: string; startedAt: string; screenshots: string; results: { journeyId: string; status: string }[] }
export interface SiteDetail {
  meta: SiteSummary; journeys: Journey[]; pages: { path: string; title: string; depth: number; screenshot?: string }[];
  tests: { id: string; versions: string[] }[]; runs: RunSummary[]; heals: HealRecord[];
}
export interface TestDetail { id: string; code: string; versions: { name: string; code: string }[] }
export interface RunDetail { id: string; results: { journeyId: string; status: string; durationMs: number; error?: string; screenshots: string[]; tracePath?: string; failure?: { url: string; screenshot?: string } }[] }

async function j<T>(res: Response): Promise<T> {
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((body as { error?: string }).error ?? `HTTP ${res.status}`);
  return body as T;
}
const post = (url: string, body: unknown) => fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

export const api = {
  config: () => fetch('/api/config').then((r) => j<Settings>(r)),
  models: (provider: ProviderId) => fetch(`/api/models?provider=${provider}`).then((r) => j<{ provider: ProviderId; models: ModelInfo[] }>(r)),
  awsProfiles: () => fetch('/api/aws-profiles').then((r) => j<{ profiles: string[]; selected?: string }>(r)),
  sites: () => fetch('/api/sites').then((r) => j<SiteSummary[]>(r)),
  site: (id: string) => fetch(`/api/sites/${encodeURIComponent(id)}`).then((r) => j<SiteDetail>(r)),
  test: (id: string, t: string) => fetch(`/api/sites/${encodeURIComponent(id)}/tests/${encodeURIComponent(t)}`).then((r) => j<TestDetail>(r)),
  run: (id: string, runId: string) => fetch(`/api/sites/${encodeURIComponent(id)}/runs/${encodeURIComponent(runId)}`).then((r) => j<RunDetail>(r)),
  saveJourneys: (id: string, journeys: Journey[]) => fetch(`/api/sites/${encodeURIComponent(id)}/journeys`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(journeys) }).then((r) => j<Journey[]>(r)),
  startJob: (body: unknown) => post('/api/jobs', body).then((r) => j<{ jobId: string }>(r)),
  fileUrl: (id: string, rel: string) => `/api/sites/${encodeURIComponent(id)}/files/${rel.split('/').map(encodeURIComponent).join('/')}`,
};

export function streamJob(jobId: string, onEvent: (e: ProgressEvent) => void, onEnd: () => void): () => void {
  const es = new EventSource(`/api/jobs/${jobId}/events`);
  es.onmessage = (m) => {
    const e = JSON.parse(m.data) as ProgressEvent;
    onEvent(e);
    if (e.type === 'done' || e.type === 'error') { es.close(); onEnd(); }
  };
  es.onerror = () => { es.close(); onEnd(); };
  return () => es.close();
}
