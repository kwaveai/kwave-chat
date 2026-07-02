// KWV usage-reporter sink resolution.
//
// The report URL and per-company bearer are injected as ENV on the chat
// machine by the KWAVE companion (same channel-env sweep that manages the
// kwv logistics vars). The machine only ever holds its own derived
// per-company bearer, never the shared provisioning secret. Both vars
// absent => the reporter idles (feature off for this machine).

import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";

export type UsageReportSink =
  | { kind: "configured"; url: string; bearer: string }
  | { kind: "missing"; reason: string };

export function resolveUsageReportSink(env: NodeJS.ProcessEnv = process.env): UsageReportSink {
  const url = normalizeOptionalString(env.KWAVE_USAGE_REPORT_URL);
  const bearer = normalizeOptionalString(env.KWAVE_USAGE_REPORT_BEARER);
  if (!url) {
    return { kind: "missing", reason: "KWAVE_USAGE_REPORT_URL is not set" };
  }
  if (!bearer) {
    return { kind: "missing", reason: "KWAVE_USAGE_REPORT_BEARER is not set" };
  }
  return { kind: "configured", url, bearer };
}
