// twitch-gemini-ai-chatbot/src/twitch/chat_router.js
// Coordinates Twitch chat routing: command RBAC, media/AI dispatch,
// per-channel cooldowns, and chatter-safe error translation.
import { FACTORY, commandsToMap } from '../utils/bot_config.js';
import { NOOP_EXECUTION_TRACE } from '../utils/execution_trace.js';
import { EVENT_REACTION_HARNESS } from './event_reaction.js';
async function generateGroqResponse(prompt, systemInstructions = '') {
    const apiKey = process.env.GROQ_API_KEY;

    if (!apiKey) {
        throw new Error('GROQ_API_KEY is missing');
    }

    const systemPrompt = [
        systemInstructions,
        `أنت ruum_ai، بوت تويتش سعودي بشخصية مرحة وواثقة ومزوحه.

تحدث باللهجة السعودية النجدية، وبالأخص لهجة الرياض، واستخدم تعابير سعودية طبيعية.

شخصيتك:
- خفيف دم، تحب الطقطقة والمزح والردود الباردة المضحكة.
- عندك ثقة بنفسك وترد بطريقة ذكية ومضحكة.
- تقدر تطقطق على المشاهدين بشكل ودي إذا كان السياق يسمح، بدون تجريح حقيقي.
- لا تتكلم بأسلوب رسمي أو كأنك موظف خدمة عملاء.
- لا تستخدم الفصحى إلا إذا احتاج الموضوع ذلك.
- لا تكثر الإيموجيات ولا تكرر نفس النكتة باستمرار.

طريقة الرد:
- خل ردودك قصيرة وطبيعية، غالباً جملة أو جملتين.
- لا ترد على كل رسالة في الشات؛ رد عندما يكون فيه سؤال أو كلام يستحق الرد.
- إذا أحد ناداك أو سألك مباشرة، حاول تجاوبه.
- إذا السؤال جدي، أعط إجابة مفيدة وصحيحة مع المحافظة على شخصيتك.
- إذا ما تعرف الإجابة، قل ذلك بصراحة ولا تخترع معلومات.
- لا تشرح أنك ذكاء اصطناعي إلا إذا انطلب منك.
- لا تكرر كلام المستخدم بدون فائدة.
- لا تستخدم عبارات افتتاحية رسمية مثل: "بالطبع، يسعدني مساعدتك".
- اجعل ردودك مناسبة لشات تويتش، مختصرة وعفوية.

أنت ruum_ai، مو مساعد رسمي. خل كلامك طبيعي كأنك واحد من الشباب في البث.`
    ].filter(Boolean).join('\n\n');

    const response = await fetch(
        'https://api.groq.com/openai/v1/chat/completions',
        {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${apiKey}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                model: 'openai/gpt-oss-120b',
                messages: [
                    {
                        role: 'system',
                        content: systemPrompt
                    },
                    {
                        role: 'user',
                        content: prompt
                    }
                ],
                max_tokens: 120,
                temperature: 0.85
            }),
            signal: AbortSignal.timeout(15000)
        }
    );

    if (!response.ok) {
        const details = await response.text();
        console.error('[Groq] API error:', response.status, details);
        throw new Error(`Groq API request failed: ${response.status}`);
    }

    const data = await response.json();

    return data.choices?.[0]?.message?.content?.trim()
        || 'ياخي مخي علّق شوي، جرّب مرة ثانية 😂';
}
وعدّل استدعاء الدالة داخل شرط `!ai` إلى:
if (aiCommand === '!ai') {
    rawResponse = await generateGroqResponse(
        prompt,
        this.systemInstructions
    );
} else {
    rawResponse = await this.aiEngine.generate(prompt, {
        channel,
        channelContext,
        recentLogs,
        harnessInstructions: this.mediaPipeline.getHarnessInstructions?.(this.prefixLists),
        overrideFileContext: this.systemInstructions,
        caller: {
            loginName: message.loginName,
            isBroadcaster: !!message.isBroadcaster,
            isMod: !!message.isMod
        },
        trace
    });
}
const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
    },
    body: JSON.stringify({
        model: 'openai/gpt-oss-120b',
        messages: [
{
    role: 'system',
    content: systemPrompt
}

},
        max_tokens: 120,
        temperature: 0.7
    }),
    signal: AbortSignal.timeout(15000)
});

if (!response.ok) {
    const details = await response.text();
    console.error('[Groq] API error:', response.status, details);
    throw new Error(`Groq API request failed: ${response.status}`);
}
}

const DEFAULT_PREFIXES = {
    ai: ['!gemini', '!ai', '@yourbotusername'],
    image: ['!image'],
    video: ['!video'],
    tts: ['!tts'],
    music: ['!song']
};

