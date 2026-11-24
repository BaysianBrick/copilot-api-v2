import consola from "consola"
import { randomUUID } from "node:crypto"

import { HTTPError } from "~/lib/error"

import type {
  ChatCompletionChunk,
  ChatCompletionResponse,
  ChatCompletionsPayload,
  ContentPart,
  Message,
} from "./create-chat-completions"
import type {
  ResponsesOutputCustomToolCall,
  ResponsesOutputFunctionCall,
  ResponsesOutputMessage,
  ResponsesPayload,
  ResponsesResult,
  ResponsesStreamItem,
} from "./create-responses"

import { createViaChatCompletions } from "./create-chat-completions"

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value)

function invalid(message: string): never {
  throw new HTTPError(
    message,
    Response.json(
      { error: { type: "invalid_request_error", message } },
      { status: 400 },
    ),
  )
}

function text(value: unknown, field: string): string {
  if (typeof value !== "string") invalid(`Expected a string for ${field}.`)
  return value
}

interface ToolIdentity {
  name: string
  namespace?: string
  custom?: boolean
}
type OutputItem =
  | ResponsesOutputMessage
  | ResponsesOutputFunctionCall
  | ResponsesOutputCustomToolCall
type Tokens = ChatCompletionResponse["usage"]
type ToolDelta = NonNullable<
  ChatCompletionChunk["choices"][number]["delta"]["tool_calls"]
>[number]

class ToolAdapter {
  identities = new Map<string, ToolIdentity>()
  tools: NonNullable<ChatCompletionsPayload["tools"]> = []

  add(items: unknown, namespace?: string): void {
    if (items === undefined) return
    if (!Array.isArray(items)) invalid("Expected an array of tools.")
    for (const item of items) {
      if (!isRecord(item)) invalid("Invalid tool definition.")
      if (item.type === "namespace" && namespace === undefined) {
        this.add(item.tools, text(item.name, "namespace"))
      } else {
        this.addFunction(item, namespace)
      }
    }
  }

  private addFunction(item: Record<string, unknown>, namespace?: string): void {
    if (item.type !== "function" && item.type !== "custom") {
      invalid(
        `Gemini Responses does not support tool type ${String(item.type)}.`,
      )
    }
    const name = text(item.name, "tool name")
    const wireName = namespace ? `${namespace}__${name}` : name
    if (!/^[\w-]{1,64}$/.test(wireName) || this.identities.has(wireName)) {
      invalid(`Invalid or duplicate Gemini tool name: ${wireName}.`)
    }
    const parameters =
      item.type === "custom" ?
        {
          type: "object",
          properties: { input: { type: "string" } },
          required: ["input"],
          additionalProperties: false,
        }
      : item.parameters
    if (!isRecord(parameters)) invalid(`Missing parameters for ${name}.`)
    this.identities.set(wireName, {
      name,
      ...(namespace && { namespace }),
      ...(item.type === "custom" && { custom: true }),
    })
    this.tools.push({
      type: "function",
      function: {
        name: wireName,
        ...(typeof item.description === "string" && {
          description: item.description,
        }),
        parameters,
      },
    })
  }
}

function messageContent(value: unknown): Array<ContentPart> {
  if (typeof value === "string") return [{ type: "text", text: value }]
  if (!Array.isArray(value)) invalid("Invalid message content.")
  return value.map((part: unknown): ContentPart => {
    if (!isRecord(part)) invalid("Invalid message content part.")
    if (part.type === "input_text" || part.type === "output_text") {
      return { type: "text", text: text(part.text, "message text") }
    }
    if (part.type === "input_image") {
      return {
        type: "image_url",
        image_url: { url: text(part.image_url, "image URL") },
      }
    }
    return invalid(`Unsupported Gemini content type: ${String(part.type)}.`)
  })
}

function appendInput(
  item: unknown,
  messages: Array<Message>,
  tools: ToolAdapter,
): void {
  if (!isRecord(item)) invalid("Invalid Responses input item.")
  switch (item.type) {
    case "additional_tools": {
      tools.add(item.tools)
      break
    }
    case "namespace": {
      tools.add([item])
      break
    }
    case "function_call":
    case "custom_tool_call": {
      const name = text(item.name, "function name")
      const qualified =
        typeof item.namespace === "string" ? `${item.namespace}__${name}` : name
      const call = {
        id: text(item.call_id, "call_id"),
        type: "function" as const,
        function: {
          name: qualified,
          arguments: inputArguments(item),
        },
      }
      const last = messages.at(-1)
      if (last?.role === "assistant")
        last.tool_calls = [...(last.tool_calls ?? []), call]
      else
        messages.push({ role: "assistant", content: null, tool_calls: [call] })
      break
    }
    case "function_call_output":
    case "custom_tool_call_output": {
      messages.push({
        role: "tool",
        tool_call_id: text(item.call_id, "call_id"),
        content: text(item.output, "function output"),
      })
      break
    }
    case "reasoning": {
      if (item.encrypted_content)
        invalid(
          "Gemini cannot replay encrypted reasoning; start a fresh session.",
        )
      break
    }
    case undefined:
    case "message": {
      messages.push(inputMessage(item))
      break
    }
    default: {
      invalid(`Unsupported Gemini input type: ${String(item.type)}.`)
    }
  }
}

