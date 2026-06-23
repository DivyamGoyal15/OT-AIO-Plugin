import { opendiscord } from "#opendiscord"
import * as discord from "discord.js"
import express from "express"
import session from "express-session"
import helmet from "helmet"
import rateLimit from "express-rate-limit"
import fs from "fs"
import path from "path"
import { jsonc } from "jsonc"
import { getAioConfig, isAioModuleEnabled } from "./config-manager.js"

const pluginRoot = path.join(process.cwd(), "plugins", "ot-aio")
const configRoot = path.join(process.cwd(), "config")
const welcomerConfigPath = path.join(pluginRoot, "welcomer.config.json")

const coreConfigFiles: Record<string, string> = {
    general: "general.jsonc",
    panels: "panels.jsonc",
    options: "options.jsonc",
    questions: "questions.jsonc",
    transcripts: "transcripts.jsonc"
}

const safeGeneralFields = ["mainColor", "language", "prefix", "serverId", "slashCommands", "textCommands"]
const discordIdRegex = /^\d{17,20}$/
const webhookRegex = /^https:\/\/(?:canary\.|ptb\.)?(?:discord(?:app)?\.com)\/api\/webhooks\/\d{17,20}\/[\w-]+/i

type BuilderField = { name: string, value: string, inline: boolean }
type BuilderEmbed = {
    enabled?: boolean
    color?: string
    title?: string
    description?: string
    authorName?: string
    authorIconUrl?: string
    authorUrl?: string
    footer?: string
    footerIconUrl?: string
    thumbnailUrl?: string
    imageUrl?: string
    timestamp?: boolean
    fields?: BuilderField[]
}
type BuilderPayload = { content: string, embed: BuilderEmbed }

const escapeHtml = (value: unknown) => String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("\"", "&quot;")
    .replaceAll("'", "&#039;")

const readJson = <T>(file: string): T => JSON.parse(fs.readFileSync(file, "utf8")) as T
const writeJson = (file: string, value: unknown) => fs.writeFileSync(file, JSON.stringify(value, null, 4) + "\n")
const readJsonc = (file: string) => jsonc.parse(fs.readFileSync(file, "utf8"))
const parseBool = (value: unknown) => value === true || value === "true" || value === "on"
const getClient = () => opendiscord.client?.client as discord.Client | null

const requireAuth = (req: any, res: any, next: any) => req.session?.authed ? next() : res.redirect("/login")

const backupFile = (filePath: string) => {
    const cfg = getAioConfig().data
    const backupRoot = path.resolve(process.cwd(), cfg.configManager.backupDirectory)
    fs.mkdirSync(backupRoot, { recursive: true })
    const stamp = new Date().toISOString().replace(/[:.]/g, "-")
    fs.copyFileSync(filePath, path.join(backupRoot, `${path.basename(filePath)}.${stamp}.bak`))
}

const jsonError = (res: any, status: number, message: string) => res.status(status).json({ ok: false, error: message })

const getBotIdentity = () => {
    const user = getClient()?.user
    return {
        id: user?.id ?? "",
        username: user?.username ?? "Open Ticket",
        tag: user?.tag ?? "Open Ticket",
        avatarUrl: user?.displayAvatarURL({ size: 128 }) ?? "",
        mention: user?.id ? `<@${user.id}>` : ""
    }
}

const getChannels = () => {
    const client = getClient()
    if (!client) return []
    const channels: { id: string, name: string, guildId: string, guildName: string, label: string }[] = []
    client.guilds.cache.forEach((guild) => {
        guild.channels.cache.forEach((channel) => {
            if (channel.type !== discord.ChannelType.GuildText && channel.type !== discord.ChannelType.GuildAnnouncement) return
            channels.push({
            id: channel.id,
            name: channel.name,
            guildId: guild.id,
            guildName: guild.name,
            label: `${guild.name} / #${channel.name}`
            })
        })
    })
    return channels.sort((a, b) => a.label.localeCompare(b.label))
}

const normalizeHexColor = (value: unknown) => {
    const color = String(value ?? "").trim()
    return /^#[0-9a-f]{6}$/i.test(color) ? color : "#33d6a6"
}

const cleanUrl = (value: unknown) => {
    const url = String(value ?? "").trim()
    if (!url) return ""
    try {
        const parsed = new URL(url)
        return parsed.protocol === "https:" || parsed.protocol === "http:" ? url : ""
    } catch {
        return ""
    }
}

const sanitizeBuilderPayload = (body: any): BuilderPayload => {
    const embed = body?.embed ?? {}
    const fields = Array.isArray(embed.fields) ? embed.fields.slice(0, 25).map((field: any) => ({
        name: String(field?.name ?? "").slice(0, 256),
        value: String(field?.value ?? "").slice(0, 1024),
        inline: Boolean(field?.inline)
    })).filter((field: BuilderField) => field.name.trim() && field.value.trim()) : []

    return {
        content: String(body?.content ?? "").slice(0, 2000),
        embed: {
            enabled: embed.enabled !== false,
            color: normalizeHexColor(embed.color),
            title: String(embed.title ?? "").slice(0, 256),
            description: String(embed.description ?? "").slice(0, 4096),
            authorName: String(embed.authorName ?? "").slice(0, 256),
            authorIconUrl: cleanUrl(embed.authorIconUrl),
            authorUrl: cleanUrl(embed.authorUrl),
            footer: String(embed.footer ?? "").slice(0, 2048),
            footerIconUrl: cleanUrl(embed.footerIconUrl),
            thumbnailUrl: cleanUrl(embed.thumbnailUrl),
            imageUrl: cleanUrl(embed.imageUrl),
            timestamp: Boolean(embed.timestamp),
            fields
        }
    }
}

const validateBuilderPayload = (payload: BuilderPayload) => {
    const embed = payload.embed
    const hasEmbed = embed.enabled !== false && Boolean(embed.title || embed.description || embed.authorName || embed.footer || embed.thumbnailUrl || embed.imageUrl || embed.fields?.length)
    if (!payload.content.trim() && !hasEmbed) return "Add message content or at least one embed field before saving or sending."
    if (payload.content.length > 2000) return "Message content must be 2000 characters or fewer."
    if ((embed.fields?.length ?? 0) > 25) return "Discord supports a maximum of 25 embed fields."
    return null
}

const toDiscordEmbed = (payload: BuilderPayload) => {
    const data = payload.embed
    if (data.enabled === false) return null
    const hasEmbed = Boolean(data.title || data.description || data.authorName || data.footer || data.thumbnailUrl || data.imageUrl || data.fields?.length)
    if (!hasEmbed) return null

    const embed = new discord.EmbedBuilder().setColor((data.color || "#33d6a6") as discord.ColorResolvable)
    if (data.title) embed.setTitle(data.title)
    if (data.description) embed.setDescription(data.description)
    if (data.authorName) embed.setAuthor({ name: data.authorName, iconURL: data.authorIconUrl || undefined, url: data.authorUrl || undefined })
    if (data.footer) embed.setFooter({ text: data.footer, iconURL: data.footerIconUrl || undefined })
    if (data.thumbnailUrl) embed.setThumbnail(data.thumbnailUrl)
    if (data.imageUrl) embed.setImage(data.imageUrl)
    if (data.timestamp) embed.setTimestamp()
    if (data.fields?.length) embed.setFields(data.fields)
    return embed
}

const buildMessageOptions = (payload: BuilderPayload): discord.MessageCreateOptions => {
    const embed = toDiscordEmbed(payload)
    return {
        content: payload.content || undefined,
        embeds: embed ? [embed] : [],
        allowedMentions: { parse: [] }
    }
}

