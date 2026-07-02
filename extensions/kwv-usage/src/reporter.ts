// KWV usage reporter - subscribes to trusted "model.usage" diagnostic
// events (one per finished assistant run: chat replies AND cron/heartbeat
// isolated runs) and ships them to the KWAVE platform, which lands them in
// the workspace cost ledger. Without this, chat LLM spend is invisible to
// the platform (the ledger only sees paperclip heartbeat runs) - the exact
// blind spot behind the 2026-06 OpenAI billing incident.
//
// Fail-soft by design: no sink env => idle; transport errors => events are
// retained up to a small cap, then oldest dropped. Reporting must never
// block or break the chat loop.

import {
  onInternalDiagnosticEvent,
  type DiagnosticEventMetadata,
  type DiagnosticEventPayload,
} from "openclaw/plugin-sdk/diagnostic-runtime";
import type {
  OpenClawPluginService,
  OpenClawPluginServiceContext,
} from "openclaw/plugin-sdk/plugin-entry";
import { resolveUsageReportSink, type UsageReportSink } from "./config.js";

/** Structural subset of DiagnosticUsageEvent (core type is not exported by the SDK barrel). */
type ModelUsageEvent = {
  type: "model.usage";
  ts: number;
  sessionKey?: string;
  channel?: string;
  provider?: string;
  model?: string;
  usage: {
    input?: number;
    output?: number;
    cacheRead?: number;
    cacheWrite?: number;
    total?: number;
  };
  costUsd?: number;
  durationMs?: number;
};

export type UsageReportEvent = {
  occurredAt: string;
  provider: string;
  model: string;
  channel?: string;
  sessionKey?: string;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  costUsd?: number;
  durationMs?: number;
};

export type UsageReporterDeps = {
  env: NodeJS.ProcessEnv;
  fetchImpl: typeof fetch;
  subscribe: typeof onInternalDiagnosticEvent;
  /** Flush cadence for a partially filled buffer. */
  flushIntervalMs: number;
  /** Flush immediately once the buffer reaches this size. */
  maxBatch: number;
  /** Hard cap on retained (unsent) events; oldest dropped beyond it. */
  maxBuffer: number;
};

const DEFAULT_DEPS: UsageReporterDeps = {
  env: process.env,
  fetchImpl: fetch,
  subscribe: onInternalDiagnosticEvent,
  flushIntervalMs: 30_000,
  maxBatch: 20,
  maxBuffer: 200,
};

function isModelUsageEvent(
  event: DiagnosticEventPayload,
  metadata: DiagnosticEventMetadata,
): event is DiagnosticEventPayload & ModelUsageEvent {
  // Only the trusted dispatcher emits model.usage; untrusted lookalikes are dropped.
  return metadata.trusted === true && event.type === "model.usage";
}

export function toReportEvent(event: ModelUsageEvent): UsageReportEvent | null {
  const input = event.usage.input ?? 0;
  const output = event.usage.output ?? 0;
  const cacheRead = event.usage.cacheRead ?? 0;
  const costUsd = event.costUsd ?? 0;
  // Nothing billable happened (e.g. an aborted run) - not worth a ledger row.
  if (input + output + cacheRead <= 0 && costUsd <= 0) {
    return null;
  }
  return {
    occurredAt: new Date(event.ts).toISOString(),
    provider: event.provider ?? "unknown",
    model: event.model ?? "unknown",
    channel: event.channel,
    sessionKey: event.sessionKey,
    inputTokens: input,
    cachedInputTokens: cacheRead,
    outputTokens: output,
    costUsd: event.costUsd,
    durationMs: event.durationMs,
  };
}

export type UsageReporter = {
  service: OpenClawPluginService;
  /** Test seam: drains the buffer now instead of waiting for the timer. */
  flushNow: () => Promise<void>;
};

export function createUsageReporter(overrides: Partial<UsageReporterDeps> = {}): UsageReporter {
  const deps: UsageReporterDeps = { ...DEFAULT_DEPS, ...overrides };
  let sink: UsageReportSink = { kind: "missing", reason: "service not started" };
  let buffer: UsageReportEvent[] = [];
  let unsubscribe: (() => void) | undefined;
  let timer: ReturnType<typeof setInterval> | undefined;
  let flushing = false;
  let logger: OpenClawPluginServiceContext["logger"] | undefined;

  async function flushNow(): Promise<void> {
    if (sink.kind !== "configured" || flushing || buffer.length === 0) {
      return;
    }
    flushing = true;
    const batch = buffer;
    buffer = [];
    try {
      const res = await deps.fetchImpl(sink.url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${sink.bearer}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ events: batch }),
      });
      if (!res.ok) {
        throw new Error(`usage sink returned HTTP ${res.status}`);
      }
    } catch (err) {
      // Keep the unsent batch (newest last) but never grow past the cap -
      // a dead sink must not leak memory on a long-lived machine.
      buffer = [...batch, ...buffer].slice(-deps.maxBuffer);
      logger?.warn?.(
        `kwv-usage: report failed, retaining ${buffer.length} event(s): ${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      flushing = false;
    }
  }

  function onEvent(event: DiagnosticEventPayload, metadata: DiagnosticEventMetadata): void {
    if (!isModelUsageEvent(event, metadata)) {
      return;
    }
    const report = toReportEvent(event);
    if (!report) {
      return;
    }
    buffer.push(report);
    if (buffer.length > deps.maxBuffer) {
      buffer = buffer.slice(-deps.maxBuffer);
    }
    if (buffer.length >= deps.maxBatch) {
      void flushNow();
    }
  }

  const service: OpenClawPluginService = {
    id: "kwv-usage",
    start(ctx) {
      logger = ctx.logger;
      sink = resolveUsageReportSink(deps.env);
      if (sink.kind === "missing") {
        ctx.logger.info(`kwv-usage: idle (${sink.reason})`);
        return;
      }
      unsubscribe = deps.subscribe(onEvent);
      timer = setInterval(() => {
        void flushNow();
      }, deps.flushIntervalMs);
      timer.unref?.();
      ctx.logger.info("kwv-usage: reporting model usage to the KWAVE platform");
    },
    stop() {
      unsubscribe?.();
      unsubscribe = undefined;
      if (timer) {
        clearInterval(timer);
        timer = undefined;
      }
      // Best-effort final drain; stop must not hang on a dead sink.
      void flushNow();
    },
  };

  return { service, flushNow };
}
