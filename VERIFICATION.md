# Verification

## Warm sessions and follow-up prompts (2026-11-03)

OpenCode 2.2.5, Kiro CLI 2.37.1, Bun 1.4.2 on macOS, model `kiro/claude-sonnet-4.6`.

- `bun run typecheck`, `bun test` (19 tests, 80 assertions), `bun run test:auth` and `bun run test:install` passed.
- `bun run test:e2e` passed all 14 live checks listed below. The `KIRO_OPENCODE_DEBUG` log showed follow-up messages reusing the Kiro session, and fresh sessions after an interruption and for title/compaction requests.
- A held MCP tool call survived 200 seconds through the stdio relay. Kiro's HTTP MCP transport failed after about 120 seconds, so the relay stays on stdio.
- Stopping OpenCode normally, and killing it with SIGKILL, both left no `kiro-cli` or relay processes behind.

Benchmark: the same three-turn conversation, run three times against two private OpenCode servers, one with the previous release and one with this version. Turn 1 asks to read a file, turn 2 asks about README headings (it uses a tool), and turn 3 is "Reply with just DONE." Times are from request to first streamed event, as measured by the bridge. Credits are Kiro's own `meteringUsage` reports. Values are medians.

| Turn | Previous: first event | This version: first event | Previous: credits | This version: credits |
|---|---|---|---|---|
| 1 (new conversation) | 7.35 s | 3.17 s | 0.076 | 0.078 |
| 2 (follow-up with tool call) | 7.76 s | 1.98 s | 0.149 | 0.131 |
| 3 (short follow-up) | 7.07 s | 1.10 s | 0.076 | 0.043 |
| Whole conversation | | | 0.306 | 0.255 |

On follow-ups the bridge sent Kiro 30–96 characters instead of a 23–26 KB replayed transcript. For comparison, the same turns in a warm native Kiro CLI session (default agent, no OpenCode system prompt or tools) took 1.03–1.06 s to the first text and 0.037–0.038 credits on turn 3. One-shot `kiro-cli chat --no-interactive --resume` took 6.0–7.8 s per turn.

## Earlier verification

Live verification on 2026-10-05 with OpenCode 2.0.23, Kiro CLI 2.25.0 and Bun 1.4.2 on macOS. Model: `kiro/claude-sonnet-4.6`, using the existing authenticated Kiro account. These checks consume real model credits.

## Live OpenCode suite

`bun run test:e2e` passed all 14 checks in its disposable Git project:

1. Streamed assistant text with an exact expected answer.
2. Conversation continuation recalling a word from the assistant's previous answer.
3. Native file writing and reading, checking actual file bytes and recorded tool calls.
4. Denied permissions preventing file changes.
5. Native terminal execution with recorded output.
6. An existing OpenCode MCP tool invoked through v2 Code Mode and the Kiro relay.
7. An attached image reaching Kiro.
8. An image returned by OpenCode's native read tool reaching Kiro.
9. Native session compaction producing its summary.
10. Interruption while awaiting an actual permission prompt, without executing the write.
11. A rejected permission becoming a tool error returned to Kiro, without executing the write.
12. Successful generation after interruption.
13. Native session diff, undo and redo, checking actual restored file bytes.
14. Two simultaneous sessions returning separate expected answers.

Snapshot checks run in a Git workspace under Documents. OpenCode did not capture snapshots in an earlier OS temporary-directory workspace; snapshot availability remains subject to OpenCode's own settings and capture rules.

## Local checks

- `bun run typecheck`: passed.
- `bun test`: 9 tests passed, 32 assertions. Covers authentication, streaming, transcript/image conversion, suspended tool continuations, cancellation, parallel tool calls, JSONC installation/uninstallation and migration from an older installation.
- `bun install --frozen-lockfile`: passed.
- `bun run test:install`: passed. The release archive includes the production lockfile; installation, a repeated installation migrating the prior entry, the `current` link and uninstall preserve an unrelated provider/plugin configuration. The download is substituted with the locally built release archive for this check.
- The global local-directory installation generated `INSTALLED_PLUGIN_OK` using the high-effort variant in standalone OpenCode.
- `bun run test:package`: packed and installed the archive into a disposable project, verified that the packaged copy was the active plugin, and generated `PACKAGED_PLUGIN_OK` with high effort. The test isolates OpenCode's global configuration while retaining Kiro authentication; no global configuration is changed.

## Limits

This validates practical OpenCode coding flows, not every future release, model or tool. Token usage is estimated from text; exact Kiro billing and image token accounting are unavailable. Binary PDF/audio/video, raw model sampling/structured-output parity, Kiro-specific proprietary agents and Codex's Responses protocol are outside this integration. See [README.md](README.md) for installation and the full boundaries.
