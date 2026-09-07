# Codex V2 Cross-Model Handoff

## Failure And Cause

On 2026-09-07, Codex CLI 0.153.2 could run `gpt-6-astra` independently,
including file tools, but a fresh Sol-to-Astra child failed before inference:

```text
Encrypted function output content could not be decrypted or decoded.
```

A synthetic loopback capture showed that the spawn tool declared its message
as a plain-text task but also set
`parameters.properties.message.encrypted = true`. The upstream returned an
opaque encrypted `spawn_agent.message`, which Codex placed in the child's
`agent_message.content` as `encrypted_content`. Astra rejected that content.

Removing only the schema encryption request made the upstream return the
complete plaintext task, and the same fresh-context handoff succeeded.
Changing the function name alone or disabling Astra responses-lite did not
resolve the failure. This establishes the schema-triggered compatibility
failure; it does not establish how the upstream manages its encryption keys.

## Compatibility Rule

`adaptResponsesPayloadForCopilot` identifies Codex V2 collaboration namespaces
by their spawn tool's `agent_type` property. Alongside the existing namespace
alias, it removes `encrypted: true` only from those tools' direct `message`
parameter schemas. The existing plaintext-content adapter relays recognizable
plaintext in the client-generated agent message wrapper.

The transformation is non-mutating and idempotent. It preserves other tools,
legacy collaboration schemas, other encrypted parameter properties, task
text, and opaque history content. It does not decrypt or drop pending tasks.
HTTP authentication and TLS to the upstream remain unchanged. Inter-agent
task arguments are now ordinary plaintext in the local conversation, as other
tool arguments are; do not include credentials in delegated tasks.

Use fresh child context and complete plain-text task sentences containing
whitespace. Old pending encrypted messages and full-history cross-model forks
are not made portable by this fix. Whitespace-free ambiguous content remains
opaque under the existing detector rather than being guessed as plaintext.

## Verification

- `bun test`: 106 passed across 10 files.
- Focused `tests/responses-endpoint.test.ts`: 26 passed.
- Typecheck, lint of the two touched files, and build passed.
- A synthetic probe using the actual production adapter passed spawn,
  Astra file-tool execution, return-to-parent, and same-child followup.
- After rebuilding and restarting the existing PM2 process, direct port 4141
  acceptance passed without probe transformations. Root session
  `01a07c16-01cc-7562-aea9-226ed49a37da` was Sol/high; child
  `01a07c16-15c7-7ce3-ae16-a58010805b20` was Astra/high. Runtime records show
  both `ASTRA_READ_OK cross_model_83721` and `ASTRA_FOLLOWUP_OK`.
- The diagnostic only used synthetic fixture data. No trading accounts,
  trading state, or trading scheduler were accessed or modified.