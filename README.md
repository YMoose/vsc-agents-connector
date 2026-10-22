# vsc-agents-connector

VS Code extension that connects the editor to coding agents — currently
[opencode](https://opencode.ai), with the VS Code side abstracted so more agents
can be plugged in later.

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

