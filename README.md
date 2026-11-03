# Kiro for OpenCode v2

An OpenCode v2 plugin that uses your authenticated Kiro CLI as a model provider. OpenCode owns the tools, permission prompts, MCP connections, file snapshots, undo/redo and session history. The plugin automatically starts its private local bridge and Kiro processes and cleans them up. No Docker, port configuration or manually started server.

## Installation

### 1. Install the prerequisites and sign in

You need [Bun](https://bun.sh/docs/installation), [OpenCode v2](https://opencode.ai/v2/docs/) and [Kiro CLI](https://kiro.dev/docs/getting-started/installation/) on your machine. Bun and Kiro CLI must be available on the `PATH` used by OpenCode. Git, Rust and Docker are not required for the quick installation.

Tested on macOS with **OpenCode 2.0.23**, **Kiro CLI 2.25.0** and **Bun 1.4.2**. Other versions and operating systems have not been verified; the OpenCode plugin dependency is pinned to 2.0.23.

```sh
opencode --version
bun --version
kiro-cli --version
kiro-cli login
```

Sign in using your own Kiro account. Authentication remains in the official Kiro CLI; you do not put an API key in this plugin. Requests use your account's available models and usage allowance.

### 2. Install with one command (macOS/Linux)

Download the published release and register it with OpenCode:

```sh
curl -fsSL https://raw.githubusercontent.com/adelhamad/kiro-opencode/main/install.sh | bash
```

The installer downloads release **0.2.1**, installs its dependencies, and keeps the plugin under `~/.local/share/opencode-kiro`. No clone or manually managed server is needed. The command executes this repository's [installer](install.sh); you can download and inspect it before running it.

It registers the installed directory in your global OpenCode configuration, preserves other providers, plugins and your default model, supports JSONC comments, and backs up the configuration before changing it. An older local installation of `opencode-kiro` in that configuration is replaced automatically, preserving its options. No package is published to npm. Windows has not been verified; the shell installer requires macOS/Linux, Bash, curl and tar.

For development or manual installation with Git:

```sh
git clone https://github.com/adelhamad/kiro-opencode.git
cd kiro-opencode
bun install --frozen-lockfile
bun run install:plugin
```

A manual installation references your clone, so keep it in place.

### 3. Restart the background service and select a model

Exit any open OpenCode terminal UI, then run:

```sh
opencode service restart
opencode models
```

After the service finishes initializing, the list should include models such as `kiro/claude-sonnet-4.6`. Reopening the terminal UI alone may keep the old background service running.

Open OpenCode in the project you want to work on:

```sh
cd /path/to/your/project
opencode
```

Run `/models`, search for `kiro`, and select a model under **Kiro CLI**. The model list and context windows come from your CLI. No extra server command is needed during normal use: the plugin starts and stops its private local bridge and Kiro processes automatically.

For a quick generation check from any project (uses Kiro credits):

```sh
opencode run --standalone --model kiro/claude-sonnet-4.6 "Reply with HELLO. Do not use tools."
```

## Troubleshooting

- **Kiro is missing from `/models`:** run `opencode service restart`, allow it to initialize, then check `opencode plugin list` and `opencode models`. Restart the terminal UI afterward. The plugin ID should be `opencode.provider.kiro`.
- **The plugin fails to load:** confirm `bun` and `kiro-cli` are on OpenCode's `PATH`, the installed directory still exists, and dependency installation completed. Re-run the installation command if necessary.
- **Authentication expired:** leave OpenCode open and run `kiro-cli login --use-device-flow` in a separate terminal. Complete sign-in there, then retry the failed request. Device flow avoids a localhost browser callback. The plugin checks authentication before starting Kiro, uses non-interactive model discovery, and refreshes the model list every 30 seconds; a failed check no longer prevents plugin startup. If you started while signed out, allow the next refresh for Kiro models to appear.
- **Unavailable-model errors:** run `kiro-cli chat --list-models --format json` and select an available model. CLI check failures and timeouts are reported separately; check the command in a terminal for detailed diagnostics.
- **Duplicate plugin ID:** keep one installation. Remove any separate project or global copy that registers another clone of this plugin.
- **The model calls itself Kiro:** this integration uses Kiro's agent through ACP. Its built-in instructions remain; this is not a raw Claude API connection. A custom agent prompt does not remove that underlying agent layer.

## Update

For the quick installation, re-run the installer, then restart the service:

```sh
curl -fsSL https://raw.githubusercontent.com/adelhamad/kiro-opencode/main/install.sh | bash
opencode service restart
```

For a manual Git installation, run these commands from your clone:

```sh
git pull --ff-only
bun install --frozen-lockfile
opencode service restart
```

Restart the terminal UI afterward. To move the clone, uninstall first and reinstall from its new location.

## Uninstall

```sh
bun ~/.local/share/opencode-kiro/current/scripts/install.ts --uninstall
opencode service restart
```

For a manual Git installation, run from your clone:

```sh
bun run uninstall:plugin
opencode service restart
```

Restart the terminal UI. This removes only this repository's plugin entry; it does not uninstall Kiro CLI or delete your OpenCode sessions.

Downloaded versions remain on disk so existing processes can finish using them. After restarting OpenCode, you may remove unused versions under `~/.local/share/opencode-kiro`; keep the directory targeted by `current` while the plugin is installed. Set `KIRO_OPENCODE_INSTALL_DIR` when running the shell installer to use a different installation location, and use that location for uninstall.

## Configuration

The installer adds this repository's absolute path to the `plugins` array in `~/.config/opencode/opencode.json` or an existing `opencode.jsonc` (honors OpenCode's `OPENCODE_CONFIG_DIR` override). Install one copy of the plugin; separate global and project copies have the same plugin ID and OpenCode rejects the duplicate. For project-only installation:

