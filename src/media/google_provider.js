import { GoogleGenAI } from '@google/genai';
import { randomUUID } from 'node:crypto';
import { readFile, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BotError } from '../utils/error_handler.js';
import { ImageDownloader } from '../utils/image_downloader.js';
import { assertInteractionSucceeded } from '../ai/interaction_response.js';

const CATALOG_TTL_MS = 60 * 60 * 1000;
const VIDEO_TIMEOUT_MS = 7 * 60 * 1000;
const VIDEO_POLL_MS = 10_000;
const GENERATION_TIMEOUT_MS = 60_000;
const ROTATE_STATUSES = new Set([401, 403, 429, 503]);

const GOOGLE_TTS_VOICES = Object.freeze([
    'Zephyr', 'Puck', 'Charon', 'Kore', 'Fenrir', 'Leda', 'Orus', 'Aoede',
    'Callirrhoe', 'Autonoe', 'Enceladus', 'Iapetus', 'Umbriel', 'Algieba',
    'Despina', 'Erinome', 'Algenib', 'Rasalgethi', 'Laomedeia', 'Achernar',
    'Alnilam', 'Schedar', 'Gacrux', 'Pulcherrima', 'Achird', 'Zubenelgenubi',
    'Vindemiatrix', 'Sadachbia', 'Sadaltager', 'Sulafat'
]);

const EMPTY_CATALOG = Object.freeze({
    image: Object.freeze([]),
    video: Object.freeze([]),
    tts: Object.freeze([]),
    music: Object.freeze([])
});

function cloneCatalog(catalog) {
    return Object.fromEntries(['image', 'video', 'tts', 'music'].map((type) => [
        type,
        (catalog[type] || []).map((model) => ({
            ...model,
            ...(model.voices ? { voices: [...model.voices] } : {}),
            ...(model.durations ? { durations: [...model.durations] } : {})
        }))
    ]));
}

function canonicalModelId(model) {
    const name = typeof model === 'string' ? model : model?.name || model?.id;
    if (typeof name !== 'string') return '';
    // Only Google base-model resources can be sent as bare IDs to this provider.
    const match = name.trim().match(/^(?:(?:(?:projects\/[^/]+\/locations\/[^/]+\/)?publishers\/google\/)?models\/)?([^/]+)$/);
    return match?.[1] || '';
}

function isImageModel(id) {
    return /^gemini-\d+(?:\.\d+)*-(?:flash(?:-lite)?|pro)-image(?:-[a-z0-9]+)*$/.test(id)
        || /^(?:gemini-)?nano-banana-(?:\d+(?:\.\d+)*|pro)(?:-[a-z0-9]+)*$/.test(id);
}

function isVeoModel(id) {
    return /^veo-\d+(?:\.\d+)*-(?:(?:lite|fast)-)?generate(?:-[a-z0-9]+)*$/.test(id);
}

function isOmniVideoModel(id) {
    return /^gemini-(?:\d+(?:\.\d+)*-)?(?:(?:flash|pro)(?:-lite)?-)?omni(?:-[a-z0-9.]+)*$/.test(id);
}

function isTtsModel(id) {
    return /^gemini-\d+(?:\.\d+)*-(?:flash|pro)(?:-lite)?(?:-preview)?-tts(?:-[a-z0-9]+)*$/.test(id);
}

function isMusicModel(id) {
    return /^lyria-\d+(?:\.\d+)*(?:-(?:clip|pro)(?:-[a-z0-9]+)*)?$/.test(id);
}

// Keep catalog filtering and saved-target validation on the same generation families.
// Descriptions and image/audio inputs do not establish media output support.
function mediaTypeForModel(id) {
    if (isImageModel(id)) return 'image';
    if (isVeoModel(id) || isOmniVideoModel(id)) return 'video';
    if (isTtsModel(id)) return 'tts';
    if (isMusicModel(id)) return 'music';
    return null;
}

// Cloud image/TTS and Developer 2.5 TTS require the content API. Other
// discovered families use Interactions, apart from Veo's dedicated API.
function usesContentApi(type, id, backendKind) {
    return (type === 'image' || type === 'tts')
        && (backendKind === 'vertex' || (type === 'tts' && id.startsWith('gemini-2.5-')));
}

