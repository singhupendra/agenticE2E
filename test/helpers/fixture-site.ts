import http from 'node:http';
import type { AddressInfo } from 'node:net';

const layout = (title: string, body: string) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${title}</title></head><body>
<header><nav aria-label="Main"><a href="/">Home</a> <a href="/about">About</a> <a href="/products">Products</a> <a href="/contact">Contact</a> <a href="/login">Login</a></nav></header>
<main>${body}</main></body></html>`;

export interface Fixture { url: string; otherUrl: string; hits: string[]; otherHits: string[]; close: () => Promise<void> }

function listen(handler: http.RequestListener): Promise<{ server: http.Server; url: string }> {
  return new Promise((resolve) => {
    const server = http.createServer(handler).listen(0, '127.0.0.1', () => resolve({ server, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}` }));
  });
}

export async function startFixtureSite(): Promise<Fixture> {
  const otherHits: string[] = [];
  const other = await listen((req, res) => { otherHits.push(req.url ?? ''); res.end('<html><title>other</title><body>other origin</body></html>'); });
  const hits: string[] = [];
  const main = await listen((req, res) => {
    const u = new URL(req.url ?? '/', 'http://x');
    hits.push(u.pathname);
    res.setHeader('content-type', 'text/html');
    const send = (title: string, body: string) => res.end(layout(title, body));
    switch (u.pathname) {
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
        return send('Login', `<h1>Sign in</h1><form><label for="e">Email</label><input id="e" name="email" type="email"><label for="p">Password</label><input id="p" name="password" type="password"><button type="submit">Sign in</button></form>`);
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
    close: async () => { await Promise.all([main, other].map((s) => new Promise((r) => { s.server.closeAllConnections(); s.server.close(() => r(null)); }))); },
  };
}
