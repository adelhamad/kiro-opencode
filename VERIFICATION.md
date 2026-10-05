# Verification

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
