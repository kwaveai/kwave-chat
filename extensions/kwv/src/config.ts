// KWV plugin config + confirm-door environment resolution.
//
// The confirm door URL and per-company bearer are injected as ENV on the
// chat machine (never hardcoded, never the master provisioning secret).
// The approver allowlist is plugin config (company-scoped, per machine).

import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";

export type KwvPluginConfig = {
  approvers?: Array<string>;
};

/** The apps/web "confirm door" the plugin POSTs decisions to. Missing when
 *  the machine has not been provisioned with both env vars yet. */
export type ConfirmDoor =
  | { kind: "configured"; url: string; bearer: string }
  | { kind: "missing"; reason: string };

export function resolveConfirmDoor(env: NodeJS.ProcessEnv = process.env): ConfirmDoor {
  const url = normalizeOptionalString(env.KWAVE_LOGISTICS_CONFIRM_URL);
  const bearer = normalizeOptionalString(env.KWAVE_LOGISTICS_CONFIRM_BEARER);
  if (!url) {
    return { kind: "missing", reason: "KWAVE_LOGISTICS_CONFIRM_URL is not set" };
  }
  if (!bearer) {
    return { kind: "missing", reason: "KWAVE_LOGISTICS_CONFIRM_BEARER is not set" };
  }
  return { kind: "configured", url, bearer };
}

/** Read the approver allowlist off the plugin config. Never falls back to a
 *  wildcard; an empty list denies everyone (enforced by isNormalizedSenderAllowed). */
export function resolveApprovers(pluginConfig: unknown): Array<string> {
  const cfg = (pluginConfig ?? {}) as KwvPluginConfig;
  if (!Array.isArray(cfg.approvers)) {
    return [];
  }
  return cfg.approvers.filter((entry): entry is string => typeof entry === "string");
}
