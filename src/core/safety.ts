/**
 * SPEC-009: links an authenticated crawl must never follow. Following `/logout` kills the session; GET links named
 * delete/remove/cancel are destructive on sloppy apps. Decided from the link text and from whole path segments.
 */
const TEXT_RE = /\b(log\s?-?out|sign\s?-?out|delete|remove|deactivate|unsubscribe|cancel\s+(my\s+|your\s+|the\s+)?(subscription|account|plan|membership|order|booking)|close\s+(my\s+|your\s+|the\s+)?account|terminate)\b/i;
const SEGMENTS = new Set([
  'logout', 'log-out', 'log_out', 'signout', 'sign-out', 'sign_out', 'delete', 'destroy', 'remove', 'cancel', 'deactivate',
  'unsubscribe', 'close-account', 'cancel-subscription', 'delete-account', 'terminate',
]);

export function isDestructiveLink(text: string, href: string): boolean {
  if (TEXT_RE.test(text)) return true;
  let pathname = href;
  try { pathname = new URL(href, 'http://x').pathname; } catch { /* use as is */ }
  return pathname.toLowerCase().split('/').some((seg) => SEGMENTS.has(seg));
}
