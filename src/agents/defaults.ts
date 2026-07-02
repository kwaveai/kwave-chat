// Defaults for agent metadata when upstream does not supply them.
// KWAVE machines ship no baked openclaw.json, so this pair IS the model a
// fresh chat session and the heartbeat bill against. It must stay on the
// KWAVE-funded provider (Anthropic, OAuth-billed); an OpenAI default here
// silently burns the metered OpenAI pool key (2026-06 billing incident).
//
// KWAVE_DEFAULT_PROVIDER / KWAVE_DEFAULT_MODEL: the companion pushes the
// admin Model registry's "default" selection into the machine env, so the
// platform default is dashboard-changeable without an image rebuild.
// Unset/blank env keeps the safe baked-in pair.
function envDefault(name: string): string | null {
  const value = process.env[name]?.trim();
  return value ? value : null;
}
export const DEFAULT_PROVIDER = envDefault("KWAVE_DEFAULT_PROVIDER") ?? "anthropic";
export const DEFAULT_MODEL = envDefault("KWAVE_DEFAULT_MODEL") ?? "claude-sonnet-4-6";
// Conservative fallback used when model metadata is unavailable.
export const DEFAULT_CONTEXT_TOKENS = 200_000;
