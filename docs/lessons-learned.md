# Lessons Learned

This file records operational lessons from integrating this proxy with OpenAI-
compatible clients and Anthropic-compatible clients such as Claude Code. It is
written to be shareable: do not add usernames, absolute home directories,
account identifiers, raw tokens, request ids, or full private prompts.

## Model Directives Are Client-Specific

Bracketed model suffixes are useful, but different clients interpret them at
different layers.

- `model[1m]` is primarily a **client-side context-budget directive** for some
  clients. The proxy recognises and strips it, but the proxy cannot force a
  client to delay auto-compaction if the client itself did not recognise the
  suffix.
- `model[xhigh]`, `model[max]`, and similar effort suffixes are proxy
  conveniences for OpenAI-compatible callers. They are parsed into
  `reasoning_effort` before the upstream request is sent.
- Do not assume one bracket can safely carry everything for every client. In
  particular, some clients recognise a clean `[1m]` suffix but do not recognise
  combined suffixes such as `[1m,xhigh]` or `[1m,max]`.

For Claude Code, keep the context suffix clean and carry effort separately:

```json
{
  "env": {
    "ANTHROPIC_BASE_URL": "http://localhost:4141",
    "ANTHROPIC_AUTH_TOKEN": "dummy",
    "ANTHROPIC_MODEL": "gpt-5.5[1m]",
    "CLAUDE_CODE_EFFORT_LEVEL": "xhigh"
  }
}
```

Then start the proxy with:

```sh
COPILOT_API_ANTHROPIC_EFFORT=xhigh copilot-api start
```

`CLAUDE_CODE_EFFORT_LEVEL` keeps the client UI/session intent aligned. The
`COPILOT_API_ANTHROPIC_EFFORT` variable is what makes the effort reach the
GitHub Copilot backend from the Anthropic `/v1/messages` path.

## Claude Code Needs Effort Injection

Claude Code talks to this proxy through the Anthropic-compatible `/v1/messages`
endpoint. The Anthropic request shape has no `reasoning_effort` field, and some
clients strip model-name effort suffixes before sending requests. Without proxy
support, the backend may receive the model but not the requested effort level.

This proxy handles that by injecting `reasoning_effort` after translating the
Anthropic request into an OpenAI-style payload. The injection is controlled by
`COPILOT_API_ANTHROPIC_EFFORT` and currently applies only to models known to
support reasoning effort (`claude*` and `gpt-5*`). Invalid effort values are
warned and ignored so a typo does not break every request.

Recommended values are:

- `low`
- `medium`
- `high`
- `xhigh`
- `max`

Use `xhigh` for GPT-5-family models unless you have verified that the upstream
model accepts a different value through the exact route you are using.

## GPT-5 Family Routing

Some GPT-5-family models are not served by GitHub Copilot through
`/chat/completions`. A first request may receive an upstream
`unsupported_api_for_model` error. This is expected: the proxy detects that
error, retries the request through `/responses`, and records the model as a
Responses-only model for subsequent calls.

Practical checks:

- Seeing a `chat/completions` rejection followed by a successful `/responses`
  retry is normal for these models.
- The final response model may be a dated upstream id even if the input model is
  an alias such as `gpt-5.5`.
- Test both streaming and non-streaming paths when changing translation code;
  they exercise different response shapes.

## Context Window Versus Backend Capability

Backend context support and client context budgeting are different things.

- The backend may accept a large prompt even if the client auto-compacts early.
- A client may show a 200K/1M toggle or suffix because it is deciding how much
  history to keep before compaction.
- The proxy strips `[1m]` to avoid sending an invalid model id upstream, but the
  proxy does not send a special API parameter for 1M context.

When debugging early compaction, verify the client-side status or context view;
do not infer it only from backend acceptance of a large request.

## Model ID Hygiene

Do not rewrite provider model ids casually.

- Use the ids advertised by `GET /v1/models` for upstream calls.
- Client documentation may show a different spelling from GitHub Copilot's
  upstream ids. Preserve the upstream id unless you have a tested mapping.
- Be careful with broad regex rewrites such as mapping every `claude-opus-4-*`
  value to a short family id. That can accidentally collapse a valid versioned
  id into a different or unsupported model.

## Streaming Usage Accounting

Streaming consumers often stop when they see a terminal `[DONE]` event. If token
usage is recorded after a `for await` loop, a consumer break can call
`return()` on the generator and skip the code that records usage.

Put stream usage recording in a `finally` block around the async generator so it
runs for normal completion and early consumer exit.

## Token Refresh And Long Requests

Long-running agentic sessions are sensitive to process stability.

- Token refresh timers must not throw out of band. Retry transient failures and
  log the final failure without terminating the process.
- Install top-level process guards for unexpected rejections/exceptions, but fix
  the root cause instead of relying on guards as normal control flow.
- Use long enough HTTP headers/body timeouts for agentic streams; short default
  client timeouts can abort valid long requests.

## Windows Operations Notes

- PowerShell 5.1 may decode UTF-8 files with the legacy system code page when
  using `Get-Content`. Use an explicit UTF-8 read when validating JSON files
  that contain non-ASCII text.
- Avoid relying on multi-line shell snippets in automation. Prefer scripts or
  compact one-liners for repeatable checks.
- When a launcher sets environment variables before starting the Node process,
  verify the child process was restarted after the launcher change. Existing
  processes keep their old environment.

## Privacy Rules For Debug Logs

Verbose mode can log translated request payloads. Those payloads may contain
private prompts, file names, repository details, or other sensitive data.

- Do not paste raw verbose logs into public issues.
- Redact prompts, tokens, account identifiers, request ids, local usernames,
  and absolute personal paths before sharing.
- Prefer minimal synthetic prompts when proving routing or effort behavior.