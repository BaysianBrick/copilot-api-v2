import consola from "consola"
import { events } from "fetch-event-stream"

import {
  copilotHeaders,
  copilotBaseUrl,
  filterClientHeaders,
} from "~/lib/api-config"
import { HTTPError } from "~/lib/error"
import { state } from "~/lib/state"

import { createGeminiResponses } from "./gemini-responses"

// Minimal client for GitHub Copilot's `/responses` endpoint (the OpenAI
// Responses API). Newer models such as the GPT-5 family are not accessible via
// `/chat/completions` and must go through here.

// ---- Request types ----

export interface ResponsesInputText {
  type: "input_text"
  text: string
}

export interface ResponsesInputImage {
  type: "input_image"
  image_url: string
}

export type ResponsesContentPart = ResponsesInputText | ResponsesInputImage

export interface ResponsesMessageItem {
  type?: "message"
  role: "user" | "assistant" | "system" | "developer"
  content: string | Array<ResponsesContentPart | { type: string; text: string }>
}

export interface ResponsesFunctionCallItem {
  type: "function_call"
  call_id: string
  name: string
  arguments: string
}

export interface ResponsesFunctionCallOutputItem {
  type: "function_call_output"
  call_id: string
  output: string
}

export interface ResponsesNamespaceTool {
  type: "function"
  name: string
  description?: string
  parameters?: {
    type?: string
    properties?: Record<string, unknown>
    required?: Array<string>
    additionalProperties?: boolean
  }
  strict?: boolean
}

export interface ResponsesNamespaceItem {
  type: "namespace"
  name: string
  description?: string
  tools: Array<ResponsesNamespaceTool>
}

export type ResponsesInputItem =
  | ResponsesMessageItem
  | ResponsesFunctionCallItem
  | ResponsesFunctionCallOutputItem
  | ResponsesNamespaceItem
  | ResponsesOutputCustomToolCall
  | { type: "custom_tool_call_output"; call_id: string; output: string }

export type ResponsesInput = string | Array<ResponsesInputItem>

export interface ResponsesTool {
  type: "function"
  name: string
  description?: string
  parameters: Record<string, unknown>
  strict?: boolean
}

export interface ResponsesPayload {
  model: string
  input: ResponsesInput
  instructions?: string
  max_output_tokens?: number | null
  reasoning?: { effort: string }
  tools?: Array<ResponsesTool>
  parallel_tool_calls?: boolean | null
  tool_choice?:
    | "none"
    | "auto"
    | "required"
    | { type: "function"; name: string }
  stream?: boolean | null
}

export type NormalizedResponsesPayload = Omit<ResponsesPayload, "input"> & {
  input: Array<ResponsesInputItem>
}

export function normalizeResponsesInput(
  payload: ResponsesPayload,
): NormalizedResponsesPayload {
  if (Array.isArray(payload.input)) return payload as NormalizedResponsesPayload
  return {
    ...payload,
    input: [{ role: "user", content: payload.input }],
  }
}

// ---- Response types (non-streaming) ----

export interface ResponsesOutputTextContent {
  type: "output_text"
  text: string
}

export interface ResponsesOutputMessage {
  type: "message"
  id?: string
  role: "assistant"
  status?: string
  content: Array<ResponsesOutputTextContent | { type: string; text?: string }>
}

export interface ResponsesOutputFunctionCall {
  type: "function_call"
  id?: string
  call_id: string
  name: string
  arguments: string
  status?: string
}

export interface ResponsesOutputReasoning {
  type: "reasoning"
  id?: string
  summary?: Array<unknown>
  content?: Array<unknown>
}

export interface ResponsesOutputCustomToolCall {
  type: "custom_tool_call"
  id?: string
  call_id: string
  name: string
  input: string
  status?: string
}

export type ResponsesOutputItem =
  | ResponsesOutputMessage
  | ResponsesOutputFunctionCall
  | ResponsesOutputReasoning
  | ResponsesOutputCustomToolCall

export interface CopilotUsageDetail {
  token_count: number
  // Typically "input" | "cache_read" | "output".
  token_type: string
}

export interface CopilotUsage {
  token_details?: Array<CopilotUsageDetail>
  total_nano_aiu?: number
}

const CODEX_V2_COLLABORATION_ALIAS = "codex_collaboration"

