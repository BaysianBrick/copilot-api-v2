import { describe, expect, test } from "bun:test"

import type { ChatCompletionsPayload } from "~/services/copilot/create-chat-completions"

import { estimateInputTokens } from "~/routes/messages/count-tokens-handler"

describe("Anthropic token-count fallback", () => {
  test("returns a conservative positive estimate for an unknown model", () => {
    const payload: ChatCompletionsPayload = {
      model: "unlisted-model",
      messages: [
        {
          role: "user",
          content: "A message that must not be counted as one token.",
        },
      ],
    }

    expect(estimateInputTokens(payload)).toBeGreaterThan(1)
  })
})
