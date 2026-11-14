export interface SecretEntry { value: string; placeholder: string }

const MIN_LEN = 3;

/** Forms a value can take once it has been embedded in a URL, JSON or HTML. */
function variants(value: string): string[] {
  const set = new Set<string>([value]);
  set.add(encodeURIComponent(value));
  set.add(encodeURI(value));
  set.add(JSON.stringify(value).slice(1, -1));
  set.add(value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'));
  return [...set].filter((v) => v.length >= MIN_LEN);
}

/**
 * Replaces known secret values with placeholders. Used on everything that leaves the process boundary of "trusted"
 * code: LLM prompts, stored data, logs, SSE, API responses. Longest secrets are replaced first.
 */
export class Redactor {
  private readonly pairs: { text: string; placeholder: string }[];
  constructor(entries: SecretEntry[]) {
    const seen = new Set<string>();
    const pairs: { text: string; placeholder: string }[] = [];
    for (const e of entries) {
      if (e.value.length < MIN_LEN) continue;
      for (const text of variants(e.value)) if (!seen.has(text)) { seen.add(text); pairs.push({ text, placeholder: e.placeholder }); }
    }
    this.pairs = pairs.sort((a, b) => b.text.length - a.text.length);
  }
  static empty(): Redactor { return new Redactor([]); }
  get size(): number { return this.pairs.length; }

  redact(s: string): string {
    let out = s;
    for (const p of this.pairs) if (out.includes(p.text)) out = out.split(p.text).join(p.placeholder);
    return out;
  }
  contains(s: string): boolean { return this.pairs.some((p) => s.includes(p.text)); }
  /** Line numbers (1-based) of lines that contain a secret. */
  linesWithSecrets(s: string): number[] {
    const lines: number[] = [];
    s.split('\n').forEach((l, i) => { if (this.contains(l)) lines.push(i + 1); });
    return lines;
  }
  redactDeep<T>(v: T): T {
    if (typeof v === 'string') return this.redact(v) as T;
    if (Array.isArray(v)) return v.map((x) => this.redactDeep(x)) as T;
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v as object).map(([k, x]) => [this.redact(k), this.redactDeep(x)])) as T;
    return v;
  }
}
