import type { Context } from "hono"
import type { ContentfulStatusCode } from "hono/utils/http-status"

import consola from "consola"

export class HTTPError extends Error {
  response: Response

  constructor(message: string, response: Response) {
    super(message)
    this.response = response
  }
}

interface UpstreamErrorBody {
  error?: {
    message?: unknown
  }
  message?: unknown
}

export function toAnthropicErrorPayload(status: number, errorText: string) {
  return {
    type: "error" as const,
    error: {
      type: mapHttpStatusToAnthropicErrorType(status),
      message: getUpstreamErrorMessage(errorText, status),
    },
  }
}

export function toOpenAIErrorPayload(status: number, errorText: string) {
  let upstream: {
    error?: {
      code?: unknown
      message?: unknown
      param?: unknown
      type?: unknown
    }
  } = {}
  try {
    upstream = JSON.parse(errorText) as typeof upstream
  } catch {
    // Plain-text upstream errors are normalized below.
  }

  const error = upstream.error
  return {
    error: {
      message: getUpstreamErrorMessage(errorText, status),
      type:
        typeof error?.type === "string" ?
          error.type
        : mapHttpStatusToOpenAIErrorType(status),
      ...(typeof error?.code === "string" && { code: error.code }),
      ...(typeof error?.param === "string" && { param: error.param }),
    },
  }
}

function mapHttpStatusToOpenAIErrorType(status: number): string {
  switch (status) {
    case 400:
    case 404:
    case 409:
    case 422: {
      return "invalid_request_error"
    }
    case 401: {
      return "authentication_error"
    }
    case 403: {
      return "permission_error"
    }
    case 429: {
      return "rate_limit_error"
    }
    default: {
      return "api_error"
    }
  }
}

function mapHttpStatusToAnthropicErrorType(status: number): string {
  switch (status) {
    case 400: {
      return "invalid_request_error"
    }
    case 401: {
      return "authentication_error"
    }
    case 403: {
      return "permission_error"
    }
    case 404: {
      return "not_found_error"
    }
    case 408:
    case 504: {
      return "timeout_error"
    }
    case 413: {
      return "request_too_large"
    }
    case 429: {
      return "rate_limit_error"
    }
    case 529: {
      return "overloaded_error"
    }
    default: {
      return "api_error"
    }
  }
}

function getUpstreamErrorMessage(errorText: string, status: number): string {
  let body: UpstreamErrorBody
  try {
    body = JSON.parse(errorText) as UpstreamErrorBody
  } catch {
    return errorText || `Request failed with status ${status}.`
  }

  const message = body.error?.message ?? body.message
  if (typeof message === "string") return message

  return errorText || `Request failed with status ${status}.`
}

export async function forwardAnthropicError(c: Context, error: unknown) {
  if (error instanceof HTTPError) {
    const errorText = await error.response.text()
    const status = error.response.status
    consola.error("HTTP error:", errorText)
    return c.json(
      toAnthropicErrorPayload(status, errorText),
      status as ContentfulStatusCode,
    )
  }

  consola.error("Error occurred:", error)
  return c.json(
    {
      type: "error",
      error: {
        type: "api_error",
        message: (error as Error).message,
      },
    },
    500,
  )
}

export async function forwardOpenAIError(c: Context, error: unknown) {
  if (error instanceof HTTPError) {
    const errorText = await error.response.text()
    const status = error.response.status
    consola.error("HTTP error:", errorText)
    return c.json(
      toOpenAIErrorPayload(status, errorText),
      status as ContentfulStatusCode,
    )
  }

  consola.error("Error occurred:", error)
  return c.json(
    {
      error: {
        message: (error as Error).message,
        type: "api_error",
      },
    },
    500,
  )
}

export async function forwardError(c: Context, error: unknown) {
  consola.error("Error occurred:", error)

  if (error instanceof HTTPError) {
    const errorText = await error.response.text()
    let errorJson: unknown
    try {
      errorJson = JSON.parse(errorText)
    } catch {
      errorJson = errorText
    }
    consola.error("HTTP error:", errorJson)
    return c.json(
      {
        error: {
          message: errorText,
          type: "error",
        },
      },
      error.response.status as ContentfulStatusCode,
    )
  }

  return c.json(
    {
      error: {
        message: (error as Error).message,
        type: "error",
      },
    },
    500,
  )
}
