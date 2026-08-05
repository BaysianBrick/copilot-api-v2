import { describe, expect, test } from "bun:test"

import type { ResponsesPayload } from "~/services/copilot/create-responses"

import { normalizeResponsesPayload } from "~/routes/responses/handler"
import {
  adaptResponsesPayloadForCopilot,
  adaptStaleAgentHistoryForCopilot,
  normalizeResponsesInput,
  recoverStaleAgentHistoryStream,
  restoreCodexCollaborationToolNames,
  type ResponsesStreamItem,
} from "~/services/copilot/create-responses"

const payload = (model: string): ResponsesPayload => ({
  model,
  input: [{ role: "user", content: "hello" }],
})

const collaborationPayload = (v2: boolean): ResponsesPayload => ({
  model: "gpt-5.6-sol",
  input: [
    {
      type: "namespace",
      name: "collaboration",
      tools: [
        {
          type: "function",
          name: "spawn_agent",
          parameters: {
            type: "object",
            properties: {
              task_name: { type: "string" },
              message: { type: "string" },
              ...(v2 && { agent_type: { type: "string" } }),
            },
          },
        },
      ],
    },
  ],
})

const encryptedAgentMessage = (id: string) => ({
  type: "agent_message",
  id,
  author: "/root/worker",
  recipient: "/root",
  content: [
    { type: "input_text", text: "worker result" },
    { type: "encrypted_content", encrypted_content: "agent-secret" },
  ],
})

const interAgentAssistantMessage = {
  type: "message",
  role: "assistant",
  content: [
    {
      type: "output_text",
      text: JSON.stringify({
        author: "/root",
        recipient: "/root/worker",
        other_recipients: [],
        content: "continue",
        trigger_turn: true,
      }),
    },
  ],
}

const streamOf = (
  ...items: Array<ResponsesStreamItem>
): AsyncIterable<ResponsesStreamItem> => ({
  [Symbol.asyncIterator](): AsyncIterator<ResponsesStreamItem> {
    let index = 0
    return {
      next: () =>
        Promise.resolve(
          index < items.length ?
            { done: false, value: items[index++] }
          : { done: true, value: undefined },
        ),
    }
  },
})

const streamEvent = (value: unknown): ResponsesStreamItem => ({
  data: JSON.stringify(value),
})

const collectStream = async (stream: AsyncIterable<ResponsesStreamItem>) => {
  const items: Array<ResponsesStreamItem> = []
  for await (const item of stream) items.push(item)
  return items
}

describe("Responses request normalization", () => {
  test("normalizes a string input into one user message", () => {
    const input: ResponsesPayload = {
      model: "gpt-5.6-sol",
      input: "hello",
    }

    expect(normalizeResponsesPayload(input).input).toEqual([
      { role: "user", content: "hello" },
    ])
  })

  test("preserves an array input", () => {
    const input = payload("gpt-5.6-sol")
    expect(Object.is(normalizeResponsesPayload(input), input)).toBe(true)
    expect(normalizeResponsesPayload(input).input).toEqual([
      { role: "user", content: "hello" },
    ])
  })

  test("strips the 1m model directive", () => {
    expect(normalizeResponsesPayload(payload("gpt-5.6-sol[1m]")).model).toBe(
      "gpt-5.6-sol",
    )
  })

  test("lifts an effort directive into Responses reasoning", () => {
    expect(
      normalizeResponsesPayload(payload("gpt-5.6-sol[xhigh,1m]")),
    ).toMatchObject({
      model: "gpt-5.6-sol",
      reasoning: { effort: "xhigh" },
    })
  })

  test("preserves max as a distinct effort above xhigh", () => {
    expect(
      normalizeResponsesPayload(payload("gpt-5.6-sol[max,1m]")),
    ).toMatchObject({
      model: "gpt-5.6-sol",
      reasoning: { effort: "max" },
    })
  })

  test("does not override explicit Responses reasoning", () => {
    const input = {
      ...payload("gpt-5.6-sol[xhigh]"),
      reasoning: { effort: "low" },
    }
    expect(normalizeResponsesPayload(input).reasoning?.effort).toBe("low")
  })
})