/**
 * Copilot reserves `collaboration.spawn_agent` with Codex's legacy schema and
 * rejects the V2 schema before inference. Aliasing only the V2 namespace avoids
 * that reserved-name check; response function calls remain named `spawn_agent`,
 * which is the name Codex expects when executing the local collaboration tool.
 */
export function adaptResponsesPayloadForCopilot(
  payload: ResponsesPayload,
): NormalizedResponsesPayload {
  const normalizedPayload = normalizeResponsesInput(payload)
  const plaintextCompatibleInput = adaptPlaintextAgentContent(
    normalizedPayload.input,
  )
  const [input, changed] = adaptNestedValue(plaintextCompatibleInput)
  if (changed) {
    return { ...normalizedPayload, input: input as Array<ResponsesInputItem> }
  }
  return plaintextCompatibleInput === normalizedPayload.input ?
      normalizedPayload
    : { ...normalizedPayload, input: plaintextCompatibleInput }
}

function adaptPlaintextAgentContent(
  input: Array<ResponsesInputItem>,
): Array<ResponsesInputItem> {
  const compatibleInput = input.map((item) => {
    const record = item as unknown as Record<string, unknown>
    if (record.type !== "agent_message" || !Array.isArray(record.content)) {
      return item
    }

    const originalContent = record.content
    const content = originalContent.map((part: unknown) => {
      if (!part || typeof part !== "object") return part
      const contentPart = part as Record<string, unknown>
      const encryptedContent = contentPart.encrypted_content
      if (
        contentPart.type !== "encrypted_content"
        || typeof encryptedContent !== "string"
        || !/\s/.test(encryptedContent)
      ) {
        return part
      }

      return { type: "input_text", text: encryptedContent }
    })

    const contentChanged = content.some(
      (part, index) => part !== originalContent[index],
    )
    if (!contentChanged) return item
    return { ...record, content } as unknown as ResponsesInputItem
  })

  const changed = compatibleInput.some((item, index) => item !== input[index])
  return changed ? compatibleInput : input
}

export function adaptStaleAgentHistoryForCopilot(
  payload: ResponsesPayload,
): NormalizedResponsesPayload {
  const adaptedPayload = adaptResponsesPayloadForCopilot(payload)
  const compatibleInput = stripConsumedAgentEncryption(adaptedPayload.input)
  return compatibleInput === adaptedPayload.input ?
      adaptedPayload
    : { ...adaptedPayload, input: compatibleInput }
}

function stripConsumedAgentEncryption(
  input: Array<ResponsesInputItem>,
): Array<ResponsesInputItem> {
  let laterModelOutput = false
  let changed = false
  const compatibleInput = [...input]

  for (let index = input.length - 1; index >= 0; index--) {
    const item = input[index] as unknown as Record<string, unknown>
    if (laterModelOutput && item.type === "agent_message") {
      const content = Array.isArray(item.content) ? item.content : []
      const compatibleContent = content.filter(
        (part) =>
          !part
          || typeof part !== "object"
          || (part as Record<string, unknown>).type !== "encrypted_content",
      )
      if (compatibleContent.length !== content.length) {
        compatibleInput[index] = {
          ...item,
          content: compatibleContent,
        } as unknown as ResponsesInputItem
        changed = true
      }
    }
    if (isModelOutput(item)) laterModelOutput = true
  }

  return changed ? compatibleInput : input
}

function isModelOutput(item: Record<string, unknown>): boolean {
  if (item.type === "message") {
    return item.role === "assistant" && !isInterAgentInstructionMessage(item)
  }
  return [
    "compaction",
    "context_compaction",
    "custom_tool_call",
    "function_call",
    "image_generation_call",
    "local_shell_call",
    "reasoning",
    "tool_search_call",
    "web_search_call",
  ].includes(String(item.type))
}

function isInterAgentInstructionMessage(
  item: Record<string, unknown>,
): boolean {
  if (!Array.isArray(item.content) || item.content.length !== 1) return false
  const part: unknown = item.content[0]
  if (!part || typeof part !== "object") return false
  const contentPart = part as Record<string, unknown>
  if (
    !["input_text", "output_text"].includes(String(contentPart.type))
    || typeof contentPart.text !== "string"
  ) {
    return false
  }

  try {
    const record = JSON.parse(contentPart.text) as Record<
      string,
      unknown
    > | null
    if (!record || typeof record !== "object") return false
    const otherRecipients = record.other_recipients
    return (
      typeof record.author === "string"
      && typeof record.recipient === "string"
      && (otherRecipients === undefined
        || (Array.isArray(otherRecipients)
          && otherRecipients.every(
            (recipient) => typeof recipient === "string",
          )))
      && typeof record.content === "string"
      && typeof record.trigger_turn === "boolean"
    )
  } catch {
    return false
  }
}

