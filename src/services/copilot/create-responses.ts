import consola from "consola"
import { events } from "fetch-event-stream"

import { copilotHeaders, copilotBaseUrl } from "~/lib/api-config"
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

export type ResponsesInputItem =
  | ResponsesMessageItem
  | ResponsesFunctionCallItem
  | ResponsesFunctionCallOutputItem

export interface ResponsesTool {
  type: "function"
  name: string
  description?: string
  parameters: Record<string, unknown>
  strict?: boolean
}

export interface ResponsesPayload {
  model: string
  input: Array<ResponsesInputItem>
  instructions?: string
  max_output_tokens?: number | null
  reasoning?: { effort: string }
  tools?: Array<ResponsesTool>
  tool_choice?:
    | "none"
    | "auto"
    | "required"
    | { type: "function"; name: string }
  stream?: boolean | null
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

/**
 * Call the upstream `/responses` endpoint. Returns the parsed result for
 * non-streaming requests, or the raw SSE event iterator for streaming requests.
 */
export const createResponses = async (payload: ResponsesPayload) => {
  if (!state.copilotToken) throw new Error("Copilot token not found")

  const enableVision = payload.input.some(
    (item) =>
      "content" in item
      && Array.isArray(item.content)
      && item.content.some((part) => part.type === "input_image"),
  )

  const isAgentCall = payload.input.some(
    (item) =>
      ("type" in item
        && (item.type === "function_call"
          || item.type === "function_call_output"))
      || ("role" in item && item.role === "assistant"),
  )

  const headers: Record<string, string> = {
    ...copilotHeaders(state, enableVision),
    "X-Initiator": isAgentCall ? "agent" : "user",
  }

  const response = await fetch(`${copilotBaseUrl(state)}/responses`, {
    method: "POST",
    headers,
    body: JSON.stringify(payload),
  })

  if (!response.ok) {
    consola.error("Failed to create responses", response)
    throw new HTTPError("Failed to create responses", response)
  }

  if (payload.stream) {
    return events(response)
  }

  return (await response.json()) as ResponsesResult
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