function inputMessage(item: Record<string, unknown>): Message {
  const role = item.role
  if (
    role !== "user"
    && role !== "assistant"
    && role !== "system"
    && role !== "developer"
  ) {
    invalid(`Unsupported Gemini message role: ${String(role)}.`)
  }
  return {
    role: role === "developer" ? "system" : role,
    content: messageContent(item.content),
  }
}

function inputArguments(item: Record<string, unknown>): string {
  return item.type === "custom_tool_call" ?
      JSON.stringify({ input: text(item.input, "custom input") })
    : text(item.arguments, "arguments")
}

function validateRequest(raw: unknown): Record<string, unknown> {
  if (!isRecord(raw)) invalid("Expected a Responses request object.")
  if (
    raw.previous_response_id
    || raw.background === true
    || raw.store === true
  ) {
    invalid(
      "Gemini Responses requires full input history and synchronous execution.",
    )
  }
  return raw
}

export function responsesToGeminiChat(payload: ResponsesPayload) {
  const raw = validateRequest(payload)
  if (
    isRecord(raw.text)
    && isRecord(raw.text.format)
    && raw.text.format.type !== "text"
  ) {
    invalid(
      "Gemini Responses currently supports only plain-text output formatting.",
    )
  }
  const tools = new ToolAdapter()
  tools.add(raw.tools)
  const messages: Array<Message> = []
  if (payload.instructions)
    messages.push({ role: "system", content: payload.instructions })
  const input: unknown =
    typeof payload.input === "string" ?
      [{ role: "user", content: payload.input }]
    : payload.input
  if (!Array.isArray(input)) invalid("Expected a string or array input.")
  for (const item of input) appendInput(item, messages, tools)
  const request: ChatCompletionsPayload = {
    model: payload.model,
    messages,
    stream: payload.stream,
    max_tokens: payload.max_output_tokens,
    reasoning_effort: payload.reasoning?.effort,
    ...(tools.tools.length > 0 && { tools: tools.tools }),
    ...(payload.parallel_tool_calls !== undefined && {
      parallel_tool_calls: payload.parallel_tool_calls,
    }),
  }
  if (typeof payload.tool_choice === "string")
    request.tool_choice = payload.tool_choice
  else if (payload.tool_choice) {
    const namespace =
      (
        isRecord(raw.tool_choice)
        && typeof raw.tool_choice.namespace === "string"
      ) ?
        raw.tool_choice.namespace
      : undefined
    request.tool_choice = {
      type: "function",
      function: {
        name:
          namespace ?
            `${namespace}__${payload.tool_choice.name}`
          : payload.tool_choice.name,
      },
    }
  }
  return { request, identities: tools.identities }
}

function normalizeUsage(tokens: Tokens): ResponsesResult["usage"] {
  if (!tokens) return undefined
  return {
    input_tokens: tokens.prompt_tokens,
    output_tokens: tokens.completion_tokens,
    total_tokens: tokens.total_tokens,
    ...(tokens.prompt_tokens_details && {
      input_tokens_details: tokens.prompt_tokens_details,
    }),
  }
}

function result(
  base: Pick<ResponsesResult, "id" | "model" | "created_at">,
  output: Array<OutputItem>,
  completion: { finish: string; tokens?: Tokens },
): ResponsesResult {
  const reasons: Record<string, string> = {
    length: "max_output_tokens",
    content_filter: "content_filter",
  }
  if (
    !["content_filter", "length", "stop", "tool_calls"].includes(
      completion.finish,
    )
  ) {
    throw new Error(`Unexpected Gemini finish reason: ${completion.finish}.`)
  }
  if (
    completion.finish === "tool_calls"
    && !output.some((item) => item.type !== "message")
  ) {
    throw new Error("Gemini ended with tool_calls but returned no tools.")
  }
  const reason = reasons[completion.finish]
  for (const item of output) item.status = reason ? "incomplete" : "completed"
  return {
    ...base,
    object: "response",
    output,
    status: reason ? "incomplete" : "completed",
    usage: normalizeUsage(completion.tokens),
    incomplete_details: reason ? { reason } : null,
  }
}