function adaptNestedValue(value: unknown): [unknown, boolean] {
  if (Array.isArray(value)) {
    const adaptedItems = value.map((item) => adaptNestedValue(item))
    const changed = adaptedItems.some(([, itemChanged]) => itemChanged)
    const output = adaptedItems.map(([adapted]) => adapted)
    return changed ? [output, true] : [value, false]
  }

  if (!value || typeof value !== "object") return [value, false]
  const record = value as Record<string, unknown>
  const isV2CollaborationNamespace = isCodexV2CollaborationNamespace(record)
  const sourceRecord =
    isV2CollaborationNamespace ?
      {
        ...record,
        name: CODEX_V2_COLLABORATION_ALIAS,
        tools: (record.tools as Array<ResponsesNamespaceTool>).map((tool) =>
          adaptCollaborationMessageSchema(tool),
        ),
      }
    : record

  let changed = isV2CollaborationNamespace
  const output: Record<string, unknown> = {}
  for (const [key, item] of Object.entries(sourceRecord)) {
    if (
      key === "description"
      && sourceRecord.type === "function"
      && typeof item === "string"
      && item.trim().length === 0
    ) {
      const toolName =
        typeof sourceRecord.name === "string" ? sourceRecord.name.trim() : ""
      output[key] = toolName ? `Invoke ${toolName}.` : "Invoke this tool."
      changed = true
      continue
    }
    const [adapted, itemChanged] = adaptNestedValue(item)
    if (itemChanged) changed = true
    output[key] = adapted
  }
  return changed ? [output, true] : [value, false]
}

function adaptCollaborationMessageSchema(
  tool: ResponsesNamespaceTool,
): ResponsesNamespaceTool {
  const properties = tool.parameters?.properties
  const message = properties?.message
  if (
    !message
    || typeof message !== "object"
    || Array.isArray(message)
    || (message as Record<string, unknown>).encrypted !== true
  ) {
    return tool
  }
  const compatibleMessage = { ...(message as Record<string, unknown>) }
  delete compatibleMessage.encrypted
  return {
    ...tool,
    parameters: {
      ...tool.parameters,
      properties: { ...properties, message: compatibleMessage },
    },
  }
}

function isCodexV2CollaborationNamespace(
  item: Record<string, unknown>,
): boolean {
  if (item.type !== "namespace" || item.name !== "collaboration") return false
  if (!Array.isArray(item.tools)) return false
  const spawnAgent = item.tools.find((tool) => {
    if (!tool || typeof tool !== "object") return false
    const candidate = tool as Record<string, unknown>
    return candidate.type === "function" && candidate.name === "spawn_agent"
  }) as ResponsesNamespaceTool | undefined
  return Object.hasOwn(spawnAgent?.parameters?.properties ?? {}, "agent_type")
}

export interface ResponsesResult {
  id: string
  object: "response"
  model: string
  created_at?: number
  status?: string
  output: Array<ResponsesOutputItem>
  output_text?: string | null
  incomplete_details?: { reason?: string } | null
  usage?: {
    input_tokens?: number
    output_tokens?: number
    total_tokens?: number
    input_tokens_details?: { cached_tokens?: number }
  } | null
  copilot_usage?: CopilotUsage
}

export interface ResponsesStreamItem {
  data?: string
  event?: string
}

const MAX_PRE_OUTPUT_BUFFER_ITEMS = 32
const MAX_PRE_OUTPUT_BUFFER_CHARS = 65_536

