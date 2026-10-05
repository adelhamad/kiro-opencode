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
- **Authentication or unavailable-model errors:** run `kiro-cli login` and `kiro-cli chat --list-models --format json`. Select an explicit model from that list, then restart the service.
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
        "model": "claude-sonnet-4.6"
      }
    }
  ]
}
```

Select an explicit model when its identity matters. `auto` maps to the configured fallback (Sonnet 4.6 by default) rather than relying on a potentially unavailable CLI default. Low/medium/high reasoning variants are forwarded to Kiro's `--effort` flag; availability is determined by Kiro and the selected model.

## Execution and permissions

Kiro receives an isolated temporary agent with **only** the relay MCP server's tools. It never gets built-in filesystem or shell tools, global Kiro MCP servers or user-defined Kiro agent hooks. The relay exposes the tool snapshot OpenCode supplied for that request. Every requested call is returned to OpenCode as a normal function call; OpenCode executes it with its own permission checks, and its result unblocks Kiro. Existing OpenCode plugins and MCP tools, including v2 Code Mode tools, follow that same path.

The private bridge binds to loopback on an automatically assigned port, with a random in-memory API secret and separate unguessable MCP session URLs. Authentication stays inside the official CLI. Processes are lazy: selecting Kiro does not start a model generation until a request is made. Concurrent OpenCode sessions and auxiliary title/compaction requests use separate Kiro turns.

## Verified behavior and boundaries

See [VERIFICATION.md](VERIFICATION.md) for the actual live checks. No compatibility layer can promise that future OpenCode/Kiro releases or every possible tool invocation will be issue-free.

- Text and base64 image input, streamed text/reasoning, native tools, existing MCP tools, permissions, session history and compaction use the normal OpenCode path.
- Each new user/auxiliary generation starts a fresh Kiro session with a labelled transcript of OpenCode's context. Tool-driven continuations within that generation resume the suspended Kiro turn. ACP has no separate native system-role field.
- Kiro 2.x ACP does not expose exact billing token counts. OpenCode receives **estimated BPE text counts**, useful for context accounting but not exact Claude tokenization, image usage or Kiro credits. Cost is not fabricated.
- Binary PDF/audio/video input is not supported by the CLI bridge. Images are supported; text files use OpenCode's normal resolution/read tools. Unsupported content fails explicitly.
- Kiro's own proprietary agents, native subagents and global MCP settings are not injected into OpenCode. OpenCode's available tools are the execution surface.
- Chat sampling, stop sequences, output limits and structured-output controls are not equivalent to a raw model API over ACP. This is an OpenCode provider integration, not a general-purpose OpenAI API implementation or a Codex Responses provider.
- Pending tool continuations expire after five minutes; a complete generation has a fifteen-minute ACP deadline. Restart OpenCode after an authentication change or CLI upgrade.

## Development

```sh
bun run typecheck
bun test
bun run test:e2e
bun run test:package
bun run test:install
```

The E2E suite uses your logged-in Kiro account and consumes model credits. It creates its own disposable Git workspace and private OpenCode server, then removes both; it does not change global configuration. Unit tests use a fake CLI. Installation tests verify comment preservation, idempotency and isolated uninstall. `test:install` builds the release archive and exercises the shell installer with a local download fixture, production dependencies, upgrade migration and uninstall in an isolated configuration.

References: [OpenCode v2 plugins](https://opencode.ai/v2/docs/build/plugins), [providers](https://opencode.ai/v2/docs/providers).