function completedTool(
  item: ResponsesOutputFunctionCall,
  custom: boolean,
): OutputItem {
  if (!custom) return item
  const parsed: unknown = JSON.parse(item.arguments)
  if (!isRecord(parsed))
    throw new Error("Invalid Gemini custom tool arguments.")
  const { arguments: _arguments, ...rest } = item
  return {
    ...rest,
    type: "custom_tool_call",
    input: text(parsed.input, "custom tool input"),
  }
}

function toolIdentity(
  identities: Map<string, ToolIdentity>,
  name: string,
): ToolIdentity {
  const identity = identities.get(name)
  if (!identity) throw new Error(`Gemini returned an unknown tool: ${name}.`)
  return identity
}

export function geminiChatToResponse(
  chat: ChatCompletionResponse,
  identities: Map<string, ToolIdentity>,
): ResponsesResult {
  if (chat.choices.length === 0)
    throw new Error("Gemini returned no completion choice.")
  const choice = chat.choices[0]
  const output: Array<OutputItem> = []
  if (choice.message.content)
    output.push({
      type: "message",
      id: `msg_${randomUUID()}`,
      role: "assistant",
      status: "completed",
      content: [{ type: "output_text", text: choice.message.content }],
    })
  for (const call of choice.message.tool_calls ?? []) {
    const identity = toolIdentity(identities, call.function.name)
    output.push(
      completedTool(
        {
          type: "function_call",
          id: `fc_${randomUUID()}`,
          call_id: call.id,
          name: identity.name,
          ...(identity.namespace && { namespace: identity.namespace }),
          arguments: call.function.arguments,
          status: "completed",
        },
        identity.custom === true,
      ),
    )
  }
  return result(
    { model: chat.model, id: `resp_${randomUUID()}`, created_at: chat.created },
    output,
    { finish: choice.finish_reason, tokens: chat.usage },
  )
}

class StreamAdapter {
  private sequence = 0
  private messageIndex: number | undefined
  private calls = new Map<number, number>()
  private customCalls = new Set<number>()
  private output: Array<OutputItem> = []
  private finish: string | null = null
  private tokens: Tokens
  private base: Pick<ResponsesResult, "id" | "model" | "created_at">
  private identities: Map<string, ToolIdentity>

  constructor(model: string, identities: Map<string, ToolIdentity>) {
    this.identities = identities
    this.base = {
      model,
      id: `resp_${randomUUID()}`,
      created_at: Math.floor(Date.now() / 1000),
    }
  }

  event(type: string, fields: Record<string, unknown>): ResponsesStreamItem {
    return {
      event: type,
      data: JSON.stringify({
        type,
        sequence_number: this.sequence++,
        ...fields,
      }),
    }
  }

  start(): Array<ResponsesStreamItem> {
    const response = {
      ...this.base,
      object: "response",
      status: "in_progress",
      output: [],
    }
    return [
      this.event("response.created", { response }),
      this.event("response.in_progress", { response }),
    ]
  }

  ingest(data: string): Array<ResponsesStreamItem> {
    const chunk = JSON.parse(data) as ChatCompletionChunk & {
      error?: { message?: string }
    }
    if (chunk.error)
      throw new Error(chunk.error.message ?? "Gemini stream failed.")
    if (!Array.isArray(chunk.choices))
      throw new Error("Invalid Gemini stream chunk.")
    if (chunk.usage) this.tokens = chunk.usage
    if (chunk.choices.length === 0) return []
    const choice = chunk.choices[0]
    if (choice.finish_reason) this.finish = choice.finish_reason
    const events: Array<ResponsesStreamItem> = []
    if (choice.delta.content) events.push(...this.message(choice.delta.content))
    for (const call of choice.delta.tool_calls ?? [])
      events.push(...this.tool(call))
    return events
  }

  private message(delta: string): Array<ResponsesStreamItem> {
    const events: Array<ResponsesStreamItem> = []
    if (this.messageIndex === undefined) {
      this.messageIndex = this.output.length
      const item: ResponsesOutputMessage = {
        type: "message",
        id: `msg_${randomUUID()}`,
        role: "assistant",
        status: "in_progress",
        content: [{ type: "output_text", text: "" }],
      }
      this.output.push(item)
      const fields = {
        output_index: this.messageIndex,
        item_id: item.id,
        content_index: 0,
      }
      events.push(
        this.event("response.output_item.added", { ...fields, item }),
        this.event("response.content_part.added", {
          ...fields,
          part: { type: "output_text", text: "", annotations: [] },
        }),
      )
    }
    const item = this.output[this.messageIndex]
    if (item.type !== "message")
      throw new Error("Invalid Gemini message state.")
    item.content[0].text = (item.content[0].text ?? "") + delta
    events.push(
      this.event("response.output_text.delta", {
        output_index: this.messageIndex,
        item_id: item.id,
        content_index: 0,
        delta,
      }),
    )
    return events
  }

