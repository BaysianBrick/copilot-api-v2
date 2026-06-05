import consola from "consola"

let installed = false

/**
 * Install global guards so a single unhandled rejection or uncaught exception
 * cannot take the whole proxy down.
 *
 * Motivation: the Copilot token refresh timer runs on an interval. A transient
 * DNS failure (`getaddrinfo ENOTFOUND api.github.com`) used to reject inside
 * that timer with no handler, which Node escalates to `uncaughtException` and
 * exits the process — silently killing a long-running background server. For a
 * stateless proxy the safe trade-off is to log loudly and keep serving; the
 * worst case is a single failed request, not a multi-hour outage.
 */
export function installProcessGuards(): void {
  if (installed) return
  installed = true

  process.on("unhandledRejection", (reason) => {
    consola.error(
      "Unhandled promise rejection (kept alive, not exiting):",
      reason,
    )
  })

  process.on("uncaughtException", (error) => {
    consola.error("Uncaught exception (kept alive, not exiting):", error)
  })
}
