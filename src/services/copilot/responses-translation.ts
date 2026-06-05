import consola from "consola"

import type {
  ChatCompletionChunk,
  ChatCompletionResponse,
  ChatCompletionsPayload,
  Message,
} from "./create-chat-completions"
import type {
  CopilotUsage,
  ResponsesInputItem,
  ResponsesMessageItem,
  ResponsesPayload,
  ResponsesResult,
  ResponsesStreamEvent,
  ResponsesTool,
} from "./create-responses"

type ChatFinishReason =
  ChatCompletionResponse["choices"][number]["finish_reason"]
type ChatToolCalls = NonNullable<
  ChatCompletionResponse["choices"][number]["message"]["tool_calls"]
>
type ChatDelta = ChatCompletionChunk["choices"][number]["delta"]

const ALLOWED_EFFORTS = new Set(["minimal", "low", "medium", "high", "xhigh"])

// Our `max` alias is not a real API value; treat it as the strongest the
// upstream understands.
function normalizeEffort(effort: string | undefined): string | undefined {
  if (!effort) return undefined
  const value = effort.toLowerCase()
  if (value === "max") return "xhigh"
  return ALLOWED_EFFORTS.has(value) ? value : undefined
}

function messageTextToString(content: Message["content"]): string {
  if (content === null) return ""
  if (typeof content === "string") return content
  return content.map((part) => (part.type === "text" ? part.text : "")).join("")
}

function toResponsesMessage(
  role: ResponsesMessageItem["role"],
  content: Message["content"],
  textType: "input_text" | "output_text",
): ResponsesMessageItem | undefined {
  if (content === null) return undefined

  if (typeof content === "string") {
    if (content.length === 0) return undefined
    return { role, content: [{ type: textType, text: content }] }
  }

  const parts: ResponsesMessageItem["content"] = content.map((part) =>
    part.type === "text" ?
      { type: textType, text: part.text }
    : { type: "input_image", image_url: part.image_url.url },
  )

  if (parts.length === 0) return undefined
  return { role, content: parts }
}

// Append a single OpenAI message to the Responses input list (or, for
// system/developer roles, to the collected instruction parts).
function appendMessage(
  message: Message,
  input: Array<ResponsesInputItem>,
  instructionParts: Array<string>,
): void {
  if (message.role === "system" || message.role === "developer") {
    const text = messageTextToString(message.content)
    if (text) instructionParts.push(text)
    return
  }

  if (message.role === "tool") {
    input.push({
      type: "function_call_output",
      call_id: message.tool_call_id ?? "",
      output: messageTextToString(message.content),
    })
    return
  }

  if (message.role === "assistant") {
    const item = toResponsesMessage("assistant", message.content, "output_text")
    if (item) input.push(item)
    for (const toolCall of message.tool_calls ?? []) {
      input.push({
        type: "function_call",
        call_id: toolCall.id,
        name: toolCall.function.name,
        arguments: toolCall.function.arguments,
      })
    }
    return
  }

  const item = toResponsesMessage("user", message.content, "input_text")
  if (item) input.push(item)
}

function translateTools(
  payload: ChatCompletionsPayload,
): Array<ResponsesTool> | undefined {
  return payload.tools?.map((tool) => ({
    type: "function",
    name: tool.function.name,
    description: tool.function.description,
    parameters: tool.function.parameters,
    strict: false,
  }))
}

function translateToolChoice(
  toolChoice: ChatCompletionsPayload["tool_choice"],
): ResponsesPayload["tool_choice"] {
  if (toolChoice && typeof toolChoice === "object") {
    return { type: "function", name: toolChoice.function.name }
  }
  if (typeof toolChoice === "string") return toolChoice
  return undefined
}

/**
 * Translate an OpenAI chat-completions payload into a Responses API payload.
 * System/developer messages become top-level `instructions`; assistant tool
 * calls and tool results become structured `function_call` /
 * `function_call_output` items.
 */
export function chatToResponsesPayload(
  payload: ChatCompletionsPayload,
): ResponsesPayload {
  const instructionParts: Array<string> = []
  const input: Array<ResponsesInputItem> = []

  for (const message of payload.messages) {
    appendMessage(message, input, instructionParts)
  }

  const tools = translateTools(payload)
  const effort = normalizeEffort(payload.reasoning_effort ?? undefined)

  const responsesPayload: ResponsesPayload = {
    model: payload.model,
    input,
    max_output_tokens: payload.max_tokens,
    stream: payload.stream,
  }

  if (instructionParts.length > 0) {
    responsesPayload.instructions = instructionParts.join("\n\n")
  }
  if (tools && tools.length > 0) {
    responsesPayload.tools = tools
    responsesPayload.tool_choice = translateToolChoice(payload.tool_choice)
  }
  if (effort) {
    responsesPayload.reasoning = { effort }
  }

  return responsesPayload
}

