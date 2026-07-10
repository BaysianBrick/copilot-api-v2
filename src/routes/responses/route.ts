import { Hono } from "hono"

import { forwardOpenAIError } from "~/lib/error"

import { handleResponse } from "./handler"

export const responseRoutes = new Hono()

responseRoutes.post("/", async (c) => {
  try {
    return await handleResponse(c)
  } catch (error) {
    return await forwardOpenAIError(c, error)
  }
})
