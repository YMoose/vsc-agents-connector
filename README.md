# vsc-agents-connector

One lightweight VS Code extension for editor context in **OpenCode** and
**DeepSeek Harness (DSH)**. Click a file or select text to update the connected
agent's input area. Each VS Code window connects to one session at a time.

## DSH setup

1. Build and enable [dsh-editor-socket](https://github.com/YMoose/dsh-editor-socket)
   in your DSH profile. Its source is included as `vendor/dsh-editor-socket`.
   See the [socket README](https://github.com/YMoose/dsh-editor-socket/blob/main/README.md) for installation.
2. Start DSH and open a session whose working directory matches your VS Code
   workspace. Tested with DSH `0.2.2-rc.1`.
3. Run **VSC Agents: Connect to Local Service**, then choose the DSH session.
   The extension discovers local instances automatically; no token copying is needed.
4. Click or select code. DSH's existing composer shows the current file and line
   range. Send your message in DSH to give that context to the agent.

**Send Selection to Session** (`Ctrl+Alt+O` / `Cmd+Alt+O`) and **Send File Reference
to Session** pin references for the next message. Clicking, selecting and pinning
do not start DSH model tasks. References freeze when the user submits a message,
including when that message queues behind another task. Selected buffer text may
include unsaved edits; text over 32 KiB falls back to path and line references.

The socket listens only on loopback and uses a per-activation bearer token.
The extension runs on the workspace side of Remote SSH / containers, so the editor
adapter and DSH must run on the same machine and share filesystem paths. Start a
new local-service connection after DSH restarts and rotates its endpoint/token.
Clicking outside the connected workspace clears live DSH context. Explicit pins
remain until submitted or removed in DSH. Disabling live follow clears the live reference.

## OpenCode connections

- **Connect to Local Service** reads OpenCode's service registration and offers
  sessions in the workspace.
- A `vscode://moose.vsc-agents-connector/connect?url=…&code=…&session=…` link
  redeems a pairing code. See [docs/bridge.md](docs/bridge.md).
- **Connect to Session** accepts URL, password and session ID for OpenCode;
  choosing DSH uses its local discovery flow.

OpenCode uses its built-in `editor-bridge`. Explicit send pins the live reference
when supported; otherwise OpenCode can send a prompt after asking for an instruction.

Credentials are stored in VS Code SecretStorage; the chosen session is remembered
per workspace. The session picker and status bar show the session title when
available, falling back to its ID. Long titles are shortened in the status bar;
hover to see the full title and ID. Reopen **Connect to Local Service** after a
rename and reconnect to refresh the stored title.

## Architecture

| Layer | Responsibility |
| --- | --- |
| `src/context/` | Capture and watch editor file, line range and selected buffer text |
| `src/connector/` | Adapter registry, session persistence, serialized dispatch and connection lifecycle |
| `src/agents/opencode/` | OpenCode discovery, pairing, live bridge and prompt protocol |
| `src/agents/dsh/` | DSH instance discovery, session lease, live updates and pins |
| `vendor/dsh-editor-socket/` | Independent DSH plugin repository, tracked as a Git submodule |

DSH host code lives in the socket repository. The VS Code package builds and
ships only its editor-neutral `plug`, `discovery` and `protocol` modules; it does
not include DSH or React runtime dependencies.

## Development

```sh
git submodule update --init --recursive
npm ci
npm run compile
npm test
npm run package
```

Compilation builds the SDK subset from the pinned submodule, then the extension.
Press `F5` to launch an Extension Development Host. Install the resulting
`vsc-agents-connector-0.3.1.vsix` to try it in a regular VS Code window.

Changes to the socket should be committed and pushed in its own repository before
pushing a parent commit that references them. Updating the submodule does not
publish the DSH plugin or install it into a user's DSH profile.

Real VS Code + Chrome acceptance steps, isolated launch helpers, screenshots,
and findings are maintained in the socket repository's
[GUI testing guide](https://github.com/YMoose/dsh-editor-socket/blob/main/docs/testing/gui.md)
(`vendor/dsh-editor-socket/docs/testing/gui.md` in this checkout). The guide covers
file clicks, mouse selections, pins, unsaved buffer text, a real composer send,
disconnect/reconnect, and wide/narrow layout checks using a local recording model.
Its `--titles` fixture and `check-title.mjs` also check picker/status-bar titles,
full hovers, reconnect after a Web rename, window-reload persistence, and untitled
session fallback through the real VS Code UI.
