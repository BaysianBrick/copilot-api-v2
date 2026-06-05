import { test, expect, describe, afterEach } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import type { UsageRecord } from "../src/lib/usage-tracker"

import {
  recordUsage,
  summarizeUsage,
  trackStreamUsage,
} from "../src/lib/usage-tracker"

const tmpFiles: Array<string> = []

function tmpLog(): string {
  const p = path.join(
    os.tmpdir(),
    `copilot-usage-test-${Date.now()}-${Math.random().toString(36).slice(2)}.jsonl`,
  )
  tmpFiles.push(p)
  return p
}

async function* fakeStream(
  items: Array<{ data?: string }>,
): AsyncGenerator<{ data?: string }> {
  await Promise.resolve()
  for (const i of items) yield i
}

afterEach(async () => {
  while (tmpFiles.length > 0) {
    const p = tmpFiles.pop()
    if (p) await fs.rm(p, { force: true })
  }
})

describe("recordUsage", () => {
  test("appends a normalized record and skips missing usage", async () => {
    const log = tmpLog()

    await recordUsage(
      {
        model: "gpt-5.5",
        via: "responses",
        stream: false,
        usage: {
          prompt_tokens: 10,
          completion_tokens: 5,
          prompt_tokens_details: { cached_tokens: 2 },
        },
      },
      log,
    )
    // No usage -> nothing written.
    await recordUsage(
      { model: "gpt-5.5", via: "responses", stream: false, usage: null },
      log,
    )

    const lines = (await fs.readFile(log, "utf8")).trim().split("\n")
    expect(lines).toHaveLength(1)
    const rec = JSON.parse(lines[0]) as UsageRecord
    expect(rec.model).toBe("gpt-5.5")
    expect(rec.prompt_tokens).toBe(10)
    expect(rec.completion_tokens).toBe(5)
    expect(rec.cached_tokens).toBe(2)
    expect(rec.total_tokens).toBe(15) // derived when absent
  })

  test("never throws on an unwritable path", async () => {
    let threw = false
    try {
      await recordUsage(
        {
          model: "m",
          via: "chat",
          stream: false,
          usage: { prompt_tokens: 1, completion_tokens: 1 },
        },
        path.join(os.tmpdir(), "no-such-dir-xyz", "nested", "usage.jsonl"),
      )
    } catch {
      threw = true
    }
    expect(threw).toBe(false)
  })
})

describe("summarizeUsage", () => {
  test("returns zeroed totals when the log is missing", async () => {
    const summary = await summarizeUsage({}, tmpLog())
    expect(summary.total.requests).toBe(0)
    expect(summary.total.total_tokens).toBe(0)
    expect(summary.by_model).toEqual({})
  })

  test("aggregates totals, by_model and by_day with filters", async () => {
    const log = tmpLog()
    const rows: Array<UsageRecord> = [
      {
        ts: "2026-06-01T10:00:00.000Z",
        model: "gpt-5.5",
        via: "responses",
        stream: true,
        prompt_tokens: 100,
        completion_tokens: 20,
        cached_tokens: 0,
        total_tokens: 120,
      },
      {
        ts: "2026-06-01T12:00:00.000Z",
        model: "claude-opus-4.8",
        via: "chat",
        stream: true,
        prompt_tokens: 50,
        completion_tokens: 10,
        cached_tokens: 5,
        total_tokens: 60,
      },
      {
        ts: "2026-06-02T09:00:00.000Z",
        model: "gpt-5.5",
        via: "responses",
        stream: false,
        prompt_tokens: 200,
        completion_tokens: 40,
        cached_tokens: 0,
        total_tokens: 240,
      },
    ]
    await fs.writeFile(
      log,
      `${rows.map((r) => JSON.stringify(r)).join("\n")}\n`,
    )

    const all = await summarizeUsage({}, log)
    expect(all.total.requests).toBe(3)
    expect(all.total.total_tokens).toBe(420)
    expect(all.by_model["gpt-5.5"].total_tokens).toBe(360)
    expect(all.by_model["claude-opus-4.8"].total_tokens).toBe(60)
    expect(all.by_day["2026-06-01"].requests).toBe(2)
    expect(all.by_day["2026-06-02"].requests).toBe(1)

    const sinceJun2 = await summarizeUsage({ since: "2026-06-02" }, log)
    expect(sinceJun2.total.requests).toBe(1)
    expect(sinceJun2.total.total_tokens).toBe(240)

    const onlyClaude = await summarizeUsage({ model: "claude-opus-4.8" }, log)
    expect(onlyClaude.total.requests).toBe(1)
    expect(onlyClaude.by_model["gpt-5.5"]).toBeUndefined()
  })

  test("ignores malformed lines", async () => {
    const log = tmpLog()
    const good: UsageRecord = {
      ts: "2026-06-01T10:00:00.000Z",
      model: "m",
      via: "chat",
      stream: false,
      prompt_tokens: 1,
      completion_tokens: 1,
      cached_tokens: 0,
      total_tokens: 2,
    }
    await fs.writeFile(log, [JSON.stringify(good), "not json", ""].join("\n"))
    const s = await summarizeUsage({}, log)
    expect(s.total.requests).toBe(1)
  })
})

