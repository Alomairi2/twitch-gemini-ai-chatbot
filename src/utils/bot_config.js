// src/utils/bot_config.js
//
// Single deep module managing bot configuration: factory presets, schema
// sanitization, and the non-throwing ConfigStore persistence layer across 6 domains.

import { DEFAULT_CHAT_MODEL, normalizeChatModel } from './chat_models.js';

export const CONFIG_TYPES = Object.freeze([
    'bot_settings',
    'stream_actions',
    'system_instructions',
    'commands',
    'event_alerts',
    'error_messages'
]);

export const FACTORY = Object.freeze({
    bot_settings: Object.freeze({
        channels: Object.freeze([]),
        model_name: DEFAULT_CHAT_MODEL,
        thinking_level: 'medium',
        search_grounding: '',
        tavily_search_depth: 'basic',
        cooldown_duration: 0,
        ignored_usernames: Object.freeze(['streamelements', 'nightbot']),
        ai_history_length: 10,
        chat_context_length: 10,
        reply_mode: 'off',
        ignore_emote_only_prompts: true,
        enable_emote_appending: true,
        bot_command_name: '!gemini,@yourbotusername',
        highlight_bot_responses: true
    }),

    stream_actions: Object.freeze({
        enabled: true,
        stream_setup_enabled: true,
        moderation_enabled: true,
        chat_access_enabled: true,
        community_enabled: true,
        polls_predictions_enabled: true,
        viewer_clips_enabled: true,
        clip_cooldown_seconds: 30
    }),

    system_instructions: `<rules>
- Keep responses short, usually 1 to 3 sentences. Chat moves fast, so never write walls of text.
- Never spoil story endings, plot twists, or game secrets unless a chatter explicitly asks for them.
- If you must decline a request, keep it brief and casual. Never lecture or preach.
- Channel metadata and viewer roles are background context. Do not volunteer them unless directly asked.
- If chatters ask where to see generated art, audio, or past logs, direct them to !dashboard.
</rules>

<channel>
This channel is using the default configuration. Streamers: replace this section with your channel facts, your bot's name, running jokes, or whatever you want.

Until this section is customized, you are in default mode. If chatters ask who you are, or when chatting with the broadcaster, you can playfully remind them that they can customize your brain in the dashboard.
</channel>

<persona>
- You are an observant regular hanging out in Twitch chat who happens to know a lot of things.
- Talk like a peer in chat, not a customer service assistant or an AI bot.
- Have real opinions. Take a stance and join the banter instead of sounding like a neutral search engine.
- Match the room's energy: playful when chat is joking around, direct when someone asks a real question.
- If you don't know something, admit it honestly instead of guessing or making things up.
</persona>`,

    commands: Object.freeze({
        media: Object.freeze({
            image: Object.freeze({ enabled: true, command: '!image', aliases: Object.freeze([]), provider: 'pollinations', model: 'flux', access: 'everyone' }),
            video: Object.freeze({ enabled: true, command: '!video', aliases: Object.freeze([]), provider: 'pollinations', model: 'wan-fast', duration: 10, access: 'everyone' }),
            tts: Object.freeze({ enabled: true, command: '!tts', aliases: Object.freeze([]), provider: 'pollinations', model: 'elevenlabs', voice: 'charlotte', access: 'everyone' }),
            music: Object.freeze({ enabled: true, command: '!song', aliases: Object.freeze([]), provider: 'pollinations', model: 'elevenmusic', duration: 30, access: 'everyone' }),
            access: 'everyone'
        }),
        custom: Object.freeze([
            Object.freeze({
                command: '!dashboard',
                aliases: Object.freeze(['!gallery', '!logs']),
                response: 'http://localhost:3000/',
                role: 'all'
            })
        ])
    }),

    event_alerts: Object.freeze({
        subscription: Object.freeze({
            enabled: true,
            ai_enabled: true,
            cooldown_seconds: 0,
            fallback_template: 'Thanks for subbing, {username}!',
            ai_prompt: "Thank {username} for subbing. {username}'s optional message: '{message}'."
        }),
        resub: Object.freeze({
            enabled: true,
            ai_enabled: true,
            cooldown_seconds: 0,
            fallback_template: 'Thanks for {months} months, {username}!',
            ai_prompt: "Thank {username} for resubbing for {months} months. {username}'s optional message: '{message}'."
        }),
        sub_gift: Object.freeze({
            enabled: true,
            ai_enabled: true,
            cooldown_seconds: 0,
            fallback_template: 'Thanks for the gift sub, {username}!',
            ai_prompt: 'Thank {username} for the gift sub.'
        }),
        community_sub_gift: Object.freeze({
            enabled: true,
            ai_enabled: true,
            cooldown_seconds: 0,
            fallback_template: 'Thanks for gifting {count} subs, {username}!',
            ai_prompt: 'Thank {username} for gifting {count} subs to the community.'
        }),
        cheer: Object.freeze({
            enabled: true,
            ai_enabled: true,
            min_bits: 100,
            cooldown_seconds: 0,
            fallback_template: 'Thanks for the {bits} bits, {username}!',
            ai_prompt: "Thank {username} for cheering {bits} bits. {username}'s optional message: '{message}'."
        }),
        channel_points: Object.freeze({
            enabled: false,
            cooldown_seconds: 5,
            rewards: Object.freeze({
                Hydrate: Object.freeze({
                    ai_enabled: true,
                    fallback_template: '{username} redeemed Hydrate. Drink water, streamer.',
                    ai_prompt: "Thank {username} for redeeming Hydrate. Remind the streamer to hydrate. {username}'s optional note: '{user_input}'."
                })
            })
        }),
        raid: Object.freeze({
            enabled: true,
            ai_enabled: true,
            min_viewers: 1,
            cooldown_seconds: 10,
            fallback_template: '{username} raided with {viewers} viewers. Welcome!',
            ai_prompt: 'Welcome {username}, who just raided with {viewers} viewers.'
        }),
        follow: Object.freeze({
            enabled: false,
            ai_enabled: true,
            cooldown_seconds: 5,
            fallback_template: 'Thanks for the follow, {username}!',
            ai_prompt: 'Thank {username} for the follow.'
        })
    }),

    error_messages: Object.freeze({
        RATE_LIMIT_EXHAUSTED: '⏰ All API keys rate limited. Try again later.',
        GEMINI_EMPTY_RESPONSE: "🔭 Empty Response. Google's servers are having issues. Try again in 30 seconds.",
        POLLINATIONS_SERVER_DOWN: '🔧 Server Down. Pollinations servers are offline. Try again later.',
        POLLINATIONS_BAD_GATEWAY: '🔧 Bad Gateway. Pollinations servers are having issues. Try again in 30 seconds.',
        POLLINATIONS_GATEWAY_TIMEOUT: '⏱️ Gateway Timeout. Pollinations took too long. Try again in 30 seconds.',
        POLLINATIONS_BAD_REQUEST: '❌ Bad Request. Pollinations rejected that prompt. Try different words.',
        POLLINATIONS_RATE_LIMITED: '⏰ Rate Limited. Pollinations is busy. Try again in 30 seconds.',
        POLLINATIONS_GENERIC_ERROR: '🔧 Pollinations {modelType} Error. Something went wrong. Try again in 30 seconds.',
        MEDIA_PROMPT_REQUIRED: '@{username} Please provide a description for the {mediaType}.',
        MEDIA_ACCESS_DENIED: '🔒 That command is restricted on this channel.',
        MEDIA_COMMAND_DISABLED: '⛔ That command is turned off right now.',
        MEDIA_PROVIDER_UNAVAILABLE: "🔧 {provider} isn't available for {mediaType} generation right now.",
        MEDIA_MODEL_UNAVAILABLE: '🔧 The selected {mediaType} model is unavailable. Ask the bot owner to choose another.',
        MEDIA_NO_DATA: '🔧 {service} Error. No {mediaType} data returned. Try again.',
        MEDIA_FALLBACK_RESPONSE: "Here's your {mediaType} {username}: {url}",
        COOLDOWN_ACTIVE: 'Cooldown active. Please wait {remainingTime} seconds before sending another message.',
        VIDEO_UPLOAD_EMPTY: '❌ Video Upload Failed. Host returned empty response. Try again.',
        VIDEO_UPLOAD_TIMEOUT: '⏱️ Video Upload Timeout. Host took too long. Try again.',
        VIDEO_UPLOAD_FAILED: '❌ Video Upload Failed. Could not upload video. Try again in 30 seconds.',
        VIDEO_TOO_LARGE: '🎬 Video Too Large. The generated video was too big. Try a simpler prompt.',
        AUDIO_UPLOAD_EMPTY: '❌ Audio Upload Failed. Host returned empty response. Try again.',
        AUDIO_UPLOAD_BAD_GATEWAY: '🔧 Audio Upload Error. Audio host is having issues. Try again in 30 seconds.',
        AUDIO_UPLOAD_SERVICE_UNAVAILABLE: '🔧 Audio Upload Error. Audio host is overloaded. Try again in 30 seconds.',
        AUDIO_UPLOAD_TIMEOUT: '⏱️ Audio Upload Timeout. Audio host took too long. Try again.',
        AUDIO_UPLOAD_FAILED: '❌ Audio Upload Failed. Could not upload audio. Try again in 30 seconds.',
        FETCH_TIMEOUT: '⏱️ Connection Timeout. The server took too long to respond. Try again.',
        FETCH_REFUSED: '🌐 Connection Refused. Could not reach the server. Try again.',
        FETCH_NOT_FOUND: '🌐 Server Not Found. Could not reach the server. Try again.',
        FETCH_RESET: '🌐 Connection Reset. The server dropped the connection. Try again.',
        FETCH_NETWORK_ERROR: '🌐 Network Error. Connection failed. Try again.',
        REQUEST_TIMEOUT: '⏱️ Timeout Error. The request took too long. Try again.',
        REQUEST_ABORTED: '⏱️ Request Aborted. The request was cancelled. Try again.',
        IMAGE_UPLOAD_EMPTY: '❌ Upload Failed. Image host returned empty response. Try again.',
        IMAGE_UPLOAD_BAD_GATEWAY: '🔧 Upload Error. Image host is having issues. Try again in 30 seconds.',
        IMAGE_UPLOAD_SERVICE_UNAVAILABLE: '🔧 Upload Error. Image host is overloaded. Try again in 30 seconds.',
        IMAGE_UPLOAD_TIMEOUT: '⏱️ Upload Timeout. Image host took too long. Try again.',
        IMAGE_UPLOAD_FAILED: '❌ Upload Failed. Could not upload image. Try again in 30 seconds.',
        IMAGE_TOO_LARGE: '🖼️ Image Too Large. Try a smaller image.',
        IMAGE_LOAD_ERROR: '🖼️ Image Error. Could not load that image. Try a different URL.',
        CONTENT_BLOCKED: '🚫 Content Blocked. The request was deemed inappropriate. Try being more specific or use different words.',
        SAFETY_FILTER: '⚠️ Safety Filter Triggered. Flagged as {categories}. Try rephrasing your message.',
        HTTP_429: '⏰ Quota Exceeded. API rate limit reached. Try again in 30 seconds.',
        HTTP_401: '🔐 Authentication Error. Ask the bot owner to fix this.',
        HTTP_403: '🚫 Access Denied. Ask the bot owner to fix this.',
        YOUTUBE_RESTRICTED: '🚫 Access Denied. The video is likely copyrighted or geo-restricted.',
        BOT_NOT_MODERATOR: 'I need moderator status in this channel to do that! Please /mod the bot in chat.',
        BROADCASTER_AUTH_REQUIRED: 'I need broadcaster authorization to update the stream in this channel.',
        BOT_SCOPE_MISSING: '🔐 Missing Permission. The Twitch account was connected without required permissions. Reconnect it to fix this.',
        POLL_UNAVAILABLE: '📊 Polls are not available for this Twitch channel.',
        PREDICTION_UNAVAILABLE: '🎯 Channel Points predictions are not available for this Twitch channel.',
        HELIX_ACTION_TIMEOUT: '⏱️ Twitch took too long to respond. Try again in a moment.',
        HELIX_ACTION_FAILED: '🔧 Twitch action failed. Try again in a moment.',
        HTTP_400: '❌ Bad Request. Ask the bot owner to fix this.',
        HTTP_404: '🔍 Not Found. Ask the bot owner to fix this.',
        HTTP_500: "🔧 Server Error. Google's servers are having issues. Try again in 30 seconds.",
        HTTP_521: '🔧 Server Down. Origin server is offline. Try again later.',
        HTTP_504: '⏱️ Gateway Timeout. Server took too long. Try again.',
        HTTP_UNKNOWN: '❌ HTTP Error {statusCode}: {message}.',
        RENDER_NETWORK_ERROR: '🌐 Network Error. Could not reach external services. Try again.',
        JSON_PARSE_ERROR: '📄 Parse Error. Ask the bot owner to fix this.',
        UNKNOWN_ERROR: '❌ Unknown Error. Ask the bot owner to fix this.'
    })
});

