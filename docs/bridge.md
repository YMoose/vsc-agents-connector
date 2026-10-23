# Bridge: opencode app → VS Code

How the opencode app (desktop or web) hands a session connection to this
extension. This document is the contract the app-side change implements
against; it lives here because the app change lands in the main repo while
the extension ships from this one.

## The link

```
vscode://moose.vsc-agents-connector/connect?url=<server>&code=<pairing-code>&session=<sessionID>
```

For VS Code forks, swap the scheme: `cursor://`, `windsurf://`, `vscodium://`
(each fork registers its own OS protocol handler; the extension id stays the
same).

Query params:

| param    | meaning                                             |
| -------- | --------------------------------------------------- |
| `url`    | opencode server base URL, e.g. `http://127.0.0.1:4096` |
| `code`   | single-use pairing code from `POST /api/pair`       |
| `session`| target session id                                   |

## App-side steps

1. The user picks "Connect opencode to this editor" (entry points: the
   open-in-app menu in the file panel, the session screen).
2. The app calls `POST /api/pair` with its own credential and receives
   `{ code, expires_in }`. The code is single-use and short-lived — never put
   the server password in the link.
3. The app opens the link:
   - desktop: `shell.openExternal(link)`;
   - web: an `<a href={link}>` click (the browser hands it to the OS).
4. The OS launches/focuses VS Code; the extension's URI handler redeems the
   code at `GET <url>/auth/connect/<code>` for a 30-day session token, stores
   it in SecretStorage, and connects.

## Why not the password in the link

`vscode://` URIs pass through OS process arguments and may land in logs or
shell history. A single-use, minutes-lived pairing code bounds the blast
radius of a leaked link to "already useless".

## Failure handling on the extension side

- Link without the extension installed: VS Code shows its marketplace prompt
  for `moose.vsc-agents-connector`.
- Expired/used code: the extension shows a connect-failed notification; the
  user re-triggers from the app.
- `vscAgents.connect` offers a manual fallback (URL + password + session id)
  for servers without pairing and for development.

## Live follow

Live follow does not use this link. It talks to the server's builtin
`editor-bridge` plugin over `POST /api/rpc/editor-bridge/<method>`; no plugin
installation step is required. See `docs/live-follow.md` for the method
contract and the `location[directory]` scoping gotcha.
