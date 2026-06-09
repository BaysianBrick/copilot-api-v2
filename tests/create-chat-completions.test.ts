import { test, expect, mock } from "bun:test"

import type { ChatCompletionsPayload } from "../src/services/copilot/create-chat-completions"

import { state } from "../src/lib/state"
import { createChatCompletions } from "../src/services/copilot/create-chat-completions"

// Mock state
state.copilotToken = "test-token"
state.vsCodeVersion = "1.0.0"
state.accountType = "individual"

// Helper to mock fetch
const fetchMock = mock(
  (_url: string, opts: { headers: Record<string, string> }) => {
    return {
      ok: true,
      json: () => ({ id: "123", object: "chat.completion", choices: [] }),
      headers: opts.headers,
    }
  },
)
// @ts-expect-error - Mock fetch doesn't implement all fetch properties
;(globalThis as unknown as { fetch: typeof fetch }).fetch = fetchMock

test("sets X-Initiator to agent if tool/assistant present", async () => {
  const payload: ChatCompletionsPayload = {
    messages: [
      { role: "user", content: "hi" },
      { role: "tool", content: "tool call" },
    ],
    model: "gpt-test",
  }
  await createChatCompletions(payload)
  expect(fetchMock).toHaveBeenCalled()
  const headers = fetchMock.mock.calls[0][1].headers
  expect(headers["X-Initiator"]).toBe("agent")
})

test("sets X-Initiator to user if only user present", async () => {
  const payload: ChatCompletionsPayload = {
    messages: [
      { role: "user", content: "hi" },
      { role: "user", content: "hello again" },
    ],
    model: "gpt-test",
  }
  await createChatCompletions(payload)
  expect(fetchMock).toHaveBeenCalled()
  const headers = fetchMock.mock.calls[1][1].headers
  expect(headers["X-Initiator"]).toBe("user")
})

test("filters and forwards client-supplied copilot/vscode/github headers", async () => {
  const payload: ChatCompletionsPayload = {
    messages: [{ role: "user", content: "hi" }],
    model: "gpt-test",
  }
  const incomingHeaders = {
    host: "localhost:4141",
    authorization: "Bearer dummy",
    "content-length": "123",
    "copilot-edits-session": "session-12345",
    "x-copilot-test-header": "test-val",
    "x-vscode-something": "vscode-val",
    "x-github-api-version": "override-by-client",
    "normal-header": "ignore-me",
  }
  await createChatCompletions(payload, incomingHeaders)
  expect(fetchMock).toHaveBeenCalled()
  // Search the calls for the one that has our test headers
  const latestCall = fetchMock.mock.calls.at(-1)
  const headers = latestCall[1].headers

  // Should forward custom headers
  expect(headers["copilot-edits-session"]).toBe("session-12345")
  expect(headers["x-copilot-test-header"]).toBe("test-val")
  expect(headers["x-vscode-something"]).toBe("vscode-val")
  expect(headers["x-github-api-version"]).toBe("override-by-client")

  // Should filter out unsafe or common overhead headers
  expect(headers["host"]).toBeUndefined()
  expect(headers["authorization"]).not.toBe("Bearer dummy") // Keep state token
  expect(headers["content-length"]).toBeUndefined()
  expect(headers["normal-header"]).toBeUndefined()
})

test("automatically strips reasoning_effort and thinking for non-reasoning models", async () => {
  const payload: ChatCompletionsPayload & { thinking?: unknown } = {
    messages: [{ role: "user", content: "hi" }],
    model: "claude-3-5-sonnet",
    reasoning_effort: "xhigh",
    thinking: { budget: 1024 },
  }
  await createChatCompletions(payload)
  expect(fetchMock).toHaveBeenCalled()
  const latestCall = fetchMock.mock.calls.at(-1)
  /* eslint-disable-next-line @typescript-eslint/no-explicit-any */
  const bodyText = (latestCall as any)[1].body as string
  const sentPayload = JSON.parse(bodyText) as Record<string, unknown>

  expect(sentPayload.model).toBe("claude-3-5-sonnet")
  expect(sentPayload.reasoning_effort).toBeUndefined()
  expect(sentPayload.thinking).toBeUndefined()
})
