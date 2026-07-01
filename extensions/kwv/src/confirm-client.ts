// HTTP client for the apps/web "confirm door".
//
// The plugin cannot call the MCP directly and must not hold the master
// provisioning secret. It POSTs the operator's button decision to a
// dedicated apps/web endpoint, authenticated with the machine's own
// per-company bearer. apps/web verifies the bearer, resolves the shortId
// to that company's pending action, and executes (or discards) it.

import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";

export type ConfirmDecision = "approve" | "cancel";

/** Outcome states the confirm door reports back. */
export type ConfirmDoorStatus = "executed" | "already-done" | "cancelled" | "expired" | "error";

export type ConfirmDoorResult =
  | { kind: "ok"; ok: boolean; status: ConfirmDoorStatus; message?: string }
  | { kind: "unauthorized" }
  | { kind: "transport-error"; message: string };

export async function postConfirmDecision(params: {
  url: string;
  bearer: string;
  shortId: string;
  decision: ConfirmDecision;
  fetchImpl?: typeof fetch;
}): Promise<ConfirmDoorResult> {
  const doFetch = params.fetchImpl ?? fetch;

  let res: Response;
  try {
    res = await doFetch(params.url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${params.bearer}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ shortId: params.shortId, decision: params.decision }),
    });
  } catch (err) {
    return {
      kind: "transport-error",
      message: err instanceof Error ? err.message : String(err),
    };
  }

  if (res.status === 401) {
    return { kind: "unauthorized" };
  }
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    return { kind: "transport-error", message: `HTTP ${res.status}: ${text.slice(0, 200)}` };
  }

  const body = (await res.json().catch(() => null)) as {
    ok?: unknown;
    status?: unknown;
    message?: unknown;
  } | null;
  if (!body || typeof body.status !== "string") {
    return { kind: "transport-error", message: "confirm door returned a malformed body" };
  }

  return {
    kind: "ok",
    ok: body.ok === true,
    status: normalizeStatus(body.status),
    message: typeof body.message === "string" ? normalizeOptionalString(body.message) : undefined,
  };
}

function normalizeStatus(raw: string): ConfirmDoorStatus {
  switch (raw) {
    case "executed":
    case "already-done":
    case "cancelled":
    case "expired":
    case "error":
      return raw;
    default:
      return "error";
  }
}
