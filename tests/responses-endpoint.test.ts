import { describe, expect, test } from "bun:test"

import type { ResponsesPayload } from "~/services/copilot/create-responses"

import { normalizeResponsesPayload } from "~/routes/responses/handler"
import {
  adaptResponsesPayloadForCopilot,
  normalizeResponsesInput,
  restoreCodexCollaborationToolNames,
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
