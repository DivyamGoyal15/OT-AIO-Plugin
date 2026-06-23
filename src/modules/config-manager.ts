import { api, opendiscord } from "#opendiscord"

export interface OTAioConfigData {
    dashboard: {
        enabled: boolean
        host: string
        port: number
        password: string
        sessionSecret: string
        siteTitle: string
    }
    modules: {
        sticky: { enabled: boolean }
        welcomer: { enabled: boolean }
        configManager: { enabled: boolean }
    }
    configManager: {
        backupDirectory: string
        allowRawJsoncFiles: string[]
    }
}

export class OTAioConfig extends api.ODJsonConfig<OTAioConfigData> {
    declare data: OTAioConfigData
}

declare module "#opendiscord-types" {
    export interface ODConfigManagerIds_Default {
        "ot-aio:config": OTAioConfig
    }

    export interface ODCheckerManagerIds_Default {
        "ot-aio:config": api.ODChecker
    }
}

export const getAioConfig = () => opendiscord.configs.get("ot-aio:config") as OTAioConfig

export const isAioModuleEnabled = (module: keyof OTAioConfigData["modules"]) => {
    const config = opendiscord.configs.get("ot-aio:config") as OTAioConfig | null
    return config?.data?.modules?.[module]?.enabled !== false
}

opendiscord.events.get("onConfigLoad").listen((configs) => {
    configs.add(new OTAioConfig("ot-aio:config", "config.json", "./plugins/ot-aio/"))
})

opendiscord.events.get("onCheckerLoad").listen((checkers) => {
    const config = opendiscord.configs.get("ot-aio:config")
    const moduleStructure = new api.ODCheckerObjectStructure("ot-aio:module-toggle", {
        children: [
            { key: "enabled", optional: false, priority: 0, checker: new api.ODCheckerBooleanStructure("ot-aio:module-enabled", {}) }
        ]
    })

    const structure = new api.ODCheckerObjectStructure("ot-aio:config", {
        children: [
            {
                key: "dashboard", optional: false, priority: 0, checker: new api.ODCheckerObjectStructure("ot-aio:dashboard", {
                    children: [
                        { key: "enabled", optional: false, priority: 0, checker: new api.ODCheckerBooleanStructure("ot-aio:dashboard-enabled", {}) },
                        { key: "host", optional: false, priority: 0, checker: new api.ODCheckerStringStructure("ot-aio:dashboard-host", { minLength: 1, maxLength: 128 }) },
                        { key: "port", optional: false, priority: 0, checker: new api.ODCheckerNumberStructure("ot-aio:dashboard-port", { min: 1, max: 65535, floatAllowed: false }) },
                        { key: "password", optional: false, priority: 0, checker: new api.ODCheckerStringStructure("ot-aio:dashboard-password", { minLength: 1, maxLength: 256 }) },
                        { key: "sessionSecret", optional: false, priority: 0, checker: new api.ODCheckerStringStructure("ot-aio:dashboard-session-secret", { minLength: 16, maxLength: 512 }) },
                        { key: "siteTitle", optional: false, priority: 0, checker: new api.ODCheckerStringStructure("ot-aio:dashboard-title", { minLength: 1, maxLength: 128 }) }
                    ]
                })
            },
            {
                key: "modules", optional: false, priority: 0, checker: new api.ODCheckerObjectStructure("ot-aio:modules", {
                    children: [
                        { key: "sticky", optional: false, priority: 0, checker: moduleStructure },
                        { key: "welcomer", optional: false, priority: 0, checker: moduleStructure },
                        { key: "configManager", optional: false, priority: 0, checker: moduleStructure }
                    ]
                })
            },
            {
                key: "configManager", optional: false, priority: 0, checker: new api.ODCheckerObjectStructure("ot-aio:config-manager", {
                    children: [
                        { key: "backupDirectory", optional: false, priority: 0, checker: new api.ODCheckerStringStructure("ot-aio:backup-directory", { minLength: 1, maxLength: 256 }) },
                        { key: "allowRawJsoncFiles", optional: false, priority: 0, checker: new api.ODCheckerArrayStructure("ot-aio:raw-files", {}) }
                    ]
                })
            }
        ]
    })

    checkers.add(new api.ODChecker("ot-aio:config", checkers.storage, 0, config!, structure))
})
