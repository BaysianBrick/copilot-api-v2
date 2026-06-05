import consola from "consola"
import fs from "node:fs/promises"

import { PATHS } from "~/lib/paths"
import { getCopilotToken } from "~/services/github/get-copilot-token"
import { getDeviceCode } from "~/services/github/get-device-code"
import { getGitHubUser } from "~/services/github/get-user"
import { pollAccessToken } from "~/services/github/poll-access-token"

import { HTTPError } from "./error"
import { state } from "./state"
import { sleep } from "./utils"

const readGithubToken = () => fs.readFile(PATHS.GITHUB_TOKEN_PATH, "utf8")

const writeGithubToken = (token: string) =>
  fs.writeFile(PATHS.GITHUB_TOKEN_PATH, token)

const REFRESH_MAX_ATTEMPTS = 5

// Refresh the Copilot token, retrying transient failures (e.g. DNS blips)
// with capped exponential backoff. Crucially this NEVER throws: it is invoked
// from a setInterval timer, where an escaping rejection becomes an
// unhandledRejection and crashes the whole process. On total failure we keep
// the existing token and try again at the next interval.
async function refreshCopilotToken(): Promise<void> {
  consola.debug("Refreshing Copilot token")
  for (let attempt = 1; attempt <= REFRESH_MAX_ATTEMPTS; attempt++) {
    try {
      const { token } = await getCopilotToken()
      state.copilotToken = token
      consola.debug("Copilot token refreshed")
      if (state.showToken) {
        consola.info("Refreshed Copilot token:", token)
      }
      return
    } catch (error) {
      consola.error(
        `Failed to refresh Copilot token (attempt ${attempt}/${REFRESH_MAX_ATTEMPTS}):`,
        error,
      )
      if (attempt < REFRESH_MAX_ATTEMPTS) {
        await sleep(Math.min(30_000, 1000 * 2 ** (attempt - 1)))
      }
    }
  }
  consola.error(
    "Copilot token refresh failed this cycle; keeping existing token and retrying next interval.",
  )
}

export const setupCopilotToken = async () => {
  const { token, refresh_in } = await getCopilotToken()
  state.copilotToken = token

  // Display the Copilot token to the screen
  consola.debug("GitHub Copilot Token fetched successfully!")
  if (state.showToken) {
    consola.info("Copilot token:", token)
  }

  const refreshInterval = (refresh_in - 60) * 1000
  setInterval(() => {
    // Fire-and-forget: refreshCopilotToken swallows its own errors so the
    // timer can never produce an unhandled rejection.
    void refreshCopilotToken()
  }, refreshInterval)
}

interface SetupGitHubTokenOptions {
  force?: boolean
}

export async function setupGitHubToken(
  options?: SetupGitHubTokenOptions,
): Promise<void> {
  try {
    const githubToken = await readGithubToken()

    if (githubToken && !options?.force) {
      state.githubToken = githubToken
      if (state.showToken) {
        consola.info("GitHub token:", githubToken)
      }
      await logUser()

      return
    }

    consola.info("Not logged in, getting new access token")
    const response = await getDeviceCode()
    consola.debug("Device code response:", response)

    consola.info(
      `Please enter the code "${response.user_code}" in ${response.verification_uri}`,
    )

    const token = await pollAccessToken(response)
    await writeGithubToken(token)
    state.githubToken = token

    if (state.showToken) {
      consola.info("GitHub token:", token)
    }
    await logUser()
  } catch (error) {
    if (error instanceof HTTPError) {
      consola.error("Failed to get GitHub token:", await error.response.json())
      throw error
    }

    consola.error("Failed to get GitHub token:", error)
    throw error
  }
}

async function logUser() {
  const user = await getGitHubUser()
  consola.info(`Logged in as ${user.login}`)
}