interface NormalizedUsage {
  prompt_tokens: number
  completion_tokens: number
  total_tokens: number
  prompt_tokens_details?: { cached_tokens: number }
}

function usageFromCopilot(
  copilotUsage: CopilotUsage,
): NormalizedUsage | undefined {
  if (!copilotUsage.token_details) return undefined
  let input = 0
  let output = 0
  let cached = 0
  for (const detail of copilotUsage.token_details) {
    switch (detail.token_type) {
      case "input": {
        input += detail.token_count
        break
      }
      case "output": {
        output += detail.token_count
        break
      }
      case "cache_read": {
        cached += detail.token_count
        break
      }
      default: {
        break
      }
    }
  }
  return {
    prompt_tokens: input,
    completion_tokens: output,
    total_tokens: input + output,
    ...(cached > 0 && { prompt_tokens_details: { cached_tokens: cached } }),
  }
}

function normalizeUsage(
  usage: ResponsesResult["usage"],
  copilotUsage: CopilotUsage | undefined,
): NormalizedUsage | undefined {
  if (usage) {
    const cached = usage.input_tokens_details?.cached_tokens
    return {
      prompt_tokens: usage.input_tokens ?? 0,
      completion_tokens: usage.output_tokens ?? 0,
      total_tokens:
        usage.total_tokens
        ?? (usage.input_tokens ?? 0) + (usage.output_tokens ?? 0),
      ...(cached !== undefined && {
        prompt_tokens_details: { cached_tokens: cached },
      }),
    }
  }
  if (copilotUsage) return usageFromCopilot(copilotUsage)
  return undefined
}

function finishReasonFor(
  hasToolCalls: boolean,
  incompleteReason: string | undefined,
): ChatFinishReason {
  if (hasToolCalls) return "tool_calls"
  if (incompleteReason === "max_output_tokens") return "length"
  return "stop"
}

/**
 * Translate a non-streaming Responses result back into the chat-completions
 * shape the rest of the proxy (and both inbound protocols) expects.
 */
export function responsesResultToChat(
  result: ResponsesResult,
): ChatCompletionResponse {
  let content = ""
  const toolCalls: ChatToolCalls = []

  for (const item of result.output) {
    if (item.type === "message") {
      for (const part of item.content) {
        if (part.type === "output_text" && "text" in part && part.text) {
          content += part.text
        }
      }
    } else if (item.type === "function_call") {
      toolCalls.push({
        id: item.call_id,
        type: "function",
        function: { name: item.name, arguments: item.arguments },
      })
    }
  }

  const usage = normalizeUsage(result.usage, result.copilot_usage)

  return {
    id: result.id,
    object: "chat.completion",
    created: result.created_at ?? Math.floor(Date.now() / 1000),
    model: result.model,
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: content.length > 0 ? content : null,
          ...(toolCalls.length > 0 && { tool_calls: toolCalls }),
        },
        logprobs: null,
        finish_reason: finishReasonFor(
          toolCalls.length > 0,
          result.incomplete_details?.reason,
        ),
      },
    ],
    ...(usage && { usage }),
  }
}

// ---- Streaming translation ----

interface StreamMeta {
  id: string
  created: number
  model: string
}

interface StreamContext {
  meta: StreamMeta
  roleSent: boolean
  sawToolCall: boolean
  toolIndexByOutput: Map<number, number>
  nextToolIndex: number
}

interface EventResult {
  chunks: Array<ChatCompletionChunk>
  done?: boolean
}

function makeChunk(
  meta: StreamMeta,
  delta: ChatDelta,
  extra?: { finishReason?: ChatFinishReason; usage?: NormalizedUsage },
): ChatCompletionChunk {
  return {
    id: meta.id,
    object: "chat.completion.chunk",
    created: meta.created,
    model: meta.model,
    choices: [
      {
        index: 0,
        delta,
        finish_reason: extra?.finishReason ?? null,
        logprobs: null,
      },
    ],
    ...(extra?.usage && { usage: extra.usage }),
  }
}

function ensureRole(ctx: StreamContext): Array<ChatCompletionChunk> {
  if (ctx.roleSent) return []
  ctx.roleSent = true
  return [makeChunk(ctx.meta, { role: "assistant" })]
}

function onCreated(
  event: ResponsesStreamEvent,
  ctx: StreamContext,
): EventResult {
  if (event.response) {
    ctx.meta = {
      id: event.response.id || ctx.meta.id,
      created: event.response.created_at ?? ctx.meta.created,
      model: event.response.model || ctx.meta.model,
    }
  }
  return { chunks: [] }
}