function supportsGenerationAction(model, id, type, backendKind) {
    // Vertex discovery omits actions. Interactions models have no corresponding
    // models API action, so their supported family remains the routing constraint.
    const action = isVeoModel(id) ? 'predictLongRunning'
        : usesContentApi(type, id, backendKind) ? 'generateContent' : null;
    return !action || !Array.isArray(model?.supportedActions) || model.supportedActions.includes(action);
}

function classifyGoogleModels(models, backendKind) {
    const catalog = { image: [], video: [], tts: [], music: [] };
    const seen = new Set();
    for (const model of models || []) {
        const id = canonicalModelId(model);
        if (!id || seen.has(id)) continue;
        const type = mediaTypeForModel(id);
        if (!type || !supportsGenerationAction(model, id, type, backendKind)) continue;
        seen.add(id);
        catalog[type].push({
            provider: 'google', id,
            ...(isVeoModel(id) ? { durations: [4, 6, 8] } : {}),
            ...(type === 'tts' ? { voices: [...GOOGLE_TTS_VOICES], defaultVoice: 'Kore' } : {})
        });
    }
    for (const type of Object.keys(catalog)) catalog[type].sort((left, right) => left.id.localeCompare(right.id));
    return catalog;
}

function statusOf(error) {
    for (const candidate of [error?.status, error?.code, error?.response?.status, error?.error?.code]) {
        const status = Number(candidate);
        if (Number.isFinite(status)) return status;
    }
    const match = String(error?.message || '').match(/\b(400|401|403|404|429|500|502|503|504)\b/);
    return match ? Number(match[1]) : null;
}

function translateGoogleError(error, mediaType) {
    const status = statusOf(error);
    const message = String(error?.message || error || '');
    if (status === 404 || /(?:model|publisher model).*(?:not found|unsupported|not supported|does not exist)|(?:unsupported|not supported).*model/i.test(message)) {
        return new BotError('MEDIA_MODEL_UNAVAILABLE', { status, cause: error, params: { mediaType } });
    }
    if (error instanceof BotError) return error;
    if (/safety|blocked|prohibited content|responsible ai/i.test(message)) {
        return new BotError('CONTENT_BLOCKED', { status, cause: error });
    }
    if (status === 401 || status === 403 || status === 429) {
        return new BotError(`HTTP_${status}`, { status, cause: error });
    }
    if (status === 400) return new BotError('HTTP_400', { status, cause: error });
    if (status && status >= 500) return new BotError(status === 504 ? 'HTTP_504' : 'HTTP_500', { status, cause: error });
    if (error?.name === 'AbortError' || /timed out|timeout/i.test(message)) {
        return new BotError('REQUEST_TIMEOUT', { cause: error });
    }
    return error;
}

async function modelList(pager) {
    if (Array.isArray(pager)) return pager;
    // SDK Pager.page is only the current page; its iterator fetches the rest.
    if (pager?.[Symbol.asyncIterator]) {
        const models = [];
        for await (const model of pager) models.push(model);
        return models;
    }
    if (Array.isArray(pager?.page)) return pager.page;
    if (pager?.[Symbol.iterator]) return [...pager];
    return [];
}

function pcmSampleRate(mimeType) {
    const match = String(mimeType || '').match(/(?:^|;)\s*rate=(\d+)/i);
    return match ? Number(match[1]) : 24_000;
}

function contentMedia(response, kind) {
    if (response?.promptFeedback?.blockReason
        || response?.candidates?.some(candidate => /SAFETY|PROHIBITED|BLOCKLIST|RECITATION/.test(candidate.finishReason || ''))) {
        throw new BotError('CONTENT_BLOCKED');
    }
    for (const candidate of response?.candidates || []) {
        for (const part of candidate.content?.parts || []) {
            const inline = part.inlineData;
            if (inline?.data && (!inline.mimeType || inline.mimeType.startsWith(`${kind}/`))) {
                return { buffer: Buffer.from(inline.data, 'base64'), mimeType: inline.mimeType || `${kind}/*` };
            }
        }
    }
    return null;
}

