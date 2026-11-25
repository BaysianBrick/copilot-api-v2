import { describe, expect, spyOn, test } from "bun:test"

import type { ChatCompletionResponse } from "~/services/copilot/create-chat-completions"
import type {
  ResponsesPayload,
  ResponsesStreamItem,
} from "~/services/copilot/create-responses"

import { HTTPError } from "~/lib/error"
import { state } from "~/lib/state"
import { createResponses } from "~/services/copilot/create-responses"
import {
  geminiChatStream,
  geminiChatToResponse,
  responsesToGeminiChat,
} from "~/services/copilot/gemini-responses"

const model = "gemini-4-neon"
const definition = {
  type: "function" as const,
  name: "lookup",
  parameters: { type: "object", properties: { key: { type: "string" } } },
}
const payload = (): ResponsesPayload => ({
  model,
  input: [
    { type: "namespace", name: "functions", tools: [definition] },
    { role: "user", content: "Look up a key." },
  ],
})
const chat = (): ChatCompletionResponse => ({
  id: "chat_1",
  model,
  object: "chat.completion",
  created: 123,
  choices: [
    {
      index: 0,
      logprobs: null,
      finish_reason: "stop",
      message: { role: "assistant", content: "OK" },
    },
  ],
  usage: {
    prompt_tokens: 10,
    completion_tokens: 3,
    total_tokens: 13,
    prompt_tokens_details: { cached_tokens: 2 },
  },
})
function* streamOf(items: Array<unknown>): Generator<ResponsesStreamItem> {
  for (const item of items)
    yield { data: typeof item === "string" ? item : JSON.stringify(item) }
}
async function collect(items: Array<unknown>) {
  const { identities } = responsesToGeminiChat(payload())
  const output: Array<Record<string, unknown>> = []
  const stream: AsyncIterable<ResponsesStreamItem> = {
    async *[Symbol.asyncIterator]() {
      for (const item of streamOf(items)) yield await Promise.resolve(item)
    },
  }
  for await (const event of geminiChatStream(stream, model, identities)) {
    output.push(JSON.parse(event.data ?? "{}") as Record<string, unknown>)
  }
  return output
}
const chunk = (delta: unknown, finish: string | null = null) => ({
  choices: [{ index: 0, delta, finish_reason: finish }],
})

describe("Gemini Responses translation", () => {
  test("loads Codex additional-tools namespaces and restores replayed names", () => {
    const p = JSON.parse(`{
      "model":"gemini-4-neon",
      "tool_choice":{"type":"function","name":"lookup","namespace":"functions"},
      "input":[
        {"type":"additional_tools","role":"developer","tools":[
          {"type":"namespace","name":"functions","tools":[
            {"type":"function","name":"lookup","parameters":{"type":"object"}}
          ]}
        ]},
        {"type":"function_call","namespace":"functions","name":"lookup","call_id":"c","arguments":"{}"},
        {"type":"function_call_output","call_id":"c","output":"ok"}
      ]
    }`) as ResponsesPayload
    const { request } = responsesToGeminiChat(p)
    expect(request.tools?.[0].function.name).toBe("functions__lookup")
    expect(request.tool_choice).toEqual({
      type: "function",
      function: { name: "functions__lookup" },
    })
    expect(request.messages[0].tool_calls?.[0].function.name).toBe(
      "functions__lookup",
    )
  })

  test("preserves instructions, images and namespaced tool history without mutating input", () => {
    const p = payload()
    p.instructions = "Use tools."
    p.input = [
      ...(Array.isArray(p.input) ? p.input : []),
      {
        type: "function_call",
        call_id: "call_1",
        name: "functions__lookup",
        arguments: '{"key":"a"}',
      },
      { type: "function_call_output", call_id: "call_1", output: "42" },
      {
        role: "user",
        content: [
          { type: "input_image", image_url: "data:image/png;base64,AA==" },
        ],
      },
    ]
    const before = structuredClone(p)
    const { request, identities } = responsesToGeminiChat(p)
    expect(request.messages[0]).toEqual({
      role: "system",
      content: "Use tools.",
    })
    expect(request.messages[2].tool_calls?.[0].function.name).toBe(
      "functions__lookup",
    )
    expect(request.messages[3]).toMatchObject({
      role: "tool",
      tool_call_id: "call_1",
      content: "42",
    })
    expect(request.messages[4].content).toEqual([
      { type: "image_url", image_url: { url: "data:image/png;base64,AA==" } },
    ])
    expect(identities.get("functions__lookup")).toEqual({
      name: "lookup",
      namespace: "functions",
    })
    expect(p).toEqual(before)
  })

  test("reports unsupported input, tools and stored-response replay explicitly", () => {
    expect(() =>
      responsesToGeminiChat({
        model,
        input: "hi",
        tools: [{ ...definition, type: "function" }],
      }),
    ).not.toThrow()
    expect(() =>
      responsesToGeminiChat({
        model,
        input: [{ role: "user", content: [{ type: "input_audio", text: "" }] }],
      }),
    ).toThrow(HTTPError)
    const replay = { model, input: "hi", previous_response_id: "resp_old" }
    expect(() => responsesToGeminiChat(replay)).toThrow("full input history")
    const custom = JSON.parse(
      '{"model":"gemini-4-neon","input":"hi","tools":[{"type":"web_search"}]}',
    ) as ResponsesPayload
    expect(() => responsesToGeminiChat(custom)).toThrow("tool type web_search")
  })
})

