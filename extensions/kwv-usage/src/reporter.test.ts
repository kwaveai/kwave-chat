import type {
  DiagnosticEventMetadata,
  DiagnosticEventPayload,
} from "openclaw/plugin-sdk/diagnostic-runtime";
import type { OpenClawPluginServiceContext } from "openclaw/plugin-sdk/plugin-entry";
import { describe, expect, it, vi } from "vitest";
import { createUsageReporter, toReportEvent } from "./reporter.js";

type Listener = (event: DiagnosticEventPayload, metadata: DiagnosticEventMetadata) => void;

const TRUSTED = { trusted: true } as DiagnosticEventMetadata;
const UNTRUSTED = { trusted: false } as DiagnosticEventMetadata;

function usageEvent(overrides: Record<string, unknown> = {}): DiagnosticEventPayload {
  return {
    type: "model.usage",
    ts: 1_750_000_000_000,
    seq: 1,
    channel: "webchat",
    sessionKey: "session-1",
    provider: "openai",
    model: "gpt-5.5",
    usage: { input: 1200, output: 340, cacheRead: 800 },
    costUsd: 0.0123,
    durationMs: 2100,
    ...overrides,
  } as unknown as DiagnosticEventPayload;
}

function serviceCtx(): OpenClawPluginServiceContext {
  return {
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  } as unknown as OpenClawPluginServiceContext;
}

function okFetch(): typeof fetch {
  return vi.fn(async () => new Response(null, { status: 200 })) as unknown as typeof fetch;
}

function harness(overrides: Record<string, unknown> = {}) {
  let listener: Listener | undefined;
  const unsubscribe = vi.fn();
  const subscribe = vi.fn((fn: Listener) => {
    listener = fn;
    return unsubscribe;
  });
  const fetchImpl = (overrides.fetchImpl as typeof fetch | undefined) ?? okFetch();
  const reporter = createUsageReporter({
    env: {
      KWAVE_USAGE_REPORT_URL: "https://agent.example/api/_kwave/usage/report",
      KWAVE_USAGE_REPORT_BEARER: "company-1.abc",
    },
    fetchImpl,
    subscribe: subscribe as never,
    flushIntervalMs: 60_000,
    maxBatch: 3,
    maxBuffer: 5,
    ...overrides,
  });
  return {
    reporter,
    fetchImpl: fetchImpl as ReturnType<typeof vi.fn>,
    subscribe,
    unsubscribe,
    emit: (event: DiagnosticEventPayload, metadata: DiagnosticEventMetadata) =>
      listener?.(event, metadata),
  };
}

describe("toReportEvent", () => {
  it("maps a usage event to the report payload", () => {
    const report = toReportEvent({
      type: "model.usage",
      ts: 1_750_000_000_000,
      channel: "webchat",
      sessionKey: "s",
      provider: "anthropic",
      model: "claude-sonnet-4-6",
      usage: { input: 10, output: 5, cacheRead: 2 },
      costUsd: 0.01,
      durationMs: 900,
    });
    expect(report).toEqual({
      occurredAt: new Date(1_750_000_000_000).toISOString(),
      provider: "anthropic",
      model: "claude-sonnet-4-6",
      channel: "webchat",
      sessionKey: "s",
      inputTokens: 10,
      cachedInputTokens: 2,
      outputTokens: 5,
      costUsd: 0.01,
      durationMs: 900,
    });
  });

  it("drops events with no billable usage", () => {
    expect(toReportEvent({ type: "model.usage", ts: 1, usage: {}, costUsd: 0 })).toBeNull();
  });

  it("falls back to unknown provider/model", () => {
    const report = toReportEvent({ type: "model.usage", ts: 1, usage: { input: 1 } });
    expect(report?.provider).toBe("unknown");
    expect(report?.model).toBe("unknown");
  });
});

describe("createUsageReporter", () => {
  it("idles without subscribing when the sink env is missing", () => {
    const subscribe = vi.fn();
    const reporter = createUsageReporter({ env: {}, subscribe: subscribe as never });
    reporter.service.start(serviceCtx());
    expect(subscribe).not.toHaveBeenCalled();
  });

  it("flushes a batch once maxBatch is reached", async () => {
    const h = harness();
    h.reporter.service.start(serviceCtx());
    h.emit(usageEvent(), TRUSTED);
    h.emit(usageEvent(), TRUSTED);
    expect(h.fetchImpl).not.toHaveBeenCalled();
    h.emit(usageEvent(), TRUSTED);
    await h.reporter.flushNow();
    expect(h.fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = h.fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://agent.example/api/_kwave/usage/report");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer company-1.abc");
    const body = JSON.parse(String(init.body)) as { events: unknown[] };
    expect(body.events).toHaveLength(3);
  });

  it("ignores untrusted and non-usage events", async () => {
    const h = harness();
    h.reporter.service.start(serviceCtx());
    h.emit(usageEvent(), UNTRUSTED);
    h.emit({ type: "model.failover", ts: 1, seq: 2 } as unknown as DiagnosticEventPayload, TRUSTED);
    await h.reporter.flushNow();
    expect(h.fetchImpl).not.toHaveBeenCalled();
  });

  it("retains events (capped) when the sink fails, and resends later", async () => {
    let fail = true;
    const fetchImpl = vi.fn(async () => {
      if (fail) {
        throw new Error("sink down");
      }
      return new Response(null, { status: 200 });
    }) as unknown as typeof fetch;
    const h = harness({ fetchImpl, maxBatch: 100 });
    h.reporter.service.start(serviceCtx());
    for (let i = 0; i < 8; i++) {
      h.emit(usageEvent({ seq: i }), TRUSTED);
    }
    await h.reporter.flushNow();
    expect(h.fetchImpl).toHaveBeenCalledTimes(1);
    // maxBuffer=5: the failed batch is retained but capped to the newest 5.
    fail = false;
    await h.reporter.flushNow();
    expect(h.fetchImpl).toHaveBeenCalledTimes(2);
    const [, init] = (h.fetchImpl as ReturnType<typeof vi.fn>).mock.calls[1] as [
      string,
      RequestInit,
    ];
    const body = JSON.parse(String(init.body)) as { events: unknown[] };
    expect(body.events).toHaveLength(5);
  });

  it("unsubscribes and drains on stop", async () => {
    const h = harness();
    h.reporter.service.start(serviceCtx());
    h.emit(usageEvent(), TRUSTED);
    h.reporter.service.stop?.(serviceCtx());
    expect(h.unsubscribe).toHaveBeenCalledTimes(1);
    // stop() kicks a best-effort flush of the remaining single event.
    await h.reporter.flushNow();
    expect(h.fetchImpl).toHaveBeenCalled();
  });
});
