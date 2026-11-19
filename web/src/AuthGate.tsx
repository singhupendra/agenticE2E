import { useCallback, useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { session, UNAUTHORIZED_EVENT, type SessionInfo } from './session';
import './auth.css';

/**
 * SPEC-014 FR-28: token entry screen. The token is held only in component state until it is exchanged for an HttpOnly
 * session cookie; it is never written to localStorage/sessionStorage.
 */
export function AuthGate({ children }: { children: ReactNode }) {
  const [info, setInfo] = useState<SessionInfo | null>(null);
  const [error, setError] = useState('');

  const refresh = useCallback(
    () =>
      session
        .get()
        .then(setInfo)
        .catch((e) => setError(String((e as Error).message))),
    [],
  );
  useEffect(() => {
    refresh();
  }, [refresh]);
  useEffect(() => {
    const onUnauthorized = () => setInfo((i) => (i?.authRequired ? { authRequired: true, authenticated: false } : i));
    window.addEventListener(UNAUTHORIZED_EVENT, onUnauthorized);
    return () => window.removeEventListener(UNAUTHORIZED_EVENT, onUnauthorized);
  }, []);

  if (!info)
    return <div className="auth-screen">{error ? <p className="error">{error}</p> : <span className="spinner" />}</div>;
  if (info.authRequired && !info.authenticated) return <Login onLogin={setInfo} />;
  return (
    <>
      {info.authRequired && (
        <div className="auth-bar">
          <span>
            {info.name} ({info.role})
          </span>
          <button onClick={() => session.logout().finally(() => setInfo({ authRequired: true, authenticated: false }))}>
            Sign out
          </button>
        </div>
      )}
      {children}
    </>
  );
}

function Login({ onLogin }: { onLogin: (s: SessionInfo) => void }) {
  const [token, setToken] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      onLogin(await session.login(token.trim()));
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
      setToken('');
    }
  };
  return (
    <div className="auth-screen">
      <div className="card auth-card">
        <h1>
          agentic<span>E2E</span>
        </h1>
        <p className="muted">
          This server requires an API token. Ask an admin for one, or create it on the server with{' '}
          <code>agentic-e2e token create</code>.
        </p>
        <form onSubmit={submit}>
          <label htmlFor="api-token" className="muted">
            API token
          </label>
          <input
            id="api-token"
            type="password"
            autoComplete="off"
            spellCheck={false}
            placeholder="ae2e_…"
            value={token}
            onChange={(e) => setToken(e.target.value)}
            autoFocus
          />
          <button type="submit" disabled={busy || !token.trim()}>
            {busy ? 'Signing in…' : 'Sign in'}
          </button>
          {error && <p className="error">{error}</p>}
        </form>
      </div>
    </div>
  );
}
