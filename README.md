# vsc-agents-connector

VS Code extension that connects the editor to coding agents — currently
[opencode](https://opencode.ai), with the VS Code side abstracted so more agents
can be plugged in later.

## Architecture: three layers

```
┌─ Layer 1  src/context/    read & watch the VS Code editor (snapshot only)
├─ Layer 2  src/connector/  agent registry, connection persistence, dispatch
└─ Layer 3  src/agents/     per-agent protocol (opencode today)
```

- **Layer 1 — `src/context/`** talks only to the `vscode` API. It produces an
  `EditorSnapshot` (`{ fsPath, relativePath, workspaceFolder, selection? }`)
  and watches selection/active-editor changes with debounce + dedupe. It knows
  nothing about agents or reference formatting.
- **Layer 2 — `src/connector/`** owns the single active connection. It keeps a
  registry of `AgentAdapter`s, persists the connection (secret header in
  SecretStorage, the rest per-workspace), renders the status bar, and routes
  Layer-1 snapshots to the active adapter's live-follow channel or its
  explicit `sendPrompt`.
- **Layer 3 — `src/agents/<id>/`** is the extension point. Each agent
  implements `AgentAdapter` (`src/connector/types.ts`): session discovery,
  `vscode://` pairing, manual connect, optional live-follow, and `sendPrompt` —
  plus the formatting of an `EditorSnapshot` into its own reference syntax
  (opencode: `@path#L1-2` / `file://…?start&end`). Server-side companion
  plugins live under `bridges/` (opencode: `bridges/opencode-vsc-bridge`).

Adding a new agent = implement `AgentAdapter` under `src/agents/<id>/` and
register it in `extension.ts`. Layers 1 and 2 do not change.

## Connect: three ways, best first

1. **VSC Agents: Connect to Local Service** — fully automatic. The extension reads the
   background service's registration file (`~/.local/state/opencode/service.json`, the
   documented discovery contract), lists its sessions, and asks you to pick one; a session
   whose directory matches the workspace is pre-selected. Nothing to type.
2. **`vscode://` link** — the opencode app (or any tool) opens
   `vscode://moose.vsc-agents-connector/connect?url=…&code=…&session=…`; the extension
   redeems the one-time pairing code for a session token. This is the path for remote
   servers and for a future app-side button; see `docs/bridge.md`.
3. **VSC Agents: Connect to Session** — manual fallback: server URL + password + session id.

## Features

- **Status bar** connection indicator; click to reconnect.
- **VSC Agents: Send Selection to Session** (`Ctrl+Alt+O` / `Cmd+Alt+O`, editor context menu):
  attaches the selected lines as `file://…?start&end` and queues a prompt.
- **VSC Agents: Send File Reference to Session** (editor title menu): same for the whole file.
- Token in SecretStorage, connection remembered per workspace.

## How it works

```
local service                        remote / web case
─────────────                        ─────────────────
service.json ──▶ url + password      app ──vscode://…&code──▶ pairing redeem
        │                                     │
        └──────▶ GET /api/session ──▶ QuickPick session
                          │
                          ▼
            SecretStorage: { url, credential, sessionID }
                          │
  "Send Selection" ── POST /api/session/:id/prompt (delivery: queue)
```

## Development

```bash
npm install
npm run compile   # type-check + emit to out/
npm test          # unit tests for the pure protocol layers (node --test)
```

Press `F5` in VS Code to launch an Extension Development Host with the extension loaded.

## Layout

```
src/wire.ts        pairing-code redeem, prompt building, file:// URIs (no vscode import)
src/discover.ts    service.json discovery + session listing (no vscode import)
src/extension.ts   activation, URI handler, commands, status bar, persistence
test/              node --test unit tests for both pure layers
docs/bridge.md     app-side bridge contract for the vscode:// path
```