const fetchTextChannel = async (channelId: string) => {
    if (!discordIdRegex.test(channelId)) return null
    const channel = await getClient()?.channels.fetch(channelId).catch(() => null)
    if (!channel || !("isTextBased" in channel) || !channel.isTextBased()) return null
    if (channel.type !== discord.ChannelType.GuildText && channel.type !== discord.ChannelType.GuildAnnouncement) return null
    return channel as discord.TextChannel | discord.NewsChannel
}

const maskWebhookUrl = (value: string) => {
    const match = /^(.+\/webhooks\/\d{17,20}\/)([\w-]+)/i.exec(value)
    return match ? `${match[1]}${"*".repeat(Math.min(12, match[2].length))}` : ""
}

const toWelcomerEmbed = (embed: BuilderEmbed) => ({
    enabled: embed.enabled !== false,
    color: normalizeHexColor(embed.color),
    title: embed.title ?? "",
    description: embed.description ?? "",
    footer: embed.footer ?? "",
    thumbnail: embed.thumbnailUrl ?? "",
    image: embed.imageUrl ?? "",
    timestamp: Boolean(embed.timestamp),
    author: {
        name: embed.authorName ?? "",
        icon: embed.authorIconUrl ?? "",
        url: embed.authorUrl ?? ""
    }
})

const fromWelcomerEmbed = (embed: any): BuilderEmbed => ({
    enabled: embed?.enabled !== false,
    color: embed?.color ?? "#33d6a6",
    title: embed?.title ?? "",
    description: embed?.description ?? "",
    authorName: embed?.author?.name ?? "",
    authorIconUrl: embed?.author?.icon ?? "",
    authorUrl: embed?.author?.url ?? "",
    footer: embed?.footer ?? "",
    thumbnailUrl: embed?.thumbnail === "user-icon" ? "" : (embed?.thumbnail ?? ""),
    imageUrl: embed?.image ?? "",
    timestamp: Boolean(embed?.timestamp),
    fields: []
})

const renderSampleVariables = (value: string) => {
    const identity = getBotIdentity()
    const replacements: Record<string, string> = {
        bot_name: identity.username,
        bot_id: identity.id,
        bot_avatar: identity.avatarUrl,
        bot_mention: identity.mention,
        user: "@Member",
        member: "@Member",
        user_name: "member",
        member_name: "member",
        display_name: "Member",
        user_display_name: "Member",
        member_display_name: "Member",
        user_id: "100000000000000000",
        member_id: "100000000000000000",
        user_mention: "@Member",
        member_mention: "@Member",
        user_avatar: identity.avatarUrl,
        member_avatar: identity.avatarUrl,
        server: "Support Server",
        server_name: "Support Server",
        server_id: "200000000000000000",
        server_icon: "",
        member_count: "128",
        boost_count: "7",
        boost_tier: "2",
        owner_id: "300000000000000000",
        owner_mention: "@Owner",
        now: new Date().toLocaleString(),
        now_timestamp: `<t:${Math.floor(Date.now() / 1000)}:F>`,
        nowtimestamp: `<t:${Math.floor(Date.now() / 1000)}:F>`,
        date: new Date().toLocaleDateString(),
        time: new Date().toLocaleTimeString(),
        unix: String(Math.floor(Date.now() / 1000)),
        relative_time: `<t:${Math.floor(Date.now() / 1000)}:R>`
    }
    return value.replace(/\{([a-z_]+)\}/gi, (match, key: string) => replacements[key.toLowerCase()] ?? match)
}

const sendWelcomerPreview = async (mode: "welcome" | "leave", config: any) => {
    const section = config[mode]
    const channel = await fetchTextChannel(String(section.channelId ?? ""))
    if (!channel) throw new Error(`Select a valid ${mode} channel before sending a test.`)

    const payload = sanitizeBuilderPayload({
        content: `${section.testTitle ?? ""}${section.messageContent ?? ""}`,
        embed: fromWelcomerEmbed(section.embed)
    })
    payload.content = renderSampleVariables(payload.content)
    payload.embed = {
        ...payload.embed,
        title: renderSampleVariables(payload.embed.title ?? ""),
        description: renderSampleVariables(payload.embed.description ?? ""),
        authorName: renderSampleVariables(payload.embed.authorName ?? ""),
        footer: renderSampleVariables(payload.embed.footer ?? "")
    }
    await channel.send(buildMessageOptions(payload))
}

const loginPage = (siteTitle: string, error = false) => `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(siteTitle)} Login</title>
<style>:root{color-scheme:dark;--bg:#0e141b;--panel:#17212b;--line:#314050;--text:#f5f7fb;--muted:#9aa6b2;--accent:#1893f8;--bad:#ff6f7a}*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;background:linear-gradient(135deg,#0d1117,#1d2a36 52%,#10251f);color:var(--text);font-family:Inter,ui-sans-serif,system-ui,Segoe UI,Arial}.card{width:min(420px,92vw);border:1px solid var(--line);background:rgba(23,33,43,.86);border-radius:8px;padding:24px;box-shadow:0 24px 80px rgba(0,0,0,.36);backdrop-filter:blur(24px)}h1{margin:0 0 6px}.muted{color:var(--muted)}input,button{width:100%;border-radius:8px;border:1px solid var(--line);padding:12px 14px;font:inherit}input{margin:18px 0 12px;background:#101820;color:var(--text)}button{background:var(--accent);border-color:transparent;color:white;cursor:pointer}.bad{color:var(--bad)}</style></head>
<body><form class="card" method="post" action="/login"><h1>${escapeHtml(siteTitle)}</h1><div class="muted">Sign in to manage the AIO plugin.</div>${error ? `<p class="bad">Invalid password.</p>` : ""}<input name="password" type="password" placeholder="Dashboard password" autofocus><button>Login</button></form></body></html>`

const appPage = () => {
    const siteTitle = getAioConfig().data.dashboard.siteTitle
    return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(siteTitle)}</title>
