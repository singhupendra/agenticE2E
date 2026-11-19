import { describe, it, expect } from 'vitest';
import { createLogger, scrubSecrets } from '../src/core/obs/logger.js';
import { buildLogRedactor, envSecretEntries } from '../src/core/obs/secrets.js';

const capture = () => {
  const lines: string[] = [];
  return {
    lines,
    stream: {
      write: (s: string) => {
        lines.push(s);
      },
    },
    json: () => lines.map((l) => JSON.parse(l)),
  };
};

describe('SPEC-013 structured logging', () => {
  it('AC-1: json format writes one object per line with level label, time, msg and bindings', () => {
    const c = capture();
    const log = createLogger({
      level: 'info',
      format: 'json',
      stream: c.stream,
      bindings: { correlationId: 'abc', action: 'generate' },
    });
    log.info({ call: 1, model: 'm' }, 'llm.call');
    const [line] = c.json();
    expect(line).toMatchObject({
      level: 'info',
      msg: 'llm.call',
      correlationId: 'abc',
      action: 'generate',
      call: 1,
      model: 'm',
    });
    expect(new Date(line.time).toISOString()).toBe(line.time);
    expect(line.pid).toBeUndefined();
    expect(c.lines[0].endsWith('\n')).toBe(true);
  });

  it('child loggers keep the parent bindings', () => {
    const c = capture();
    const log = createLogger({ level: 'info', format: 'json', stream: c.stream, bindings: { correlationId: 'abc' } });
    log.child({ runId: 'r1' }).info('run.finished');
    expect(c.json()[0]).toMatchObject({ correlationId: 'abc', runId: 'r1' });
  });

  it('AC-2: levels filter, silent writes nothing', () => {
    const c = capture();
    const log = createLogger({ level: 'warn', format: 'json', stream: c.stream });
    log.info('nope');
    log.debug('nope');
    log.warn('yes');
    log.error('also');
    expect(c.json().map((l) => l.msg)).toEqual(['yes', 'also']);
    const s = capture();
    const quiet = createLogger({ level: 'silent', format: 'json', stream: s.stream });
    quiet.error('x');
    quiet.fatal('y');
    expect(s.lines).toEqual([]);
  });

  it('AC-3: pretty format is a readable single line', () => {
    const c = capture();
    createLogger({ level: 'info', format: 'pretty', stream: c.stream }).warn({ attempt: 2, status: 429 }, 'llm.retry');
    expect(c.lines[0]).toMatch(/^\d\d:\d\d:\d\d\.\d{3} WARN {2}llm\.retry attempt=2 status=429\n$/);
  });

  it('defaults to warn + pretty', () => {
    const c = capture();
    const log = createLogger({ stream: c.stream });
    log.info('hidden');
    log.warn('shown');
    expect(c.lines).toHaveLength(1);
    expect(c.lines[0]).toContain('WARN');
  });

  describe('AC-4: no secret ever reaches a log line', () => {
    const env = {
      ANTHROPIC_API_KEY: 'sk-ant-api03-REALKEYvalue1234567890',
      AWS_SECRET_ACCESS_KEY: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
      OTEL_EXPORTER_OTLP_HEADERS: 'x-honeycomb-team=hc-secret-123',
      HOME: '/home/u',
    };
    const redactor = buildLogRedactor(
      [
        { value: 's3cr3t-pw', placeholder: '{{password}}' },
        { value: 'alice@example.com', placeholder: '{{username}}' },
      ],
      env,
    );

    it('redacts credential values, env secrets, known secret shapes and sensitive keys', () => {
      const c = capture();
      const log = createLogger({ level: 'debug', format: 'json', stream: c.stream, redactor });
      log.info({ err: new Error('login failed for alice@example.com with s3cr3t-pw') }, 'oops');
      log.info({ nested: { deep: [`key=${env.ANTHROPIC_API_KEY}`] } }, 'env');
      log.info(`aws ${env.AWS_SECRET_ACCESS_KEY}`);
      log.info(
        'other sk-ant-api03-ZZZZZZZZZZZZZZZZZZZZ and Authorization: Bearer abc.def.ghi123 and AKIAIOSFODNN7EXAMPLE and ABSKQmVkcm9ja0FQSUtleS1hYmNkZWZnaGlqa2xtbm9w',
      );
      log.info(
        { password: 'hunter2', apiKey: 'k-123', headers: { authorization: 'Basic xyz' }, user: { token: 't0k' } },
        'keys',
      );
      log.info('collector x-honeycomb-team=hc-secret-123');
      const out = c.lines.join('');
      for (const s of [
        's3cr3t-pw',
        'alice@example.com',
        env.ANTHROPIC_API_KEY,
        env.AWS_SECRET_ACCESS_KEY,
        'ZZZZZZZZZZZZZZZZZZZZ',
        'abc.def.ghi123',
        'AKIAIOSFODNN7EXAMPLE',
        'ABSKQmVkcm9ja0FQSUtleS1hYmNkZWZnaGlqa2xtbm9w',
        'hunter2',
        'k-123',
        'Basic xyz',
        't0k',
        'hc-secret-123',
      ]) {
        expect(out, s).not.toContain(s);
      }
      expect(out).toContain('{{password}}');
      expect(out).toContain('[REDACTED]');
      expect(out).toContain('login failed for {{username}} with {{password}}');
    });

    it('FR-6: hyphenated sensitive keys (x-api-key) are censored at any depth', () => {
      const c = capture();
      const log = createLogger({ level: 'info', format: 'json', stream: c.stream });
      log.info(
        {
          'x-api-key': 'top-k3y',
          headers: { 'x-api-key': 'hdr-k3y', 'X-Api-Key': 'mixed-k3y' },
          req: { headers: { 'x-api-key': 'deep-k3y' } },
        },
        'call',
      );
      const out = c.lines.join('');
      for (const v of ['top-k3y', 'hdr-k3y', 'mixed-k3y', 'deep-k3y']) expect(out, v).not.toContain(v);
      const [line] = c.json();
      expect(line.headers['x-api-key']).toBe('[REDACTED]');
      expect(line.req.headers['x-api-key']).toBe('[REDACTED]');
    });

    it('pretty output is redacted too', () => {
      const c = capture();
      createLogger({ level: 'info', format: 'pretty', stream: c.stream, redactor }).warn(
        { detail: 'pw s3cr3t-pw' },
        `key ${env.ANTHROPIC_API_KEY}`,
      );
      expect(c.lines[0]).not.toContain('s3cr3t-pw');
      expect(c.lines[0]).not.toContain('REALKEY');
    });

    it('envSecretEntries only registers known secret variables (not HOME etc.)', () => {
      const values = envSecretEntries(env).map((e) => e.value);
      expect(values).toContain(env.ANTHROPIC_API_KEY);
      expect(values).toContain('hc-secret-123');
      expect(values).not.toContain('/home/u');
    });

    it('scrubSecrets handles shapes without knowing the values', () => {
      expect(scrubSecrets('x sk-ant-admin01-abcdefghijklmnop y')).toBe('x [REDACTED] y');
      expect(scrubSecrets('Bearer abcdefghijk')).toBe('Bearer [REDACTED]');
      expect(scrubSecrets('plain text with sk and bearer words')).toBe('plain text with sk and bearer words');
    });
  });
});
