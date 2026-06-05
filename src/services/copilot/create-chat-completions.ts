import consola from "consola"
import { events } from "fetch-event-stream"

import { copilotHeaders, copilotBaseUrl } from "~/lib/api-config"
import { HTTPError } from "~/lib/error"
import { parseModelSpec } from "~/lib/model-spec"
import { state } from "~/lib/state"

import { createResponses, type ResponsesResult } from "./create-responses"
import {
  chatToResponsesPayload,
  responsesResultToChat,
  translateResponsesStream,
} from "./responses-translation"

// Models that upstream only serves via `/responses` (learned at runtime when
// `/chat/completions` rejects them with `unsupported_api_for_model`).
const responsesOnlyModels = new Set<string>()

export const createChatCompletions = async (
  payload: ChatCompletionsPayload,
) => {
  if (!state.copilotToken) throw new Error("Copilot token not found")

  // Normalize capability directives such as "gpt-5.5[high]" or "model[1m]":
  // strip the suffix and lift a reasoning effort into the payload.
  const spec = parseModelSpec(payload.model)
  const effortUnset = (payload.reasoning_effort ?? null) === null
  const req: ChatCompletionsPayload = {
    ...payload,
    model: spec.model,
    ...(spec.effort && effortUnset && { reasoning_effort: spec.effort }),
  }

  if (responsesOnlyModels.has(req.model)) {
    return createViaResponses(req)
  }

  try {
    return await createViaChatCompletions(req)
  } catch (error) {
    if (await isUnsupportedApiError(error)) {
      consola.info(
        `Model "${req.model}" is not served via /chat/completions; retrying via /responses.`,
      )
      responsesOnlyModels.add(req.model)
      return createViaResponses(req)
    }
    throw error
  }
}

const createViaChatCompletions = async (payload: ChatCompletionsPayload) => {
  const enableVision = payload.messages.some(
    (x) =>
      typeof x.content !== "string"
      && x.content?.some((x) => x.type === "image_url"),
  )

  // Agent/user check for X-Initiator header
  // Determine if any message is from an agent ("assistant" or "tool")
  const isAgentCall = payload.messages.some((msg) =>
    ["assistant", "tool"].includes(msg.role),
  )

  // Build headers and add X-Initiator
  const headers: Record<string, string> = {
    ...copilotHeaders(state, enableVision),
    "X-Initiator": isAgentCall ? "agent" : "user",
  }

  const response = await fetch(`${copilotBaseUrl(state)}/chat/completions`, {
    method: "POST",
    headers,
    body: JSON.stringify(payload),
  })

  if (!response.ok) {
    consola.error("Failed to create chat completions", response)
    throw new HTTPError("Failed to create chat completions", response)
  }

  if (payload.stream) {
    return events(response)
  }

  return (await response.json()) as ChatCompletionResponse
}

const createViaResponses = async (payload: ChatCompletionsPayload) => {
  const responsesPayload = chatToResponsesPayload(payload)
  const result = await createResponses(responsesPayload)

  if (payload.stream) {
    return translateResponsesStream(
      result as AsyncIterable<{ data?: string; event?: string }>,
    )
  }

  return responsesResultToChat(result as ResponsesResult)
}

// Detect the upstream "this model needs the /responses endpoint" rejection.
// Clones the response so the body is still readable if we rethrow.
const isUnsupportedApiError = async (error: unknown): Promise<boolean> => {
  if (!(error instanceof HTTPError)) return false
  if (error.response.status !== 400) return false
  try {
    const text = await error.response.clone().text()
    return text.includes("unsupported_api_for_model")
  } catch {
    return false
  }
}

// Streaming types

export interface ChatCompletionChunk {
  id: string
  object: "chat.completion.chunk"
  created: number
  model: string
  choices: Array<Choice>
  system_fingerprint?: string
  usage?: {
    prompt_tokens: number
    completion_tokens: number
    total_tokens: number
    prompt_tokens_details?: {
      cached_tokens: number
    }
    completion_tokens_details?: {
      accepted_prediction_tokens: number
      rejected_prediction_tokens: number
    }
  }
}

interface Delta {
  content?: string | null
  role?: "user" | "assistant" | "system" | "tool"
  tool_calls?: Array<{
    index: number
    id?: string
    type?: "function"
    function?: {
      name?: string
      arguments?: string
    }
  }>
}

interface Choice {
  index: number
  delta: Delta
  finish_reason: "stop" | "length" | "tool_calls" | "content_filter" | null
  logprobs: object | null
}

// Non-streaming types

export interface ChatCompletionResponse {
  id: string
  object: "chat.completion"
  created: number
  model: string
  choices: Array<ChoiceNonStreaming>
  system_fingerprint?: string
  usage?: {
    prompt_tokens: number
    completion_tokens: number
    total_tokens: number
    prompt_tokens_details?: {
      cached_tokens: number
    }
  }
}

interface ResponseMessage {
  role: "assistant"
  content: string | null
  tool_calls?: Array<ToolCall>
}

interface ChoiceNonStreaming {
  index: number
  message: ResponseMessage
  logprobs: object | null
  finish_reason: "stop" | "length" | "tool_calls" | "content_filter"
}

// Payload types

export interface ChatCompletionsPayload {
  messages: Array<Message>
  model: string
  temperature?: number | null
  top_p?: number | null
  max_tokens?: number | null
  stop?: string | Array<string> | null
  n?: number | null
  stream?: boolean | null

  frequency_penalty?: number | null
  presence_penalty?: number | null
  logit_bias?: Record<string, number> | null
  logprobs?: boolean | null
  response_format?: { type: "json_object" } | null
  seed?: number | null
  /** Reasoning effort for reasoning-capable models (GPT-5 family, etc.). */
  reasoning_effort?: string | null
  tools?: Array<Tool> | null
  tool_choice?:
    | "none"
    | "auto"
    | "required"
    | { type: "function"; function: { name: string } }
    | null
  user?: string | null
}

export interface Tool {
  type: "function"
  function: {
    name: string
    description?: string
    parameters: Record<string, unknown>
  }
}

export interface Message {
  role: "user" | "assistant" | "system" | "tool" | "developer"
  content: string | Array<ContentPart> | null

  name?: string
  tool_calls?: Array<ToolCall>
  tool_call_id?: string
}

export interface ToolCall {
  id: string
  type: "function"
  function: {
    name: string
    arguments: string
  }
}

export type ContentPart = TextPart | ImagePart

export interface TextPart {
  type: "text"
  text: string
}

export interface ImagePart {
  type: "image_url"
  image_url: {
    url: string
    detail?: "low" | "high" | "auto"
  }
}
