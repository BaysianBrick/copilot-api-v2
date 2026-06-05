import { test, expect, describe } from "bun:test"

import { parseModelSpec } from "../src/lib/model-spec"

describe("parseModelSpec", () => {
  test("returns bare model unchanged when no directives", () => {
    const spec = parseModelSpec("gpt-5.5")
    expect(spec.model).toBe("gpt-5.5")
    expect(spec.effort).toBeUndefined()
    expect(spec.context1m).toBe(false)
  })

  test("parses effort suffix", () => {
    const spec = parseModelSpec("gpt-5.5[high]")
    expect(spec.model).toBe("gpt-5.5")
    expect(spec.effort).toBe("high")
  })

  test("parses xhigh effort", () => {
    expect(parseModelSpec("gpt-5.5[xhigh]").effort).toBe("xhigh")
  })

  test("parses none effort", () => {
    expect(parseModelSpec("gpt-5.5[none]").effort).toBe("none")
  })

  test("parses 1m context directive and strips it", () => {
    const spec = parseModelSpec("claude-opus-4.8[1m]")
    expect(spec.model).toBe("claude-opus-4.8")
    expect(spec.context1m).toBe(true)
  })

  test("strips trailing [1m] from an already-qualified variant id", () => {
    const spec = parseModelSpec("claude-opus-4.7-1m-internal[1m]")
    expect(spec.model).toBe("claude-opus-4.7-1m-internal")
    expect(spec.context1m).toBe(true)
  })

  test("parses combined directives in one bracket", () => {
    const spec = parseModelSpec("gpt-5.5[high,1m]")
    expect(spec.model).toBe("gpt-5.5")
    expect(spec.effort).toBe("high")
    expect(spec.context1m).toBe(true)
  })

  test("parses combined directives in multiple brackets", () => {
    const spec = parseModelSpec("gpt-5.5[high][1m]")
    expect(spec.effort).toBe("high")
    expect(spec.context1m).toBe(true)
  })

  test("ignores unknown directive tokens but still strips them", () => {
    const spec = parseModelSpec("gpt-5.5[banana]")
    expect(spec.model).toBe("gpt-5.5")
    expect(spec.effort).toBeUndefined()
  })

  test("is case-insensitive for directives", () => {
    const spec = parseModelSpec("gpt-5.5[HIGH]")
    expect(spec.effort).toBe("high")
  })
})
