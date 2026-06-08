# Copilot API Proxy

> [!WARNING]
> This is a reverse-engineered proxy of GitHub Copilot API. It is not supported by GitHub, and may break unexpectedly. Use at your own risk.

> [!WARNING]
> **GitHub Security Notice:**  
> Excessive automated or scripted use of Copilot (including rapid or bulk requests, such as via automated tools) may trigger GitHub's abuse-detection systems.  
> You may receive a warning from GitHub Security, and further anomalous activity could result in temporary suspension of your Copilot access.
>
> GitHub prohibits use of their servers for excessive automated bulk activity or any activity that places undue burden on their infrastructure.
>
> Please review:
>
> - [GitHub Acceptable Use Policies](https://docs.github.com/site-policy/acceptable-use-policies/github-acceptable-use-policies#4-spam-and-inauthentic-activity-on-github)
> - [GitHub Copilot Terms](https://docs.github.com/site-policy/github-terms/github-terms-for-additional-products-and-features#github-copilot)
>
> Use this proxy responsibly to avoid account restrictions.

[![ko-fi](https://ko-fi.com/img/githubbutton_sm.svg)](https://ko-fi.com/E1E519XS7W)

---

**Note:** If you are using [opencode](https://github.com/sst/opencode), you do not need this project. Opencode supports GitHub Copilot provider out of the box.

---

## Project Overview

A reverse-engineered proxy for the GitHub Copilot API that exposes it as an OpenAI and Anthropic compatible service. This allows you to use GitHub Copilot with any tool that supports the OpenAI Chat Completions API or the Anthropic Messages API, including to power [Claude Code](https://docs.anthropic.com/en/docs/claude-code/overview).

## Features

- **OpenAI & Anthropic Compatibility**: Exposes GitHub Copilot as an OpenAI-compatible (`/v1/chat/completions`, `/v1/models`, `/v1/embeddings`) and Anthropic-compatible (`/v1/messages`) API.
- **GPT-5 family via the Responses API**: Models that GitHub only serves over the `/responses` endpoint (e.g. the GPT-5 family) are routed there transparently and translated back to chat-completion shape, so they work through both the OpenAI and Anthropic endpoints, streaming or not. See [Reasoning Effort & Context Directives](#reasoning-effort--context-directives).
- **Reasoning effort & context directives**: Request a model's reasoning effort or context window with a bracketed model-name suffix, e.g. `gpt-5.5[high]` or `claude-opus-4.8[1m]`.
- **Persistent token-usage accounting**: Every request's token usage is logged locally and queryable via `GET /usage/tokens`. See [Token Usage Accounting](#token-usage-accounting).
- **Resilient by default**: Long streaming completions no longer trip undici's stock 300s timeout (configurable via `COPILOT_API_TIMEOUT_MS`), and transient DNS failures during token refresh can no longer crash the process.
- **Claude Code Integration**: Easily configure and launch [Claude Code](https://docs.anthropic.com/en/docs/claude-code/overview) to use Copilot as its backend with a simple command-line flag (`--claude-code`).
- **Usage Dashboard**: A web-based dashboard to monitor your Copilot API usage, view quotas, and see detailed statistics.
- **Rate Limit Control**: Manage API usage with rate-limiting options (`--rate-limit`) and a waiting mechanism (`--wait`) to prevent errors from rapid requests.
- **Manual Request Approval**: Manually approve or deny each API request for fine-grained control over usage (`--manual`).
- **Token Visibility**: Option to display GitHub and Copilot tokens during authentication and refresh for debugging (`--show-token`).
- **Flexible Authentication**: Authenticate interactively or provide a GitHub token directly, suitable for CI/CD environments.
- **Support for Different Account Types**: Works with individual, business, and enterprise GitHub Copilot plans.

## Demo

https://github.com/user-attachments/assets/7654b383-669d-4eb9-b23c-06d7aefee8c5

## Prerequisites

- Bun (>= 1.2.x)
- GitHub account with Copilot subscription (individual, business, or enterprise)

## Installation

To install dependencies, run:

```sh
bun install
```

## Using with Docker

Build image

```sh
docker build -t copilot-api .
```

Run the container

```sh
# Create a directory on your host to persist the GitHub token and related data
mkdir -p ./copilot-data

# Run the container with a bind mount to persist the token
# This ensures your authentication survives container restarts

docker run -p 4141:4141 -v $(pwd)/copilot-data:/root/.local/share/copilot-api copilot-api
```

> **Note:**
> The GitHub token and related data will be stored in `copilot-data` on your host. This is mapped to `/root/.local/share/copilot-api` inside the container, ensuring persistence across restarts.

### Docker with Environment Variables

You can pass the GitHub token directly to the container using environment variables:

```sh
# Build with GitHub token
docker build --build-arg GH_TOKEN=your_github_token_here -t copilot-api .

# Run with GitHub token
docker run -p 4141:4141 -e GH_TOKEN=your_github_token_here copilot-api

# Run with additional options
docker run -p 4141:4141 -e GH_TOKEN=your_token copilot-api start --verbose --port 4141
```

### Docker Compose Example

```yaml
version: "3.8"
services:
  copilot-api:
    build: .
    ports:
      - "4141:4141"
    environment:
      - GH_TOKEN=your_github_token_here
    restart: unless-stopped
```

The Docker image includes:

- Multi-stage build for optimized image size
- Non-root user for enhanced security
- Health check for container monitoring
- Pinned base image version for reproducible builds

## Using with npx

You can run the project directly using npx:

```sh
npx copilot-api@latest start
```

With options:

```sh
npx copilot-api@latest start --port 8080
```

For authentication only:

```sh
npx copilot-api@latest auth
```

## Command Structure

Copilot API now uses a subcommand structure with these main commands:

- `start`: Start the Copilot API server. This command will also handle authentication if needed.
- `auth`: Run GitHub authentication flow without starting the server. This is typically used if you need to generate a token for use with the `--github-token` option, especially in non-interactive environments.
- `check-usage`: Show your current GitHub Copilot usage and quota information directly in the terminal (no server required).
- `debug`: Display diagnostic information including version, runtime details, file paths, and authentication status. Useful for troubleshooting and support.

## Command Line Options

### Start Command Options

The following command line options are available for the `start` command:

| Option         | Description                                                                   | Default    | Alias |
| -------------- | ----------------------------------------------------------------------------- | ---------- | ----- |
| --port         | Port to listen on                                                             | 4141       | -p    |
| --verbose      | Enable verbose logging                                                        | false      | -v    |
| --account-type | Account type to use (individual, business, enterprise)                        | individual | -a    |
| --manual       | Enable manual request approval                                                | false      | none  |
| --rate-limit   | Rate limit in seconds between requests                                        | none       | -r    |
| --wait         | Wait instead of error when rate limit is hit                                  | false      | -w    |
| --github-token | Provide GitHub token directly (must be generated using the `auth` subcommand) | none       | -g    |
| --claude-code  | Generate a command to launch Claude Code with Copilot API config              | false      | -c    |
| --show-token   | Show GitHub and Copilot tokens on fetch and refresh                           | false      | none  |
| --proxy-env    | Initialize proxy from environment variables                                   | false      | none  |

### Auth Command Options

| Option       | Description               | Default | Alias |
| ------------ | ------------------------- | ------- | ----- |
| --verbose    | Enable verbose logging    | false   | -v    |
| --show-token | Show GitHub token on auth | false   | none  |

### Debug Command Options

| Option | Description               | Default | Alias |
| ------ | ------------------------- | ------- | ----- |
| --json | Output debug info as JSON | false   | none  |

## API Endpoints

The server exposes several endpoints to interact with the Copilot API. It provides OpenAI-compatible endpoints and now also includes support for Anthropic-compatible endpoints, allowing for greater flexibility with different tools and services.

### OpenAI Compatible Endpoints

These endpoints mimic the OpenAI API structure.

| Endpoint                    | Method | Description                                               |
| --------------------------- | ------ | --------------------------------------------------------- |
| `POST /v1/chat/completions` | `POST` | Creates a model response for the given chat conversation. |
| `GET /v1/models`            | `GET`  | Lists the currently available models.                     |
| `POST /v1/embeddings`       | `POST` | Creates an embedding vector representing the input text.  |

### Anthropic Compatible Endpoints

These endpoints are designed to be compatible with the Anthropic Messages API.

| Endpoint                         | Method | Description                                                  |
| -------------------------------- | ------ | ------------------------------------------------------------ |
| `POST /v1/messages`              | `POST` | Creates a model response for a given conversation.           |
| `POST /v1/messages/count_tokens` | `POST` | Calculates the number of tokens for a given set of messages. |

### Usage Monitoring Endpoints

New endpoints for monitoring your Copilot usage and quotas.

| Endpoint            | Method | Description                                                                                        |
| ------------------- | ------ | -------------------------------------------------------------------------------------------------- |
| `GET /usage`        | `GET`  | Get detailed Copilot usage statistics and quota information (from GitHub).                          |
| `GET /usage/tokens` | `GET`  | Get this proxy's locally-recorded token usage, aggregated by model and day. See below.             |
| `GET /token`        | `GET`  | Get the current Copilot token being used by the API.                                               |

## Reasoning Effort & Context Directives

See [Lessons Learned](docs/lessons-learned.md) for the edge cases discovered
while wiring these directives through Claude Code and GPT-5-family models.

Some Copilot capabilities are request parameters rather than separate models. To
request them with any client (including ones that only let you set a model
name), append a bracketed directive to the model id. The directive is parsed and
stripped before the request reaches GitHub.

| Model name             | Effect                                                              |
| ---------------------- | ------------------------------------------------------------------ |
| `gpt-5.5[high]`        | Sets `reasoning_effort` to `high`.                                  |
| `gpt-5.5[xhigh]`       | Sets `reasoning_effort` to `xhigh`.                                 |
| `gpt-5.5[high,1m]`     | Combine directives with a comma (or repeat brackets: `[high][1m]`).|
| `claude-opus-4.8[1m]`  | Recognised and stripped (the suffix is a no-op; see note below).   |

- **Reasoning effort** accepts `none`, `low`, `medium`, `high`, and `xhigh`. The
  aliases `max` (→ `xhigh`) and `minimal` (→ `low`) are normalised to the nearest
  value the GPT-5 family accepts. An explicit `reasoning_effort` in the request
  body always takes precedence over the suffix.
- **Claude Code effort injection** is controlled by
  `COPILOT_API_ANTHROPIC_EFFORT` for the Anthropic-compatible `/v1/messages`
  path. Keep client-side context suffixes clean (for example `gpt-5.5[1m]`) and
  pass effort through the environment (for example
  `COPILOT_API_ANTHROPIC_EFFORT=xhigh`) instead of relying on a combined suffix.
- **GPT-5 routing** is automatic: if `/chat/completions` rejects a model with
  `unsupported_api_for_model`, the proxy transparently retries it over the
  `/responses` endpoint and remembers the choice for subsequent requests.
- **Context (`1m`)** is recognised and stripped, but it is informational only —
  the proxy does **not** need to send anything extra to unlock a large context.
  Newer Claude models such as `claude-opus-4.8` advertise a 1M-token context
  window natively, so a plain `claude-opus-4.8` request already gets the full
  window. Older 4.6/4.7 expose 1M as a dedicated model id
  (`claude-opus-4.6-1m`, `claude-opus-4.7-1m-internal`) which you pass through
  directly. The 200K/1M switch shown in some editors is a client-side
  context-budgeting choice, not an API parameter.

## Token Usage Accounting

The proxy records the token usage of every completion it serves (OpenAI or
Anthropic, streaming or not, chat or `/responses`) to a local JSON Lines file at
`~/.local/share/copilot-api/usage.jsonl`. Recording is best-effort and never
interferes with a request.

Query the aggregated totals with `GET /usage/tokens` (also available as
`/v1/usage/tokens`):

```sh
# Everything recorded so far
curl http://localhost:4141/usage/tokens

# Only a specific model
curl "http://localhost:4141/usage/tokens?model=claude-opus-4.8"

# Only since a given ISO timestamp (inclusive)
curl "http://localhost:4141/usage/tokens?since=2026-06-01"
```

The response aggregates `requests`, `prompt_tokens`, `completion_tokens`,
`cached_tokens`, and `total_tokens` overall, `by_model`, and `by_day`:

```json
{
  "total": {
    "requests": 4,
    "prompt_tokens": 40,
    "completion_tokens": 38,
    "cached_tokens": 0,
    "total_tokens": 78
  },
  "by_model": {
    "claude-opus-4.8": { "requests": 3, "prompt_tokens": 32, "completion_tokens": 32, "cached_tokens": 0, "total_tokens": 64 },
    "gpt-5.5": { "requests": 1, "prompt_tokens": 8, "completion_tokens": 6, "cached_tokens": 0, "total_tokens": 14 }
  },
  "by_day": {
    "2026-06-05": { "requests": 4, "prompt_tokens": 40, "completion_tokens": 38, "cached_tokens": 0, "total_tokens": 78 }
  }
}
```

## Network Timeouts

Long agentic completions can take many minutes to return the first byte, which
trips undici's stock 300-second timeout and surfaces as `UND_ERR_HEADERS_TIMEOUT`
or `BodyTimeoutError`. The proxy raises the headers/body timeout to 15 minutes by
default. Override it (in milliseconds) with the `COPILOT_API_TIMEOUT_MS`
environment variable:

```sh
COPILOT_API_TIMEOUT_MS=1800000 npx copilot-api@latest start # 30 minutes
```

## Example Usage

Using with npx:

```sh
# Basic usage with start command
npx copilot-api@latest start

# Run on custom port with verbose logging
npx copilot-api@latest start --port 8080 --verbose

# Use with a business plan GitHub account
npx copilot-api@latest start --account-type business

# Use with an enterprise plan GitHub account
npx copilot-api@latest start --account-type enterprise

# Enable manual approval for each request
npx copilot-api@latest start --manual

# Set rate limit to 30 seconds between requests
npx copilot-api@latest start --rate-limit 30

# Wait instead of error when rate limit is hit
npx copilot-api@latest start --rate-limit 30 --wait

# Provide GitHub token directly
npx copilot-api@latest start --github-token ghp_YOUR_TOKEN_HERE

# Run only the auth flow
npx copilot-api@latest auth

# Run auth flow with verbose logging
npx copilot-api@latest auth --verbose

# Show your Copilot usage/quota in the terminal (no server needed)
npx copilot-api@latest check-usage

# Display debug information for troubleshooting
npx copilot-api@latest debug

# Display debug information in JSON format
npx copilot-api@latest debug --json

# Initialize proxy from environment variables (HTTP_PROXY, HTTPS_PROXY, etc.)
npx copilot-api@latest start --proxy-env
```

## Using the Usage Viewer

After starting the server, a URL to the Copilot Usage Dashboard will be displayed in your console. This dashboard is a web interface for monitoring your API usage.

1.  Start the server. For example, using npx:
    ```sh
    npx copilot-api@latest start
    ```
2.  The server will output a URL to the usage viewer. Copy and paste this URL into your browser. It will look something like this:
    `https://ericc-ch.github.io/copilot-api?endpoint=http://localhost:4141/usage`
    - If you use the `start.bat` script on Windows, this page will open automatically.

The dashboard provides a user-friendly interface to view your Copilot usage data:

- **API Endpoint URL**: The dashboard is pre-configured to fetch data from your local server endpoint via the URL query parameter. You can change this URL to point to any other compatible API endpoint.
- **Fetch Data**: Click the "Fetch" button to load or refresh the usage data. The dashboard will automatically fetch data on load.
- **Usage Quotas**: View a summary of your usage quotas for different services like Chat and Completions, displayed with progress bars for a quick overview.
- **Detailed Information**: See the full JSON response from the API for a detailed breakdown of all available usage statistics.
- **URL-based Configuration**: You can also specify the API endpoint directly in the URL using a query parameter. This is useful for bookmarks or sharing links. For example:
  `https://ericc-ch.github.io/copilot-api?endpoint=http://your-api-server/usage`

## Using with Claude Code

This proxy can be used to power [Claude Code](https://docs.anthropic.com/en/claude-code), an experimental conversational AI assistant for developers from Anthropic.

There are two ways to configure Claude Code to use this proxy:

### Interactive Setup with `--claude-code` flag

To get started, run the `start` command with the `--claude-code` flag:

```sh
npx copilot-api@latest start --claude-code
```

You will be prompted to select a primary model and a "small, fast" model for background tasks. After selecting the models, a command will be copied to your clipboard. This command sets the necessary environment variables for Claude Code to use the proxy.

Paste and run this command in a new terminal to launch Claude Code.

### Manual Configuration with `settings.json`

Alternatively, you can configure Claude Code by creating a `.claude/settings.json` file in your project's root directory. This file should contain the environment variables needed by Claude Code. This way you don't need to run the interactive setup every time.

Here is an example `.claude/settings.json` file:

```json
{
  "env": {
    "ANTHROPIC_BASE_URL": "http://localhost:4141",
    "ANTHROPIC_AUTH_TOKEN": "dummy",
    "ANTHROPIC_MODEL": "gpt-4.1",
    "ANTHROPIC_DEFAULT_SONNET_MODEL": "gpt-4.1",
    "ANTHROPIC_SMALL_FAST_MODEL": "gpt-4.1",
    "ANTHROPIC_DEFAULT_HAIKU_MODEL": "gpt-4.1",
    "DISABLE_NON_ESSENTIAL_MODEL_CALLS": "1",
    "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC": "1"
  },
  "permissions": {
    "deny": [
      "WebSearch"
    ]
  }
}
```

You can find more options here: [Claude Code settings](https://docs.anthropic.com/en/docs/claude-code/settings#environment-variables)

You can also read more about IDE integration here: [Add Claude Code to your IDE](https://docs.anthropic.com/en/docs/claude-code/ide-integrations)

## Running from Source

The project can be run from source in several ways:

### Development Mode

```sh
bun run dev
```

### Production Mode

```sh
bun run start
```

## Usage Tips

- To avoid hitting GitHub Copilot's rate limits, you can use the following flags:
  - `--manual`: Enables manual approval for each request, giving you full control over when requests are sent.
  - `--rate-limit <seconds>`: Enforces a minimum time interval between requests. For example, `copilot-api start --rate-limit 30` will ensure there's at least a 30-second gap between requests.
  - `--wait`: Use this with `--rate-limit`. It makes the server wait for the cooldown period to end instead of rejecting the request with an error. This is useful for clients that don't automatically retry on rate limit errors.
- If you have a GitHub business or enterprise plan account with Copilot, use the `--account-type` flag (e.g., `--account-type business`). See the [official documentation](https://docs.github.com/en/enterprise-cloud@latest/copilot/managing-copilot/managing-github-copilot-in-your-organization/managing-access-to-github-copilot-in-your-organization/managing-github-copilot-access-to-your-organizations-network#configuring-copilot-subscription-based-network-routing-for-your-enterprise-or-organization) for more details.
