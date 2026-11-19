import { randomBytes } from 'node:crypto';
import { Redactor } from '../redact.js';
import type { Logger } from './logger.js';

export type AttrValue = string | number | boolean;
export type Attributes = Record<string, AttrValue | undefined>;

export interface Span {
  readonly traceId: string;
  readonly spanId: string;
  setAttributes(a: Attributes): void;
  recordError(e: unknown): void;
  end(): void;
}
export interface Tracer {
  readonly enabled: boolean;
  startSpan(name: string, opts?: { traceId?: string; parent?: Span; attributes?: Attributes }): Span;
  /** Exports ended spans. Never throws. */
  flush(): Promise<void>;
}

const hex = (bytes: number) => randomBytes(bytes).toString('hex');
const T0_NS = BigInt(Date.now()) * 1_000_000n;
const H0 = process.hrtime.bigint();
/** Wall-clock anchored, monotonic nanoseconds. */
const nowNs = () => (T0_NS + (process.hrtime.bigint() - H0)).toString();

const NOOP_SPAN: Span = {
  traceId: '0'.repeat(32),
  spanId: '0'.repeat(16),
  setAttributes() {},
  recordError() {},
  end() {},
};
const NOOP_TRACER: Tracer = { enabled: false, startSpan: () => NOOP_SPAN, flush: async () => {} };

interface OtlpSpan {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name: string;
  kind: number;
  startTimeUnixNano: string;
  endTimeUnixNano?: string;
  attributes: { key: string; value: Record<string, unknown> }[];
  status: { code: number; message?: string };
}

/** Parses `OTEL_EXPORTER_OTLP_HEADERS` (`k=v,k2=v2`, values may be URL-encoded). */
export function parseOtlpHeaders(raw: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const pair of (raw ?? '').split(',')) {
    const i = pair.indexOf('=');
    if (i <= 0) continue;
    const k = pair.slice(0, i).trim();
    const v = pair.slice(i + 1).trim();
    if (k) {
      try {
        out[k] = decodeURIComponent(v);
      } catch {
        out[k] = v;
      }
    }
  }
  return out;
}

/** OTLP endpoint for traces from the standard env vars, or undefined (= tracing off). */
export function tracesEndpoint(env: Record<string, string | undefined>): string | undefined {
  if (env.OTEL_SDK_DISABLED?.trim().toLowerCase() === 'true') return undefined;
  const specific = env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT?.trim();
  if (specific) return specific;
  const base = env.OTEL_EXPORTER_OTLP_ENDPOINT?.trim();
  return base ? `${base.replace(/\/+$/, '')}/v1/traces` : undefined;
}

/**
 * SPEC-013 FR-26/27: minimal OTLP/HTTP JSON trace exporter. Off (no-op) unless an OTLP endpoint env var is set.
 * Attribute values and error messages pass through `redactor` before export.
 */
export function createTracer(
  opts: { env?: Record<string, string | undefined>; fetch?: typeof fetch; redactor?: Redactor; log?: Logger } = {},
): Tracer {
  const env = opts.env ?? process.env;
  const endpoint = tracesEndpoint(env);
  if (!endpoint) return NOOP_TRACER;
  const doFetch = opts.fetch ?? fetch;
  const redactor = opts.redactor ?? Redactor.empty();
  const headers = {
    ...parseOtlpHeaders(env.OTEL_EXPORTER_OTLP_HEADERS),
    ...parseOtlpHeaders(env.OTEL_EXPORTER_OTLP_TRACES_HEADERS),
  };
  const serviceName = env.OTEL_SERVICE_NAME?.trim() || 'agentic-e2e';
  let done: OtlpSpan[] = [];

  const toAttr = (key: string, v: AttrValue) => ({
    key,
    value:
      typeof v === 'boolean'
        ? { boolValue: v }
        : typeof v === 'number'
          ? Number.isInteger(v)
            ? { intValue: String(v) }
            : { doubleValue: v }
          : { stringValue: redactor.redact(v) },
  });

  const tracer: Tracer = {
    enabled: true,
    startSpan(name, o = {}) {
      const traceId = o.parent?.traceId ?? (o.traceId && /^[0-9a-f]{32}$/.test(o.traceId) ? o.traceId : hex(16));
      const s: OtlpSpan = {
        traceId,
        spanId: hex(8),
        ...(o.parent ? { parentSpanId: o.parent.spanId } : {}),
        name: redactor.redact(name),
        kind: o.parent ? 1 : 2,
        startTimeUnixNano: nowNs(),
        attributes: [],
        status: { code: 0 },
      };
      let ended = false;
      const span: Span = {
        traceId,
        spanId: s.spanId,
        setAttributes(a) {
          for (const [k, v] of Object.entries(a)) if (v !== undefined) s.attributes.push(toAttr(k, v));
        },
        recordError(e) {
          s.status = { code: 2, message: redactor.redact((e as Error)?.message ?? String(e)) };
        },
        end() {
          if (ended) return;
          ended = true;
          s.endTimeUnixNano = nowNs();
          done.push(s);
        },
      };
      if (o.attributes) span.setAttributes(o.attributes);
      return span;
    },
    async flush() {
      if (!done.length) return;
      const spans = done;
      done = [];
      const body = {
        resourceSpans: [
          {
            resource: { attributes: [toAttr('service.name', serviceName)] },
            scopeSpans: [{ scope: { name: 'agentic-e2e' }, spans }],
          },
        ],
      };
      try {
        const res = await doFetch(endpoint, {
          method: 'POST',
          headers: { 'content-type': 'application/json', ...headers },
          body: JSON.stringify(body),
        });
        if (!res.ok) opts.log?.warn({ status: res.status, spans: spans.length }, 'otel.export_failed');
      } catch (e) {
        opts.log?.warn({ error: (e as Error).message, spans: spans.length }, 'otel.export_failed');
      }
    },
  };
  return tracer;
}