function interactionMedia(interaction, kind) {
    // Keep the pipeline's one-artifact contract. SDK convenience properties
    // select the last block, so prefer the first generated block in the timeline.
    for (const step of interaction?.steps || []) {
        if (step.type !== 'model_output') continue;
        for (const content of step?.content || []) {
            if (content?.type === kind && content.data) {
                return {
                    buffer: Buffer.from(content.data, 'base64'),
                    mimeType: content.mime_type || `${kind}/*`,
                    sampleRate: content.sample_rate,
                    channels: content.channels
                };
            }
        }
    }
    const direct = interaction?.[`output_${kind}`];
    if (direct?.data) {
        return {
            buffer: Buffer.from(direct.data, 'base64'),
            mimeType: direct.mime_type || `${kind}/*`,
            sampleRate: direct.sample_rate,
            channels: direct.channels
        };
    }
    return null;
}

export function pcmToWav(pcm, { sampleRate = 24_000, channels = 1, bitDepth = 16 } = {}) {
    const data = Buffer.from(pcm);
    const header = Buffer.alloc(44);
    const bytesPerSample = bitDepth / 8;
    header.write('RIFF', 0);
    header.writeUInt32LE(36 + data.length, 4);
    header.write('WAVE', 8);
    header.write('fmt ', 12);
    header.writeUInt32LE(16, 16);
    header.writeUInt16LE(1, 20);
    header.writeUInt16LE(channels, 22);
    header.writeUInt32LE(sampleRate, 24);
    header.writeUInt32LE(sampleRate * channels * bytesPerSample, 28);
    header.writeUInt16LE(channels * bytesPerSample, 32);
    header.writeUInt16LE(bitDepth, 34);
    header.write('data', 36);
    header.writeUInt32LE(data.length, 40);
    return Buffer.concat([header, data]);
}

export class GoogleProvider {
    #catalogState;
    #catalogRefresh = null;

    constructor({
        googleBackend,
        clientFactory = (options) => new GoogleGenAI(options),
        imageDownloader = null,
        fetchImpl = globalThis.fetch.bind(globalThis),
        now = () => Date.now(),
        sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
        catalogTtlMs = CATALOG_TTL_MS,
        videoTimeoutMs = VIDEO_TIMEOUT_MS,
        videoPollMs = VIDEO_POLL_MS,
        generationTimeoutMs = GENERATION_TIMEOUT_MS
    } = {}) {
        this.id = 'google';
        this.name = this.id;
        this.googleBackend = googleBackend;
        this.clients = googleBackend?.kind === 'vertex'
            ? [{
                client: clientFactory({
                    enterprise: true,
                    project: googleBackend.projectId,
                    location: 'global'
                }),
                regionalClient: clientFactory({
                    enterprise: true,
                    project: googleBackend.projectId,
                    location: 'us-central1'
                })
            }]
            : (googleBackend?.apiKeys || []).filter(Boolean)
                .map((key) => {
                    const client = clientFactory({ apiKey: key });
                    return { key, client, regionalClient: client };
                });
        this.activeKeyIndex = 0;
        this.imageDownloader = imageDownloader ?? new ImageDownloader();
        this.now = now;
        this.sleep = sleep;
        this.catalogTtlMs = catalogTtlMs;
        this.videoTimeoutMs = videoTimeoutMs;
        this.videoPollMs = videoPollMs;
        this.generationTimeoutMs = generationTimeoutMs;
        this.capabilities = { mediaTypes: new Set(['image', 'video', 'tts', 'music']) };
        this.#catalogState = { data: null, successAt: 0, failedAt: 0 };
    }

    supports(type) {
        return this.capabilities.mediaTypes.has(type);
    }

