import consola from "consola"
import { events } from "fetch-event-stream"

import {
  copilotHeaders,
  copilotBaseUrl,
  filterClientHeaders,
} from "~/lib/api-config"
import { HTTPError } from "~/lib/error"
import { state } from "~/lib/state"

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

export type ResponsesOutputItem =
  | ResponsesOutputMessage
  | ResponsesOutputFunctionCall
  | ResponsesOutputReasoning

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
  const [input, changed] = adaptNestedValue(normalizedPayload.input)
  return changed ?
      { ...normalizedPayload, input: input as Array<ResponsesInputItem> }
    : normalizedPayload
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
  if (isCodexV2CollaborationNamespace(record)) {
    return [{ ...record, name: CODEX_V2_COLLABORATION_ALIAS }, true]
  }

  let changed = false
  const output: Record<string, unknown> = {}
  for (const [key, item] of Object.entries(record)) {
    const [adapted, itemChanged] = adaptNestedValue(item)
    if (itemChanged) changed = true
    output[key] = adapted
  }
  return changed ? [output, true] : [value, false]
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

interface ResponsesStreamItem {
  data?: string
  event?: string
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

  const upstreamPayload = adaptResponsesPayloadForCopilot(payload)

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

  const response = await fetch(`${copilotBaseUrl(state)}/responses`, {
    method: "POST",
    headers,
    body: JSON.stringify(upstreamPayload),
  })

  if (!response.ok) {
    consola.error("Failed to create responses", response)
    throw new HTTPError("Failed to create responses", response)
  }

  if (payload.stream) {
    return restoreCodexCollaborationStream(events(response))
  }

  return restoreCodexCollaborationToolNames(
    (await response.json()) as ResponsesResult,
  )
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
