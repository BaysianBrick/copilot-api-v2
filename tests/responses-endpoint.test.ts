import { describe, expect, test } from "bun:test"

import type { ResponsesPayload } from "~/services/copilot/create-responses"

import { normalizeResponsesPayload } from "~/routes/responses/handler"

const payload = (model: string): ResponsesPayload => ({
  model,
  input: [{ role: "user", content: "hello" }],
})

describe("Responses request normalization", () => {
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
