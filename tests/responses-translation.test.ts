import { test, expect, describe } from "bun:test"

import type {
  ChatCompletionChunk,
  ChatCompletionsPayload,
} from "../src/services/copilot/create-chat-completions"
import type { ResponsesResult } from "../src/services/copilot/create-responses"

import {
  chatToResponsesPayload,
  responsesResultToChat,
  translateResponsesStream,
} from "../src/services/copilot/responses-translation"

describe("chatToResponsesPayload", () => {
  test("moves system messages into instructions", () => {
    const payload: ChatCompletionsPayload = {
      model: "gpt-5.5",
      messages: [
        { role: "system", content: "You are helpful." },
        { role: "user", content: "Hi" },
      ],
      max_tokens: 100,
    }
    const out = chatToResponsesPayload(payload)
    expect(out.instructions).toBe("You are helpful.")
    expect(out.input).toHaveLength(1)
    expect(out.input[0]).toEqual({
      role: "user",
      content: [{ type: "input_text", text: "Hi" }],
    })
    expect(out.max_output_tokens).toBe(100)
  })

  test("translates assistant tool calls and tool results to structured items", () => {
    const payload: ChatCompletionsPayload = {
      model: "gpt-5.5",
      messages: [
        { role: "user", content: "Weather in Paris?" },
        {
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: "call_1",
              type: "function",
              function: {
                name: "get_weather",
                arguments: '{"location":"Paris"}',
              },
            },
          ],
        },
        { role: "tool", tool_call_id: "call_1", content: "sunny" },
      ],
    }
    const out = chatToResponsesPayload(payload)
    expect(out.input).toEqual([
      {
        role: "user",
        content: [{ type: "input_text", text: "Weather in Paris?" }],
      },
      {
        type: "function_call",
        call_id: "call_1",
        name: "get_weather",
        arguments: '{"location":"Paris"}',
      },
      { type: "function_call_output", call_id: "call_1", output: "sunny" },
    ])
  })

  test("flattens tools and maps reasoning effort", () => {
    const payload: ChatCompletionsPayload = {
      model: "gpt-5.5",
      messages: [{ role: "user", content: "hi" }],
      reasoning_effort: "high",
      tools: [
        {
          type: "function",
          function: {
            name: "f",
            description: "d",
            parameters: { type: "object", properties: {} },
          },
        },
      ],
      tool_choice: "auto",
    }
    const out = chatToResponsesPayload(payload)
    expect(out.reasoning).toEqual({ effort: "high" })
    expect(out.tools).toEqual([
      {
        type: "function",
        name: "f",
        description: "d",
        parameters: { type: "object", properties: {} },
        strict: false,
      },
    ])
    expect(out.tool_choice).toBe("auto")
  })

  test("maps the 'max' effort alias to xhigh and drops unknown efforts", () => {
    expect(
      chatToResponsesPayload({
        model: "gpt-5.5",
        messages: [{ role: "user", content: "hi" }],
        reasoning_effort: "max",
      }).reasoning,
    ).toEqual({ effort: "xhigh" })

    expect(
      chatToResponsesPayload({
        model: "gpt-5.5",
        messages: [{ role: "user", content: "hi" }],
        reasoning_effort: "banana",
      }).reasoning,
    ).toBeUndefined()
  })
})

describe("responsesResultToChat", () => {
  test("extracts text and usage from copilot_usage", () => {
    const result: ResponsesResult = {
      id: "resp_1",
      object: "response",
      model: "gpt-5.5-2026-04-23",
      output: [
        { type: "reasoning", summary: [], content: [] },
        {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "PONG" }],
        },
      ],
      copilot_usage: {
        token_details: [
          { token_count: 12, token_type: "input" },
          { token_count: 3, token_type: "cache_read" },
          { token_count: 7, token_type: "output" },
        ],
      },
    }
    const chat = responsesResultToChat(result)
    expect(chat.choices[0].message.content).toBe("PONG")
    expect(chat.choices[0].finish_reason).toBe("stop")
    expect(chat.usage).toEqual({
      prompt_tokens: 12,
      completion_tokens: 7,
      total_tokens: 19,
      prompt_tokens_details: { cached_tokens: 3 },
    })
  })

  test("maps function_call output to tool_calls with finish tool_calls", () => {
    const result: ResponsesResult = {
      id: "resp_2",
      object: "response",
      model: "gpt-5.5",
      output: [
        {
          type: "function_call",
          call_id: "call_9",
          name: "get_weather",
          arguments: '{"location":"Paris"}',
        },
      ],
    }
    const chat = responsesResultToChat(result)
    expect(chat.choices[0].message.content).toBeNull()
    expect(chat.choices[0].message.tool_calls).toEqual([
      {
        id: "call_9",
        type: "function",
        function: { name: "get_weather", arguments: '{"location":"Paris"}' },
      },
    ])
    expect(chat.choices[0].finish_reason).toBe("tool_calls")
  })

  test("maps incomplete max_output_tokens to length", () => {
    const result: ResponsesResult = {
      id: "r",
      object: "response",
      model: "gpt-5.5",
      output: [
        {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "x" }],
        },
      ],
      incomplete_details: { reason: "max_output_tokens" },
    }
    expect(responsesResultToChat(result).choices[0].finish_reason).toBe(
      "length",
    )
  })
})

