import { api, opendiscord } from "#opendiscord"
import * as discord from "discord.js"
import { isAioModuleEnabled } from "./config-manager.js"

interface WelcomerAuthorConfig {
    name: string
    icon: string
    url: string
}

interface WelcomerEmbedConfig {
    enabled: boolean
    color: string
    title: string
    description: string
    footer: string
    thumbnail: string
    image: string
    timestamp: boolean
    author: WelcomerAuthorConfig
}

interface WelcomerWelcomeConfig {
    enabled: boolean
    channelId: string
    messageContent: string
    testTitle: string
    dm: {
        enabled: boolean
        messageContent: string
    }
    roles: {
        enabled: boolean
        roleIds: string[]
    }
    embed: WelcomerEmbedConfig
}

interface WelcomerLeaveConfig {
    enabled: boolean
    channelId: string
    messageContent: string
    testTitle: string
    embed: WelcomerEmbedConfig
}

export interface WelcomerConfigData {
    enabled: boolean
    welcome: WelcomerWelcomeConfig
    leave: WelcomerLeaveConfig
}

class WelcomerJsonConfig extends api.ODJsonConfig<WelcomerConfigData> {
    declare data: WelcomerConfigData
}

declare module "#opendiscord-types" {
    export interface ODConfigManagerIds_Default {
        "ot-aio:welcomer:config": WelcomerJsonConfig
    }

    export interface ODCheckerManagerIds_Default {
        "ot-aio:welcomer:config": api.ODChecker
    }

    export interface ODSlashCommandManagerIds_Default {
        "ot-aio:welcomer:welcome-command": api.ODSlashCommand
        "ot-aio:welcomer:leave-command": api.ODSlashCommand
    }

    export interface ODCommandResponderManagerIds_Default {
        "ot-aio:welcomer:welcome-responder": { source: "slash" | "text", params: {}, workers: "ot-aio:welcomer:welcome-worker" }
        "ot-aio:welcomer:leave-responder": { source: "slash" | "text", params: {}, workers: "ot-aio:welcomer:leave-worker" }
    }
}

