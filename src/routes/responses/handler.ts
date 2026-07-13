import type { Context } from "hono"

import consola from "consola"
import { streamSSE, type SSEMessage } from "hono/streaming"

import { awaitApproval } from "~/lib/approval"
import { parseModelSpec } from "~/lib/model-spec"
import { checkRateLimit } from "~/lib/rate-limit"
import { state } from "~/lib/state"
import {
  normalizeResponsesUsage,
  recordUsage,
  trackStreamUsage,
} from "~/lib/usage-tracker"
import {
  createResponses,
  normalizeResponsesInput,
  type NormalizedResponsesPayload,
  type ResponsesPayload,
  type ResponsesResult,
} from "~/services/copilot/create-responses"

export async function handleResponse(c: Context) {
  await checkRateLimit(state)

  const payload = normalizeResponsesPayload(
    await c.req.json<ResponsesPayload>(),
  )
  consola.debug(
    "Responses request payload:",
    JSON.stringify(payload).slice(-400),
  )

  if (state.manualApprove) await awaitApproval()

  const response = await createResponses(payload, c.req.header())
  if (isNonStreaming(response)) {
    await recordUsage({
      model: payload.model,
      via: "responses",
      stream: false,
      usage: normalizeResponsesUsage(response.usage),
    })
    return c.json(response)
  }

  return streamSSE(c, async (stream) => {
    const trackedResponse = trackStreamUsage(
      { model: payload.model, via: "responses" },
      response,
    )
    for await (const event of trackedResponse) {
      await stream.writeSSE(event as SSEMessage)
    }
  })
}

export function normalizeResponsesPayload(
  payload: ResponsesPayload,
): NormalizedResponsesPayload {
  const normalizedPayload = normalizeResponsesInput(payload)
  const spec = parseModelSpec(normalizedPayload.model)
  if (!spec.effort || normalizedPayload.reasoning?.effort) {
    return spec.model === normalizedPayload.model ?
        normalizedPayload
      : { ...normalizedPayload, model: spec.model }
  }

  return {
    ...normalizedPayload,
    model: spec.model,
    reasoning: {
      ...normalizedPayload.reasoning,
      effort: normalizeResponsesEffort(spec.effort),
    },
  }
}

function normalizeResponsesEffort(effort: string): string {
  if (effort === "minimal") return "low"
  return effort
}

const isNonStreaming = (
  response: Awaited<ReturnType<typeof createResponses>>,
): response is ResponsesResult => Object.hasOwn(response, "output")