describe("Copilot multi-agent namespace compatibility", () => {
  test("normalizes string input at the Copilot client boundary", () => {
    const input: ResponsesPayload = {
      model: "gpt-5.6-sol",
      input: "hello",
    }

    expect(normalizeResponsesInput(input).input).toEqual([
      { role: "user", content: "hello" },
    ])
    expect(adaptResponsesPayloadForCopilot(input).input).toEqual([
      { role: "user", content: "hello" },
    ])
  })

  test("downgrades clearly plaintext agent content mislabeled as encrypted", () => {
    const input = {
      model: "gpt-5.6-terra",
      input: [
        {
          type: "agent_message",
          author: "/root",
          recipient: "/root/worker",
          content: [
            { type: "input_text", text: "Message Type: NEW_TASK\nPayload:\n" },
            {
              type: "encrypted_content",
              encrypted_content: "Read package.json and report its version.",
            },
          ],
        },
      ],
    } as unknown as ResponsesPayload

    expect(adaptResponsesPayloadForCopilot(input).input[0]).toMatchObject({
      type: "agent_message",
      content: [
        { type: "input_text", text: "Message Type: NEW_TASK\nPayload:\n" },
        {
          type: "input_text",
          text: "Read package.json and report its version.",
        },
      ],
    })
  })

  test("preserves opaque encrypted agent content", () => {
    const encryptedContent = `gAAAAA${"x".repeat(120)}`
    const input = {
      model: "gpt-5.6-terra",
      input: [
        {
          type: "agent_message",
          author: "/root",
          recipient: "/root/worker",
          content: [
            {
              type: "encrypted_content",
              encrypted_content: encryptedContent,
            },
          ],
        },
      ],
    } as unknown as ResponsesPayload

    expect(Object.is(adaptResponsesPayloadForCopilot(input), input)).toBe(true)
  })

  test("aliases the V2 collaboration namespace", () => {
    const input = collaborationPayload(true)
    const output = adaptResponsesPayloadForCopilot(input)

    expect(output.input[0]).toMatchObject({
      type: "namespace",
      name: "codex_collaboration",
    })
    expect(input.input[0]).toMatchObject({ name: "collaboration" })
  })

  test("leaves the legacy collaboration namespace unchanged", () => {
    const input = collaborationPayload(false)
    expect(Object.is(adaptResponsesPayloadForCopilot(input), input)).toBe(true)
  })

  test("aliases a V2 namespace nested inside an input item", () => {
    const namespace = collaborationPayload(true).input[0]
    const input = {
      model: "gpt-5.6-sol",
      input: [
        {
          role: "developer" as const,
          content: [{ type: "input_text", text: "tools", nested: namespace }],
        },
      ],
    } as unknown as ResponsesPayload

    const output = adaptResponsesPayloadForCopilot(input) as unknown as {
      input: Array<{ content: Array<{ nested: { name: string } }> }>
    }
    expect(output.input[0].content[0].nested.name).toBe("codex_collaboration")
  })

  test("strips consumed agent encryption but preserves pending agent content", () => {
    const input = {
      model: "gpt-5.6-sol",
      input: [
        encryptedAgentMessage("amsg_consumed"),
        {
          type: "reasoning",
          summary: [],
          content: null,
          encrypted_content: "reasoning-secret",
        },
        encryptedAgentMessage("amsg_pending"),
      ],
    } as unknown as ResponsesPayload

    expect(Object.is(adaptResponsesPayloadForCopilot(input), input)).toBe(true)
    expect(adaptStaleAgentHistoryForCopilot(input).input as unknown).toEqual([
      {
        type: "agent_message",
        id: "amsg_consumed",
        author: "/root/worker",
        recipient: "/root",
        content: [{ type: "input_text", text: "worker result" }],
      },
      {
        type: "reasoning",
        summary: [],
        content: null,
        encrypted_content: "reasoning-secret",
      },
      encryptedAgentMessage("amsg_pending"),
    ])
    expect(input.input[0]).toMatchObject({
      content: [{ type: "input_text" }, { type: "encrypted_content" }],
    })
    expect(input.input[2]).toMatchObject({
      content: [{ type: "input_text" }, { type: "encrypted_content" }],
    })
  })

  test("does not treat serialized inter-agent instructions as model output", () => {
    const input = {
      model: "gpt-5.6-sol",
      input: [
        encryptedAgentMessage("amsg_before_instruction"),
        interAgentAssistantMessage,
        encryptedAgentMessage("amsg_after_instruction"),
      ],
    } as unknown as ResponsesPayload

    expect(Object.is(adaptStaleAgentHistoryForCopilot(input), input)).toBe(true)
    expect(input.input as unknown).toEqual([
      encryptedAgentMessage("amsg_before_instruction"),
      interAgentAssistantMessage,
      encryptedAgentMessage("amsg_after_instruction"),
    ])
  })

  test("treats ordinary assistant messages as model output", () => {
    const input = {
      model: "gpt-5.6-sol",
      input: [
        encryptedAgentMessage("amsg_consumed"),
        {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "acknowledged" }],
        },
      ],
    } as unknown as ResponsesPayload

    expect(adaptStaleAgentHistoryForCopilot(input).input[0]).toMatchObject({
      content: [{ type: "input_text" }],
    })
  })

  test("agent-history compatibility adaptation is idempotent", () => {
    const input = {
      model: "gpt-5.6-sol",
      input: [
        encryptedAgentMessage("amsg_consumed"),
        {
          type: "reasoning",
          summary: [],
          content: null,
          encrypted_content: "reasoning-secret",
        },
      ],
    } as unknown as ResponsesPayload

    const first = adaptStaleAgentHistoryForCopilot(input)
    const second = adaptStaleAgentHistoryForCopilot(first)
    expect(second).toEqual(first)
    expect(Object.is(second, first)).toBe(true)
  })
})

