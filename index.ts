import { api, utilities } from "#opendiscord"

if ((utilities as any).project && (utilities as any).project !== "openticket") {
    throw new api.ODPluginError("This plugin only works in Open Ticket!")
}

await import("./src/modules/config-manager.js")
await import("./src/modules/sticky.js")
await import("./src/modules/welcomer.js")
await import("./src/modules/dashboard.js")
