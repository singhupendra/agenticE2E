import http from 'node:http';
import type { AddressInfo } from 'node:net';

const layout = (title: string, body: string, loggedIn = false) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${title}</title></head><body>
<header><nav aria-label="Main"><a href="/">Home</a> <a href="/about">About</a> <a href="/products">Products</a> <a href="/contact">Contact</a> <a href="/login">Login</a>${loggedIn ? ' <a href="/account">My account</a>' : ''}</nav></header>
<main>${body}</main></body></html>`;

/** SPEC-009: the fixture's one account. Real-looking but fake; tests assert these strings leak nowhere. */
export const FIXTURE_USER = 'member@example.test';
export const FIXTURE_PASSWORD = 'Zeta-9-pass-QX7';

export interface Fixture {
  url: string; otherUrl: string; hits: string[]; otherHits: string[];
  /** number of POST /login requests (successful or not) */
  loginPosts: () => number;
  /** invalidate every server-side session (cookies stay valid-looking in the browser) */
  expireSessions: () => void;
  close: () => Promise<void>;
}

function listen(handler: http.RequestListener): Promise<{ server: http.Server; url: string }> {
  return new Promise((resolve) => {
    const server = http.createServer(handler).listen(0, '127.0.0.1', () => resolve({ server, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}` }));
  });
}

export async function startFixtureSite(): Promise<Fixture> {
  const otherHits: string[] = [];
  const other = await listen((req, res) => { otherHits.push(req.url ?? ''); res.end('<html><title>other</title><body>other origin</body></html>'); });
  const hits: string[] = [];
  const sessions = new Set<string>();
  let loginPosts = 0;
  let seq = 0;
  const readBody = (req: http.IncomingMessage) => new Promise<URLSearchParams>((resolve) => {
    let b = '';
    req.on('data', (d) => (b += d));
    req.on('end', () => resolve(new URLSearchParams(b)));
  });
  const main = await listen(async (req, res) => {
    const u = new URL(req.url ?? '/', 'http://x');
    hits.push(u.pathname);
    res.setHeader('content-type', 'text/html');
    const sid = /(?:^|;\s*)sid=([^;]+)/.exec(req.headers.cookie ?? '')?.[1];
    const loggedIn = !!sid && sessions.has(sid);
    const send = (title: string, body: string) => res.end(layout(title, body, loggedIn));
    const redirect = (to: string, cookie?: string) => { res.statusCode = 303; res.setHeader('location', to); if (cookie) res.setHeader('set-cookie', cookie); res.end(); };
    const protectedPage = (title: string, body: string) => (loggedIn ? send(title, body) : redirect('/login'));
    if (req.method === 'POST' && u.pathname === '/login') {
      loginPosts++;
      const f = await readBody(req);
      if (f.get('email') === FIXTURE_USER && f.get('password') === FIXTURE_PASSWORD) {
        const id = `s${++seq}-${Math.random().toString(36).slice(2)}`;
        sessions.add(id);
        return redirect('/account', `sid=${id}; Path=/; HttpOnly`);
      }
      res.statusCode = 401;
      return send('Login', '<h1>Sign in</h1><p role="alert">Invalid email or password</p><form method="post" action="/login"><label for="e">Email</label><input id="e" name="email" type="email"><label for="p">Password</label><input id="p" name="password" type="password"><button type="submit">Sign in</button></form>');
    }
    if (req.method === 'POST' && u.pathname === '/account/confirm') {
      const f = await readBody(req);
      if (!loggedIn) return redirect('/login');
      return send('Settings', `<h1>Settings</h1>${f.get('password') === FIXTURE_PASSWORD ? '<p role="status">Password confirmed</p>' : '<p role="alert">Wrong password</p>'}`);
    }
    switch (u.pathname) {
      case '/account':
        return protectedPage('My account', `<h1>Welcome back, Test Member</h1><p>Signed in as ${FIXTURE_USER}</p><a href="/account/settings">Settings</a> <a href="/account/delete">Delete account</a> <a href="/logout">Log out</a>`);
      case '/account/settings':
        return protectedPage('Settings', '<h1>Settings</h1><form method="post" action="/account/confirm" aria-label="Confirm password"><label for="cp">Confirm password</label><input id="cp" name="password" type="password"><button type="submit">Confirm</button></form>');
      case '/account/delete':
        return protectedPage('Delete account', '<h1>Account deleted</h1>');
      case '/logout':
        sessions.delete(sid ?? '');
        return redirect('/login', 'sid=; Path=/; Max-Age=0');
      case '/':
        return send('Fixture Shop - Home', `<h1>Welcome to Fixture Shop</h1>
<form role="search" action="/search" method="get"><label for="q">Search</label><input id="q" name="q" type="text" data-testid="search-input"><button type="submit">Search</button></form>`);
      case '/search':
        return send('Search results', `<h1>Results for ${(u.searchParams.get('q') ?? '').replace(/[<>&]/g, '')}</h1><ul><li>Blue Widget</li></ul>`);
      case '/about':
        return send('About us', `<h1>About</h1><p>We sell widgets.</p><a href="/team">Meet the team</a> <a href="${other.url}/ext">Partner site</a> <a href="/files/report.pdf">Report</a>`);
      case '/team':
        return send('Team', `<h1>Our team</h1><p>Ada and Grace.</p>`);
      case '/products':
        return send('Products', `<h1>Products</h1><a href="/product/1">Blue Widget</a> <a href="/product/2">Red Widget</a>`);
      case '/product/1':
      case '/product/2':
        return send('Product', `<h1>Widget ${u.pathname.slice(-1)}</h1><button>Add to cart</button>`);
      case '/contact':
        return send('Contact us', `<h1>Contact</h1>
<form id="contact" aria-label="Contact form"><label for="name">Name</label><input id="name" name="name" required>
<label for="email">Email</label><input id="email" name="email" type="email" required>
<label for="msg">Message</label><textarea id="msg" name="message"></textarea>
<button type="submit">Send message</button></form><p role="status" id="status"></p>
<script>document.getElementById('contact').addEventListener('submit',function(e){e.preventDefault();document.getElementById('status').textContent='Thanks, '+document.getElementById('name').value+'!';});</script>`);
      case '/login':
        return send('Login', `<h1>Sign in</h1><form method="post" action="/login"><label for="e">Email</label><input id="e" name="email" type="email"><label for="p">Password</label><input id="p" name="password" type="password"><button type="submit">Sign in</button></form>`);
      default:
        res.statusCode = 404;
        return send('Not found', '<h1>404</h1>');
    }
  });
  return {
    url: main.url,
    otherUrl: other.url,
    hits,
    otherHits,
    loginPosts: () => loginPosts,
    expireSessions: () => sessions.clear(),
    close: async () => { await Promise.all([main, other].map((s) => new Promise((r) => { s.server.closeAllConnections(); s.server.close(() => r(null)); }))); },
  };
}