describe("Codex stale agent history recovery", () => {
  test("does not retry a successful response stream", async () => {
    const created = streamEvent({ type: "response.created" })
    const output = streamEvent({ type: "response.output_item.added" })
    const completed = streamEvent({ type: "response.completed" })
    let retries = 0

    const recovered = recoverStaleAgentHistoryStream(
      streamOf(created, output, completed),
      () => {
        retries += 1
        return Promise.resolve(streamOf())
      },
    )

    expect(await collectStream(recovered)).toEqual([created, output, completed])
    expect(retries).toBe(0)
  })

  test("retries an unexplained empty failure before output", async () => {
    const failedCreated = streamEvent({ type: "response.created" })
    const keepAlive = { event: "ping" }
    const metadata = streamEvent({ type: "response.metadata" })
    const malformed = { data: "not-json" }
    const failed = streamEvent({
      type: "response.failed",
      response: {
        id: "resp_failed",
        status: "failed",
        error: null,
        output: [],
      },
    })
    const retryCreated = streamEvent({ type: "response.created" })
    const completed = streamEvent({ type: "response.completed" })
    let retries = 0

    const recovered = recoverStaleAgentHistoryStream(
      streamOf(failedCreated, keepAlive, metadata, malformed, failed),
      () => {
        retries += 1
        return Promise.resolve(streamOf(retryCreated, completed))
      },
    )

    expect(await collectStream(recovered)).toEqual([retryCreated, completed])
    expect(retries).toBe(1)
  })

  test("does not retry a structured response failure", async () => {
    const created = streamEvent({ type: "response.created" })
    const failed = streamEvent({
      type: "response.failed",
      response: {
        status: "failed",
        error: { code: "invalid_request", message: "bad input" },
        output: [],
      },
    })
    let retries = 0

    const recovered = recoverStaleAgentHistoryStream(
      streamOf(created, failed),
      () => {
        retries += 1
        return Promise.resolve(streamOf())
      },
    )

    expect(await collectStream(recovered)).toEqual([created, failed])
    expect(retries).toBe(0)
  })

  test("does not retry after any response output was exposed", async () => {
    const created = streamEvent({ type: "response.created" })
    const output = streamEvent({ type: "response.output_item.added" })
    const failed = streamEvent({
      type: "response.failed",
      response: { status: "failed", error: null, output: [] },
    })
    let retries = 0

    const recovered = recoverStaleAgentHistoryStream(
      streamOf(created, output, failed),
      () => {
        retries += 1
        return Promise.resolve(streamOf())
      },
    )

    expect(await collectStream(recovered)).toEqual([created, output, failed])
    expect(retries).toBe(0)
  })

  test("fails open when the pre-output buffer reaches its bound", async () => {
    const created = streamEvent({ type: "response.created" })
    const keepAlives = Array.from({ length: 33 }, (_, index) => ({
      event: `ping-${index}`,
    }))
    const failed = streamEvent({
      type: "response.failed",
      response: { status: "failed", error: null, output: [] },
    })
    const inputItems = [created, ...keepAlives, failed]
    let retries = 0

    const recovered = recoverStaleAgentHistoryStream(
      streamOf(...inputItems),
      () => {
        retries += 1
        return Promise.resolve(streamOf())
      },
    )

    expect(await collectStream(recovered)).toEqual(inputItems)
    expect(retries).toBe(0)
  })

  test("fails open when the pre-output buffer reaches its byte bound", async () => {
    const created = streamEvent({ type: "response.created" })
    const oversizedMetadata = streamEvent({
      type: "response.metadata",
      metadata: "x".repeat(65_536),
    })
    const failed = streamEvent({
      type: "response.failed",
      response: { status: "failed", error: null, output: [] },
    })
    const inputItems = [created, oversizedMetadata, failed]
    let retries = 0

    const recovered = recoverStaleAgentHistoryStream(
      streamOf(...inputItems),
      () => {
        retries += 1
        return Promise.resolve(streamOf())
      },
    )

    expect(await collectStream(recovered)).toEqual(inputItems)
    expect(retries).toBe(0)
  })

  test("restores namespaced collaboration function names", () => {
    const input = {
      type: "response.output_item.added",
      item: {
        type: "function_call",
        namespace: "codex_collaboration",
        name: "codex_collaborationspawn_agent",
      },
    }

    expect(restoreCodexCollaborationToolNames(input)).toMatchObject({
      item: {
        namespace: "collaboration",
        name: "collaborationspawn_agent",
      },
    })
    expect(input.item.name).toBe("codex_collaborationspawn_agent")
  })
})
