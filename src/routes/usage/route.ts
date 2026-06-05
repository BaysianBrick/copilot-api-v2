import { Hono } from "hono"

import { summarizeUsage } from "~/lib/usage-tracker"
import { getCopilotUsage } from "~/services/github/get-copilot-usage"

export const usageRoute = new Hono()

usageRoute.get("/", async (c) => {
  try {
    const usage = await getCopilotUsage()
    return c.json(usage)
  } catch (error) {
    console.error("Error fetching Copilot usage:", error)
    return c.json({ error: "Failed to fetch Copilot usage" }, 500)
  }
})

// Local token-usage accounting recorded by this proxy (distinct from the
// GitHub quota at `/usage`). Optional query params: `since` (ISO timestamp,
// inclusive) and `model` (exact model id).
usageRoute.get("/tokens", async (c) => {
  try {
    const since = c.req.query("since")
    const model = c.req.query("model")
    const summary = await summarizeUsage({ since, model })
    return c.json(summary)
  } catch (error) {
    console.error("Error summarizing token usage:", error)
    return c.json({ error: "Failed to summarize token usage" }, 500)
  }
})
