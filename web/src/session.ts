/** SPEC-014: web session (HttpOnly cookie set by POST /api/session). The token itself is never stored in the browser. */
export interface SessionInfo {
  authRequired: boolean;
  authenticated: boolean;
  name?: string;
  role?: 'viewer' | 'operator' | 'admin';
}

export const UNAUTHORIZED_EVENT = 'agentic-e2e:unauthorized';
export const notifyUnauthorized = () => window.dispatchEvent(new Event(UNAUTHORIZED_EVENT));

async function body<T>(res: Response): Promise<T> {
  const b = await res.json().catch(() => ({}));
  if (!res.ok)
    throw new Error(
      res.status === 401
        ? 'Invalid or revoked token'
        : res.status === 429
          ? 'Too many attempts; wait a minute and try again'
          : ((b as { error?: string }).error ?? `HTTP ${res.status}`),
    );
  return b as T;
}
const json = { 'content-type': 'application/json' };

export const session = {
  get: () => fetch('/api/session').then((r) => body<SessionInfo>(r)),
  login: (token: string) =>
    fetch('/api/session', { method: 'POST', headers: json, body: JSON.stringify({ token }) }).then((r) =>
      body<SessionInfo>(r),
    ),
  logout: () =>
    fetch('/api/session', { method: 'DELETE', headers: json, body: '{}' }).then((r) => body<SessionInfo>(r)),
};