export async function* recoverStaleAgentHistoryStream(
  stream: AsyncIterable<ResponsesStreamItem>,
  retry: () => Promise<AsyncIterable<ResponsesStreamItem>>,
): AsyncGenerator<ResponsesStreamItem> {
  const bufferedItems: Array<ResponsesStreamItem> = []
  let bufferedChars = 0
  let outputExposed = false

  for await (const item of stream) {
    if (outputExposed) {
      yield item
      continue
    }
    const parsed = parseStreamData(item.data)
    if (isRecoverableStaleAgentFailure(parsed)) {
      consola.warn(
        "Retrying Responses without consumed agent encryption:",
        JSON.stringify({ failed_response_id: responseId(parsed) }),
      )
      const retryStream = await retry()
      for await (const retryItem of retryStream) yield retryItem
      return
    }
    if (shouldBufferPreOutputItem(item, parsed)) {
      const itemChars = streamItemChars(item)
      if (wouldExceedPreOutputBuffer(bufferedItems, bufferedChars, itemChars)) {
        for (const bufferedItem of bufferedItems) yield bufferedItem
        bufferedItems.length = 0
        yield item
        outputExposed = true
        continue
      }
      bufferedItems.push(item)
      bufferedChars += itemChars
      continue
    }

    for (const bufferedItem of bufferedItems) yield bufferedItem
    bufferedItems.length = 0
    bufferedChars = 0
    yield item
    outputExposed = true
  }

  for (const bufferedItem of bufferedItems) yield bufferedItem
}

function shouldBufferPreOutputItem(
  item: ResponsesStreamItem,
  parsed: unknown,
): boolean {
  return !item.data || parsed === undefined || isPreOutputEvent(parsed)
}

function streamItemChars(item: ResponsesStreamItem): number {
  return (item.data?.length ?? 0) + (item.event?.length ?? 0)
}

function wouldExceedPreOutputBuffer(
  bufferedItems: Array<ResponsesStreamItem>,
  bufferedChars: number,
  itemChars: number,
): boolean {
  return (
    bufferedItems.length >= MAX_PRE_OUTPUT_BUFFER_ITEMS
    || bufferedChars + itemChars > MAX_PRE_OUTPUT_BUFFER_CHARS
  )
}

function parseStreamData(data: string | undefined): unknown {
  if (!data || data === "[DONE]") return undefined
  try {
    return JSON.parse(data) as unknown
  } catch {
    return undefined
  }
}

function isPreOutputEvent(value: unknown): boolean {
  if (!value || typeof value !== "object") return false
  const type = (value as Record<string, unknown>).type
  return [
    "response.created",
    "response.in_progress",
    "response.metadata",
    "response.queued",
  ].includes(String(type))
}

function responseId(value: unknown): string | null {
  if (!value || typeof value !== "object") return null
  const response = (value as Record<string, unknown>).response
  if (!response || typeof response !== "object") return null
  const id = (response as Record<string, unknown>).id
  return typeof id === "string" ? id.slice(0, 80) : null
}

function isRecoverableStaleAgentFailure(value: unknown): boolean {
  if (!value || typeof value !== "object") return false
  const event = value as Record<string, unknown>
  if (event.type !== "response.failed") return false
  const response = event.response
  if (!response || typeof response !== "object") return false
  const details = response as Record<string, unknown>
  return (
    details.status === "failed"
    && details.error === null
    && Array.isArray(details.output)
    && details.output.length === 0
  )
}

async function* restoreCodexCollaborationStream(
  stream: AsyncIterable<ResponsesStreamItem>,
): AsyncGenerator<ResponsesStreamItem> {
  for await (const item of stream) {
    if (!item.data) {
      yield item
      continue
    }

    try {
      const parsed = JSON.parse(item.data) as unknown
      if (
        parsed
        && typeof parsed === "object"
        && (parsed as Record<string, unknown>).type === "response.failed"
      ) {
        const response = (parsed as Record<string, unknown>).response
        const details =
          response && typeof response === "object" ?
            (response as Record<string, unknown>)
          : {}
        consola.error(
          "Upstream Responses failed:",
          JSON.stringify({
            id: details.id ?? null,
            status: details.status ?? null,
            error: details.error ?? null,
          }),
        )
      }
      const [restored, changed] = restoreNestedToolNames(parsed)
      yield changed ? { ...item, data: JSON.stringify(restored) } : item
    } catch {
      yield item
    }
  }
}

export function restoreCodexCollaborationToolNames<T>(value: T): T {
  return restoreNestedToolNames(value)[0] as T
}