const cleanName = (value) => String(value || '').replace('#', '').trim().toLowerCase();
const channelKey = (channel) => `#${cleanName(channel)}`;

function frameConversationalMessage(message, text) {
    const role = message.isBroadcaster ? 'broadcaster' : message.isMod ? 'moderator' : 'viewer';
    return `Message from (role:${role}) ${message.loginName}: ${text}`;
}

const DEFAULT_EVENT_ALERTS = FACTORY.event_alerts;

function interpolate(template, vars) {
    return String(template ?? '').replace(/\{(\w+)\}/g, (_, key) => {
        const value = vars[key];
        return value == null ? '' : String(value);
    });
}

function eventVars(event) {
    const d = event.details || {};
    const user = event.user || {};
    const recipient = d.recipient || {};
    const reward = d.reward || {};
    return {
        username: user.displayName || user.login || 'someone',
        tier: d.tier || '',
        months: d.months ?? '',
        streak: d.streak ?? '',
        message: d.message ?? '',
        bits: d.bits ?? '',
        count: d.count ?? '',
        recipient: recipient.displayName || recipient.login || 'a community member',
        reward: reward.title || '',
        user_input: reward.userInput || '',
        viewers: d.viewers ?? ''
    };
}

function findRewardConfig(policy, title) {
    const rewards = policy?.rewards || {};
    if (rewards[title]) return rewards[title];
    const lower = String(title || '').toLowerCase();
    for (const [key, value] of Object.entries(rewards)) {
        if (key.toLowerCase() === lower) return value;
    }
    return null;
}

function asPrefixList(value, fallback) {
    if (value == null || value === '') return [...fallback];
    const items = Array.isArray(value) ? value : String(value).split(',');
    return items.map((item) => String(item).trim().toLowerCase()).filter(Boolean);
}

class CooldownTracker {
    constructor({ duration, clock }) {
        this.duration = typeof duration === 'number' ? duration : 1;
        this.clock = clock;
        this.lastByChannel = new Map();
    }

    checkAndConsume(channel) {
        if (this.duration <= 0) return { onCooldown: false };

        const now = this.clock();
        const last = this.lastByChannel.get(channel) ?? 0;
        const elapsed = (now - last) / 1000;
        if (elapsed < this.duration) {
            return { onCooldown: true, remaining: (this.duration - elapsed).toFixed(1) };
        }

        this.lastByChannel.set(channel, now);
        return { onCooldown: false };
    }
}

class EventAlertRegistry {
    constructor({ eventAlerts } = {}) {
        this.config = eventAlerts && typeof eventAlerts === 'object' ? eventAlerts : DEFAULT_EVENT_ALERTS;
    }

    getPolicy(kind) {
        return this.config?.[kind] || null;
    }

    reload(source) {
        if (source && typeof source === 'object') {
            this.config = source;
        }
    }
}

class EventCooldownTracker {
    constructor({ clock = Date.now }) {
        this.clock = clock;
        this.lastByKey = new Map();
    }

    checkAndConsume(channel, kind, duration) {
        if (duration <= 0) return { onCooldown: false };

        const key = `${channelKey(channel)}:${kind}`;
        const now = this.clock();
        const last = this.lastByKey.get(key);
        if (last !== undefined) {
            const elapsed = (now - last) / 1000;
            if (elapsed < duration) {
                return { onCooldown: true, remaining: (duration - elapsed).toFixed(1) };
            }
        }

        this.lastByKey.set(key, now);
        return { onCooldown: false };
    }
}

class CustomCommandRegistry {
    constructor({ customCommands } = {}) {
        this.commands = new Map();
        this.reload(customCommands);
    }

    reload(source) {
        if (Array.isArray(source)) {
            this.commands = commandsToMap(source);
            return;
        }

        if (source instanceof Map) {
            this.commands = source;
            return;
        }
    }

    match(text) {
        const messageLower = String(text ?? '').trim().toLowerCase();
        for (const [cmd, spec] of this.commands) {
            if (messageLower === cmd || messageLower.startsWith(`${cmd} `)) {
                return { cmd, ...spec };
            }
        }
        return null;
    }
}

class CommandMatcher {
    constructor(aiList, mediaEntries) {
        this.ai = aiList;
        this.media = mediaEntries;
    }

    matchAi(lowerText) {
        return this.ai.find((cmd) => lowerText.startsWith(cmd)) || null;
    }

    matchMedia(lowerText) {
        return this.media.find(({ cmd }) => lowerText.startsWith(cmd)) || null;
    }

    mediaPrompt(text, command) {
        return text.slice(command.length).replace(/^,\s*/, '').trim();
    }
}

const MEDIA_TYPES = ['image', 'video', 'tts', 'music'];

