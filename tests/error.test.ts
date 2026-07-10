import { describe, expect, test } from "bun:test"

import { toAnthropicErrorPayload } from "~/lib/error"

describe("Anthropic error translation", () => {
  test("uses the Anthropic envelope and preserves an upstream error message", () => {
    const payload = toAnthropicErrorPayload(
      429,
      JSON.stringify({ error: { message: "Too many requests." } }),
    )

    expect(payload).toEqual({
      type: "error",
      error: {
        type: "rate_limit_error",
        message: "Too many requests.",
      },
    })
  })

  test("uses an API error for an unclassified response status", () => {
    const payload = toAnthropicErrorPayload(502, "Bad gateway")

    expect(payload).toEqual({
      type: "error",
      error: {
        type: "api_error",
        message: "Bad gateway",
      },
    })
  })
})
