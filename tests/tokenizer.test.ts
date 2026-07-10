import { describe, expect, test } from "bun:test"

import type { ChatCompletionsPayload } from "~/services/copilot/create-chat-completions"
import type { Model } from "~/services/copilot/get-models"

import { getTokenCount } from "~/lib/tokenizer"

const model: Model = {
  capabilities: {
    family: "gpt-5",
    limits: {},
    object: "model_capabilities",
    supports: {},
    tokenizer: "o200k_base",
    type: "chat",
  },
  id: "gpt-5.6-sol",
  model_picker_enabled: true,
  name: "GPT-5.6 Sol",
  object: "model",
  preview: false,
  vendor: "OpenAI",
  version: "",
}

describe("token counting", () => {
  test("counts ChatML special tokens instead of throwing", async () => {
    const payload: ChatCompletionsPayload = {
      model: model.id,
      messages: [{ role: "user", content: "<|im_end|>" }],
    }

    const count = await getTokenCount(payload, model)

    expect(count.input).toBeGreaterThan(0)
  })
})
