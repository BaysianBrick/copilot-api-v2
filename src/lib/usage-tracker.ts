import consola from "consola"
import fs from "node:fs/promises"

import { PATHS } from "./paths"

// Persistent token-usage accounting.
//
// Every completion (OpenAI or Anthropic inbound, streaming or not, chat or
// /responses upstream) flows through `createChatCompletions`, whose result
// carries an OpenAI-style `usage` object. We append one JSON line per request
// to `usage.jsonl` and aggregate on demand via `summarizeUsage`. Recording is
// best-effort and never throws, so accounting can never break a real request.

export type UsageVia = "chat" | "responses"

/** OpenAI-style usage block as it appears on responses and final stream chunks. */
export interface RawUsage {
  prompt_tokens?: number
  completion_tokens?: number
  total_tokens?: number
  prompt_tokens_details?: { cached_tokens?: number }
}

export interface UsageRecord {
  ts: string
  model: string
  via: UsageVia
  stream: boolean
  prompt_tokens: number
  completion_tokens: number
  cached_tokens: number
  total_tokens: number
}

export interface RecordUsageInput {
  model: string
  via: UsageVia
  stream: boolean
  usage: RawUsage | null | undefined
}

function toRecord(input: RecordUsageInput): UsageRecord | undefined {
  const u = input.usage
  if (!u) return undefined
  const prompt = u.prompt_tokens ?? 0
  const completion = u.completion_tokens ?? 0
  return {
    ts: new Date().toISOString(),
    model: input.model,
    via: input.via,
    stream: input.stream,
    prompt_tokens: prompt,
    completion_tokens: completion,
    cached_tokens: u.prompt_tokens_details?.cached_tokens ?? 0,
    total_tokens: u.total_tokens ?? prompt + completion,
  }
}

/**
 * Append a single usage record. Best-effort: a missing usage object is skipped
 * and any filesystem error is logged at debug level rather than thrown.
 */
export async function recordUsage(
  input: RecordUsageInput,
  logPath: string = PATHS.USAGE_LOG_PATH,
): Promise<void> {
  const record = toRecord(input)
  if (!record) return
  try {
    await fs.appendFile(logPath, `${JSON.stringify(record)}\n`)
  } catch (error) {
    consola.debug("Failed to record usage:", error)
  }
}

// Extract the OpenAI-style usage block from one stream item, if present.
function usageFromStreamItem(item: { data?: string }): RawUsage | undefined {
  const data = item.data
  if (typeof data !== "string" || data === "[DONE]") return undefined
  try {
    const chunk = JSON.parse(data) as { usage?: RawUsage }
    return chunk.usage
  } catch {
    // Non-JSON keep-alive lines are ignored.
    return undefined
  }
}

/**
 * Wrap a completion stream so the terminal `usage` chunk is recorded as a side
 * effect. Items are yielded unchanged, so both the OpenAI and Anthropic
 * handlers consume the stream exactly as before.
 *
 * Recording happens in a `finally` block so it still runs when the consumer
 * stops early — the Anthropic handler, for example, `break`s on the `[DONE]`
 * sentinel, which triggers this generator's `.return()` and would otherwise
 * skip the post-loop recording.
 */
export async function* trackStreamUsage<T extends { data?: string }>(
  meta: { model: string; via: UsageVia },
  stream: AsyncIterable<T>,
  logPath: string = PATHS.USAGE_LOG_PATH,
): AsyncGenerator<T> {
  let usage: RawUsage | undefined
  try {
    for await (const item of stream) {
      usage = usageFromStreamItem(item) ?? usage
      yield item
    }
  } finally {
    await recordUsage(
      { model: meta.model, via: meta.via, stream: true, usage },
      logPath,
    )
  }
}

interface UsageTotals {
  requests: number
  prompt_tokens: number
  completion_tokens: number
  cached_tokens: number
  total_tokens: number
}

export interface UsageSummary {
  total: UsageTotals
  by_model: Record<string, UsageTotals>
  by_day: Record<string, UsageTotals>
  since?: string
  model?: string
}

function emptyTotals(): UsageTotals {
  return {
    requests: 0,
    prompt_tokens: 0,
    completion_tokens: 0,
    cached_tokens: 0,
    total_tokens: 0,
  }
}

function addInto(totals: UsageTotals, record: UsageRecord): void {
  totals.requests += 1
  totals.prompt_tokens += record.prompt_tokens
  totals.completion_tokens += record.completion_tokens
  totals.cached_tokens += record.cached_tokens
  totals.total_tokens += record.total_tokens
}

export interface SummarizeOptions {
  /** ISO date/time lower bound (inclusive). Records before this are skipped. */
  since?: string
  /** Restrict to a single model id. */
  model?: string
}

/**
 * Read the usage log and aggregate totals overall, per model, and per UTC day.
 * Returns zeroed totals when the log does not yet exist.
 */
export async function summarizeUsage(
  options: SummarizeOptions = {},
  logPath: string = PATHS.USAGE_LOG_PATH,
): Promise<UsageSummary> {
  const summary: UsageSummary = {
    total: emptyTotals(),
    by_model: {},
    by_day: {},
    ...(options.since && { since: options.since }),
    ...(options.model && { model: options.model }),
  }

  let content: string
  try {
    content = await fs.readFile(logPath, "utf8")
  } catch {
    return summary
  }

  for (const line of content.split("\n")) {
    const trimmed = line.trim()
    if (!trimmed) continue

    let record: UsageRecord
    try {
      record = JSON.parse(trimmed) as UsageRecord
    } catch {
      continue
    }

    if (options.since && record.ts < options.since) continue
    if (options.model && record.model !== options.model) continue

    addInto(summary.total, record)

    summary.by_model[record.model] ??= emptyTotals()
    addInto(summary.by_model[record.model], record)

    const day = record.ts.slice(0, 10)
    summary.by_day[day] ??= emptyTotals()
    addInto(summary.by_day[day], record)
  }

  return summary
}