function onOutputItemAdded(
  event: ResponsesStreamEvent,
  ctx: StreamContext,
): EventResult {
  const item = event.item
  if (item?.type === "function_call") {
    const chunks = ensureRole(ctx)
    ctx.sawToolCall = true
    const toolIndex = ctx.nextToolIndex++
    if (event.output_index !== undefined) {
      ctx.toolIndexByOutput.set(event.output_index, toolIndex)
    }
    chunks.push(
      makeChunk(ctx.meta, {
        tool_calls: [
          {
            index: toolIndex,
            id: item.call_id,
            type: "function",
            function: { name: item.name, arguments: "" },
          },
        ],
      }),
    )
    return { chunks }
  }
  if (item?.type === "message") return { chunks: ensureRole(ctx) }
  return { chunks: [] }
}

function onTextDelta(
  event: ResponsesStreamEvent,
  ctx: StreamContext,
): EventResult {
  if (!event.delta) return { chunks: [] }
  const chunks = ensureRole(ctx)
  chunks.push(makeChunk(ctx.meta, { content: event.delta }))
  return { chunks }
}

function onArgsDelta(
  event: ResponsesStreamEvent,
  ctx: StreamContext,
): EventResult {
  if (event.delta === undefined || event.output_index === undefined) {
    return { chunks: [] }
  }
  const toolIndex = ctx.toolIndexByOutput.get(event.output_index) ?? 0
  return {
    chunks: [
      makeChunk(ctx.meta, {
        tool_calls: [
          { index: toolIndex, function: { arguments: event.delta } },
        ],
      }),
    ],
  }
}

function onCompleted(
  event: ResponsesStreamEvent,
  ctx: StreamContext,
): EventResult {
  const result = event.response
  const usage = normalizeUsage(
    result?.usage,
    result?.copilot_usage ?? event.copilot_usage,
  )
  const finishReason = finishReasonFor(
    ctx.sawToolCall,
    result?.incomplete_details?.reason,
  )
  return {
    chunks: [makeChunk(ctx.meta, {}, { finishReason, usage })],
    done: true,
  }
}

function onFailed(
  event: ResponsesStreamEvent,
  ctx: StreamContext,
): EventResult {
  consola.error(
    "Responses stream error event:",
    JSON.stringify(event).slice(0, 300),
  )
  return {
    chunks: [makeChunk(ctx.meta, {}, { finishReason: "stop" })],
    done: true,
  }
}

type EventHandler = (
  event: ResponsesStreamEvent,
  ctx: StreamContext,
) => EventResult

const EVENT_HANDLERS: Partial<Record<string, EventHandler>> = {
  "response.created": onCreated,
  "response.output_item.added": onOutputItemAdded,
  "response.output_text.delta": onTextDelta,
  "response.function_call_arguments.delta": onArgsDelta,
  "response.completed": onCompleted,
  "response.incomplete": onCompleted,
  "response.failed": onFailed,
  "response.error": onFailed,
}

const encode = (chunk: ChatCompletionChunk) => ({ data: JSON.stringify(chunk) })

/**
 * Translate the Responses API SSE stream into chat-completion chunk events
 * (`{ data: "<json>" }`), terminated by `{ data: "[DONE]" }`. The output is
 * consumed identically to `events()` output by both the OpenAI and Anthropic
 * handlers.
 */
export async function* translateResponsesStream(
  rawEvents: AsyncIterable<{ data?: string }> | Iterable<{ data?: string }>,
): AsyncGenerator<{ data: string }> {
  const ctx: StreamContext = {
    meta: { id: "response", created: Math.floor(Date.now() / 1000), model: "" },
    roleSent: false,
    sawToolCall: false,
    toolIndexByOutput: new Map(),
    nextToolIndex: 0,
  }

  for await (const raw of rawEvents) {
    if (!raw.data || raw.data === "[DONE]") continue

    let event: ResponsesStreamEvent
    try {
      event = JSON.parse(raw.data) as ResponsesStreamEvent
    } catch {
      continue
    }

    const handler = EVENT_HANDLERS[event.type]
    if (!handler) continue

    const { chunks, done } = handler(event, ctx)
    for (const chunk of chunks) yield encode(chunk)
    if (done) {
      yield { data: "[DONE]" }
      return
    }
  }

  // Stream ended without an explicit completion event.
  yield encode(
    makeChunk(
      ctx.meta,
      {},
      { finishReason: ctx.sawToolCall ? "tool_calls" : "stop" },
    ),
  )
  yield { data: "[DONE]" }
}