  private tool(call: ToolDelta): Array<ResponsesStreamItem> {
    const events: Array<ResponsesStreamItem> = []
    let index = this.calls.get(call.index)
    if (index === undefined) {
      if (!call.id || !call.function?.name)
        throw new Error("Gemini tool call is missing a name or ID.")
      const identity = toolIdentity(this.identities, call.function.name)
      const item: ResponsesOutputFunctionCall = {
        type: "function_call",
        id: `fc_${randomUUID()}`,
        call_id: call.id,
        name: identity.name,
        ...(identity.namespace && { namespace: identity.namespace }),
        arguments: "",
        status: "in_progress",
      }
      index = this.output.length
      this.output.push(item)
      this.calls.set(call.index, index)
      if (identity.custom) this.customCalls.add(index)
      events.push(
        this.event("response.output_item.added", {
          output_index: index,
          item:
            identity.custom ?
              {
                ...item,
                type: "custom_tool_call",
                arguments: undefined,
                input: "",
              }
            : item,
        }),
      )
    }
    const item = this.output[index]
    if (item.type !== "function_call")
      throw new Error("Invalid Gemini tool state.")
    if (call.function?.arguments) {
      item.arguments += call.function.arguments
      if (!this.customCalls.has(index))
        events.push(
          this.event("response.function_call_arguments.delta", {
            output_index: index,
            item_id: item.id,
            delta: call.function.arguments,
          }),
        )
    }
    return events
  }

  complete(): Array<ResponsesStreamItem> {
    if (!this.finish)
      throw new Error("Gemini stream ended without a finish reason.")
    const events: Array<ResponsesStreamItem> = []
    for (const [index, original] of this.output.entries()) {
      const item =
        original.type === "function_call" ?
          completedTool(original, this.customCalls.has(index))
        : original
      this.output[index] = item
      item.status =
        ["content_filter", "length"].includes(this.finish) ? "incomplete" : (
          "completed"
        )
      const fields = { output_index: index, item_id: item.id }
      if (item.type === "message") {
        events.push(
          this.event("response.output_text.done", {
            ...fields,
            content_index: 0,
            text: item.content[0].text,
          }),
          this.event("response.content_part.done", {
            ...fields,
            content_index: 0,
            part: item.content[0],
          }),
        )
      } else if (item.type === "function_call") {
        events.push(
          this.event("response.function_call_arguments.done", {
            ...fields,
            arguments: item.arguments,
          }),
        )
      } else {
        events.push(
          this.event("response.custom_tool_call_input.delta", {
            ...fields,
            delta: item.input,
          }),
          this.event("response.custom_tool_call_input.done", {
            ...fields,
            input: item.input,
          }),
        )
      }
      events.push(this.event("response.output_item.done", { ...fields, item }))
    }
    const response = result(this.base, this.output, {
      finish: this.finish,
      tokens: this.tokens,
    })
    events.push(
      this.event(
        response.status === "incomplete" ?
          "response.incomplete"
        : "response.completed",
        { response },
      ),
    )
    return events
  }

  failed(error: unknown): ResponsesStreamItem {
    consola.error("Gemini Responses stream failed:", error)
    return this.event("response.failed", {
      response: {
        ...this.base,
        object: "response",
        status: "failed",
        output: this.output,
        error: {
          code: "upstream_error",
          message: error instanceof Error ? error.message : String(error),
        },
      },
    })
  }
}

export async function* geminiChatStream(
  stream: AsyncIterable<ResponsesStreamItem>,
  model: string,
  identities: Map<string, ToolIdentity>,
): AsyncGenerator<ResponsesStreamItem> {
  const adapter = new StreamAdapter(model, identities)
  yield* adapter.start()
  try {
    for await (const raw of stream) {
      if (raw.data === "[DONE]") break
      if (raw.data) yield* adapter.ingest(raw.data)
    }
    yield* adapter.complete()
  } catch (error) {
    yield adapter.failed(error)
  }
}

export async function createGeminiResponses(
  payload: ResponsesPayload,
  headers?: Record<string, string>,
) {
  const { request, identities } = responsesToGeminiChat(payload)
  const chat = await createViaChatCompletions(request, headers)
  if ("choices" in chat) return geminiChatToResponse(chat, identities)
  return geminiChatStream(chat, payload.model, identities)
}