function entriesFromPrefixLists(prefixLists) {
    const entries = [];
    for (const type of [...MEDIA_TYPES].reverse()) {
        for (const cmd of prefixLists[type] || []) {
            entries.push({ cmd, mediaType: type, enabled: true });
        }
    }
    return entries;
}

function normalizedCommandList(cfg) {
    if (!cfg || typeof cfg !== 'object') return [];
    const raw = [cfg.command, ...(Array.isArray(cfg.aliases) ? cfg.aliases : String(cfg.aliases || '').split(','))];
    return raw.map((item) => String(item || '').trim().toLowerCase()).filter(Boolean);
}

function mediaAccessAllowed(message, access) {
    if (!access || access === 'everyone') return true;
    const badges = message?.tags?.badges || {};
    const isBroadcaster = !!badges.broadcaster || !!message?.isBroadcaster;
    const isMod = badges.moderator != null || !!message?.isMod;
    const isVip = badges.vip != null;
    const isSub = badges.subscriber != null || badges.sub != null;
    switch (access) {
        case 'mod': return isBroadcaster || isMod;
        case 'vipmod': return isBroadcaster || isMod || isVip;
        case 'subs': return isBroadcaster || isMod || isVip || isSub;
        default: return true;
    }
}

function userHasRole({ isBroadcaster, isMod } = {}, requiredRole) {
    if (!requiredRole || requiredRole === 'all') return true;
    if (requiredRole === 'broadcaster') return !!isBroadcaster;
    return !!isBroadcaster || !!isMod;
}

const REPLY_MODES = new Set(['off', 'tag', 'reply']);

function normalizeReplyMode(value) {
    return REPLY_MODES.has(value) ? value : 'off';
}

function deliveryActor(trigger = {}) {
    trigger = trigger || {};
    const username = String(trigger.username || trigger.displayName || '').replace(/^@/, '').trim();
    const loginName = cleanName(trigger.loginName || trigger.login || '');
    return {
        username: username || loginName,
        loginName,
        targets: new Set([username, loginName].map(cleanName).filter(Boolean))
    };
}

function stripLeadingTargetTag(text, actor) {
    const value = String(text ?? '').trim();
    const match = value.match(/^@([a-z0-9_]+)[,:;]?(?=\s|$)/i);
    if (!match || !actor.targets.has(cleanName(match[1]))) return value;
    return value.slice(match[0].length).trimStart();
}

function addLeadingTargetTag(text, actor) {
    const value = String(text ?? '').trim();
    if (!actor.username || stripLeadingTargetTag(value, actor) !== value) return value;
    return `@${actor.username} ${value}`.trim();
}

export class ChatRouter {
    #systemInstructions = '';

    /**
     * @param {object} options collaborator instances and policy. Never reads environment variables.
     */
    constructor({
        aiEngine,
        mediaPipeline,
        emotePool,
        errorHandler,
        customCommands,
        eventAlerts,
        systemInstructions,
        cooldownDuration = 1,
        chatContextLength = 20,
        maxMessageLength = 499,
        prefixes = {},
        mediaCommands = null,
        replyMode = 'off',
        ignoreEmoteOnlyPrompts = true,
        clock = Date.now,
        executionTrace = NOOP_EXECUTION_TRACE
    } = {}) {
        if (!aiEngine || !mediaPipeline || !emotePool) {
            throw new Error('ChatRouter requires aiEngine, mediaPipeline, and emotePool');
        }

        this.aiEngine = aiEngine;
        this.mediaPipeline = mediaPipeline;
        this.emotePool = emotePool;
        this.errorHandler = errorHandler;
        if (!errorHandler) {
            console.warn('[ChatRouter] No errorHandler provided; error immunity is degraded.');
        }

        this.clock = clock;
        this.chatContextLength = chatContextLength;
        this.maxMessageLength = maxMessageLength;
        this.replyMode = normalizeReplyMode(replyMode);
        this.ignoreEmoteOnlyPrompts = ignoreEmoteOnlyPrompts !== false;
        this.executionTrace = executionTrace || NOOP_EXECUTION_TRACE;
        this.transport = null;

        this.#systemInstructions = typeof systemInstructions === 'string' ? systemInstructions : FACTORY.system_instructions;

        this.prefixLists = {
            ai: asPrefixList(prefixes.ai, DEFAULT_PREFIXES.ai),
            image: asPrefixList(prefixes.image, DEFAULT_PREFIXES.image),
            video: asPrefixList(prefixes.video, DEFAULT_PREFIXES.video),
            tts: asPrefixList(prefixes.tts, DEFAULT_PREFIXES.tts),
            music: asPrefixList(prefixes.music, DEFAULT_PREFIXES.music)
        };

        this.cooldowns = new CooldownTracker({ duration: cooldownDuration, clock });
        this.customCommands = new CustomCommandRegistry({ customCommands });
        this.eventAlerts = new EventAlertRegistry({ eventAlerts });
        this.eventCooldowns = new EventCooldownTracker({ clock });

        // Media command settings from config:commands.media are the live source of
        // truth; the prefix lists above remain as boot fallback when no config exists.
        this.mediaCommands = mediaCommands && typeof mediaCommands === 'object'
            ? { ...structuredClone(FACTORY.commands.media), ...mediaCommands }
            : null;
        if (this.mediaCommands) {
            this.#rebuildMediaRouting();
        } else {
            this.matcher = new CommandMatcher(this.prefixLists.ai, entriesFromPrefixLists(this.prefixLists));
        }
    }