<link id="favicon" rel="icon" href="data:,">
<style>
:root{color-scheme:dark;--bg:#10161d;--panel:#1d252f;--panel2:#252e39;--panel3:#151c24;--line:#344150;--text:#f5f7fb;--muted:#9da8b5;--soft:#c8d0d9;--accent:#1594f8;--accent2:#23c483;--bad:#f05f6d;--warn:#f2bd3d;--shadow:0 24px 70px rgba(0,0,0,.34)}
*{box-sizing:border-box}body{margin:0;min-height:100vh;background:linear-gradient(140deg,#0d1117,#1b2834 46%,#10251f);color:var(--text);font-family:Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;font-size:15px}button,input,select,textarea{font:inherit}button{border:1px solid var(--line);background:var(--panel2);color:var(--text);border-radius:8px;padding:10px 13px;cursor:pointer;transition:.18s ease}button:hover,.nav button:hover{transform:translateY(-1px);border-color:#536477}button.primary{background:linear-gradient(135deg,var(--accent),#39b6ff);border-color:transparent;color:white;font-weight:700}button.good{background:var(--accent2);border-color:transparent;color:#06130d;font-weight:800}button.danger{background:var(--bad);border-color:transparent;color:white}button:disabled{opacity:.55;cursor:not-allowed;transform:none}.shell{display:grid;grid-template-columns:280px 1fr;min-height:100vh}.side{padding:22px;border-right:1px solid var(--line);background:rgba(18,25,33,.82);backdrop-filter:blur(24px);position:sticky;top:0;height:100vh}.brand{display:flex;gap:12px;align-items:center;margin-bottom:20px}.brand img{width:42px;height:42px;border-radius:8px}.brand b{display:block;font-size:18px}.muted{color:var(--muted)}.nav{display:grid;gap:8px}.nav button{text-align:left;background:transparent}.nav button.active{background:#405065;border-color:#52647a}.main{padding:22px;display:grid;gap:18px;min-width:0}.top{display:flex;justify-content:space-between;align-items:flex-start;gap:16px}.cards{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:12px}.card,.panel{border:1px solid var(--line);background:rgba(29,37,47,.88);border-radius:8px;box-shadow:var(--shadow);backdrop-filter:blur(20px)}.card{padding:16px}.panel{overflow:hidden}.workspace{display:grid;grid-template-columns:minmax(360px,1fr) minmax(360px,.9fr);gap:16px}.editor{padding:16px}.preview-wrap{padding:16px;background:rgba(13,18,24,.36)}.tabs{display:grid;grid-template-columns:repeat(3,1fr);border:1px solid var(--line);border-radius:8px;overflow:hidden;margin-bottom:14px}.tabs button{border:0;border-radius:0;background:var(--panel3);font-size:18px}.tabs button.active{background:#405065}.form-grid{display:grid;grid-template-columns:1fr 1fr;gap:12px}.full{grid-column:1/-1}label{display:grid;gap:6px;color:var(--soft);font-weight:700}label span{font-size:13px;color:var(--muted);font-weight:600}input,select,textarea{width:100%;border:1px solid var(--line);border-radius:8px;background:#121922;color:var(--text);padding:10px 12px;outline:none}textarea{min-height:120px;resize:vertical;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}input[type=color]{height:42px;padding:4px}.switch{display:flex;align-items:center;gap:10px}.switch input{width:20px;height:20px}.actions{display:flex;gap:9px;flex-wrap:wrap;align-items:center;margin-top:14px}.builder-pane{display:none;animation:fade .18s ease}.builder-pane.active{display:block}.field-row{display:grid;grid-template-columns:1fr 1fr auto;gap:8px;align-items:start;margin-bottom:8px}.field-row textarea{min-height:46px}.discord{background:#313338;border-radius:8px;padding:18px;min-height:300px}.msg{display:grid;grid-template-columns:50px 1fr;gap:12px}.avatar{width:42px;height:42px;border-radius:50%;background:#1594f8;object-fit:cover}.botline{display:flex;gap:8px;align-items:center;font-size:20px}.bot-tag{font-size:11px;background:#5865f2;padding:2px 5px;border-radius:4px}.message-content{color:#dbdee1;white-space:pre-wrap;margin:8px 0}.embed-preview{max-width:620px;background:#2b2d31;border-left:5px solid var(--accent);border-radius:5px;padding:12px 14px;min-height:44px;overflow:hidden}.embed-author{display:flex;gap:7px;align-items:center;font-weight:700;color:#f2f3f5}.embed-author img{width:22px;height:22px;border-radius:50%}.embed-title{font-weight:800;font-size:18px;margin-top:8px;color:white}.embed-desc{white-space:pre-wrap;color:#dbdee1;margin-top:8px}.embed-fields{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:9px;margin-top:10px}.embed-field:not(.inline){grid-column:1/-1}.embed-field b{display:block}.embed-field div{white-space:pre-wrap;color:#dbdee1}.embed-media{max-width:100%;border-radius:5px;margin-top:10px}.embed-thumb{float:right;max-width:90px;max-height:90px;border-radius:5px;margin-left:10px}.embed-footer{display:flex;gap:7px;align-items:center;color:var(--muted);font-size:13px;margin-top:10px}.embed-footer img{width:20px;height:20px;border-radius:50%}.list{display:grid;gap:8px;max-height:540px;overflow:auto}.list-item{padding:12px;border:1px solid var(--line);border-radius:8px;background:var(--panel3);cursor:pointer}.list-item.active{border-color:var(--accent);background:#26364a}.variables{display:grid;gap:10px}.variable-search{position:sticky;top:0}.var-group h4{margin:14px 0 6px;color:var(--soft)}.var-list{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:6px}.var-chip{background:#141b24;border:1px solid var(--line);border-radius:8px;padding:9px;text-align:left}.raw-error,.error{color:var(--bad);font-weight:700}.toast{position:fixed;right:18px;bottom:18px;display:grid;gap:8px;z-index:30}.toast div{background:#111922;border:1px solid var(--line);box-shadow:var(--shadow);padding:12px 14px;border-radius:8px}.hide{display:none!important}.config-list{display:grid;gap:10px}.config-editor{min-height:440px}.notice{border:1px solid rgba(21,148,248,.35);background:rgba(21,148,248,.1);border-radius:8px;padding:12px;color:#d9ecff}.subnav{display:flex;gap:8px;flex-wrap:wrap;margin-bottom:12px}.subnav button.active{background:#405065}.loading:after{content:"";display:inline-block;width:12px;height:12px;margin-left:8px;border:2px solid currentColor;border-right-color:transparent;border-radius:50%;animation:spin .7s linear infinite}@keyframes spin{to{transform:rotate(360deg)}}@keyframes fade{from{opacity:.35;transform:translateY(4px)}to{opacity:1;transform:none}}@media(max-width:1050px){.shell{grid-template-columns:1fr}.side{position:relative;height:auto;border-right:0;border-bottom:1px solid var(--line)}.nav{grid-template-columns:repeat(2,1fr)}.workspace{grid-template-columns:1fr}.cards{grid-template-columns:repeat(2,1fr)}}@media(max-width:650px){.main,.side{padding:14px}.form-grid,.cards{grid-template-columns:1fr}.field-row{grid-template-columns:1fr}.embed-fields{grid-template-columns:1fr}.top{display:grid}.tabs button{font-size:16px}}
</style>
</head>
<body>
<div class="shell">
<aside class="side">
    <div class="brand"><img id="brandAvatar" alt=""><div><b id="brandName">${escapeHtml(siteTitle)}</b><span class="muted">AIO plugin dashboard</span></div></div>
    <nav class="nav">
        <button data-view="overview">Dashboard</button>
        <button data-view="welcomer">Welcomer Builder</button>
        <button data-view="leave">Leave Builder</button>
        <button data-view="embed">Embed Sender</button>
        <button data-view="sticky">Sticky Builder</button>
        <button data-view="configs">Configs</button>
    </nav>
</aside>
<main class="main">
    <section class="view" id="view-overview"></section>
    <section class="view hide" id="view-welcomer"></section>
    <section class="view hide" id="view-leave"></section>
    <section class="view hide" id="view-embed"></section>
    <section class="view hide" id="view-sticky"></section>
    <section class="view hide" id="view-configs"></section>
</main>
</div>
<div class="toast" id="toast"></div>
<script>
const state={boot:null,view:'overview',dirty:false,builders:{},stickySelected:null,configKey:null};
const variableGroups={
Bot:['{bot_name}','{bot_id}','{bot_avatar}','{bot_mention}'],
User:['{user}','{user_name}','{user_display_name}','{user_id}','{user_mention}','{user_avatar}','{user_created_at}','{user_joined_at}'],
Server:['{server_name}','{server}','{server_id}','{server_icon}','{member_count}','{boost_count}','{boost_tier}','{owner_id}','{owner_mention}'],
Time:['{now}','{now_timestamp}','{date}','{time}','{unix}','{relative_time}'],
Welcome:['{member}','{member_name}','{member_display_name}','{member_id}','{member_mention}','{member_avatar}','{member_count}','{server_name}'],
Leave:['{member}','{member_name}','{member_id}','{member_avatar}','{member_count}','{server_name}'],
Ticket:['{ticket_id}','{ticket_name}','{ticket_channel}','{ticket_channel_id}','{ticket_creator}','{ticket_creator_id}','{ticket_creator_mention}','{ticket_category}','{ticket_claimed_by}','{ticket_created_at}']
};
const $=(s,r=document)=>r.querySelector(s);
const $$=(s,r=document)=>Array.from(r.querySelectorAll(s));
const esc=(v)=>String(v??'').replace(/[&<>"']/g,m=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;'}[m]));
const api=async(url,opts={})=>{const r=await fetch(url,{headers:{'Content-Type':'application/json'},...opts});const text=await r.text();let data={};try{data=text?JSON.parse(text):{}}catch{data={error:text||'Request failed'}}if(!r.ok)throw new Error(data.error||'Request failed');return data};
function toast(msg,bad=false){const box=document.createElement('div');box.textContent=msg;box.style.borderColor=bad?'var(--bad)':'var(--line)';$('#toast').appendChild(box);setTimeout(()=>box.remove(),4200)}
function setLoading(btn,on){if(!btn)return;btn.disabled=on;btn.classList.toggle('loading',on)}
window.addEventListener('beforeunload',(e)=>{if(state.dirty){e.preventDefault();e.returnValue=''}});
function route(view){if(state.dirty&&!confirm('Discard unsaved changes?'))return;state.view=view;state.dirty=false;history.replaceState(null,'','#'+view);$$('.view').forEach(v=>v.classList.add('hide'));$('#view-'+view).classList.remove('hide');$$('.nav button').forEach(b=>b.classList.toggle('active',b.dataset.view===view));renderView()}
function channelOptions(selected=''){return '<option value="">Select a channel</option>'+state.boot.channels.map(c=>'<option value="'+esc(c.id)+'" '+(c.id===selected?'selected':'')+'>'+esc(c.label)+'</option>').join('')}
function defaultPayload(){return{content:'',embed:{enabled:true,color:'#33d6a6',title:'',description:'',authorName:'',authorIconUrl:'',authorUrl:'',footer:'',footerIconUrl:'',thumbnailUrl:'',imageUrl:'',timestamp:false,fields:[]}}}
function sample(v){const bot=state.boot.identity;const map={bot_name:bot.username,bot_id:bot.id,bot_avatar:bot.avatarUrl,bot_mention:bot.mention,user:'@Member',member:'@Member',user_name:'member',member_name:'member',display_name:'Member',user_display_name:'Member',member_display_name:'Member',user_id:'100000000000000000',member_id:'100000000000000000',user_mention:'@Member',member_mention:'@Member',server:'Support Server',server_name:'Support Server',member_count:'128',now:new Date().toLocaleString(),now_timestamp:'<t:'+Math.floor(Date.now()/1000)+':F>',nowtimestamp:'<t:'+Math.floor(Date.now()/1000)+':F>',date:new Date().toLocaleDateString(),time:new Date().toLocaleTimeString(),unix:String(Math.floor(Date.now()/1000)),relative_time:'<t:'+Math.floor(Date.now()/1000)+':R>'};return String(v??'').replace(/\\{([a-z_]+)\\}/gi,(m,k)=>map[k.toLowerCase()]??m)}
function builderHtml(id,payload,context){payload=payload||defaultPayload();const e=payload.embed||defaultPayload().embed;return '<div class="tabs" data-tabs="'+id+'"><button data-tab="visual" class="active">Visual</button><button data-tab="raw">Raw</button><button data-tab="variables">Variables</button></div>'+
'<div class="builder-pane active" data-pane="visual">'+
'<div class="form-grid">'+
'<label class="full">Message content <span>Text above the embed</span><textarea data-k="content">'+esc(payload.content||'')+'</textarea></label>'+
'<label class="switch full"><input type="checkbox" data-k="embed.enabled" '+(e.enabled!==false?'checked':'')+'> Enable embed</label>'+
'<label>Author name<input data-k="embed.authorName" value="'+esc(e.authorName||'')+'"></label><label>Author icon URL<input data-k="embed.authorIconUrl" value="'+esc(e.authorIconUrl||'')+'"></label>'+
'<label>Title<input data-k="embed.title" maxlength="256" value="'+esc(e.title||'')+'"></label><label>Color<input type="color" data-k="embed.color" value="'+esc(e.color||'#33d6a6')+'"></label>'+
'<label class="full">Description<textarea data-k="embed.description">'+esc(e.description||'')+'</textarea></label>'+
'<label>Thumbnail URL<input data-k="embed.thumbnailUrl" value="'+esc(e.thumbnailUrl||'')+'"></label><label>Image URL<input data-k="embed.imageUrl" value="'+esc(e.imageUrl||'')+'"></label>'+
'<label>Footer text<input data-k="embed.footer" value="'+esc(e.footer||'')+'"></label><label>Footer icon URL<input data-k="embed.footerIconUrl" value="'+esc(e.footerIconUrl||'')+'"></label>'+
'<label class="switch full"><input type="checkbox" data-k="embed.timestamp" '+(e.timestamp?'checked':'')+'> Add timestamp</label>'+
'<div class="full"><div class="actions"><button type="button" data-action="add-field">+ Field</button><button type="button" data-action="clear" class="danger">Clear</button></div><div data-fields></div></div>'+
'</div></div>'+
'<div class="builder-pane" data-pane="raw"><textarea class="config-editor" data-raw></textarea><div class="raw-error" data-raw-error></div></div>'+
'<div class="builder-pane" data-pane="variables">'+variablesHtml(context)+'</div>';
}
function variablesHtml(context){let groups=['Bot','User','Server','Time'];if(context==='welcome')groups.push('Welcome');if(context==='leave')groups.push('Leave');if(context==='sticky')groups.push('Ticket');groups.push('Ticket');return '<div class="variables"><input class="variable-search" placeholder="Search variables">'+groups.filter((g,i,a)=>a.indexOf(g)===i).map(g=>'<div class="var-group"><h4>'+g+'</h4><div class="var-list">'+variableGroups[g].map(v=>'<button type="button" class="var-chip" data-var="'+esc(v)+'">'+esc(v)+'</button>').join('')+'</div></div>').join('')+'</div>'}
function readBuilder(root){const data=structuredClone(state.builders[root.dataset.builder]||defaultPayload());$$('[data-k]',root).forEach(el=>{const key=el.dataset.k;const val=el.type==='checkbox'?el.checked:el.value;if(key==='content')data.content=val;else{const sub=key.split('.')[1];data.embed[sub]=val}});data.embed.fields=$$('[data-field]',root).map(row=>({name:$('[data-f-name]',row).value,value:$('[data-f-value]',row).value,inline:$('[data-f-inline]',row).checked})).filter(f=>f.name||f.value);return data}
function writeBuilder(id,data){state.builders[id]=structuredClone(data||defaultPayload());const root=$('[data-builder="'+id+'"]');if(!root)return;renderFields(root);$('[data-raw]',root).value=JSON.stringify(state.builders[id],null,4);drawPreview(id)}
function bindBuilder(id,context){const root=$('[data-builder="'+id+'"]');root.addEventListener('input',e=>{if(e.target.matches('.variable-search')){const q=e.target.value.toLowerCase();$$('.var-chip',root).forEach(b=>b.classList.toggle('hide',!b.textContent.toLowerCase().includes(q)));return}state.builders[id]=readBuilder(root);$('[data-raw]',root).value=JSON.stringify(state.builders[id],null,4);state.dirty=true;drawPreview(id)});root.addEventListener('change',()=>{state.builders[id]=readBuilder(root);state.dirty=true;drawPreview(id)});root.addEventListener('click',e=>{const btn=e.target.closest('button');if(!btn)return;if(btn.dataset.tab){$$('[data-tab]',root).forEach(b=>b.classList.toggle('active',b===btn));$$('[data-pane]',root).forEach(p=>p.classList.toggle('active',p.dataset.pane===btn.dataset.tab));if(btn.dataset.tab==='raw')$('[data-raw]',root).value=JSON.stringify(state.builders[id],null,4)}if(btn.dataset.action==='add-field'){state.builders[id].embed.fields.push({name:'',value:'',inline:false});renderFields(root);state.dirty=true;drawPreview(id)}if(btn.dataset.action==='clear'){state.builders[id]=defaultPayload();root.innerHTML=builderHtml(id,state.builders[id],context);bindBuilder(id,context);writeBuilder(id,state.builders[id]);state.dirty=true}if(btn.dataset.var){navigator.clipboard?.writeText(btn.dataset.var);toast('Copied '+btn.dataset.var)}});$('[data-raw]',root).addEventListener('input',e=>{try{state.builders[id]=JSON.parse(e.target.value);$('[data-raw-error]',root).textContent='';state.dirty=true;drawPreview(id)}catch(err){$('[data-raw-error]',root).textContent=err.message}});writeBuilder(id,state.builders[id])}
function renderFields(root){const id=root.dataset.builder;const fields=(state.builders[id].embed.fields||[]);$('[data-fields]',root).innerHTML=fields.map((f,i)=>'<div class="field-row" data-field="'+i+'"><label>Field name<input data-f-name value="'+esc(f.name)+'"></label><label>Field value<textarea data-f-value>'+esc(f.value)+'</textarea></label><div><label class="switch"><input type="checkbox" data-f-inline '+(f.inline?'checked':'')+'> Inline</label><button type="button" data-remove-field="'+i+'" class="danger">Remove</button></div></div>').join('');$$('[data-remove-field]',root).forEach(b=>b.onclick=()=>{fields.splice(Number(b.dataset.removeField),1);state.builders[id].embed.fields=fields;renderFields(root);state.dirty=true;drawPreview(id)})}
function drawPreview(id){const box=$('[data-preview="'+id+'"]');if(!box)return;const p=state.builders[id]||defaultPayload();const e=p.embed||{};const bot=state.boot.identity;box.innerHTML='<div class="discord"><div class="msg"><img class="avatar" src="'+esc(bot.avatarUrl)+'"><div><div class="botline"><span>'+esc(bot.username)+'</span><span class="bot-tag">BOT</span></div><div class="message-content">'+esc(sample(p.content||'')).replace(/\\n/g,'<br>')+'</div>'+embedPreviewHtml(e)+'</div></div></div>'}
function embedPreviewHtml(e){if(e.enabled===false)return '';const has=e.title||e.description||e.authorName||e.footer||e.thumbnailUrl||e.imageUrl||(e.fields&&e.fields.length);if(!has)return '<div class="embed-preview" style="border-left-color:'+esc(e.color||'#33d6a6')+'"></div>';return '<div class="embed-preview" style="border-left-color:'+esc(e.color||'#33d6a6')+'">'+(e.thumbnailUrl?'<img class="embed-thumb" src="'+esc(e.thumbnailUrl)+'">':'')+(e.authorName?'<div class="embed-author">'+(e.authorIconUrl?'<img src="'+esc(e.authorIconUrl)+'">':'')+'<span>'+esc(sample(e.authorName))+'</span></div>':'')+(e.title?'<div class="embed-title">'+esc(sample(e.title))+'</div>':'')+(e.description?'<div class="embed-desc">'+esc(sample(e.description)).replace(/\\n/g,'<br>')+'</div>':'')+(e.fields&&e.fields.length?'<div class="embed-fields">'+e.fields.map(f=>'<div class="embed-field '+(f.inline?'inline':'')+'"><b>'+esc(sample(f.name))+'</b><div>'+esc(sample(f.value)).replace(/\\n/g,'<br>')+'</div></div>').join('')+'</div>':'')+(e.imageUrl?'<img class="embed-media" src="'+esc(e.imageUrl)+'">':'')+(e.footer||e.timestamp?'<div class="embed-footer">'+(e.footerIconUrl?'<img src="'+esc(e.footerIconUrl)+'">':'')+'<span>'+esc(sample(e.footer||''))+(e.timestamp?' • Today at '+new Date().toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'}):'')+'</span></div>':'')+'</div>'}
function welcomerPayload(mode){const cfg=state.boot.welcomer[mode];return{content:cfg.messageContent||'',embed:{enabled:cfg.embed?.enabled!==false,color:cfg.embed?.color||'#33d6a6',title:cfg.embed?.title||'',description:cfg.embed?.description||'',authorName:cfg.embed?.author?.name||'',authorIconUrl:cfg.embed?.author?.icon||'',authorUrl:cfg.embed?.author?.url||'',footer:cfg.embed?.footer||'',thumbnailUrl:cfg.embed?.thumbnail==='user-icon'?'':(cfg.embed?.thumbnail||''),imageUrl:cfg.embed?.image||'',timestamp:!!cfg.embed?.timestamp,fields:[]}}}
function renderOverview(){const b=state.boot;$('#view-overview').innerHTML='<div class="top"><div><h1>Dashboard</h1><div class="muted">Manage AIO modules without touching raw JSON for common workflows.</div></div><a href="/logout"><button>Logout</button></a></div><div class="cards"><div class="card"><span class="muted">Guilds</span><h2>'+b.stats.guilds+'</h2></div><div class="card"><span class="muted">Channels</span><h2>'+b.channels.length+'</h2></div><div class="card"><span class="muted">Ping</span><h2>'+b.stats.ping+'ms</h2></div><div class="card"><span class="muted">Memory</span><h2>'+b.stats.memory+' MB</h2></div></div><div class="cards">'+['welcomer','sticky','configManager'].map(k=>'<div class="card"><h3>'+esc(k)+'</h3><p class="muted">'+(b.aio.modules[k].enabled?'Enabled':'Disabled')+'</p><button data-module="'+k+'">'+(b.aio.modules[k].enabled?'Disable':'Enable')+'</button></div>').join('')+'</div><div class="notice">Welcomer and Leave now save to separate config sections. Embed Sender does not store webhook URLs unless a future explicit saved-webhook feature is added.</div>';$$('[data-module]').forEach(btn=>btn.onclick=async()=>{const k=btn.dataset.module;setLoading(btn,true);try{await api('/api/modules',{method:'PUT',body:JSON.stringify({module:k,enabled:!state.boot.aio.modules[k].enabled})});await boot();toast('Module updated')}catch(e){toast(e.message,true)}finally{setLoading(btn,false)}})}
function renderWelcomerMode(mode){const id=mode+'Builder';const section=state.boot.welcomer[mode];$('#view-'+(mode==='welcome'?'welcomer':'leave')).innerHTML='<div class="top"><div><h1>'+(mode==='welcome'?'Welcomer':'Leave Message')+' Builder</h1><div class="muted">Separate save path for '+mode+' messages.</div></div></div><div class="workspace"><div class="panel editor"><div class="form-grid"><label class="switch full"><input id="'+mode+'Enabled" type="checkbox" '+(section.enabled?'checked':'')+'> Enable '+mode+' messages</label><label class="full">Channel<select id="'+mode+'Channel">'+channelOptions(section.channelId)+'</select></label></div><div data-builder="'+id+'">'+builderHtml(id,welcomerPayload(mode),mode)+'</div><div class="actions"><button class="primary" id="'+mode+'Save">Save</button><button id="'+mode+'Test">Test preview</button></div></div><div class="panel preview-wrap"><div data-preview="'+id+'"></div></div></div>';state.builders[id]=welcomerPayload(mode);bindBuilder(id,mode);$('#'+mode+'Enabled').onchange=()=>state.dirty=true;$('#'+mode+'Channel').onchange=()=>state.dirty=true;$('#'+mode+'Save').onclick=async(e)=>{setLoading(e.target,true);try{await api('/api/welcomer/'+mode,{method:'PUT',body:JSON.stringify({enabled:$('#'+mode+'Enabled').checked,channelId:$('#'+mode+'Channel').value,payload:state.builders[id]})});state.dirty=false;await boot(false);toast((mode==='welcome'?'Welcomer':'Leave')+' saved')}catch(err){toast(err.message,true)}finally{setLoading(e.target,false)}};$('#'+mode+'Test').onclick=async(e)=>{setLoading(e.target,true);try{await api('/api/welcomer/'+mode+'/test',{method:'POST',body:JSON.stringify({enabled:$('#'+mode+'Enabled').checked,channelId:$('#'+mode+'Channel').value,payload:state.builders[id]})});toast('Test message sent')}catch(err){toast(err.message,true)}finally{setLoading(e.target,false)}}}
function renderEmbed(){const id='embedBuilder';$('#view-embed').innerHTML='<div class="top"><div><h1>Embed Builder / Sender</h1><div class="muted">Build visually, edit raw JSON, send normally or through a webhook.</div></div></div><div class="workspace"><div class="panel editor"><div data-builder="'+id+'">'+builderHtml(id,state.builders[id]||defaultPayload(),'default')+'</div><div class="subnav"><button data-send-mode="normal" class="active">Normal Send</button><button data-send-mode="webhook">Webhook Send</button><button data-send-mode="sticky">Save as Sticky</button></div><div id="sendNormal"><label>Channel<select id="sendChannel">'+channelOptions()+'</select></label><div class="actions"><button class="primary" id="sendBot">Send message</button></div></div><div id="sendWebhook" class="hide"><label>Webhook URL<input id="webhookUrl" placeholder="https://discord.com/api/webhooks/..."></label><label>Webhook username<input id="webhookName"></label><label>Webhook avatar URL<input id="webhookAvatar"></label><div class="actions"><button class="primary" id="sendHook">Send through webhook</button></div></div><div id="sendSticky" class="hide"><label>Sticky channel<select id="embedStickyChannel">'+channelOptions()+'</select></label><label>Cooldown messages<input id="embedStickyCooldown" type="number" min="1" value="1"></label><label class="switch"><input id="embedStickyEnabled" type="checkbox" checked> Enable sticky</label><div class="actions"><button class="good" id="saveEmbedSticky">Save sticky</button></div></div></div><div class="panel preview-wrap"><div data-preview="'+id+'"></div></div></div>';state.builders[id]=state.builders[id]||defaultPayload();bindBuilder(id,'default');$$('[data-send-mode]').forEach(b=>b.onclick=()=>{$$('[data-send-mode]').forEach(x=>x.classList.toggle('active',x===b));$('#sendNormal').classList.toggle('hide',b.dataset.sendMode!=='normal');$('#sendWebhook').classList.toggle('hide',b.dataset.sendMode!=='webhook');$('#sendSticky').classList.toggle('hide',b.dataset.sendMode!=='sticky')});$('#sendBot').onclick=sendBot;$('#sendHook').onclick=sendWebhook;$('#saveEmbedSticky').onclick=saveEmbedSticky}
async function sendBot(e){setLoading(e.target,true);try{await api('/api/embed/send',{method:'POST',body:JSON.stringify({mode:'bot',channelId:$('#sendChannel').value,payload:state.builders.embedBuilder})});toast('Message sent')}catch(err){toast(err.message,true)}finally{setLoading(e.target,false)}}
async function sendWebhook(e){setLoading(e.target,true);try{const d=await api('/api/embed/send',{method:'POST',body:JSON.stringify({mode:'webhook',webhookUrl:$('#webhookUrl').value,webhookUsername:$('#webhookName').value,webhookAvatarUrl:$('#webhookAvatar').value,payload:state.builders.embedBuilder})});$('#webhookUrl').value=d.maskedWebhookUrl||'';toast('Webhook message sent')}catch(err){toast(err.message,true)}finally{setLoading(e.target,false)}}
async function saveEmbedSticky(e){setLoading(e.target,true);try{await api('/api/stickies/'+encodeURIComponent($('#embedStickyChannel').value),{method:'PUT',body:JSON.stringify({channelId:$('#embedStickyChannel').value,type:'embed',messageContent:state.builders.embedBuilder.content,embedData:state.builders.embedBuilder.embed,enabled:$('#embedStickyEnabled').checked,mode:'message',cooldownMessages:Number($('#embedStickyCooldown').value||1)})});await boot(false);toast('Sticky saved')}catch(err){toast(err.message,true)}finally{setLoading(e.target,false)}}
function stickyPayload(entry){return{content:entry?.messageContent||'',embed:entry?.embedData?{enabled:true,color:entry.embedData.color||'#33d6a6',title:entry.embedData.title||'',description:entry.embedData.description||'',authorName:entry.embedData.authorName||'',authorIconUrl:entry.embedData.authorIconUrl||'',footer:entry.embedData.footer||'',footerIconUrl:entry.embedData.footerIconUrl||'',thumbnailUrl:entry.embedData.thumbnailUrl||'',imageUrl:entry.embedData.imageUrl||'',timestamp:!!entry.embedData.timestamp,fields:entry.embedData.fields||[]}:defaultPayload().embed}}
function renderSticky(){const entries=state.boot.stickies||[];const selected=entries.find(e=>e.channelId===state.stickySelected)||entries[0]||null;if(selected)state.stickySelected=selected.channelId;const id='stickyBuilder';$('#view-sticky').innerHTML='<div class="top"><div><h1>Sticky Message Builder</h1><div class="muted">Create, edit, resend, and delete sticky messages.</div></div><button id="newSticky">New Sticky</button></div><div class="workspace"><div class="panel editor"><div class="list">'+(entries.length?entries.map(e=>'<div class="list-item '+(selected&&e.channelId===selected.channelId?'active':'')+'" data-sticky="'+esc(e.channelId)+'"><b>#'+esc(e.channelId)+'</b><div class="muted">'+esc(e.type)+' / '+esc(e.mode)+' / '+(e.enabled?'enabled':'disabled')+'</div></div>').join(''):'<div class="notice">No sticky messages yet.</div>')+'</div><hr><div class="form-grid"><label class="full">Channel<select id="stickyChannel">'+channelOptions(selected?.channelId||'')+'</select></label><label class="switch"><input id="stickyEnabled" type="checkbox" '+(selected?.enabled!==false?'checked':'')+'> Enabled</label><label>Cooldown messages<input id="stickyCooldown" type="number" min="1" value="'+esc(selected?.cooldownMessages||1)+'"></label></div><div data-builder="'+id+'">'+builderHtml(id,stickyPayload(selected),'sticky')+'</div><div class="actions"><button class="primary" id="saveSticky">Save sticky</button><button id="resendSticky">Resend</button><button class="danger" id="deleteSticky">Delete</button></div></div><div class="panel preview-wrap"><div data-preview="'+id+'"></div></div></div>';state.builders[id]=stickyPayload(selected);bindBuilder(id,'sticky');$$('[data-sticky]').forEach(x=>x.onclick=()=>{state.stickySelected=x.dataset.sticky;state.dirty=false;renderSticky()});$('#newSticky').onclick=()=>{state.stickySelected=null;state.builders[id]=defaultPayload();renderSticky()};$('#saveSticky').onclick=async(e)=>{setLoading(e.target,true);try{await api('/api/stickies/'+encodeURIComponent($('#stickyChannel').value),{method:'PUT',body:JSON.stringify({channelId:$('#stickyChannel').value,type:'embed',messageContent:state.builders[id].content,embedData:state.builders[id].embed,enabled:$('#stickyEnabled').checked,mode:'message',cooldownMessages:Number($('#stickyCooldown').value||1)})});state.stickySelected=$('#stickyChannel').value;state.dirty=false;await boot(false);toast('Sticky saved')}catch(err){toast(err.message,true)}finally{setLoading(e.target,false)}};$('#resendSticky').onclick=async(e)=>{if(!state.stickySelected)return;setLoading(e.target,true);try{await api('/api/stickies/'+encodeURIComponent(state.stickySelected)+'/resend',{method:'POST'});toast('Sticky resent')}catch(err){toast(err.message,true)}finally{setLoading(e.target,false)}};$('#deleteSticky').onclick=async(e)=>{if(!state.stickySelected||!confirm('Delete this sticky?'))return;setLoading(e.target,true);try{await api('/api/stickies/'+encodeURIComponent(state.stickySelected),{method:'DELETE'});state.stickySelected=null;state.dirty=false;await boot(false);toast('Sticky deleted')}catch(err){toast(err.message,true)}finally{setLoading(e.target,false)}}}
function renderConfigs(){const files=state.boot.configs;$('#view-configs').innerHTML='<div class="top"><div><h1>Configs</h1><div class="muted">Safe general fields and allowed raw JSONC files.</div></div></div><div class="workspace"><div class="panel editor"><div class="config-list">'+files.map(f=>'<button data-config="'+esc(f.key)+'">'+esc(f.label)+' <span class="muted">'+esc(f.mode)+'</span></button>').join('')+'</div></div><div class="panel editor"><div id="configEditor" class="notice">Choose a config file.</div></div></div>';$$('[data-config]').forEach(btn=>btn.onclick=()=>loadConfig(btn.dataset.config))}
async function loadConfig(key){try{const d=await api('/api/configs/'+encodeURIComponent(key));state.configKey=key;if(d.mode==='general'){$('#configEditor').innerHTML='<div class="form-grid">'+Object.keys(d.data).map(k=>'<label>'+esc(k)+'<input data-general="'+esc(k)+'" value="'+esc(d.data[k])+'"></label>').join('')+'</div><div class="actions"><button class="primary" id="saveConfig">Save</button></div>'}else{$('#configEditor').innerHTML='<textarea class="config-editor" id="rawConfig">'+esc(d.content)+'</textarea><div class="error" id="configError"></div><div class="actions"><button class="primary" id="saveConfig">Validate & Save</button></div>'}$('#saveConfig').onclick=()=>saveConfig(d.mode)}catch(e){toast(e.message,true)}}
async function saveConfig(mode){try{const body=mode==='general'?{data:Object.fromEntries($$('[data-general]').map(i=>[i.dataset.general,i.value]))}:{content:$('#rawConfig').value};await api('/api/configs/'+encodeURIComponent(state.configKey),{method:'PUT',body:JSON.stringify(body)});toast('Config saved')}catch(e){$('#configError')&&($('#configError').textContent=e.message);toast(e.message,true)}}
function renderView(){if(!state.boot)return;if(state.view==='overview')renderOverview();if(state.view==='welcomer')renderWelcomerMode('welcome');if(state.view==='leave')renderWelcomerMode('leave');if(state.view==='embed')renderEmbed();if(state.view==='sticky')renderSticky();if(state.view==='configs')renderConfigs()}
async function boot(render=true){state.boot=await api('/api/bootstrap');const id=state.boot.identity;$('#brandName').textContent=id.username||'AIO Dashboard';if(id.avatarUrl){$('#brandAvatar').src=id.avatarUrl;$('#favicon').href=id.avatarUrl}else{$('#brandAvatar').style.display='none'}if(render)route(location.hash.replace('#','')||'overview');else renderView()}
$$('.nav button').forEach(btn=>btn.onclick=()=>route(btn.dataset.view));
boot().catch(e=>toast(e.message,true));
</script>
</body>
</html>`
}

const getBootstrap = () => {
    const cfg = getAioConfig().data
    const client = getClient()
    const welcomer = readJson<any>(welcomerConfigPath)
    const stickyManager = opendiscord.plugins.classes.get("ot-aio:sticky:manager") as any
    const allowedRaw = new Set(cfg.configManager.allowRawJsoncFiles)
    return {
        identity: getBotIdentity(),
        aio: cfg,
        welcomer,
        stickies: stickyManager?.getAllEntries?.() ?? [],
        channels: getChannels(),
        configs: Object.keys(coreConfigFiles).map((key) => ({
            key,
            label: coreConfigFiles[key],
            mode: key === "general" ? "safe fields" : allowedRaw.has(key) ? "raw JSONC" : "disabled"
        })),
        stats: {
            guilds: client?.guilds.cache.size ?? 0,
            users: client?.users.cache.size ?? 0,
            ping: client?.ws.ping ?? 0,
            memory: Math.round(process.memoryUsage().heapUsed / 1024 / 1024)
        }
    }
}

const saveWelcomerSection = (mode: "welcome" | "leave", body: any) => {
    const config = readJson<any>(welcomerConfigPath)
    const payload = sanitizeBuilderPayload(body.payload ?? {})
    const error = body.enabled === false ? null : validateBuilderPayload(payload)
    if (error) throw new Error(error)

    config[mode] = {
        ...config[mode],
        enabled: Boolean(body.enabled),
        channelId: String(body.channelId ?? ""),
        messageContent: payload.content,
        embed: toWelcomerEmbed(payload.embed)
    }
    backupFile(welcomerConfigPath)
    writeJson(welcomerConfigPath, config)
    const loaded = opendiscord.configs.get("ot-aio:welcomer:config") as any
    loaded?.reload?.()
    return config
}

const toStickyEmbedData = (embed: BuilderEmbed) => ({
    title: embed.title ?? "",
    description: embed.description ?? "",
    color: normalizeHexColor(embed.color),
    authorName: embed.authorName ?? "",
    authorIconUrl: embed.authorIconUrl ?? "",
    footer: embed.footer ?? "",
    footerIconUrl: embed.footerIconUrl ?? "",
    imageUrl: embed.imageUrl ?? "",
    thumbnailUrl: embed.thumbnailUrl ?? "",
    timestamp: Boolean(embed.timestamp),
    fields: Array.isArray(embed.fields) ? embed.fields : []
})

const startDashboard = () => {
    const cfg = getAioConfig().data
    if (!cfg.dashboard.enabled) return

    const app = express()
    app.use(helmet({ contentSecurityPolicy: false }))
    app.use(rateLimit({ windowMs: 60_000, limit: 240, standardHeaders: true, legacyHeaders: false }))
    app.use(express.urlencoded({ extended: true, limit: "10mb" }))
    app.use(express.json({ limit: "10mb" }))
    app.use(session({
        secret: cfg.dashboard.sessionSecret,
        resave: false,
        saveUninitialized: false,
        cookie: { maxAge: 1000 * 60 * 60 * 24, sameSite: "lax" }
    }))

    app.get("/login", (req: any, res: any) => res.send(loginPage(cfg.dashboard.siteTitle, req.query.error === "1")))
    app.post("/login", (req: any, res: any) => {
        if (req.body.password === cfg.dashboard.password) {
            req.session.authed = true
            return res.redirect("/")
        }
        return res.redirect("/login?error=1")
    })
    app.get("/logout", requireAuth, (req: any, res: any) => req.session.destroy(() => res.redirect("/login")))
    app.get(["/", "/welcomer", "/leave", "/embed", "/sticky", "/configs"], requireAuth, (_req: any, res: any) => res.send(appPage()))

    app.get("/api/bootstrap", requireAuth, (_req: any, res: any) => res.json(getBootstrap()))
    app.get("/api/bot-identity", requireAuth, (_req: any, res: any) => res.json(getBotIdentity()))

    app.put("/api/modules", requireAuth, (req: any, res: any) => {
        const key = String(req.body.module ?? "") as "sticky" | "welcomer" | "configManager"
        if (!["sticky", "welcomer", "configManager"].includes(key)) return jsonError(res, 400, "Invalid module.")
        const config = getAioConfig()
        config.data.modules[key].enabled = parseBool(req.body.enabled)
        writeJson(path.join(pluginRoot, "config.json"), config.data)
        res.json({ ok: true })
    })

    app.put("/api/welcomer/:mode", requireAuth, (req: any, res: any) => {
        try {
            if (!isAioModuleEnabled("welcomer")) return jsonError(res, 409, "Welcomer module is disabled.")
            const mode = String(req.params.mode)
            if (mode !== "welcome" && mode !== "leave") return jsonError(res, 404, "Unknown welcomer section.")
            const config = saveWelcomerSection(mode, req.body)
            res.json({ ok: true, config })
        } catch (error: any) {
            jsonError(res, 400, error.message)
        }
    })

    app.post("/api/welcomer/:mode/test", requireAuth, async (req: any, res: any) => {
        try {
            if (!isAioModuleEnabled("welcomer")) return jsonError(res, 409, "Welcomer module is disabled.")
            const mode = String(req.params.mode)
            if (mode !== "welcome" && mode !== "leave") return jsonError(res, 404, "Unknown welcomer section.")
            const config = saveWelcomerSection(mode, req.body)
            await sendWelcomerPreview(mode, config)
            res.json({ ok: true })
        } catch (error: any) {
            jsonError(res, 400, error.message)
        }
    })

    app.post("/api/embed/send", requireAuth, async (req: any, res: any) => {
        try {
            const payload = sanitizeBuilderPayload(req.body.payload ?? {})
            const error = validateBuilderPayload(payload)
            if (error) return jsonError(res, 400, error)

            if (req.body.mode === "webhook") {
                const webhookUrl = String(req.body.webhookUrl ?? "").trim()
                if (!webhookRegex.test(webhookUrl)) return jsonError(res, 400, "Enter a valid Discord webhook URL.")
                const webhook = new discord.WebhookClient({ url: webhookUrl })
                await webhook.send({
                    ...buildMessageOptions(payload),
                    username: String(req.body.webhookUsername ?? "").trim() || undefined,
                    avatarURL: cleanUrl(req.body.webhookAvatarUrl) || undefined
                })
                webhook.destroy()
                return res.json({ ok: true, maskedWebhookUrl: maskWebhookUrl(webhookUrl) })
            }

            const channel = await fetchTextChannel(String(req.body.channelId ?? ""))
            if (!channel) return jsonError(res, 400, "Select a valid text channel.")
            await channel.send(buildMessageOptions(payload))
            res.json({ ok: true })
        } catch (error: any) {
            jsonError(res, 400, "Message send failed. Check the channel, webhook, and bot permissions.")
        }
    })

    app.put("/api/stickies/:channelId", requireAuth, (req: any, res: any) => {
        try {
            if (!isAioModuleEnabled("sticky")) return jsonError(res, 409, "Sticky module is disabled.")
            const channelId = String(req.body.channelId ?? req.params.channelId ?? "")
            if (!discordIdRegex.test(channelId)) return jsonError(res, 400, "Invalid channel ID.")
            const payload = sanitizeBuilderPayload({ content: req.body.messageContent, embed: req.body.embedData })
            const error = validateBuilderPayload(payload)
            if (error) return jsonError(res, 400, error)
            const manager = opendiscord.plugins.classes.get("ot-aio:sticky:manager") as any
            const existing = manager.getEntry(channelId)
            const entry = manager.normalizeEntry({
                version: 2,
                channelId,
                enabled: req.body.enabled !== false,
                type: "embed",
                mode: req.body.mode === "timed" ? "timed" : "message",
                messageContent: payload.content,
                embedData: toStickyEmbedData(payload.embed),
                attachmentData: null,
                lastStickyMessageId: existing?.lastStickyMessageId ?? null,
                ignoredRoleIds: existing?.ignoredRoleIds ?? [],
                cooldownMessages: Math.max(1, Math.floor(Number(req.body.cooldownMessages ?? 1))),
                timedResendMinutes: req.body.timedResendMinutes ? Math.max(1, Math.floor(Number(req.body.timedResendMinutes))) : null,
                lastTimedResendAt: existing?.lastTimedResendAt ?? null,
                expiration: existing?.expiration ?? null,
                schedule: existing?.schedule ?? null,
                reaction: existing?.reaction ?? null,
                analytics: existing?.analytics,
                createdAt: existing?.createdAt ?? new Date().toISOString(),
                updatedAt: new Date().toISOString()
            })
            if (existing?.attachmentData) manager.deleteAttachmentFile(existing.attachmentData)
            manager.saveEntry(entry)
            res.json({ ok: true, entry })
        } catch (error: any) {
            jsonError(res, 400, error.message)
        }
    })

    app.post("/api/stickies/:channelId/resend", requireAuth, async (req: any, res: any) => {
        const manager = opendiscord.plugins.classes.get("ot-aio:sticky:manager") as any
        const result = await manager.resendSticky(String(req.params.channelId), "dashboard")
        res.status(result.success ? 200 : 400).json(result.success ? { ok: true } : { ok: false, error: result.reason })
    })

    app.delete("/api/stickies/:channelId", requireAuth, async (req: any, res: any) => {
        const manager = opendiscord.plugins.classes.get("ot-aio:sticky:manager") as any
        const removed = await manager.removeEntry(String(req.params.channelId), true)
        res.status(removed ? 200 : 404).json(removed ? { ok: true } : { ok: false, error: "Sticky not found." })
    })

    app.get("/api/configs/:key", requireAuth, (req: any, res: any) => {
        try {
            if (!isAioModuleEnabled("configManager")) return jsonError(res, 409, "Config manager is disabled.")
            const key = String(req.params.key)
            if (!coreConfigFiles[key]) return jsonError(res, 404, "Unknown config.")
            const filePath = path.join(configRoot, coreConfigFiles[key])
            if (key === "general") {
                const current = readJsonc(filePath)
                const data = Object.fromEntries(safeGeneralFields.map((field) => [field, current[field] ?? ""]))
                return res.json({ ok: true, mode: "general", data })
            }
            if (!getAioConfig().data.configManager.allowRawJsoncFiles.includes(key)) return jsonError(res, 403, "Config is not exposed.")
            res.json({ ok: true, mode: "raw", content: fs.readFileSync(filePath, "utf8") })
        } catch (error: any) {
            jsonError(res, 400, error.message)
        }
    })

    app.put("/api/configs/:key", requireAuth, (req: any, res: any) => {
        try {
            if (!isAioModuleEnabled("configManager")) return jsonError(res, 409, "Config manager is disabled.")
            const key = String(req.params.key)
            if (!coreConfigFiles[key]) return jsonError(res, 404, "Unknown config.")
            const filePath = path.join(configRoot, coreConfigFiles[key])
            const current = readJsonc(filePath)
            backupFile(filePath)
            if (key === "general") {
                for (const field of safeGeneralFields) {
                    const currentValue = current[field]
                    if (typeof currentValue === "boolean") current[field] = parseBool(req.body.data?.[field])
                    else current[field] = String(req.body.data?.[field] ?? "")
                }
                fs.writeFileSync(filePath, JSON.stringify(current, null, 4) + "\n")
            } else {
                if (!getAioConfig().data.configManager.allowRawJsoncFiles.includes(key)) return jsonError(res, 403, "Config is not exposed.")
                const content = String(req.body.content ?? "")
                jsonc.parse(content)
                fs.writeFileSync(filePath, content)
            }
            res.json({ ok: true })
        } catch (error: any) {
            jsonError(res, 400, error.message)
        }
    })

    const server = app.listen(cfg.dashboard.port, cfg.dashboard.host, () => {
        opendiscord.log(`AIO dashboard running at http://${cfg.dashboard.host}:${cfg.dashboard.port}`, "plugin")
    })
    server.on("error", (error: Error) => opendiscord.log(`AIO dashboard failed to start: ${error.message}`, "plugin"))
}

let dashboardStarted = false
opendiscord.events.get("onReadyForUsage").listen(() => {
    if (dashboardStarted) return
    dashboardStarted = true
    startDashboard()
})
