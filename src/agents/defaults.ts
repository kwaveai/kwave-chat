// Defaults for agent metadata when upstream does not supply them.
// KWAVE machines ship no baked openclaw.json, so this pair IS the model a
// fresh chat session and the heartbeat bill against. It must stay on the
// KWAVE-funded provider (Anthropic, OAuth-billed); an OpenAI default here
// silently burns the metered OpenAI pool key (2026-06 billing incident).
export const DEFAULT_PROVIDER = "anthropic";
export const DEFAULT_MODEL = "claude-sonnet-4-6";
// Conservative fallback used when model metadata is unavailable.
export const DEFAULT_CONTEXT_TOKENS = 200_000;