export function createFactoryDefaults(env = {}) {
    const csvList = (v) => String(v || '').split(',').map((s) => s.trim().replace(/^#/, '').toLowerCase()).filter(Boolean);
    const boolVal = (v, fallback) => (v === undefined || v === null || v === '' ? fallback : String(v) === 'true');
    const clipCooldown = Number(env.STREAM_ACTIONS_CLIP_COOLDOWN_SECONDS);
    const seededClipCooldown = env.STREAM_ACTIONS_CLIP_COOLDOWN_SECONDS !== undefined
        && env.STREAM_ACTIONS_CLIP_COOLDOWN_SECONDS !== ''
        && Number.isFinite(clipCooldown)
        && clipCooldown >= 0
        && clipCooldown <= 300
        ? clipCooldown
        : FACTORY.stream_actions.clip_cooldown_seconds;

    // Dashboard URL is the composition root's job; FACTORY keeps the
    // placeholder and env seeds the live default (Render auto-sets
    // RENDER_EXTERNAL_URL, local fallback stays localhost).
    const dashboardUrl = String(env.RENDER_EXTERNAL_URL || 'http://localhost:3000').replace(/\/+$/, '') + '/';
    const commands = dashboardUrl === 'http://localhost:3000/'
        ? FACTORY.commands
        : Object.freeze({
            media: FACTORY.commands.media,
            custom: Object.freeze([
                Object.freeze({
                    command: '!dashboard',
                    aliases: Object.freeze(['!gallery', '!logs']),
                    response: dashboardUrl,
                    role: 'all'
                })
            ])
        });

    const envIgnored = csvList(env.IGNORED_USERNAMES);

    return Object.freeze({
        bot_settings: Object.freeze({
            channels: Object.freeze(csvList(env.JOIN_CHANNELS)),
            model_name: normalizeChatModel(env.MODEL_NAME),
            thinking_level: env.THINKING_LEVEL || FACTORY.bot_settings.thinking_level,
            search_grounding: env.SEARCH_GROUNDING || FACTORY.bot_settings.search_grounding,
            tavily_search_depth: env.TAVILY_SEARCH_DEPTH || FACTORY.bot_settings.tavily_search_depth,
            cooldown_duration: env.COOLDOWN_DURATION !== undefined && env.COOLDOWN_DURATION !== '' ? Number(env.COOLDOWN_DURATION) : FACTORY.bot_settings.cooldown_duration,
            ignored_usernames: Object.freeze(envIgnored.length ? envIgnored : [...FACTORY.bot_settings.ignored_usernames]),
            ai_history_length: Number(env.AI_HISTORY_LENGTH) || FACTORY.bot_settings.ai_history_length,
            chat_context_length: Number(env.CHAT_CONTEXT_LENGTH) || FACTORY.bot_settings.chat_context_length,
            reply_mode: FACTORY.bot_settings.reply_mode,
            ignore_emote_only_prompts: FACTORY.bot_settings.ignore_emote_only_prompts,
            enable_emote_appending: boolVal(env.ENABLE_EMOTE_APPENDING, FACTORY.bot_settings.enable_emote_appending),
            bot_command_name: env.BOT_COMMAND_NAME || FACTORY.bot_settings.bot_command_name,
            highlight_bot_responses: boolVal(env.HIGHLIGHT_BOT_RESPONSES, FACTORY.bot_settings.highlight_bot_responses)
        }),
        stream_actions: Object.freeze({
            ...FACTORY.stream_actions,
            enabled: boolVal(env.ENABLE_STREAM_ACTIONS, FACTORY.stream_actions.enabled),
            clip_cooldown_seconds: seededClipCooldown
        }),
        system_instructions: FACTORY.system_instructions,
        commands,
        event_alerts: FACTORY.event_alerts,
        error_messages: FACTORY.error_messages
    });
}

const REDIS_KEY = (type) => `config:${type}`;
const ROLES = new Set(['all', 'moderator', 'broadcaster']);
const ACCESS_LEVELS = new Set(['everyone', 'subs', 'vipmod', 'mod']);
const EVENT_KINDS = Object.keys(FACTORY.event_alerts);
const MEDIA_COMMAND_KEYS = ['image', 'video', 'tts', 'music'];

function exactTrigger(value) {
    return String(value ?? '').trim().toLowerCase().slice(0, 32);
}

/**
 * Collects every chat trigger owned by the commands config (media command
 * names/aliases + custom static commands) using exact sigil preservation.
 */
export function collectExactTriggers(commands) {
    const triggers = [];
    if (!commands || typeof commands !== 'object') return triggers;
    for (const key of MEDIA_COMMAND_KEYS) {
        const cfg = commands.media?.[key];
        if (!cfg || typeof cfg !== 'object') continue;
        const sources = [cfg.command, ...(Array.isArray(cfg.aliases) ? cfg.aliases : String(cfg.aliases ?? '').split(','))];
        for (const source of sources) {
            const t = exactTrigger(source);
            if (t) triggers.push(t);
        }
    }
    const custom = Array.isArray(commands.custom) ? commands.custom : [];
    for (const row of custom) {
        if (!row || typeof row !== 'object') continue;
        const sources = [row.command, ...(Array.isArray(row.aliases) ? row.aliases : String(row.aliases ?? '').split(','))];
        for (const source of sources) {
            const t = exactTrigger(source);
            if (t) triggers.push(t);
        }
    }
    return triggers;
}

// Legacy alias — keep test & external imports working; exact semantics.
export const collectCommandTriggers = collectExactTriggers;

function invalid(message) {
    const err = new Error(message);
    err.code = 'INVALID_CONFIG';
    return err;
}

function sanitizeCustomCommandList(raw, fieldName = 'custom_commands') {
    if (!Array.isArray(raw)) throw invalid(`${fieldName} must be an array`);
    const seen = new Set();
    return raw.map((row, i) => {
        const command = exactTrigger(row?.command);
        if (!command) throw invalid(`${fieldName}[${i}].command is required`);
        if (seen.has(command)) throw invalid(`duplicate command ${command}`);
        seen.add(command);

        const aliases = [];
        const rawAliases = Array.isArray(row?.aliases)
            ? row.aliases
            : String(row?.aliases || '').split(',');
        for (const a of rawAliases) {
            const alias = exactTrigger(a);
            if (!alias) continue;
            if (seen.has(alias)) throw invalid(`duplicate command or alias ${alias}`);
            seen.add(alias);
            aliases.push(alias);
        }

        const response = String(row?.response || '').trim();
        if (!response) throw invalid(`${fieldName}[${i}].response is required`);
        if (response.length > 499) throw invalid(`${fieldName}[${i}].response exceeds 499 characters`);
        const role = ROLES.has(row?.role) ? row.role : 'all';
        return { command, aliases, response, role };
    });
}

function sanitizeEventKind(kind, factoryKind, rawKind) {
    if (!rawKind || typeof rawKind !== 'object' || Array.isArray(rawKind)) {
        throw invalid(`event_alerts.${kind} must be an object`);
    }
    const out = { ...factoryKind };

    if ('enabled' in rawKind) out.enabled = Boolean(rawKind.enabled);
    if ('ai_enabled' in rawKind) out.ai_enabled = Boolean(rawKind.ai_enabled);

    if ('cooldown_seconds' in rawKind) {
        const cd = Number(rawKind.cooldown_seconds);
        if (!Number.isFinite(cd) || cd < 0) {
            throw invalid(`event_alerts.${kind}.cooldown_seconds must be a non-negative number`);
        }
        out.cooldown_seconds = cd;
    }

    if ('fallback_template' in rawKind && rawKind.fallback_template != null) {
        const ft = String(rawKind.fallback_template);
        if (ft.length > 499) throw invalid(`event_alerts.${kind}.fallback_template exceeds 499 characters`);
        out.fallback_template = ft;
    }

    if ('ai_prompt' in rawKind && rawKind.ai_prompt != null) {
        const ap = String(rawKind.ai_prompt);
        if (ap.length > 1000) throw invalid(`event_alerts.${kind}.ai_prompt exceeds 1000 characters`);
        out.ai_prompt = ap;
    }

    if ('min_bits' in factoryKind && 'min_bits' in rawKind) {
        const mb = Number(rawKind.min_bits);
        if (!Number.isFinite(mb) || mb < 0) {
            throw invalid(`event_alerts.${kind}.min_bits must be a non-negative number`);
        }
        out.min_bits = mb;
    }

    if ('min_viewers' in factoryKind && 'min_viewers' in rawKind) {
        const mv = Number(rawKind.min_viewers);
        if (!Number.isFinite(mv) || mv < 0) {
            throw invalid(`event_alerts.${kind}.min_viewers must be a non-negative number`);
        }
        out.min_viewers = mv;
    }

    if (kind === 'channel_points' && 'rewards' in rawKind) {
        if (rawKind.rewards && typeof rawKind.rewards === 'object' && !Array.isArray(rawKind.rewards)) {
            const rewardsOut = {};
            for (const [rewardTitle, rewardCfg] of Object.entries(rawKind.rewards)) {
                if (!rewardCfg || typeof rewardCfg !== 'object') continue;
                const cleanTitle = String(rewardTitle).trim();
                if (!cleanTitle) continue;
                const rOut = {};
                rOut.ai_enabled = rewardCfg.ai_enabled !== undefined ? Boolean(rewardCfg.ai_enabled) : true;
                if (rewardCfg.fallback_template != null) {
                    const rft = String(rewardCfg.fallback_template);
                    if (rft.length > 499) throw invalid(`rewards[${cleanTitle}].fallback_template exceeds 499 characters`);
                    rOut.fallback_template = rft;
                }
                if (rewardCfg.ai_prompt != null) {
                    const rap = String(rewardCfg.ai_prompt);
                    if (rap.length > 1000) throw invalid(`rewards[${cleanTitle}].ai_prompt exceeds 1000 characters`);
                    rOut.ai_prompt = rap;
                }
                rewardsOut[cleanTitle] = rOut;
            }
            out.rewards = rewardsOut;
        }
    }

    return out;
}

export function sanitizeConfig(type, raw, context = {}) {
    switch (type) {
        case 'bot_settings': {
            if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
                throw invalid('bot_settings must be an object');
            }
            const out = { ...FACTORY.bot_settings };

            if ('channels' in raw) {
                if (!Array.isArray(raw.channels)) throw invalid('bot_settings.channels must be an array');
                out.channels = raw.channels
                    .map((c) => String(c || '').trim().replace(/^#/, '').toLowerCase())
                    .filter(Boolean);
            }
            if ('model_name' in raw) out.model_name = normalizeChatModel(raw.model_name);
            if ('thinking_level' in raw && raw.thinking_level) out.thinking_level = String(raw.thinking_level).trim();
            if ('search_grounding' in raw) out.search_grounding = String(raw.search_grounding || '').trim();
            if ('tavily_search_depth' in raw) out.tavily_search_depth = String(raw.tavily_search_depth || 'basic').trim();
            if ('cooldown_duration' in raw) {
                const cd = Number(raw.cooldown_duration);
                if (Number.isFinite(cd) && cd >= 0) out.cooldown_duration = cd;
            }
            if ('ignored_usernames' in raw) {
                if (Array.isArray(raw.ignored_usernames)) {
                    out.ignored_usernames = raw.ignored_usernames.map((u) => String(u || '').trim().toLowerCase()).filter(Boolean);
                }
            }
            if ('ai_history_length' in raw) {
                const l = Number(raw.ai_history_length);
                if (Number.isFinite(l) && l >= 0) out.ai_history_length = l;
            }
            if ('chat_context_length' in raw) {
                const l = Number(raw.chat_context_length);
                if (Number.isFinite(l) && l >= 0) out.chat_context_length = l;
            }
            if ('reply_mode' in raw && ['off', 'tag', 'reply'].includes(raw.reply_mode)) {
                out.reply_mode = raw.reply_mode;
            }
            if ('ignore_emote_only_prompts' in raw) {
                out.ignore_emote_only_prompts = Boolean(raw.ignore_emote_only_prompts);
            }
            if ('enable_emote_appending' in raw) out.enable_emote_appending = Boolean(raw.enable_emote_appending);
            if ('bot_command_name' in raw && raw.bot_command_name) out.bot_command_name = String(raw.bot_command_name).trim();
            if ('highlight_bot_responses' in raw) out.highlight_bot_responses = Boolean(raw.highlight_bot_responses);

            if (Array.isArray(context.commandTriggers) && context.commandTriggers.length > 0) {
                const owned = new Set(context.commandTriggers.map(exactTrigger).filter(Boolean));
                for (const rawPrefix of String(out.bot_command_name ?? '').split(',')) {
                    const p = exactTrigger(rawPrefix);
                    if (p && owned.has(p)) {
                        throw invalid(`${p} is already in use.`);
                    }
                }
            }

            return out;
        }
        case 'stream_actions': {
            if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
                throw invalid('stream_actions must be an object');
            }
            const out = { ...FACTORY.stream_actions };
            for (const key of [
                'enabled',
                'stream_setup_enabled',
                'moderation_enabled',
                'chat_access_enabled',
                'community_enabled',
                'polls_predictions_enabled',
                'viewer_clips_enabled'
            ]) {
                if (key in raw) out[key] = Boolean(raw[key]);
            }
            if ('clip_cooldown_seconds' in raw) {
                const cooldown = Number(raw.clip_cooldown_seconds);
                if (!Number.isFinite(cooldown) || cooldown < 0 || cooldown > 300) {
                    throw invalid('stream_actions.clip_cooldown_seconds must be between 0 and 300');
                }
                out.clip_cooldown_seconds = cooldown;
            }
            return out;
        }
        case 'system_instructions': {
            if (typeof raw !== 'string') throw invalid('system_instructions must be a string');
            if (raw.length > 16_000) throw invalid('system_instructions exceeds 16000 characters');
            return raw;
        }
        case 'commands': {
            if (!raw || typeof raw !== 'object') throw invalid('commands must be an object');
            const out = structuredClone(FACTORY.commands);
            if (raw.media && typeof raw.media === 'object') {
                const m = raw.media;
                for (const key of MEDIA_COMMAND_KEYS) {
                    if (m[key] && typeof m[key] === 'object') {
                        const source = m[key];
                        const factory = FACTORY.commands.media[key];
                        const provider = source.provider === undefined ? factory.provider : source.provider;
                        const model = source.model === undefined ? factory.model : source.model;
                        if (!['pollinations', 'google'].includes(provider)) {
                            throw invalid(`commands.media.${key}.provider must be pollinations or google`);
                        }
                        if (typeof model !== 'string' || !model.trim()) {
                            throw invalid(`commands.media.${key}.model must be a non-empty string`);
                        }
                        out.media[key] = {
                            enabled: 'enabled' in source ? Boolean(source.enabled) : factory.enabled,
                            command: exactTrigger(source.command ?? factory.command) || factory.command,
                            aliases: [],
                            provider,
                            model: model.trim(),
                            access: ACCESS_LEVELS.has(source.access) ? source.access : factory.access
                        };
                        const aliasSource = Array.isArray(m[key].aliases)
                            ? m[key].aliases
                            : String(m[key].aliases ?? '').split(',');
                        const seenTriggers = new Set([out.media[key].command]);
                        const aliases = [];
                        for (const src of aliasSource) {
                            const a = exactTrigger(src);
                            if (!a) continue;
                            if (seenTriggers.has(a)) throw invalid(`${a} is already in use.`);
                            seenTriggers.add(a);
                            aliases.push(a);
                        }
                        out.media[key].aliases = aliases;
                        if ('voice' in source) {
                            if (typeof source.voice !== 'string' || !source.voice.trim()) {
                                throw invalid(`commands.media.${key}.voice must be a non-empty string`);
                            }
                            out.media[key].voice = source.voice.trim();
                        }
                        if ('duration' in source) {
                            const duration = Number(source.duration);
                            if (!Number.isFinite(duration) || duration <= 0) {
                                throw invalid(`commands.media.${key}.duration must be greater than zero`);
                            }
                            out.media[key].duration = duration;
                        }
                    }
                }
                if ('access' in m && ACCESS_LEVELS.has(m.access)) out.media.access = m.access;
            }
            if (raw.custom) {
                out.custom = sanitizeCustomCommandList(raw.custom, 'commands.custom');
            }

            // Loud trigger-collision rejection: every chat trigger must be unique
            // across media cards, custom commands, and the AI prefix, so saves fail
            // visibly instead of silently shadowing by routing order.
            const ownerByTrigger = new Map();
            const claimTrigger = (trigger, owner) => {
                const existing = ownerByTrigger.get(trigger);
                if (existing) throw invalid(`${trigger} is already in use.`);
                ownerByTrigger.set(trigger, owner);
            };
            for (const key of MEDIA_COMMAND_KEYS) {
                claimTrigger(out.media[key].command, `the ${key} command`);
                for (const alias of out.media[key].aliases) claimTrigger(alias, `the ${key} command`);
            }
            for (const row of out.custom) {
                claimTrigger(row.command, `custom command ${row.command}`);
                for (const alias of row.aliases) claimTrigger(alias, `custom command ${row.command}`);
            }
            for (const prefix of context.aiPrefixes || []) {
                const p = exactTrigger(prefix);
                if (p && ownerByTrigger.has(p)) {
                    throw invalid(`${p} is already in use.`);
                }
            }
            return out;
        }
        case 'event_alerts': {
            if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
                throw invalid('event_alerts must be an object');
            }
            const out = structuredClone(FACTORY.event_alerts);
            for (const kind of EVENT_KINDS) {
                if (raw[kind] == null) continue;
                out[kind] = sanitizeEventKind(kind, out[kind], raw[kind]);
            }
            return out;
        }
        case 'error_messages': {
            if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
                throw invalid('error_messages must be an object');
            }
            const out = { ...FACTORY.error_messages };
            for (const key of Object.keys(out)) {
                if (raw[key] == null) continue;
                const text = String(raw[key]);
                if (text.length > 499) throw invalid(`${key} exceeds 499 characters`);
                out[key] = text;
            }
            return out;
        }
        default:
            throw invalid(`unknown type ${type}`);
    }
}

