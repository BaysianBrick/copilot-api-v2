import { randomUUID } from "node:crypto"

import type { State } from "./state"

export const standardHeaders = () => ({
  "content-type": "application/json",
  accept: "application/json",
})

const COPILOT_VERSION = "0.26.7"
const EDITOR_PLUGIN_VERSION = `copilot-chat/${COPILOT_VERSION}`
const USER_AGENT = `GitHubCopilotChat/${COPILOT_VERSION}`

const API_VERSION = "2025-04-01"

export const copilotBaseUrl = (state: State) =>
  state.accountType === "individual" ?
    "https://api.githubcopilot.com"
  : `https://api.${state.accountType}.githubcopilot.com`
export const copilotHeaders = (state: State, vision: boolean = false) => {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${state.copilotToken}`,
    "content-type": standardHeaders()["content-type"],
    "copilot-integration-id": "vscode-chat",
    "editor-version": `vscode/${state.vsCodeVersion}`,
    "editor-plugin-version": EDITOR_PLUGIN_VERSION,
    "user-agent": USER_AGENT,
    "openai-intent": "conversation-panel",
    "x-github-api-version": API_VERSION,
    "x-request-id": randomUUID(),
    "x-vscode-user-agent-library-version": "electron-fetch",
  }

  if (vision) headers["copilot-vision-request"] = "true"

  return headers
}

export const GITHUB_API_BASE_URL = "https://api.github.com"
export const githubHeaders = (state: State) => ({
  ...standardHeaders(),
  authorization: `token ${state.githubToken}`,
  "editor-version": `vscode/${state.vsCodeVersion}`,
  "editor-plugin-version": EDITOR_PLUGIN_VERSION,
  "user-agent": USER_AGENT,
  "x-github-api-version": API_VERSION,
  "x-vscode-user-agent-library-version": "electron-fetch",
})

export const GITHUB_BASE_URL = "https://github.com"
export const GITHUB_CLIENT_ID = "Iv1.b507a08c87ecfe98"
export const GITHUB_APP_SCOPES = ["read:user"].join(" ")

/**
 * Filters a set of incoming client request headers, retaining only those
 * that are safe and necessary to forward upstream (such as Copilot session
 * tracking and edit session metadata). This prevents header leakage (e.g.
 * client-supplied Host, Authorization, Content-Length) while keeping sessions intact.
 */
export function filterClientHeaders(
  clientHeaders?: Record<string, string>,
): Record<string, string> {
  if (!clientHeaders) return {}
  const forwarded: Record<string, string> = {}
  for (const [key, value] of Object.entries(clientHeaders)) {
    const lk = key.toLowerCase()
    if (
      (lk.startsWith("copilot-")
        || lk.startsWith("x-copilot-")
        || lk.startsWith("x-github-")
        || lk.startsWith("x-vscode-"))
      && lk !== "authorization"
      && lk !== "content-type"
      && lk !== "content-length"
      && lk !== "host"
    ) {
      forwarded[key] = value
    }
  }
  return forwarded
}