    async #withRotation(work, mediaType) {
        if (this.clients.length === 0) {
            throw new BotError('MEDIA_PROVIDER_UNAVAILABLE', { params: { provider: this.id, mediaType } });
        }
        let lastError;
        for (let offset = 0; offset < this.clients.length; offset += 1) {
            const index = (this.activeKeyIndex + offset) % this.clients.length;
            const entry = this.clients[index];
            try {
                const result = await work(entry, index);
                this.activeKeyIndex = index;
                return result;
            } catch (error) {
                lastError = error;
                if (!ROTATE_STATUSES.has(statusOf(error)) || offset === this.clients.length - 1) break;
            }
        }
        throw translateGoogleError(lastError, mediaType);
    }

    async #discover() {
        return this.#withRotation(async (entry) => classifyGoogleModels(
            await modelList(await (entry.regionalClient || entry.client).models.list()), this.googleBackend?.kind
        ));
    }

    async catalog() {
        const now = this.now();
        if (this.#catalogState.data && now - this.#catalogState.successAt < this.catalogTtlMs) return cloneCatalog(this.#catalogState.data);
        if (this.#catalogState.failedAt && now - this.#catalogState.failedAt < this.catalogTtlMs) {
            return cloneCatalog(this.#catalogState.data || EMPTY_CATALOG);
        }
        if (this.#catalogRefresh) return this.#catalogRefresh;
        this.#catalogRefresh = (async () => {
            try {
                const catalog = await this.#discover();
                this.#catalogState = { data: catalog, successAt: this.now(), failedAt: 0 };
                return cloneCatalog(catalog);
            } catch (error) {
                this.#catalogState.failedAt = this.now();
                console.warn('[Google Media] Model discovery failed:', error?.message || error);
                return cloneCatalog(this.#catalogState.data || EMPTY_CATALOG);
            } finally {
                this.#catalogRefresh = null;
            }
        })();
        return this.#catalogRefresh;
    }

    #resolveTarget(type, target) {
        if (!this.supports(type)) {
            throw new BotError('MEDIA_PROVIDER_UNAVAILABLE', { params: { provider: this.id, mediaType: type } });
        }
        const model = canonicalModelId(target?.model);
        if (!model || mediaTypeForModel(model) !== type) {
            throw new BotError('MEDIA_MODEL_UNAVAILABLE', { params: { mediaType: type } });
        }
        return { ...target, model };
    }

    async #referenceInput(prompt, type) {
        if (type === 'tts') return { prompt: String(prompt || ''), image: null };
        const original = String(prompt || '');
        const match = original.match(/https?:\/\/\S+/);
        if (!match) return { prompt: original, image: null };
        try {
            const image = await this.imageDownloader.downloadImageAsBase64(match[0]);
            return { prompt: original.replace(match[0], '').trim() || 'Create a variation.', image };
        } catch (error) {
            throw new BotError('IMAGE_LOAD_ERROR', { cause: error });
        }
    }

    async #videoBuffer(entry, video) {
        if (video?.videoBytes) return Buffer.from(video.videoBytes, 'base64');
        if (!video?.uri) return null;
        const client = entry.regionalClient || entry.client;
        const downloadPath = join(tmpdir(), `twitch-google-video-${randomUUID()}.mp4`);
        try {
            await client.files.download({ file: video, downloadPath });
            return await readFile(downloadPath);
        } finally {
            await unlink(downloadPath).catch(() => {});
        }
    }

    async #generateVeo(prompt, target) {
        const input = await this.#referenceInput(prompt, 'video');
        const established = await this.#withRotation(async (entry) => {
            const client = entry.regionalClient || entry.client;
            return {
                entry,
                client,
                operation: await client.models.generateVideos({
                    model: target.model,
                    source: {
                        prompt: input.prompt,
                        ...(input.image ? { image: { imageBytes: input.image.data, mimeType: input.image.mimeType } } : {})
                    },
                    config: { numberOfVideos: 1, ...(target.duration ? { durationSeconds: target.duration } : {}) }
                })
            };
        }, 'video');
        const deadline = this.now() + this.videoTimeoutMs;
        let operation = established.operation;
        while (!operation?.done) {
            if (this.now() >= deadline) throw new BotError('REQUEST_TIMEOUT');
            await this.sleep(this.videoPollMs);
            try {
                operation = await established.client.operations.getVideosOperation({ operation });
            } catch (error) {
                throw translateGoogleError(error, 'video');
            }
        }
        if (operation.error) throw translateGoogleError(operation.error, 'video');
        const video = operation.response?.generatedVideos?.[0]?.video;
        const buffer = await this.#videoBuffer(established.entry, video);
        if (!buffer?.length) throw new BotError('MEDIA_NO_DATA', { params: { service: this.id, mediaType: 'video' } });
        return { buffer, mimeType: video?.mimeType || 'video/mp4' };
    }

    async #generateInteraction(type, prompt, target) {
        const input = await this.#referenceInput(prompt, type);
        return this.#withRotation(async ({ client }) => {
            const interactionInput = input.image
                ? [
                    { type: 'text', text: input.prompt },
                    { type: 'image', mime_type: input.image.mimeType, data: input.image.data }
                ]
                : input.prompt;
            const kind = type === 'image' ? 'image' : type === 'video' ? 'video' : 'audio';
            const request = { model: target.model, input: interactionInput, store: false };
            request.response_format = { type: kind };
            if (type === 'tts') {
                request.generation_config = { speech_config: [{ voice: target.voice || 'Kore' }] };
                request.response_format.mime_type = 'audio/wav';
            }
            const interaction = await client.interactions.create(request, {
                timeout_ms: type === 'video' || type === 'music' ? this.videoTimeoutMs : this.generationTimeoutMs,
                retries: { strategy: 'none' }
            });
            assertInteractionSucceeded(interaction);
            const media = interactionMedia(interaction, kind);
            if (!media?.buffer?.length) throw new BotError('MEDIA_NO_DATA', { params: { service: this.id, mediaType: type } });
            if (kind === 'audio' && /pcm|l16/i.test(media.mimeType)) {
                return {
                    buffer: pcmToWav(media.buffer, {
                        sampleRate: media.sampleRate || pcmSampleRate(media.mimeType),
                        channels: media.channels || 1
                    }),
                    mimeType: 'audio/wav'
                };
            }
            return { buffer: media.buffer, mimeType: media.mimeType };
        }, type);
    }

    // Cloud image/TTS and Developer 2.5 TTS still require this API.
    // Keep the exception here; chat and supported media use Interactions.
    async #generateContentMedia(type, prompt, target) {
        const input = await this.#referenceInput(prompt, type);
        return this.#withRotation(async ({ client }) => {
            const kind = type === 'image' ? 'image' : 'audio';
            const response = await client.models.generateContent({
                model: target.model,
                contents: input.image
                    ? [{ text: input.prompt }, { inlineData: { mimeType: input.image.mimeType, data: input.image.data } }]
                    : input.prompt,
                config: {
                    responseModalities: [kind.toUpperCase()],
                    ...(type === 'tts' ? {
                        speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: target.voice || 'Kore' } } }
                    } : {}),
                    httpOptions: { timeout: this.generationTimeoutMs, retryOptions: { attempts: 1 } }
                }
            });
            const media = contentMedia(response, kind);
            if (!media?.buffer?.length) throw new BotError('MEDIA_NO_DATA', { params: { service: this.id, mediaType: type } });
            if (kind === 'audio' && /pcm|l16/i.test(media.mimeType)) {
                return { buffer: pcmToWav(media.buffer, { sampleRate: pcmSampleRate(media.mimeType) }), mimeType: 'audio/wav' };
            }
            return media;
        }, type);
    }

    async generate({ type, prompt, target = {} } = {}) {
        target = this.#resolveTarget(type, target);
        try {
            if (usesContentApi(type, target.model, this.googleBackend?.kind)) {
                return await this.#generateContentMedia(type, prompt, target);
            }
            if (type === 'image') return await this.#generateInteraction(type, prompt, target);
            if (type === 'video' && isVeoModel(target.model)) return await this.#generateVeo(prompt, target);
            if (type === 'video' && isOmniVideoModel(target.model)) return await this.#generateInteraction(type, prompt, target);
            if (type === 'tts' && isTtsModel(target.model)) return await this.#generateInteraction(type, prompt, target);
            if (type === 'music' && isMusicModel(target.model)) return await this.#generateInteraction(type, prompt, target);
            throw new BotError('MEDIA_MODEL_UNAVAILABLE', { params: { mediaType: type } });
        } catch (error) {
            throw translateGoogleError(error, type);
        }
    }
}

export default GoogleProvider;