test("routes Gemini 4 models through chat but keeps GPT on Responses", async () => {
  const savedToken = state.copilotToken
  state.copilotToken = "fixture-token"
  const fetchMock = spyOn(globalThis, "fetch")
  try {
    for (const id of [
      "gemini-4-argon",
      "gemini-4-carbon",
      "gemini-4-neon",
      "gemini-4-hydrogen",
    ]) {
      fetchMock.mockResolvedValueOnce(Response.json({ ...chat(), model: id }))
      await createResponses(
        { model: id, input: "hi" },
        { "session-id": "fixture" },
      )
      expect(fetchMock.mock.calls.at(-1)?.[0]).toEndWith("/chat/completions")
      const headers = fetchMock.mock.calls.at(-1)?.[1]?.headers
      expect(headers).toMatchObject({ "copilot-session-id": "fixture" })
    }
    fetchMock.mockResolvedValueOnce(
      Response.json({
        id: "resp_native",
        object: "response",
        model: "gpt-6.1-sol",
        output: [],
      }),
    )
    await createResponses({ model: "gpt-6.1-sol", input: "hi" })
    expect(fetchMock.mock.calls.at(-1)?.[0]).toEndWith("/responses")
  } finally {
    fetchMock.mockRestore()
    Object.assign(state, { copilotToken: savedToken })
  }
})

