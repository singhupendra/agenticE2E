import { describe, it, expect } from 'vitest';
import { Redactor } from '../src/core/redact.js';

const r = new Redactor([
  { value: 'hunter2-Secret', placeholder: '{{password}}' },
  { value: 'me+tag@example.test', placeholder: '{{username}}' },
  { value: 'a.b*c', placeholder: '{{pin}}' },
  { value: 'ab', placeholder: '{{short}}' },
]);

describe('Redactor (SPEC-009 AC-8)', () => {
  it('replaces plain occurrences with placeholders', () => {
    expect(r.redact('login me+tag@example.test / hunter2-Secret ok')).toBe('login {{username}} / {{password}} ok');
  });
  it('replaces URL-encoded and JSON-escaped forms', () => {
    expect(r.redact('?u=me%2Btag%40example.test')).toBe('?u={{username}}');
    const tricky = new Redactor([{ value: 'p"w\\d\nx', placeholder: '{{password}}' }]);
    expect(tricky.redact(JSON.stringify({ a: 'p"w\\d\nx' }))).not.toContain('p\\"w');
    expect(tricky.redact('raw p"w\\d\nx raw')).toBe('raw {{password}} raw');
  });
  it('treats regex metacharacters literally and ignores values shorter than 3 chars', () => {
    expect(r.redact('x a.b*c y aXbbc ab ab')).toBe('x {{pin}} y aXbbc ab ab');
  });
  it('contains() detects any form', () => {
    expect(r.contains('nothing here')).toBe(false);
    expect(r.contains('x hunter2-Secret')).toBe(true);
    expect(r.contains('x me%2Btag%40example.test')).toBe(true);
  });
  it('redactDeep walks objects and arrays and leaves non-strings alone', () => {
    const out = r.redactDeep({ a: ['hunter2-Secret', 3, null], b: { c: 'me+tag@example.test', d: true } });
    expect(out).toEqual({ a: ['{{password}}', 3, null], b: { c: '{{username}}', d: true } });
    expect(JSON.stringify(out)).not.toContain('hunter2');
  });
  it('empty redactor is a no-op', () => {
    const e = Redactor.empty();
    expect(e.redact('anything')).toBe('anything');
    expect(e.contains('anything')).toBe(false);
  });
  it('longer secrets win over secrets that are substrings of them', () => {
    const x = new Redactor([{ value: 'pass', placeholder: '{{a}}' }, { value: 'pass-longer', placeholder: '{{b}}' }]);
    expect(x.redact('pass-longer and pass')).toBe('{{b}} and {{a}}');
  });
});