describe("trackStreamUsage", () => {
  test("yields items unchanged and records the terminal usage chunk", async () => {
    const log = tmpLog()
    const items = [
      { data: JSON.stringify({ choices: [{ delta: { content: "Hi" } }] }) },
      {
        data: JSON.stringify({
          choices: [{ delta: {}, finish_reason: "stop" }],
          usage: {
            prompt_tokens: 7,
            completion_tokens: 3,
            total_tokens: 10,
            prompt_tokens_details: { cached_tokens: 1 },
          },
        }),
      },
      { data: "[DONE]" },
    ]

    const seen: Array<{ data?: string }> = []
    for await (const item of trackStreamUsage(
      { model: "claude-opus-4.8", via: "chat" },
      fakeStream(items),
      log,
    )) {
      seen.push(item)
    }

    // Passthrough preserves every item including [DONE].
    expect(seen).toEqual(items)

    const summary = await summarizeUsage({}, log)
    expect(summary.total.requests).toBe(1)
    expect(summary.by_model["claude-opus-4.8"].prompt_tokens).toBe(7)
    expect(summary.by_model["claude-opus-4.8"].completion_tokens).toBe(3)
    expect(summary.by_model["claude-opus-4.8"].cached_tokens).toBe(1)
  })

  test("records nothing when no usage chunk appears", async () => {
    const log = tmpLog()
    const items = [
      { data: JSON.stringify({ choices: [{ delta: { content: "Hi" } }] }) },
      { data: "[DONE]" },
    ]
    for await (const item of trackStreamUsage(
      { model: "m", via: "chat" },
      fakeStream(items),
      log,
    )) {
      expect(item).toBeDefined()
    }
    const summary = await summarizeUsage({}, log)
    expect(summary.total.requests).toBe(0)
  })

  test("still records when the consumer breaks early (Anthropic [DONE])", async () => {
    const log = tmpLog()
    const items = [
      { data: JSON.stringify({ choices: [{ delta: { content: "Hi" } }] }) },
      {
        data: JSON.stringify({
          choices: [{ delta: {}, finish_reason: "stop" }],
          usage: { prompt_tokens: 12, completion_tokens: 4, total_tokens: 16 },
        }),
      },
      { data: "[DONE]" },
    ]

    // Mimic the Anthropic handler: consume up to and including [DONE], then break.
    for await (const item of trackStreamUsage(
      { model: "claude-opus-4.8", via: "chat" },
      fakeStream(items),
      log,
    )) {
      if (item.data === "[DONE]") break
    }

    const summary = await summarizeUsage({}, log)
    expect(summary.total.requests).toBe(1)
    expect(summary.by_model["claude-opus-4.8"].prompt_tokens).toBe(12)
    expect(summary.by_model["claude-opus-4.8"].completion_tokens).toBe(4)
  })
})