describe("Gemini Responses output", () => {
  test("roundtrips freeform custom tools and streams decoded input", async () => {
    const p = JSON.parse(
      '{"model":"gemini-4-neon","input":"Patch a file.","tools":[{"type":"custom","name":"apply_patch","description":"Apply a patch."}]}',
    ) as ResponsesPayload
    const { request, identities } = responsesToGeminiChat(p)
    expect(request.tools?.[0].function.parameters).toMatchObject({
      required: ["input"],
      properties: { input: { type: "string" } },
    })
    const response = chat()
    const patch = "*** Begin Patch\n*** End Patch"
    response.choices[0].message.tool_calls = [
      {
        id: "patch_1",
        type: "function",
        function: {
          name: "apply_patch",
          arguments: JSON.stringify({ input: patch }),
        },
      },
    ]
    const converted = geminiChatToResponse(response, identities)
    expect(converted.output[1]).toMatchObject({
      type: "custom_tool_call",
      name: "apply_patch",
      input: patch,
      call_id: "patch_1",
    })
    const history: ResponsesPayload = {
      ...p,
      input: [
        {
          type: "custom_tool_call",
          name: "apply_patch",
          input: patch,
          call_id: "patch_1",
        },
        { type: "custom_tool_call_output", call_id: "patch_1", output: "done" },
      ],
    }
    const decoded = responsesToGeminiChat(history)
    expect(decoded.request.messages[0].tool_calls?.[0].function.arguments).toBe(
      JSON.stringify({ input: patch }),
    )
    expect(decoded.request.messages[1]).toMatchObject({
      role: "tool",
      content: "done",
    })
    const stream: AsyncIterable<ResponsesStreamItem> = {
      async *[Symbol.asyncIterator]() {
        yield await Promise.resolve({
          data: JSON.stringify(
            chunk(
              {
                tool_calls: [
                  {
                    index: 0,
                    id: "patch_1",
                    function: {
                      name: "apply_patch",
                      arguments: JSON.stringify({ input: patch }),
                    },
                  },
                ],
              },
              "tool_calls",
            ),
          ),
        })
      },
    }
    const events: Array<Record<string, unknown>> = []
    for await (const event of geminiChatStream(stream, model, identities)) {
      events.push(JSON.parse(event.data ?? "{}") as Record<string, unknown>)
    }
    expect(
      events.find((e) => e.type === "response.custom_tool_call_input.done"),
    ).toMatchObject({ input: patch })
    expect(events.at(-1)?.type).toBe("response.completed")
  })

  test("converts non-streaming tool calls and cached usage; marks truncation incomplete", () => {
    const response = chat()
    response.choices[0].message.tool_calls = [
      {
        id: "call_1",
        type: "function",
        function: { name: "functions__lookup", arguments: '{"key":"a"}' },
      },
    ]
    response.choices[0].finish_reason = "length"
    const converted = geminiChatToResponse(
      response,
      responsesToGeminiChat(payload()).identities,
    )
    expect(converted).toMatchObject({
      status: "incomplete",
      incomplete_details: { reason: "max_output_tokens" },
      usage: {
        input_tokens: 10,
        output_tokens: 3,
        input_tokens_details: { cached_tokens: 2 },
      },
    })
    expect(converted.output[1]).toMatchObject({
      type: "function_call",
      call_id: "call_1",
      name: "lookup",
      namespace: "functions",
    })
  })

  test("streams interleaved parallel tools with stable indexes and exact arguments", async () => {
    const events = await collect([
      chunk({ content: "Checking." }),
      chunk({
        tool_calls: [
          {
            index: 0,
            id: "a",
            function: { name: "functions__lookup", arguments: '{"key":' },
          },
          {
            index: 1,
            id: "b",
            function: { name: "functions__lookup", arguments: '{"key":"b"}' },
          },
        ],
      }),
      chunk({ tool_calls: [{ index: 0, function: { arguments: '"a"}' } }] }),
      chunk({}, "tool_calls"),
      { choices: [], usage: chat().usage },
      "[DONE]",
    ])
    expect(events.map((e) => e.sequence_number)).toEqual(
      events.map((_, i) => i),
    )
    expect(
      events
        .filter((e) => e.type === "response.output_item.added")
        .map((e) => e.output_index),
    ).toEqual([0, 1, 2])
    expect(
      events
        .filter((e) => e.type === "response.function_call_arguments.done")
        .map((e) => e.arguments),
    ).toEqual(['{"key":"a"}', '{"key":"b"}'])
    expect(events.at(-1)).toMatchObject({
      type: "response.completed",
      response: {
        status: "completed",
        usage: { input_tokens: 10, output_tokens: 3 },
      },
    })
  })

  test("does not turn a truncated or broken stream into success", async () => {
    const incomplete = await collect([
      chunk({ content: "partial" }),
      chunk({}, "length"),
    ])
    expect(incomplete.at(-1)).toMatchObject({
      type: "response.incomplete",
      response: { incomplete_details: { reason: "max_output_tokens" } },
    })
    for (const input of [
      [chunk({ content: "partial" })],
      [chunk({ content: "partial" }), "{invalid"],
      [{ error: { message: "rate limited" } }],
      [
        chunk({
          tool_calls: [
            {
              index: 0,
              id: "a",
              function: { name: "unknown", arguments: "{}" },
            },
          ],
        }),
      ],
    ]) {
      const events = await collect(input)
      expect(events.at(-1)?.type).toBe("response.failed")
      expect(events.some((e) => e.type === "response.completed")).toBe(false)
    }
  })
})