const getConfig = () => opendiscord.configs.get("ot-aio:welcomer:config") as WelcomerJsonConfig
const isWelcomerEnabled = () => isAioModuleEnabled("welcomer") && getConfig()?.data?.enabled !== false
const isUrl = (value: string | undefined) => Boolean(value && /^https?:\/\//i.test(value))
const cleanChannelId = (value: string) => /^\d{17,20}$/.test(value) ? value : ""

const render = (value: string, member: discord.GuildMember | discord.PartialGuildMember) => {
    const user = "user" in member && member.user ? member.user : null
    return (value ?? "")
        .replaceAll("{user}", member.toString())
        .replaceAll("{user_name}", user?.username ?? member.displayName ?? "Member")
        .replaceAll("{display_name}", member.displayName ?? user?.username ?? "Member")
        .replaceAll("{server}", member.guild.name)
        .replaceAll("{member_count}", member.guild.memberCount.toString())
}

const getThumbnailUrl = (member: discord.GuildMember | discord.PartialGuildMember, thumbnail: string): string | undefined => {
    if (thumbnail.toLowerCase() === "user-icon") return member.user?.displayAvatarURL({ size: 512 })
    return isUrl(thumbnail) ? thumbnail : undefined
}

const buildEmbed = (member: discord.GuildMember | discord.PartialGuildMember, data: WelcomerEmbedConfig) => {
    if (!data.enabled) return null

    const embed = new discord.EmbedBuilder()
        .setColor((data.color || "#ffffff") as discord.ColorResolvable)

    if (data.title) embed.setTitle(render(data.title, member))
    if (data.description) embed.setDescription(render(data.description, member))
    if (data.footer) embed.setFooter({ text: render(data.footer, member) })
    if (data.timestamp) embed.setTimestamp()

    const thumbnail = getThumbnailUrl(member, data.thumbnail)
    if (thumbnail) embed.setThumbnail(thumbnail)
    if (isUrl(data.image)) embed.setImage(data.image)

    if (data.author?.name) {
        embed.setAuthor({
            name: render(data.author.name, member),
            iconURL: isUrl(data.author.icon) ? data.author.icon : undefined,
            url: isUrl(data.author.url) ? data.author.url : undefined
        })
    }

    return embed
}

const sendWelcome = async (member: discord.GuildMember, preview = false) => {
    if (!isWelcomerEnabled()) return
    const config = getConfig().data
    if (!config.welcome.enabled) return

    const content = render((preview ? config.welcome.testTitle : "") + config.welcome.messageContent, member)
    const embed = buildEmbed(member, config.welcome.embed)
    const payload: discord.MessageCreateOptions = {
        content,
        embeds: embed ? [embed] : []
    }

    const channelId = cleanChannelId(config.welcome.channelId)
    const channel = channelId ? await member.guild.channels.fetch(channelId).catch(() => null) : null
    if (channel?.isTextBased()) await channel.send(payload).catch(() => null)

    if (!preview && config.welcome.dm.enabled && config.welcome.dm.messageContent.trim()) {
        await member.send({
            content: render(config.welcome.dm.messageContent, member),
            embeds: embed ? [embed] : []
        }).catch(() => null)
    }

    if (!preview && config.welcome.roles.enabled) {
        const roles = config.welcome.roles.roleIds.filter((roleId) => /^\d{17,20}$/.test(roleId))
        if (roles.length > 0) await member.roles.add(roles, "Welcomer module join roles").catch(() => null)
    }
}

const sendLeave = async (member: discord.GuildMember | discord.PartialGuildMember, preview = false) => {
    if (!isWelcomerEnabled()) return
    const config = getConfig().data
    if (!config.leave.enabled) return

    const content = render((preview ? config.leave.testTitle : "") + config.leave.messageContent, member)
    const embed = buildEmbed(member, config.leave.embed)
    const channelId = cleanChannelId(config.leave.channelId)
    const channel = channelId ? await member.guild.channels.fetch(channelId).catch(() => null) : null
    if (channel?.isTextBased()) {
        await channel.send({
            content,
            embeds: embed ? [embed] : []
        }).catch(() => null)
    }
}

opendiscord.events.get("onConfigLoad").listen((configs) => {
    configs.add(new WelcomerJsonConfig("ot-aio:welcomer:config", "welcomer.config.json", "./plugins/ot-aio/"))
})

opendiscord.events.get("onCheckerLoad").listen((checkers) => {
    const config = opendiscord.configs.get("ot-aio:welcomer:config")
    const authorStructure = (id: string) => new api.ODCheckerObjectStructure(id, {
        children: [
            { key: "name", optional: false, priority: 0, checker: new api.ODCheckerStringStructure(`${id}:name`, { maxLength: 256 }) },
            { key: "icon", optional: false, priority: 0, checker: new api.ODCheckerStringStructure(`${id}:icon`, { maxLength: 512 }) },
            { key: "url", optional: false, priority: 0, checker: new api.ODCheckerStringStructure(`${id}:url`, { maxLength: 512 }) }
        ]
    })
    const embedStructure = (id: string) => new api.ODCheckerObjectStructure(id, {
        children: [
            { key: "enabled", optional: false, priority: 0, checker: new api.ODCheckerBooleanStructure(`${id}:enabled`, {}) },
            { key: "color", optional: false, priority: 0, checker: new api.ODCheckerStringStructure(`${id}:color`, { minLength: 0, maxLength: 16 }) },
            { key: "title", optional: false, priority: 0, checker: new api.ODCheckerStringStructure(`${id}:title`, { maxLength: 256 }) },
            { key: "description", optional: false, priority: 0, checker: new api.ODCheckerStringStructure(`${id}:description`, { maxLength: 4096 }) },
            { key: "footer", optional: false, priority: 0, checker: new api.ODCheckerStringStructure(`${id}:footer`, { maxLength: 2048 }) },
            { key: "thumbnail", optional: false, priority: 0, checker: new api.ODCheckerStringStructure(`${id}:thumbnail`, { maxLength: 512 }) },
            { key: "image", optional: false, priority: 0, checker: new api.ODCheckerStringStructure(`${id}:image`, { maxLength: 512 }) },
            { key: "timestamp", optional: false, priority: 0, checker: new api.ODCheckerBooleanStructure(`${id}:timestamp`, {}) },
            { key: "author", optional: false, priority: 0, checker: authorStructure(`${id}:author`) }
        ]
    })
    const structure = new api.ODCheckerObjectStructure("ot-aio:welcomer:config", {
        children: [
            { key: "enabled", optional: false, priority: 0, checker: new api.ODCheckerBooleanStructure("ot-aio:welcomer:enabled", {}) },
            {
                key: "welcome", optional: false, priority: 0, checker: new api.ODCheckerObjectStructure("ot-aio:welcomer:welcome", {
                    children: [
                        { key: "enabled", optional: false, priority: 0, checker: new api.ODCheckerBooleanStructure("ot-aio:welcomer:welcome-enabled", {}) },
                        { key: "channelId", optional: false, priority: 0, checker: new api.ODCheckerStringStructure("ot-aio:welcomer:welcome-channel", { maxLength: 32 }) },
                        { key: "messageContent", optional: false, priority: 0, checker: new api.ODCheckerStringStructure("ot-aio:welcomer:welcome-message", { maxLength: 2000 }) },
                        { key: "testTitle", optional: false, priority: 0, checker: new api.ODCheckerStringStructure("ot-aio:welcomer:welcome-test-title", { maxLength: 256 }) },
                        {
                            key: "dm", optional: false, priority: 0, checker: new api.ODCheckerObjectStructure("ot-aio:welcomer:dm", {
                                children: [
                                    { key: "enabled", optional: false, priority: 0, checker: new api.ODCheckerBooleanStructure("ot-aio:welcomer:dm-enabled", {}) },
                                    { key: "messageContent", optional: false, priority: 0, checker: new api.ODCheckerStringStructure("ot-aio:welcomer:dm-message", { maxLength: 2000 }) }
                                ]
                            })
                        },
                        {
                            key: "roles", optional: false, priority: 0, checker: new api.ODCheckerObjectStructure("ot-aio:welcomer:roles", {
                                children: [
                                    { key: "enabled", optional: false, priority: 0, checker: new api.ODCheckerBooleanStructure("ot-aio:welcomer:roles-enabled", {}) },
                                    { key: "roleIds", optional: false, priority: 0, checker: new api.ODCheckerArrayStructure("ot-aio:welcomer:role-ids", {}) }
                                ]
                            })
                        },
                        { key: "embed", optional: false, priority: 0, checker: embedStructure("ot-aio:welcomer:welcome-embed") }
                    ]
                })
            },
            {
                key: "leave", optional: false, priority: 0, checker: new api.ODCheckerObjectStructure("ot-aio:welcomer:leave", {
                    children: [
                        { key: "enabled", optional: false, priority: 0, checker: new api.ODCheckerBooleanStructure("ot-aio:welcomer:leave-enabled", {}) },
                        { key: "channelId", optional: false, priority: 0, checker: new api.ODCheckerStringStructure("ot-aio:welcomer:leave-channel", { maxLength: 32 }) },
                        { key: "messageContent", optional: false, priority: 0, checker: new api.ODCheckerStringStructure("ot-aio:welcomer:leave-message", { maxLength: 2000 }) },
                        { key: "testTitle", optional: false, priority: 0, checker: new api.ODCheckerStringStructure("ot-aio:welcomer:leave-test-title", { maxLength: 256 }) },
                        { key: "embed", optional: false, priority: 0, checker: embedStructure("ot-aio:welcomer:leave-embed") }
                    ]
                })
            }
        ]
    })
    checkers.add(new api.ODChecker("ot-aio:welcomer:config", checkers.storage, 0, config!, structure))
})

opendiscord.events.get("onClientLoad").listen((client) => {
    if (!client.intents.includes("GuildMembers")) client.intents.push("GuildMembers")
})

opendiscord.events.get("onSlashCommandLoad").listen((slash) => {
    const options: discord.ApplicationCommandOptionData[] = [
        { type: discord.ApplicationCommandOptionType.Subcommand, name: "test", description: "Preview the configured message." },
        { type: discord.ApplicationCommandOptionType.Subcommand, name: "reload", description: "Reload the Welcomer configuration." }
    ]

    slash.add(new api.ODSlashCommand("ot-aio:welcomer:welcome-command", {
        name: "welcome",
        description: "Manage welcome messages.",
        type: discord.ApplicationCommandType.ChatInput,
        contexts: [discord.InteractionContextType.Guild],
        integrationTypes: [discord.ApplicationIntegrationType.GuildInstall],
        options
    }))
    slash.add(new api.ODSlashCommand("ot-aio:welcomer:leave-command", {
        name: "leave",
        description: "Manage leave messages.",
        type: discord.ApplicationCommandType.ChatInput,
        contexts: [discord.InteractionContextType.Guild],
        integrationTypes: [discord.ApplicationIntegrationType.GuildInstall],
        options
    }))
})

opendiscord.events.get("onHelpMenuComponentLoad").listen((menu) => {
    const extra = menu.get("opendiscord:extra")
    extra.add(new api.ODHelpMenuCommandComponent("ot-aio:welcomer:welcome-test", 1, {
        slashName: "/welcome test",
        slashDescription: "Preview the welcome message."
    }))
    extra.add(new api.ODHelpMenuCommandComponent("ot-aio:welcomer:leave-test", 2, {
        slashName: "/leave test",
        slashDescription: "Preview the leave message."
    }))
})

opendiscord.events.get("onCommandResponderLoad").listen((commands) => {
    const general = opendiscord.configs.get("opendiscord:general")

    const welcome = new api.ODCommandResponder("ot-aio:welcomer:welcome-responder", general.data.prefix, "welcome")
    welcome.workers.add(new api.ODWorker("ot-aio:welcomer:welcome-worker", 0, async (instance: any, _params: any, source: any, cancel: any) => {
        if (source !== "slash") return
        if (!isWelcomerEnabled()) {
            await instance.reply({ content: "Welcomer is disabled in the AIO dashboard.", ephemeral: true })
            return cancel()
        }
        const subcommand = instance.options.getSubCommand()
        if (subcommand === "reload") {
            getConfig().reload()
            await instance.reply({ content: "Welcomer configuration reloaded.", ephemeral: true })
            return cancel()
        }
        await sendWelcome(instance.member as discord.GuildMember, true)
        await instance.reply({ content: "Welcome preview sent.", ephemeral: true })
        return cancel()
    }))
    commands.add(welcome)

    const leave = new api.ODCommandResponder("ot-aio:welcomer:leave-responder", general.data.prefix, "leave")
    leave.workers.add(new api.ODWorker("ot-aio:welcomer:leave-worker", 0, async (instance: any, _params: any, source: any, cancel: any) => {
        if (source !== "slash") return
        if (!isWelcomerEnabled()) {
            await instance.reply({ content: "Welcomer is disabled in the AIO dashboard.", ephemeral: true })
            return cancel()
        }
        const subcommand = instance.options.getSubCommand()
        if (subcommand === "reload") {
            getConfig().reload()
            await instance.reply({ content: "Welcomer configuration reloaded.", ephemeral: true })
            return cancel()
        }
        await sendLeave(instance.member as discord.GuildMember, true)
        await instance.reply({ content: "Leave preview sent.", ephemeral: true })
        return cancel()
    }))
    commands.add(leave)
})

let listenersRegistered = false
opendiscord.events.get("onClientReady").listen(() => {
    if (listenersRegistered) return
    listenersRegistered = true
    const client = opendiscord.client.client as discord.Client

    client.on("guildMemberAdd", async (member) => {
        await sendWelcome(member).catch((error) => opendiscord.log(`Welcomer welcome send failed: ${error}`, "plugin"))
    })

    client.on("guildMemberRemove", async (member) => {
        await sendLeave(member).catch((error) => opendiscord.log(`Welcomer leave send failed: ${error}`, "plugin"))
    })
})
