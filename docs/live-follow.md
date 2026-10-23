# Live follow: VS Code → opencode TUI prompt

Mirror the editor's current file/selection into the connected opencode TUI
prompt in real time, Claude-Code style. As you move the cursor or change the
selection, a trailing `@path/to/file.ts#Lx-y` chip in the TUI prompt is
replaced in place; press `Ctrl+Alt+O` to pin the chip as ordinary prompt
text. With no selection the chip degrades to the bare file path.

## Architecture

```
VS Code extension                opencode server                  TUI
-----------------                ---------------                  ---
LiveFollower  ── update/pin ──▶  editor-bridge (builtin) ── SSE ─▶  prompt chip
 (debounced)    POST /api/rpc/    plugin (RPC → events)            (replaces
                editor-bridge/    re-emits as                       trailing
                <method>          rpc.editor-bridge.*               chip)
```

Three RPC methods, each taking `{ input: { text } }`:

| method  | effect                                                            |
| ------- | ----------------------------------------------------------------- |
| `update`| set/replace the trailing live chip (`text` empty clears it)       |
| `pin`   | commit the chip as ordinary prompt text (stops being replaced)    |
| `clear` | remove the chip                                                   |

## The bridge

The bridge is a **builtin server plugin** (`editor-bridge`) in the main opencode
repo, so there is nothing to install or register in `opencode.json`. The
extension only needs a running opencode server that includes it; older servers
without the plugin simply make live follow go quiet (see below).

## Location scoping (the important gotcha)

`POST /api/rpc/...` resolves its server location from
`location[directory]` (query) or `x-opencode-directory` (header), falling
back to the service's own cwd. The bridge emits the SSE event tagged with
that location, and the TUI only renders a chip whose
`location.directory` matches the directory its session is attached to.

**Without the directory the event is tagged with the service cwd (e.g.
`/home/user`) and the TUI drops it silently.** The extension therefore
persists the connected session's `directory` at connect time and sends it
as `location[directory]` on every bridge call. The QuickPick path reads it
from the session; the URI/manual paths fall back to the VS Code workspace
folder.

## Running the dev TUI

```bash
cd <workdir>          # the directory the chip should route to
cd /home/user/opencode/packages/cli
OPENCODE_TUI_CHANNEL=dev \
OPENCODE_PASSWORD="$(opencode service get password)" \
bun run src/index.ts --server "$(opencode service status)" <workdir>
```

Run from `packages/cli` (so its `bunfig.toml` loads `@opentui/solid`'s JSX
import source — running from the repo root makes Bun fall back to
`react/jsx-dev-runtime` and fail), and pass `<workdir>` as the trailing
argument so the TUI attaches to that directory instead of `packages/cli`.
The chip only lands in a TUI whose attached directory matches the
`location[directory]` the extension sends (the connected session's
directory).

Probe:

```sh
PASSWORD=$(opencode service get password)
URL=$(opencode service status)
curl -sg -u "opencode:$PASSWORD" \
  -X POST "$URL/api/rpc/editor-bridge/update?location[directory]=<tui-dir>" \
  -H "content-type: application/json" -d '{"input":{"text":"@x.ts#L1-2"}}'
# {} = bridge live; watch the event with:
curl -sN -u "opencode:$PASSWORD" "$URL/api/event"
```

## TUI side (lives in the main repo, local experiment)

`packages/tui/src/component/prompt/index.tsx` listens for the three
`rpc.editor-bridge.*` events. The chip is registered as a real file
part + extmark so `onContentChange`'s `syncExtmarksWithPromptParts` keeps
it aligned; an `update` rewrites the chip range (resetting extmarks first)
and re-registers it, so rapid selection changes replace rather than append.
Covered by `packages/tui/test/prompt-live-follow.test.tsx` (createAppFixture
+ `events.emit`).

### The chip attachment URI

The chip text is `@rel/path#L9-19`, but the file part's `uri` must be a
readable `file://` URL or the server rejects the prompt with
`AttachmentError` ("fail to send prompt"). The TUI converts it with
`pathToFileURL(path.resolve(<location.directory>, rel))` and carries the
line range as `?start=9&end=19` query params — the server's
`SessionPrompt.readFileAttachment` reads `file:` URLs and honors exactly
those params. So a chip `@.oxlintrc.json#L9-19` becomes
`file:///home/user/opencode/.oxlintrc.json?start=9&end=19`. Do not
put the `#L…` fragment into the URI itself; it is display text only.

That change is intentionally not committed upstream — it is a local
experiment with no config gate, living on the `ide-live-follow` branch.

## Config

- `vscAgents.liveFollow` (default `true`) — master switch.
- `vscAgents.followDebounceMs` (default `150`, min `50`) — selection-change
  debounce.

When the builtin bridge is unavailable (older server) or a connection is
down, the follower goes quiet and explicit send falls back to the original
prompt-with-input flow.
