// Parsing of optional capability directives appended to a model id.
//
// GitHub Copilot exposes some capabilities (e.g. Claude "High reasoning" or
// "1M context") as distinct model ids, but for the GPT-5 family the reasoning
// effort is a request parameter (`reasoning.effort`) rather than a separate id.
// To give clients a uniform way to request these, we accept a bracketed suffix
// on the model name and strip it before talking to the upstream API:
//
//   gpt-5.5[high]                 -> model gpt-5.5,            effort "high"
//   gpt-5.5[xhigh]                -> model gpt-5.5,            effort "xhigh"
//   claude-opus-4.8[1m]           -> model claude-opus-4.8,    context1m true
//   gpt-5.5[high,1m]              -> model gpt-5.5,            effort "high" + context1m
//   claude-opus-4.7-1m-internal[1m] -> model claude-opus-4.7-1m-internal (suffix stripped)
//
// Stripping is the important part: it keeps pre-existing client configs that
// already carry a `[1m]` suffix from 400-ing against the upstream model list.
//
// NOTE on the `1m` directive: it is recognised and stripped, but the proxy does
// NOT need to send anything extra to "unlock" 1M context. The newer Claude
// models (e.g. claude-opus-4.8) advertise max_context_window_tokens=1_000_000
// natively in /models — verified empirically: a plain `claude-opus-4.8` request
// with a ~414K-token prompt returns 200 (usage.prompt_tokens=413886). The
// 200K/1M switch shown in the VS Code UI is a client-side context-budgeting
// choice, not an API parameter. Older 4.6/4.7 expose 1M as a separate model id
// (claude-opus-4.6-1m / claude-opus-4.7-1m-internal) which clients pass through
// directly. So `context1m` is informational only; the upstream request body is
// passed through unchanged and large prompts already get the full window.

export type ReasoningEffort =
  | "none"
  | "minimal"
  | "low"
  | "medium"
  | "high"
  | "xhigh"
  | "max"

const EFFORT_VALUES = new Set<ReasoningEffort>([
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
])

export interface ModelSpec {
  /** Bare model id with any `[...]` directive removed. */
  model: string
  /** Reasoning effort requested via suffix, if any. */
  effort?: ReasoningEffort
  /** Whether a 1M-context directive was present. */
  context1m: boolean
}

/**
 * Parse capability directives from a model id. Always returns a usable bare
 * `model`; unrecognised directive tokens are ignored (but still stripped).
 */
export function parseModelSpec(rawModel: string): ModelSpec {
  const spec: ModelSpec = { model: rawModel, context1m: false }

  // Collect every bracketed group, e.g. "[high][1m]" or "[high,1m]".
  const directives: Array<string> = []
  const stripped = rawModel.replaceAll(
    /\[([^\]]*)\]/g,
    (_match, inner: string) => {
      directives.push(inner)
      return ""
    },
  )

  spec.model = stripped.trim()

  for (const group of directives) {
    for (const token of group.split(/[,\s]+/)) {
      const value = token.trim().toLowerCase()
      if (!value) continue
      if (value === "1m" || value === "context-1m" || value === "context1m") {
        spec.context1m = true
      } else if (EFFORT_VALUES.has(value as ReasoningEffort)) {
        spec.effort = value as ReasoningEffort
      }
      // Unknown tokens are intentionally ignored.
    }
  }

  return spec
}
