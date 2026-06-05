import consola from "consola"
import { Agent, setGlobalDispatcher } from "undici"

// Default to a generous 15 minute timeout. Long agentic completions (and
// slow upstream "high demand" responses) can take many minutes to stream the
// first byte; undici's stock 300s headers/body timeouts abort them and surface
// as `UND_ERR_HEADERS_TIMEOUT` / `BodyTimeoutError`.
const DEFAULT_TIMEOUT_MS = 15 * 60 * 1000 // 900_000

/**
 * Resolve the network timeout (ms) from `COPILOT_API_TIMEOUT_MS`, falling back
 * to {@link DEFAULT_TIMEOUT_MS} when unset or invalid.
 */
export function getNetworkTimeoutMs(): number {
  const raw = process.env.COPILOT_API_TIMEOUT_MS
  if (!raw) return DEFAULT_TIMEOUT_MS
  const parsed = Number.parseInt(raw, 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_TIMEOUT_MS
}

/**
 * Shared undici Agent options that raise the headers/body timeouts so long
 * streaming completions are not aborted mid-flight. Reused by both the direct
 * dispatcher and the proxy dispatcher so behaviour is identical either way.
 */
export function agentTimeoutOptions(): Agent.Options {
  const timeout = getNetworkTimeoutMs()
  return {
    headersTimeout: timeout, // time to first byte
    bodyTimeout: timeout, // gap between bytes while streaming
    keepAliveTimeout: 60_000,
    connect: { timeout: 30_000 },
  }
}

/**
 * Install a global undici dispatcher with long timeouts. Replaces the old
 * external `--import copilot-api-timeout.mjs` bootstrap. No-op under Bun, whose
 * `fetch` does not use undici and ignores `setGlobalDispatcher`.
 */
export function configureGlobalDispatcher(): void {
  if (typeof Bun !== "undefined") return

  try {
    setGlobalDispatcher(new Agent(agentTimeoutOptions()))
    consola.debug(
      `undici timeouts raised to ${getNetworkTimeoutMs()} ms (headers/body)`,
    )
  } catch (error) {
    consola.debug("Failed to configure global undici dispatcher:", error)
  }
}