```sh
bun scripts/install.ts --config=/absolute/path/to/project/opencode.jsonc
```

For explicit CLI location or the `auto` fallback, replace the plugin entry with an object:

```jsonc
{
  "plugins": [
    {
      "package": "/absolute/path/to/kiro-opencode",
      "options": {
        "cli": "/absolute/path/to/kiro-cli",
        "model": "claude-sonnet-4.6",
        "prewarm": true,
        "idleMinutes": 15
      }
    }
  ]
}
```

`prewarm` (default `true`) starts the Kiro process when the plugin loads with a signed-in CLI, so the first message skips process startup; set it to `false` to start Kiro only on the first request. `idleMinutes` (default 15) is how long an unused Kiro process and kept conversations stay alive.

Select an explicit model when its identity matters. `auto` maps to the configured fallback (Sonnet 4.6 by default) rather than relying on a potentially unavailable CLI default. Low/medium/high reasoning variants are forwarded to Kiro's `--effort` flag; availability is determined by Kiro and the selected model.

## Execution and permissions

Kiro receives an isolated temporary agent with **only** the relay MCP server's tools. It never gets built-in filesystem or shell tools, global Kiro MCP servers or user-defined Kiro agent hooks. The relay exposes the tool snapshot OpenCode supplied for that request. Every requested call is returned to OpenCode as a normal function call; OpenCode executes it with its own permission checks, and its result unblocks Kiro. Existing OpenCode plugins and MCP tools, including v2 Code Mode tools, follow that same path.

The private bridge binds to loopback on an automatically assigned port, with a random in-memory API secret and separate unguessable MCP session URLs. Authentication stays inside the official CLI. One warm `kiro-cli acp` process per reasoning-effort level hosts all conversations as separate Kiro sessions; it exits after it has been idle, when OpenCode unloads the plugin or exits, and after an authentication failure. Prewarming starts the process but makes no model request and uses no credits. Concurrent OpenCode sessions and auxiliary title/compaction requests use separate Kiro sessions.

## Verified behavior and boundaries

See [VERIFICATION.md](VERIFICATION.md) for the actual live checks. No compatibility layer can promise that future OpenCode/Kiro releases or every possible tool invocation will be issue-free.

- Text and base64 image input, streamed text/reasoning, native tools, existing MCP tools, permissions, session history and compaction use the normal OpenCode path.
- An OpenCode conversation keeps its Kiro session between messages. A follow-up sends only the new user message; Kiro already holds the earlier turns, so they are not re-sent as new input and Kiro can reuse its prompt cache. The plugin compares digests of every earlier message. If anything before the new message changed (undo/revert, compaction, edited instructions, a different tool list, directory or effort level), after an interruption or error, or after the conversation idled out, it starts a fresh Kiro session with a labelled transcript of OpenCode's full context. Title and compaction requests are always one-shot sessions. Tool-driven continuations within a generation resume the suspended Kiro turn. ACP has no separate native system-role field.
- Starting Kiro reuses the model watcher's recent `kiro-cli whoami` result instead of running it again for every message.
- Kiro 2.x ACP does not expose exact billing token counts. OpenCode receives **estimated BPE text counts** of the full conversation, even when only a follow-up was sent, because OpenCode uses them for context accounting and compaction. They are not exact Claude tokenization, image usage or Kiro credits. Cost is not fabricated. Set `KIRO_OPENCODE_DEBUG=/path/to/log.jsonl` in OpenCode's environment to record per-request timings, whether the Kiro session was reused, and Kiro's reported credits (no message content).
- Binary PDF/audio/video input is not supported by the CLI bridge. Images are supported; text files use OpenCode's normal resolution/read tools. Unsupported content fails explicitly.
- Kiro's own proprietary agents, native subagents and global MCP settings are not injected into OpenCode. OpenCode's available tools are the execution surface.
- Chat sampling, stop sequences, output limits and structured-output controls are not equivalent to a raw model API over ACP. This is an OpenCode provider integration, not a general-purpose OpenAI API implementation or a Codex Responses provider.
- Pending tool continuations expire after five minutes; a complete generation has a fifteen-minute ACP deadline. Retry the failed request after an authentication change; interrupted generations are not replayed automatically. Restart OpenCode after a CLI upgrade.

## Development

```sh
bun run typecheck
bun test
bun run test:e2e
bun run test:auth
bun run test:package
bun run test:install
```

The E2E suite uses your logged-in Kiro account and consumes model credits. It creates its own disposable Git workspace and private OpenCode server, then removes both; it does not change global configuration. Unit tests use a fake CLI. `test:auth` runs a real isolated OpenCode server with simulated Kiro login expiry and recovery, without using account credentials or model credits. Installation tests verify comment preservation, idempotency and isolated uninstall. `test:install` builds the release archive and exercises the shell installer with a local download fixture, production dependencies, upgrade migration and uninstall in an isolated configuration.

References: [OpenCode v2 plugins](https://opencode.ai/v2/docs/build/plugins), [providers](https://opencode.ai/v2/docs/providers).
