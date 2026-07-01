// KWV plugin entrypoint. Registers the `kwv` interactive-button namespace so
// operators can approve/cancel irreversible KWAVE logistics stock writes from
// a channel button. Telegram first; Slack/Discord reuse the same handler.
//
// This plugin never holds the master provisioning secret and cannot call the
// MCP directly. It only reacts to a human button tap and POSTs the decision to
// the apps/web confirm door with the machine's per-company bearer (from env).

import { definePluginEntry, type OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { resolveApprovers } from "./src/config.js";
import { handleKwvInteractive, type KwvInteractiveContext } from "./src/handler.js";

const KWV_NAMESPACE = "kwv";
// Telegram ships first; Slack/Discord reuse the same channel-agnostic handler
// once their button-notify posting lands (main session).
const KWV_CHANNELS = ["telegram"] as const;

export default definePluginEntry({
  id: "kwv",
  name: "KWAVE Logistics Approval",
  description: "Approve or cancel irreversible KWAVE logistics stock writes from a channel button.",
  register(api: OpenClawPluginApi) {
    for (const channel of KWV_CHANNELS) {
      api.registerInteractiveHandler({
        channel,
        namespace: KWV_NAMESPACE,
        // The runtime passes the channel-specific interactive context; we use
        // only its portable subset (see KwvInteractiveContext).
        handler: (ctx) =>
          handleKwvInteractive(ctx as KwvInteractiveContext, {
            getApprovers: () => resolveApprovers(api.pluginConfig),
          }),
      });
    }
  },
});