export class ConfigStore {
    constructor({ storage, defaults = null } = {}) {
        this.storage = storage || null;
        this.defaults = defaults || FACTORY;
        this.cache = new Map();
        this.hydration = null;
    }

    async get(type) {
        await this.#ensureHydrated();
        return this.#publicEntry(this.cache.get(type));
    }

    async getAll() {
        await this.#ensureHydrated();
        const overrides = {};
        const out = {};
        for (const type of CONFIG_TYPES) {
            const { value, override } = this.#publicEntry(this.cache.get(type));
            out[type] = value;
            overrides[type] = override;
        }
        return { ...out, overrides };
    }

    /**
     * Whether a stored override document for a config type actually defines a
     * given top-level key. False for factory fallbacks and unparsable docs.
     * Lets boot code tell "saved as empty" apart from "field predates schema",
     * e.g. so env seeds migrate in exactly once for modal-owned lists.
     */
    async storedDocHas(type, key) {
        await this.#ensureHydrated();
        const document = this.cache.get(type)?.document;
        return Boolean(document && typeof document === 'object' && key in document);
    }

    async set(type, raw, context = {}) {
        await this.#ensureHydrated();
        const value = sanitizeConfig(type, raw, context);
        const stored = type === 'system_instructions' ? value : JSON.stringify(value);
        this.cache.set(type, {
            value,
            override: true,
            document: type === 'system_instructions' ? null : value
        });
        this.#backgroundPersist(`write ${type}`, this.#write(REDIS_KEY(type), stored));
        return { value: structuredClone(value), override: true };
    }

