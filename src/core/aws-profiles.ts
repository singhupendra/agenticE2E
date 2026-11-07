import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

type Env = Record<string, string | undefined>;
type Section = { name: string; kind: 'profile' | 'other'; values: Map<string, string> };

/** Same shape the config schema enforces for `awsRegion`. */
const REGION = /^[a-z]{2}(-[a-z0-9]+)+-\d+$/;

const configPath = (env: Env) => env.AWS_CONFIG_FILE || path.join(env.HOME || os.homedir(), '.aws', 'config');
const credentialsPath = (env: Env) => env.AWS_SHARED_CREDENTIALS_FILE || path.join(env.HOME || os.homedir(), '.aws', 'credentials');

/**
 * Minimal INI reader: sections and `key = value` lines only. In the config file a profile section is `[default]` or
 * `[profile name]`; everything else (`[sso-session x]`, `[services x]`, …) is not a profile. In the credentials file every
 * section is a profile. Unreadable/missing files yield no sections.
 */
function readSections(file: string, isConfigFile: boolean): Section[] {
  let text: string;
  try { text = fs.readFileSync(file, 'utf8'); } catch { return []; }
  const sections: Section[] = [];
  let cur: Section | undefined;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#') || line.startsWith(';')) continue;
    const header = /^\[(.+?)\]\s*(?:[#;].*)?$/.exec(line);
    if (header) {
      const title = header[1].trim();
      if (!isConfigFile) cur = { name: title, kind: 'profile', values: new Map() };
      else if (title === 'default') cur = { name: 'default', kind: 'profile', values: new Map() };
      else {
        const m = /^profile\s+(.+)$/.exec(title);
        cur = m ? { name: m[1].trim(), kind: 'profile', values: new Map() } : { name: title, kind: 'other', values: new Map() };
      }
      sections.push(cur);
      continue;
    }
    // Indented continuation lines (nested settings such as `services` blocks) are not top-level keys.
    if (!cur || /^\s/.test(raw)) continue;
    const eq = line.indexOf('=');
    if (eq > 0) cur.values.set(line.slice(0, eq).trim().toLowerCase(), line.slice(eq + 1).trim());
  }
  return sections;
}

/** Sorted, de-duplicated names of the profiles in the shared AWS config and credentials files. Never reads secrets out. */
export function listAwsProfiles(env: Env = process.env): string[] {
  const names = new Set<string>();
  for (const s of readSections(configPath(env), true)) if (s.kind === 'profile') names.add(s.name);
  for (const s of readSections(credentialsPath(env), false)) names.add(s.name);
  return [...names].sort();
}

/** The `region` set on a profile in the shared config file, if it is a plausible region. */
export function awsProfileRegion(profile: string, env: Env = process.env): string | undefined {
  const s = readSections(configPath(env), true).find((x) => x.kind === 'profile' && x.name === profile);
  const r = s?.values.get('region');
  return r && REGION.test(r) ? r : undefined;
}
