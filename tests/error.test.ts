import { describe, expect, test } from "bun:test"

import { toAnthropicErrorPayload, toOpenAIErrorPayload } from "~/lib/error"

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

describe("OpenAI error translation", () => {
  test("preserves an upstream OpenAI error and code", () => {
    const payload = toOpenAIErrorPayload(
      400,
      JSON.stringify({
        error: {
          message: "Invalid input.",
          type: "invalid_request_error",
          code: "invalid_request_body",
        },
      }),
    )

    expect(payload).toEqual({
      error: {
        message: "Invalid input.",
        type: "invalid_request_error",
        code: "invalid_request_body",
      },
    })
  })

  test("maps a plain-text rate limit response", () => {
    expect(toOpenAIErrorPayload(429, "Slow down")).toEqual({
      error: { message: "Slow down", type: "rate_limit_error" },
    })
  })
})
