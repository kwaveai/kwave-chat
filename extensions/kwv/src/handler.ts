// Channel-agnostic KWV approval-button handler.
//
// Wired to the `kwv` interactive namespace on Telegram first; Slack/Discord
// reuse this exact handler because it only touches the portable subset of the
// interactive context (senderId, auth, callback payload, respond). The hard
// gate is that a human must actually tap the button: the model cannot
// synthesize a confirm, because execution happens only through the button
// click arriving inside the machine, then a POST to the apps/web confirm door.

import { isNormalizedSenderAllowed } from "openclaw/plugin-sdk/allow-from";
import { resolveConfirmDoor } from "./config.js";
import {
  postConfirmDecision,
  type ConfirmDecision,
  type ConfirmDoorResult,
} from "./confirm-client.js";

/** The portable subset of a channel interactive-handler context that KWV uses.
 *  Telegram/Slack/Discord contexts all provide these fields structurally. */
export interface KwvInteractiveContext {
  senderId?: string;
  accountId: string;
  auth: { isAuthorizedSender: boolean };
  callback: { namespace: string; payload: string };
  respond: {
    editMessage: (params: { text: string }) => Promise<void>;
    clearButtons: () => Promise<void>;
    reply: (params: { text: string }) => Promise<void>;
  };
}

export interface KwvHandlerDeps {
  /** Resolve the current approver allowlist (from plugin config). */
  getApprovers: () => Array<string>;
  /** Injectable for tests; defaults to global fetch. */
  fetchImpl?: typeof fetch;
  /** Injectable for tests; defaults to process.env. */
  env?: NodeJS.ProcessEnv;
}

type ParsedPayload =
  | { kind: "approve"; shortId: string }
  | { kind: "cancel"; shortId: string }
  | { kind: "invalid" };

const SHORT_ID_RE = /^[0-9a-f]{32}$/;

/** Parse the post-namespace payload: "a:<shortId>" or "c:<shortId>". */
export function parseKwvPayload(payload: string): ParsedPayload {
  const separatorIndex = payload.indexOf(":");
  if (separatorIndex < 0) {
    return { kind: "invalid" };
  }
  const action = payload.slice(0, separatorIndex);
  const shortId = payload.slice(separatorIndex + 1);
  if (!SHORT_ID_RE.test(shortId)) {
    return { kind: "invalid" };
  }
  if (action === "a") {
    return { kind: "approve", shortId };
  }
  if (action === "c") {
    return { kind: "cancel", shortId };
  }
  return { kind: "invalid" };
}

export async function handleKwvInteractive(
  ctx: KwvInteractiveContext,
  deps: KwvHandlerDeps,
): Promise<{ handled: true }> {
  const parsed = parseKwvPayload(ctx.callback.payload);
  if (parsed.kind === "invalid") {
    // Malformed button - do not touch the message; just tell the clicker.
    await ctx.respond.reply({ text: "This approval button is invalid or malformed." });
    return { handled: true };
  }

  // Two-gate authorization, both required. Gate 1: the channel already
  // authorized this sender. Gate 2: the sender is on the company approver
  // allowlist. isNormalizedSenderAllowed denies an empty list (fail-closed);
  // only an explicit "*" opts into wildcard. A denied clicker cannot reach
  // the confirm door - we reply and leave the button for a real approver.
  if (!isApprover(ctx, deps.getApprovers())) {
    await ctx.respond.reply({ text: "You are not authorized to approve KWAVE logistics actions." });
    return { handled: true };
  }

  const door = resolveConfirmDoor(deps.env ?? process.env);
  if (door.kind === "missing") {
    await finalize(
      ctx,
      `Approval service is not configured (${door.reason}). Nothing was changed.`,
    );
    return { handled: true };
  }

  const decision: ConfirmDecision = parsed.kind === "approve" ? "approve" : "cancel";
  const result = await postConfirmDecision({
    url: door.url,
    bearer: door.bearer,
    shortId: parsed.shortId,
    decision,
    fetchImpl: deps.fetchImpl,
  });

  await finalize(ctx, renderResult(result));
  return { handled: true };
}

function isApprover(ctx: KwvInteractiveContext, approvers: Array<string>): boolean {
  if (!ctx.auth.isAuthorizedSender) {
    return false;
  }
  const senderId = ctx.senderId;
  if (!senderId) {
    return false;
  }
  return isNormalizedSenderAllowed({ senderId, allowFrom: approvers });
}

function renderResult(result: ConfirmDoorResult): string {
  if (result.kind === "unauthorized") {
    return "Approval service rejected this machine's key (confirm door auth failed). Nothing was changed.";
  }
  if (result.kind === "transport-error") {
    return `Could not reach the approval service: ${result.message}`;
  }
  switch (result.status) {
    case "executed":
      return "✅ Approved and executed.";
    case "already-done":
      return "⚠️ Already completed - this action ran earlier and was not repeated.";
    case "cancelled":
      return "✖️ Cancelled - the action was discarded.";
    case "expired":
      return "⏰ Expired - this approval is no longer valid. Ask for a fresh one.";
    case "error":
      return result.message ? `❌ Failed: ${result.message}` : "❌ Failed.";
  }
}

/** Edit the message to its final state and drop the buttons so it can't be
 *  tapped again. Button removal is best-effort (they may already be gone). */
async function finalize(ctx: KwvInteractiveContext, text: string): Promise<void> {
  await ctx.respond.editMessage({ text });
  try {
    await ctx.respond.clearButtons();
  } catch {
    // Buttons already cleared or message too old - the text edit is what matters.
  }
}