async function collect(
  events: Array<{ type: string; [k: string]: unknown }>,
): Promise<Array<string>> {
  function* gen() {
    for (const e of events) yield { data: JSON.stringify(e) }
  }
  const out: Array<string> = []
  for await (const item of translateResponsesStream(gen())) out.push(item.data)
  return out
}

function parseChunks(out: Array<string>): Array<ChatCompletionChunk> {
  return out
    .filter((d) => d !== "[DONE]")
    .map((d) => JSON.parse(d) as ChatCompletionChunk)
}

describe("translateResponsesStream", () => {
  test("translates a text stream into chat chunks ending with [DONE]", async () => {
    const out = await collect([
      {
        type: "response.created",
        response: {
          id: "resp_1",
          object: "response",
          model: "gpt-5.5",
          created_at: 100,
          output: [],
        },
      },
      {
        type: "response.output_item.added",
        output_index: 0,
        item: { type: "message", role: "assistant", content: [] },
      },
      { type: "response.output_text.delta", output_index: 0, delta: "Hel" },
      { type: "response.output_text.delta", output_index: 0, delta: "lo" },
      {
        type: "response.completed",
        response: {
          id: "resp_1",
          object: "response",
          model: "gpt-5.5",
          output: [],
          copilot_usage: {
            token_details: [
              { token_count: 5, token_type: "input" },
              { token_count: 2, token_type: "output" },
            ],
          },
        },
      },
    ])

    expect(out.at(-1)).toBe("[DONE]")
    const chunks = parseChunks(out)
    expect(chunks[0].choices[0].delta.role).toBe("assistant")
    const text = chunks.map((c) => c.choices[0].delta.content ?? "").join("")
    expect(text).toBe("Hello")
    const final = chunks.at(-1)
    expect(final?.choices[0].finish_reason).toBe("stop")
    expect(final?.usage?.prompt_tokens).toBe(5)
    expect(final?.usage?.completion_tokens).toBe(2)
  })

  test("translates a tool-call stream", async () => {
    const out = await collect([
      {
        type: "response.created",
        response: { id: "r", object: "response", model: "gpt-5.5", output: [] },
      },
      {
        type: "response.output_item.added",
        output_index: 0,
        item: {
          type: "function_call",
          call_id: "call_1",
          name: "get_weather",
          arguments: "",
        },
      },
      {
        type: "response.function_call_arguments.delta",
        output_index: 0,
        delta: '{"location":',
      },
      {
        type: "response.function_call_arguments.delta",
        output_index: 0,
        delta: '"Paris"}',
      },
      {
        type: "response.completed",
        response: { id: "r", object: "response", model: "gpt-5.5", output: [] },
      },
    ])

    const chunks = parseChunks(out)
    const first = chunks.find((c) => c.choices[0].delta.tool_calls?.[0]?.id)
    expect(first?.choices[0].delta.tool_calls?.[0]).toEqual({
      index: 0,
      id: "call_1",
      type: "function",
      function: { name: "get_weather", arguments: "" },
    })
    const args = chunks
      .map((c) => c.choices[0].delta.tool_calls?.[0]?.function?.arguments ?? "")
      .join("")
    expect(args).toBe('{"location":"Paris"}')
    const final = chunks.at(-1)
    expect(final?.choices[0].finish_reason).toBe("tool_calls")
  })
})