    async reset(type, context = {}) {
        await this.#ensureHydrated();
        // Validate the factory-restored value BEFORE deleting so a colliding
        // reset can't destroy the stored override.
        const value = sanitizeConfig(type, structuredClone(this.defaults[type]), context);
        this.cache.set(type, { value, override: false, document: null });
        this.#backgroundPersist(`reset ${type}`, this.#del(REDIS_KEY(type)));
        return { value: structuredClone(value), override: false };
    }

    async #ensureHydrated() {
        if (this.cache.size === CONFIG_TYPES.length) return;
        this.hydration ??= this.#hydrate();
        await this.hydration;
    }

    async #hydrate() {
        const keys = CONFIG_TYPES.map(REDIS_KEY);
        let values;
        try {
            if (this.storage?.getValues) {
                values = await this.storage.getValues(keys);
            } else {
                values = await Promise.all(keys.map((key) => this.storage?.getValue?.(key) ?? null));
            }
        } catch {
            values = keys.map(() => null);
        }
        for (let index = 0; index < CONFIG_TYPES.length; index++) {
            const type = CONFIG_TYPES[index];
            this.cache.set(type, this.#parseEntry(type, values?.[index]));
        }
    }

    #parseEntry(type, raw) {
        const fallback = structuredClone(this.defaults[type]);
        if (raw == null || raw === '') return { value: fallback, override: false, document: null };
        try {
            const parsed = type === 'system_instructions' ? String(raw) : JSON.parse(raw);
            return {
                value: sanitizeConfig(type, parsed),
                override: true,
                document: type === 'system_instructions' ? null : parsed
            };
        } catch {
            return { value: fallback, override: false, document: null };
        }
    }

    #publicEntry(entry) {
        return { value: structuredClone(entry.value), override: entry.override };
    }

    #backgroundPersist(label, pending) {
        Promise.resolve(pending)
            .then((success) => {
                if (success === false) console.error(`[Config] Failed to ${label}: storage unavailable`);
            })
            .catch((error) => {
                console.error(`[Config] Failed to ${label}:`, error?.message || error);
            });
    }

    async #write(key, value) {
        if (!this.storage?.setValue) return;
        return await this.storage.setValue(key, value);
    }

    async #del(key) {
        if (!this.storage?.deleteValue) return;
        return await this.storage.deleteValue(key);
    }
}

export function commandsToMap(list) {
    const map = new Map();
    for (const row of list || []) {
        if (!row || typeof row !== 'object') continue;
        const spec = { response: row.response, role: row.role };
        if (row.command) {
            const cmd = exactTrigger(row.command);
            if (cmd) map.set(cmd, spec);
        }
        if (row.aliases) {
            const aliasList = Array.isArray(row.aliases)
                ? row.aliases
                : String(row.aliases).split(',');
            for (const a of aliasList) {
                const clean = exactTrigger(a);
                if (!clean) continue;
                map.set(clean, spec);
            }
        }
    }
    return map;
}
