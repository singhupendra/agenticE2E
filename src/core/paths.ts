import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** Root of the agentic-e2e package (where node_modules with Playwright lives). */
export function packageRoot(): string {
  let dir = path.dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 8; i++) {
    const pj = path.join(dir, 'package.json');
    if (fs.existsSync(pj) && JSON.parse(fs.readFileSync(pj, 'utf8')).name === 'agentic-e2e') return dir;
    dir = path.dirname(dir);
  }
  throw new Error('Could not locate agentic-e2e package root');
}
