#!/usr/bin/env node
import fs from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';

const dist = fileURLToPath(new URL('../dist/cli/index.js', import.meta.url));
if (!fs.existsSync(dist)) {
  console.error('agentic-e2e is not built. Run `pnpm build` (or use `pnpm cli <command>` for the dev runner).');
  process.exit(1);
}
const { main } = await import(pathToFileURL(dist).href);
process.exit(await main(process.argv));
