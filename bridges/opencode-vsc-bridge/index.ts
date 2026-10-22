// opencode-vsc-bridge: receives editor context from the VSC Agents Connector
// extension over the plugin RPC endpoint and re-emits it as live events that
// the (patched) TUI mirrors into the prompt input.
//
// Load from opencode.json (use the absolute path on your machine):
//   { "plugins": ["file:///<repo>/bridges/opencode-vsc-bridge/index.ts"] }

import { Plugin, Rpc } from "@opencode/plugin/effect"
import { Deferred, Effect, Schema } from "effect"

const Context = Schema.Struct({
  /** Chip text, e.g. `@src/wire.ts#L76-110`, or "" when the editor has no file. */
  text: Schema.String,
})

const Definition = Rpc.define({
  id: "opencode-vsc-bridge",
  methods: {
    // Live follow: the editor's current file/selection changed.
    update: { input: Context, output: Schema.Void },
    // Explicit pin: user pressed the send key; the TUI commits the chip.
    pin: { input: Context, output: Schema.Void },
    // Editor lost track (closed, no workspace): clear the chip.
    clear: { input: Schema.Struct({}), output: Schema.Void },
  },
  events: {
    context: { schema: Context },
    pin: { schema: Context },
    clear: { schema: Schema.Struct({}) },
  },
})

export default Plugin.define({
  id: "opencode-vsc-bridge",
  effect: Effect.fn(function* (ctx) {
    // Handlers emit through the registration, which only exists after
    // ctx.rpc.register returns; a Deferred breaks the cycle safely.
    type Events = { readonly emit: (name: "context" | "pin" | "clear", data: { text: string }) => Effect.Effect<void, unknown> }
    const ready = yield* Deferred.make<Events>()
    const emit = (name: "context" | "pin" | "clear", data: { text: string }) =>
      Deferred.await(ready).pipe(Effect.flatMap((events) => events.emit(name, data)))

    const registration = yield* ctx.rpc.register(Definition, {
      update: (input) => emit("context", input),
      pin: (input) => emit("pin", input),
      clear: () => emit("clear", { text: "" }),
    })
    yield* Deferred.succeed(ready, registration.events as Events)
  }),
})
