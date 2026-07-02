// KWV usage-reporter plugin entrypoint. Ships per-turn model usage
// (provider, model, tokens, cost) to the KWAVE platform so chat spend is
// visible in workspace cost dashboards. Sibling of the kwv logistics
// plugin; same trust model (per-company bearer from env, never the master
// provisioning secret).

import { definePluginEntry, type OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { createUsageReporter } from "./src/reporter.js";

export default definePluginEntry({
  id: "kwv-usage",
  name: "KWAVE Usage Reporter",
  description: "Reports per-turn model usage to the KWAVE platform cost ledger.",
  register(api: OpenClawPluginApi) {
    api.registerService(createUsageReporter().service);
  },
});