    /**
     * Live view of the response cooldown seconds. WebServer assigns this on
     * dashboard saves so config:bot_settings.cooldown_duration hot-applies.
     */
    get cooldownDuration() {
        return this.cooldowns.duration;
    }

    set cooldownDuration(seconds) {
        this.cooldowns.duration = typeof seconds === 'number' ? seconds : 1;
    }

    reloadReplyMode(value) {
        this.replyMode = normalizeReplyMode(value);
    }

    reloadIgnoreEmoteOnlyPrompts(value) {
        this.ignoreEmoteOnlyPrompts = value !== false;
    }

    #rebuildMediaRouting() {
        const entries = [];
        for (const type of MEDIA_TYPES) {
            const cfg = this.mediaCommands?.[type];
            const all = normalizedCommandList(cfg);
            const enabled = cfg && cfg.enabled === false ? [] : all;
            for (const cmd of all) {
                entries.push({ cmd, mediaType: type, enabled: enabled.includes(cmd) });
            }
            this.prefixLists[type] = enabled;
        }
        this.matcher = new CommandMatcher(this.prefixLists.ai, entries);
    }

    /**
     * Hot-reloads generative media command settings (names, aliases, enabled flags,
     * trigger, aliases, enabled state, and access from config:commands.media.
     * @param {object} media sanitized commands.media object
     */
    reloadMediaCommands(media) {
        if (!media || typeof media !== 'object') return;
        this.mediaCommands = { ...structuredClone(FACTORY.commands.media), ...media };
        this.#rebuildMediaRouting();
    }

    /**
     * Hot-reloads AI command prefixes from config:bot_settings.bot_command_name,
     * keeping media routing untouched.
     * @param {string} nameCsv comma-separated trigger list
     */
    reloadAiPrefixes(nameCsv) {
        const next = asPrefixList(nameCsv, []);
        if (next.length === 0) return;
        this.prefixLists.ai = next;
        this.matcher = new CommandMatcher(next, this.matcher.media);
    }

    /**
     * Classifies invocation intent once for both ambient projection and routing.
     * Native reply identity is a transport-normalized fact; only the direct
     * parent Twitch user ID participates in bot-target detection.
     */
    classify(message = {}, botUserId = this.transport?.botUserId) {
        const text = String(message.text ?? '');
        const lower = text.toLowerCase();

        if (message.isReply) {
            const parentUserId = String(message.replyParentUserId || '');
            if (!parentUserId || !botUserId || parentUserId !== String(botUserId)) {
                return { kind: 'none' };
            }
        }

        const custom = this.customCommands.match(text);
        if (custom) return { kind: 'custom', command: custom.cmd, custom };

        const media = this.matcher.matchMedia(lower);
        if (media) return { kind: 'media', command: media.cmd, mediaType: media.mediaType, media };

        const aiCommand = this.matcher.matchAi(lower);
        if (aiCommand || message.isReply) {
            return { kind: 'ai', command: aiCommand || null };
        }

        return { kind: 'none' };
    }

    /**
     * Binds inbound chat messages and EventSub events. Returns an unsubscribe function.
     * @param {object} transport TwitchTransport-like collaborator
     * @returns {() => void}
     */
    attach(transport) {
        if (!transport) {
            throw new Error('attach(transport) requires a transport instance');
        }
        this.transport = transport;
        transport.setMessageClassifier?.((message) => this.classify(message, transport.botUserId));
        let listening = true;

        const onMessage = (message) => {
            if (!listening) return undefined;
            return Promise.resolve(this.handle(message)).catch((error) => {
                console.error('[ChatRouter] Routing failed:', error);
                return { kind: 'error', channel: message?.channel, sent: false };
            });
        };

        const onEvent = (event) => {
            if (!listening) return undefined;
            return Promise.resolve(this.handleEvent(event)).catch((error) => {
                console.error('[ChatRouter] Event routing failed:', error);
                return { kind: 'error', channel: event?.channel, sent: false };
            });
        };

        const transportUnsub = transport.onMessage(onMessage);
        const eventUnsub = typeof transport.onEvent === 'function' ? transport.onEvent(onEvent) : null;

        return () => {
            listening = false;
            if (typeof transportUnsub === 'function') transportUnsub();
            if (typeof eventUnsub === 'function') eventUnsub();
        };
    }

    /**
     * Re-reads custom commands from configured source or supplied override.
     * @param {Array|Map} [source] Optional new Array or Map
     */
    reloadCustomCommands(source) {
        this.customCommands.reload(source);
    }

    /**
     * Re-reads event alerts from configured source or supplied override.
     * @param {object} [source] Optional new object
     */
    reloadEventAlerts(source) {
        this.eventAlerts.reload(source);
    }

    /**
     * Current system instructions persona.
     */
    get systemInstructions() {
        return this.#systemInstructions;
    }

    /**
     * Re-reads system instructions persona from supplied string.
     * @param {string} [source] Optional string override
     */
    reloadSystemInstructions(source) {
        if (typeof source === 'string') {
            this.#systemInstructions = source;
        }
    }

    async #deliverResponse(transport, {
        channel,
        text,
        trigger = {},
        decorateAi = false,
        trace = null
    }) {
        trigger = trigger || {};
        const actor = deliveryActor(trigger);
        const messageId = String(trigger.messageId || '');
        const effectiveMode = this.replyMode === 'reply' && !messageId
            ? (actor.username ? 'tag' : 'off')
            : this.replyMode;

        const prepare = (mode) => {
            let delivered = String(text ?? '').trim();
            if (mode === 'tag') delivered = addLeadingTargetTag(delivered, actor);
            if (mode === 'reply') delivered = stripLeadingTargetTag(delivered, actor);
            if (decorateAi) {
                delivered = this.emotePool.decorateReply(channel, delivered, {
                    maxLength: this.maxMessageLength
                });
            }
            return delivered;
        };

        const delivered = prepare(effectiveMode);
        const options = effectiveMode === 'reply'
            ? { replyParentMessageId: messageId }
            : undefined;
        trace?.event('response.intended', { text: delivered });
        let sendStarted = performance.now();
        trace?.event('twitch.send.started', { reply: Boolean(options) });
        try {
            await transport.send(channel, delivered, options);
            trace?.event('twitch.send.accepted', { durationMs: performance.now() - sendStarted });
            trace?.event('response.delivered', { text: delivered });
            return delivered;
        } catch (error) {
            trace?.event('twitch.send.failed', {
                durationMs: performance.now() - sendStarted,
                reason: error?.message || String(error)
            });
            if (effectiveMode !== 'reply' || error?.code !== 'INVALID_REPLY_PARENT') throw error;
            const fallback = prepare(actor.username ? 'tag' : 'off');
            sendStarted = performance.now();
            trace?.event('response.intended', { text: fallback });
            trace?.event('twitch.send.started', { reply: false });
            await transport.send(channel, fallback);
            trace?.event('twitch.send.accepted', { durationMs: performance.now() - sendStarted });
            trace?.event('response.delivered', { text: fallback });
            return fallback;
        }
    }

    /**
     * Route one inbound chat message. Safe for hermetic tests via transportOverride.
     * Throws synchronously if no transport is available.
     * @param {object} message Inbound message payload
     * @param {object} [transportOverride] Optional transport for testing
     * @returns {Promise<object>} RouteResult
     */
    async handle(message = {}, transportOverride) {
        const transport = transportOverride || this.transport;
        if (!transport) {
            throw new Error('ChatRouter.handle() requires an attached transport or transportOverride');
        }

        const channel = message.channel;
        const text = message.text ?? '';
        let trace = null;

        try {
            const invocation = message.invocation || this.classify(message, transport.botUserId);
            if (invocation.kind === 'none') {
                return { kind: 'none', channel, sent: false };
            }
            trace = this.executionTrace.begin({
                kind: invocation.kind,
                command: invocation.command,
                mediaType: invocation.mediaType,
                requester: message.loginName || message.username || message.tags?.username,
                channel
            });

            const finish = (result, outcome = null, reason = null) => {
                trace.terminal(outcome, reason);
                return result;
            };

            const aiCommand = invocation.kind === 'ai' ? invocation.command : null;

            // Prompt-specific emote pass: command removal + emote-only detection.
            // The transport already recorded the transcript with its own pass.
            const { textForAi, isEmoteOnly } =
                this.emotePool.ingestMessage({
                    channel,
                    text,
                    tags: message.tags,
                    prefix: aiCommand || ''
                });

            // 2. Custom command matching & RBAC
            const custom = invocation.kind === 'custom' ? invocation.custom : null;
            if (custom) {
                if (!userHasRole(message, custom.role)) {
                    trace.markRejected('access denied');
                    return finish(
                        { kind: 'unauthorized', channel, command: custom.cmd, sent: false },
                        'rejected',
                        'access denied'
                    );
                }

                const cooldown = this.cooldowns.checkAndConsume(channel);
                if (cooldown.onCooldown) {
                    trace.markRejected(`cooldown active (${cooldown.remaining}s remaining)`);
                    return finish({
                        kind: 'cooldown',
                        channel,
                        command: custom.cmd,
                        sent: false,
                        remaining: cooldown.remaining
                    }, 'rejected', 'cooldown active');
                }

                const reply = await this.#deliverResponse(transport, {
                    channel,
                    text: custom.response,
                    trigger: message,
                    trace
                });
                return finish({
                    kind: 'custom',
                    channel,
                    command: custom.cmd,
                    sent: true,
                    reply
                });
            }

            // 3. Media command matching
            const media = invocation.kind === 'media' ? invocation.media : null;
            if (media) {
                if (media.enabled === false) {
                    const safeReply = this.#safeErrorReply('MEDIA_COMMAND_DISABLED');
                    const reply = transport && safeReply
                        ? await this.#deliverResponse(transport, { channel, text: safeReply, trigger: message, trace })
                        : '';
                    trace.markRejected('media command disabled');
                    return finish(
                        { kind: 'media_disabled', channel, command: media.cmd, mediaType: media.mediaType, sent: Boolean(reply), reply: reply || undefined },
                        'rejected',
                        'media command disabled'
                    );
                }

                const access = this.mediaCommands?.[media.mediaType]?.access
                    || this.mediaCommands?.access
                    || 'everyone';
                if (!mediaAccessAllowed(message, access)) {
                    const safeReply = this.#safeErrorReply('MEDIA_ACCESS_DENIED');
                    const reply = transport && safeReply
                        ? await this.#deliverResponse(transport, { channel, text: safeReply, trigger: message, trace })
                        : '';
                    trace.markRejected('media access denied');
                    return finish(
                        { kind: 'media_denied', channel, command: media.cmd, mediaType: media.mediaType, sent: Boolean(reply), reply: reply || undefined },
                        'rejected',
                        'media access denied'
                    );
                }

                const prompt = this.matcher.mediaPrompt(text, media.cmd);
                const conversationPrompt = frameConversationalMessage(message, text);
                if (prompt) {
                    const cooldown = this.cooldowns.checkAndConsume(channel);
                    if (cooldown.onCooldown) {
                        const cooldownResult = await this.#sendCooldown(transport, channel, cooldown, {
                            command: media.cmd,
                            mediaType: media.mediaType
                        }, message, trace);
                        trace.markRejected('cooldown active');
                        return finish(cooldownResult, 'rejected', 'cooldown active');
                    }
                }

                const result = await this.mediaPipeline.synthesize({
                    channel,
                    user: message.tags,
                    prompt,
                    mediaType: media.mediaType,
                    command: media.cmd,
                    conversationPrompt,
                    trace
                });
                const reply = await this.#deliverResponse(transport, {
                    channel,
                    text: result.replyText,
                    trigger: message,
                    trace
                });
                if (result.success) {
                    this.aiEngine.commitConversationTurn(channel, {
                        userParts: [{ type: 'text', text: conversationPrompt }],
                        modelParts: [{ type: 'text', text: reply }]
                    });
                }
                const routeResult = {
                    kind: 'media',
                    channel,
                    command: media.cmd,
                    mediaType: media.mediaType,
                    sent: true,
                    reply
                };
                if (!result.success) {
                    const outcome = result.traceOutcome === 'rejected' ? 'rejected' : 'failed';
                    const reason = result.traceReason || (outcome === 'rejected' ? 'media request rejected' : 'media generation failed');
                    return finish(routeResult, outcome, reason);
                }
                return finish(routeResult);
            }

            // 4. AI conversational command matching
            if (invocation.kind === 'ai') {
                if (isEmoteOnly && this.ignoreEmoteOnlyPrompts) {
                    console.log(`Command ${aiCommand} ignored: emote-only message`);
                    trace.markRejected('emote-only prompt ignored');
                    return finish(
                        { kind: 'emote_only', channel, command: aiCommand, sent: false },
                        'rejected',
                        'emote-only prompt ignored'
                    );
                }

                const cooldown = this.cooldowns.checkAndConsume(channel);
                if (cooldown.onCooldown) {
                    const cooldownResult = await this.#sendCooldown(
                        transport,
                        channel,
                        cooldown,
                        { command: aiCommand },
                        message,
                        trace
                    );
                    trace.markRejected('cooldown active');
                    return finish(cooldownResult, 'rejected', 'cooldown active');
                }

                const { channelContext, recentLogs } = await transport.getContext(channel, {
                    logCount: this.chatContextLength
                });
                const prompt = frameConversationalMessage(message, textForAi);
                

                                let rawResponse;

                if (aiCommand === '!ai') {
                    rawResponse = await generateGroqResponse(
    prompt,
    this.systemInstructions
);
                } else {
                    rawResponse = await this.aiEngine.generate(prompt, {
                        channel,
                        channelContext,
                        recentLogs,
                        harnessInstructions: this.mediaPipeline.getHarnessInstructions?.(this.prefixLists),
                        overrideFileContext: this.systemInstructions,
                        caller: {
                            loginName: message.loginName,
                            isBroadcaster: !!message.isBroadcaster,
                            isMod: !!message.isMod
                        },
                        trace
                    });
                }

                const reply = await this.#deliverResponse(transport, {
                    channel,
                    text: rawResponse,
                    trigger: message,
                    decorateAi: true,
                    trace
                });

                return finish({
                    kind: 'ai',
                    channel,
                    command: aiCommand,
                    sent: true,
                    reply
                });
            }

            trace.markRejected('recognized route did not dispatch');
            return finish({ kind: 'none', channel, sent: false }, 'rejected', 'recognized route did not dispatch');
        } catch (error) {
            console.error('[ChatRouter] Failed to handle chat message:', error);
            trace?.markFailed(error?.message || String(error));
            const result = await this.#sendSafeError(transport, channel, error, message, trace);
            trace?.terminal('failed', error?.message || String(error));
            return result;
        }
    }

    async #sendCooldown(transport, channel, cooldown, extra = {}, trigger = {}, trace = null) {
        const reply = this.errorHandler?.format?.('COOLDOWN_ACTIVE', {
            remainingTime: cooldown.remaining
        });

        if (transport && reply) {
            const delivered = await this.#deliverResponse(transport, { channel, text: reply, trigger, trace });
            return {
                kind: 'cooldown',
                channel,
                sent: true,
                remaining: cooldown.remaining,
                reply: delivered,
                ...extra
            };
        }

        return {
            kind: 'cooldown',
            channel,
            sent: false,
            remaining: cooldown.remaining,
            ...extra
        };
    }

    async #sendSafeError(transport, channel, error, trigger = {}, trace = null) {
        try {
            const reply = this.#safeErrorReply(error);
            if (transport && reply) {
                const delivered = await this.#deliverResponse(transport, { channel, text: reply, trigger, trace });
                return { kind: 'error', channel, sent: true, reply: delivered, error: error?.message };
            }
            return { kind: 'error', channel, sent: false, reply: reply || undefined, error: error?.message };
        } catch (sendError) {
            console.error('[ChatRouter] Failed to send error response:', sendError);
            return { kind: 'error', channel, sent: false, error: error?.message };
        }
    }

    #safeErrorReply(error) {
        if (typeof this.errorHandler?.format === 'function') {
            return this.errorHandler.format(error);
        }
        return null;
    }

    /**
     * Route one inbound Twitch EventSub event.
     * @param {object} event BotTriggerEvent payload
     * @param {object} [transportOverride] Optional transport for testing
     * @returns {Promise<object>} EventRouteResult
     */
    async handleEvent(event = {}, transportOverride) {
        const transport = transportOverride || this.transport;
        if (!transport) {
            throw new Error('ChatRouter.handleEvent() requires an attached transport or transportOverride');
        }

        const channel = event.channel;
        const eventKind = event.kind;

        try {
            const policy = this.eventAlerts.getPolicy(eventKind);
            if (!policy || policy.enabled === false) {
                return { kind: 'disabled', channel, eventKind, sent: false };
            }

            if (eventKind === 'cheer' && typeof policy.min_bits === 'number'
                && (Number(event.details?.bits) || 0) < policy.min_bits) {
                return { kind: 'threshold', channel, eventKind, sent: false };
            }
            if (eventKind === 'raid' && typeof policy.min_viewers === 'number'
                && (Number(event.details?.viewers) || 0) < policy.min_viewers) {
                return { kind: 'threshold', channel, eventKind, sent: false };
            }

            const cooldown = this.eventCooldowns.checkAndConsume(
                channel, eventKind, Number(policy.cooldown_seconds) || 0
            );
            if (cooldown.onCooldown) {
                return { kind: 'cooldown', channel, eventKind, sent: false, remaining: cooldown.remaining };
            }

            const vars = eventVars(event);
            let reply = '';
            let source = 'fallback';

            if (eventKind === 'channel_points') {
                const rewardCfg = findRewardConfig(policy, event.details?.reward?.title);
                if (!rewardCfg) {
                    return { kind: 'unconfigured_reward', channel, eventKind, sent: false };
                }
                const aiEnabled = rewardCfg.ai_enabled !== false;
                const fallbackTemplate = rewardCfg.fallback_template || '';
                const promptTemplate = rewardCfg.ai_prompt || '';

                if (aiEnabled && promptTemplate) {
                    try {
                        const { channelContext, recentLogs } = await transport.getContext(channel, {
                            logCount: this.chatContextLength
                        });
                        const framed = `[Event Alert: ${eventKind}] ${interpolate(promptTemplate, vars)}`;
                        const raw = await this.aiEngine.generate(framed, {
                            channel,
                            channelContext,
                            recentLogs,
                            harnessInstructions: [
                                EVENT_REACTION_HARNESS
                            ],
                            overrideFileContext: this.systemInstructions,
                            disableTools: true,
                            caller: {
                                loginName: event.user?.login || '',
                                isBroadcaster: false,
                                isMod: false
                            }
                        });
                        if (raw && String(raw).trim()) {
                            reply = raw;
                            source = 'ai';
                        }
                    } catch {
                        // Silent - quota, timeout, safety, network. Chat never sees this.
                    }
                }

                if (source !== 'ai') {
                    reply = interpolate(fallbackTemplate, vars).trim();
                    source = 'fallback';
                }

                if (!reply) {
                    return { kind: 'event', channel, eventKind, sent: false, source };
                }

                const delivered = await this.#deliverResponse(transport, {
                    channel,
                    text: reply,
                    trigger: event.user,
                    decorateAi: source === 'ai'
                });
                return { kind: 'event', channel, eventKind, sent: true, reply: delivered, source };
            }

            const aiEnabled = policy.ai_enabled !== false;
            const fallbackTemplate = policy.fallback_template || '';
            const promptTemplate = policy.ai_prompt || '';

            if (aiEnabled && promptTemplate) {
                try {
                    const { channelContext, recentLogs } = await transport.getContext(channel, {
                        logCount: this.chatContextLength
                    });
                    const framed = `[Event Alert: ${eventKind}] ${interpolate(promptTemplate, vars)}`;
                    const raw = await this.aiEngine.generate(framed, {
                        channel,
                        channelContext,
                        recentLogs,
                        harnessInstructions: [
                            EVENT_REACTION_HARNESS
                        ],
                        overrideFileContext: this.systemInstructions,
                        disableTools: true,
                        caller: {
                            loginName: event.user?.login || '',
                            isBroadcaster: false,
                            isMod: false
                        }
                    });
                    if (raw && String(raw).trim()) {
                        reply = raw;
                        source = 'ai';
                    }
                } catch {
                    // Silent - quota, timeout, safety, network. Chat never sees this.
                }
            }

            if (source !== 'ai') {
                reply = interpolate(fallbackTemplate, vars).trim();
                source = 'fallback';
            }

            if (!reply) {
                return { kind: 'event', channel, eventKind, sent: false, source };
            }

            const delivered = await this.#deliverResponse(transport, {
                channel,
                text: reply,
                trigger: event.user,
                decorateAi: source === 'ai'
            });
            return { kind: 'event', channel, eventKind, sent: true, reply: delivered, source };
        } catch (error) {
            console.error('[ChatRouter] Failed to handle event:', error);
            // Last resort: try fallback one more time, still never leak the error.
            try {
                const policy = this.eventAlerts.getPolicy(eventKind);
                if (eventKind === 'channel_points') {
                    const rewardCfg = findRewardConfig(policy, event.details?.reward?.title);
                    if (rewardCfg?.fallback_template) {
                        const reply = interpolate(rewardCfg.fallback_template, eventVars(event)).trim();
                        if (transport && reply) {
                            const delivered = await this.#deliverResponse(transport, { channel, text: reply, trigger: event.user });
                            return { kind: 'event', channel, eventKind, sent: true, reply: delivered, source: 'fallback' };
                        }
                    }
                } else if (policy?.fallback_template) {
                    const reply = interpolate(policy.fallback_template, eventVars(event)).trim();
                    if (transport && reply) {
                        const delivered = await this.#deliverResponse(transport, { channel, text: reply, trigger: event.user });
                        return { kind: 'event', channel, eventKind, sent: true, reply: delivered, source: 'fallback' };
                    }
                }
            } catch { /* ignore */ }
            return { kind: 'error', channel, eventKind, sent: false };
        }
    }

}

export default ChatRouter;