function restoreNestedToolNames(value: unknown): [unknown, boolean] {
  if (Array.isArray(value)) {
    const restoredItems = value.map((item) => restoreNestedToolNames(item))
    const changed = restoredItems.some(([, itemChanged]) => itemChanged)
    const output = restoredItems.map(([restored]) => restored)
    return changed ? [output, true] : [value, false]
  }

  if (!value || typeof value !== "object") return [value, false]
  const record = value as Record<string, unknown>
  let changed = false
  const output: Record<string, unknown> = {}
  for (const [key, item] of Object.entries(record)) {
    if (key === "namespace" && item === CODEX_V2_COLLABORATION_ALIAS) {
      output[key] = "collaboration"
      changed = true
      continue
    }
    if (
      key === "name"
      && typeof item === "string"
      && item.startsWith(CODEX_V2_COLLABORATION_ALIAS)
    ) {
      output[key] = item.replace(CODEX_V2_COLLABORATION_ALIAS, "collaboration")
      changed = true
      continue
    }
    const [restored, itemChanged] = restoreNestedToolNames(item)
    if (itemChanged) changed = true
    output[key] = restored
  }
  return changed ? [output, true] : [value, false]
}

/**
 * Call the upstream `/responses` endpoint. Returns the parsed result for
 * non-streaming requests, or the raw SSE event iterator for streaming requests.
 */
export const createResponses = async (
  payload: ResponsesPayload,
  clientHeaders?: Record<string, string>,
) => {
  if (!state.copilotToken) throw new Error("Copilot token not found")

  if (/^gemini-4-(?:carbon|neon|hydrogen)$/.test(payload.model)) {
    return createGeminiResponses(payload, clientHeaders)
  }

  const upstreamPayload = adaptResponsesPayloadForCopilot(payload)
  const recoveryPayload = adaptStaleAgentHistoryForCopilot(upstreamPayload)

  const enableVision = upstreamPayload.input.some(
    (item) =>
      "content" in item
      && Array.isArray(item.content)
      && item.content.some((part) => part.type === "input_image"),
  )

  const isAgentCall = upstreamPayload.input.some(
    (item) =>
      ("type" in item
        && (item.type === "function_call"
          || item.type === "function_call_output"))
      || ("role" in item && item.role === "assistant"),
  )

  const headers: Record<string, string> = {
    ...copilotHeaders(state, enableVision),
    "X-Initiator": isAgentCall ? "agent" : "user",
    ...filterClientHeaders(clientHeaders),
  }

  const request = (requestPayload: NormalizedResponsesPayload) =>
    fetchResponses(requestPayload, headers)
  const response = await request(upstreamPayload)

  if (payload.stream) {
    const stream = events(response)
    const recoveredStream =
      recoveryPayload === upstreamPayload ? stream : (
        recoverStaleAgentHistoryStream(stream, async () =>
          events(await request(recoveryPayload)),
        )
      )
    return restoreCodexCollaborationStream(recoveredStream)
  }

  const result = (await response.json()) as ResponsesResult
  if (
    recoveryPayload !== upstreamPayload
    && isRecoverableStaleAgentFailure({
      type: "response.failed",
      response: result,
    })
  ) {
    consola.warn("Retrying Responses without consumed agent encryption")
    const retryResponse = await request(recoveryPayload)
    return restoreCodexCollaborationToolNames(
      (await retryResponse.json()) as ResponsesResult,
    )
  }
  return restoreCodexCollaborationToolNames(result)
}

async function fetchResponses(
  payload: NormalizedResponsesPayload,
  headers: Record<string, string>,
): Promise<Response> {
  const response = await fetch(`${copilotBaseUrl(state)}/responses`, {
    method: "POST",
    headers,
    body: JSON.stringify(payload),
  })
  if (!response.ok) {
    consola.error("Failed to create responses", response)
    throw new HTTPError("Failed to create responses", response)
  }
  return response
}

// ---- Streaming event types ----

export interface ResponsesStreamEvent {
  type: string
  sequence_number?: number
  // response.created / response.completed / response.failed
  response?: ResponsesResult & { error?: { message?: string } | null }
  // response.output_item.added / .done
  item?: ResponsesOutputItem & { call_id?: string; name?: string }
  output_index?: number
  // response.output_text.delta
  delta?: string
  item_id?: string
  // response.function_call_arguments.done
  arguments?: string
  copilot_usage?: CopilotUsage
}
