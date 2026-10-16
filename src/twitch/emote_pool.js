// src/twitch/emote_pool.js
//
// Deep EmotePool module: single source of truth for channel emote state across chat
// routing, AI prompt generation, reply decoration, and web gallery rendering.
// Hydrates from Redis cache on boot, synchronizes real-time via 7TV EventAPI and
// BTTV WebSockets with conditional ETag polling for FFZ, and emits live updates.

import {
  fetchSevenTvChannelEmotesForTwitchIds,
  fetchSevenTvGlobalEmotes,
  fetchBttvChannelEmotesForTwitchIds,
  fetchBttvGlobalEmotes,
  fetchFfzChannelEmotesForTwitchIds,
  fetchFfzGlobalEmotes,
  fetchFfzRoomConditional,
  assetFrom7tvEmote,
  assetFromBttvEmote
} from './emote_providers.js';
import { SevenTvEventListener, BttvEventListener } from './emote_sync.js';

const PLATFORMS = ['7tv', 'bttv', 'ffz'];
const CACHE_GLOBALS = 'emotes:cache:__globals__';
const EMPTY_VIEW = { tokens: [], match: null, space: null, pool: [] };
const EMOTE_ONLY = /^(?:\s*emote:\S+\s*)+$/;
const WORD = '\\p{L}\\p{N}_';
const URL_SPLIT = /(https?:\/\/\S+)/g;
const MAX_OBSERVED_TWITCH_EMOTES = 512;

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const channelKey = (channel) => (channel ? `#${String(channel).replace('#', '').toLowerCase()}` : null);

const defaultTimers = {
  setTimeout: (...a) => globalThis.setTimeout(...a),
  clearTimeout: (id) => globalThis.clearTimeout(id),
  setInterval: (...a) => globalThis.setInterval(...a),
  clearInterval: (id) => globalThis.clearInterval(id)
};

function createDefaultProviders(fetchImpl) {
  return {
    '7tv': {
      name: '7TV',
      fetchChannel: (ids, o) => fetchSevenTvChannelEmotesForTwitchIds(ids, { fetchImpl, ...o }),
      fetchGlobal: (o) => fetchSevenTvGlobalEmotes({ fetchImpl, ...o })
    },
    bttv: {
      name: 'BTTV',
      fetchChannel: (ids, o) => fetchBttvChannelEmotesForTwitchIds(ids, { fetchImpl, ...o }),
      fetchGlobal: (o) => fetchBttvGlobalEmotes({ fetchImpl, ...o })
    },
    ffz: {
      name: 'FFZ',
      fetchChannel: (ids, o) => fetchFfzChannelEmotesForTwitchIds(ids, { fetchImpl, ...o }),
      fetchGlobal: (o) => fetchFfzGlobalEmotes({ fetchImpl, ...o })
    }
  };
}

export function getEmoteHarness(appendEnabled = false) {
  const parts = [
    '<emotes>',
    'emote:NAME identifies a Twitch emote in conversational text and supplied chat context.',
    'Treat emote:NAME tokens as opaque unless the user\'s request makes the emote relevant.',
    'You may reproduce emotes observed in supplied context when relevant or explicitly requested, preserving their exact spelling and case. Do not invent emotes.',
    'Unmarked emote-like text in previous bot replies does not establish that an emote exists.',
    'Thought summaries are model-generated reasoning, not emote evidence, even when they contain emote:NAME markers.'
  ];
  if (appendEnabled) {
    parts.push('The application may automatically append a channel emote to your response. You do not choose an automatically appended emote and should not claim to know why a particular emote was selected.');
  }
  parts.push('</emotes>');
  return parts.join('\n');
}

export class EmotePool {
  #storage;
  #fetch;
  #timer;
  #wsImpl;
  #providers;
  #cfg;
  #channels = new Map();
  #nativeNames = new Map();
  #globals = { '7tv': new Map(), bttv: new Map(), ffz: new Map() };
  #setIdToChannel = new Map();
  #twitchIdToChannel = new Map();
  #unionView = EMPTY_VIEW;
  #unionAssets = {};
  #listeners = new Set();
  #sevenTv = null;
  #bttv = null;
  #pollTimer = null;
  #persistTimers = new Map();
  #disposed = false;
  #activeSync = null;
  #pendingSync = null;
  #trailingSync = null;

  constructor(options = {}) {
    this.#storage = options.storage || null;
    this.#fetch = options.fetchImpl || globalThis.fetch?.bind(globalThis);
    this.#timer = options.timerImpl || defaultTimers;
    this.#wsImpl = options.wsImpl || null;
    this.#providers = options.providers || createDefaultProviders(this.#fetch);
    this.#cfg = {
      globals: {
        '7tv': options.include7tvGlobals ?? false,
        bttv: options.includeBttvGlobals ?? false,
        ffz: options.includeFfzGlobals ?? false
      },
      timeoutMs: Number(options.timeoutMs ?? 10_000),
      appendEnabled: options.appendEnabled ?? true,
      spacing: options.spacing ?? true,
      random: options.random || Math.random,
      pollMs: Number(options.pollMs ?? 10 * 60 * 1000),
      restFallbackMs: Number(options.restFallbackMs ?? 30 * 60 * 1000),
      persistDebounceMs: Number(options.persistDebounceMs ?? 5_000),
      cachePrefix: options.cachePrefix || 'emotes:cache:'
    };
  }

  /* ── Lifecycle & Storage Hydration ───────────────────────── */

  /**
   * Public synchronization seam for startup, channel changes, reconnects,
   * and dashboard saves. Bursts collapse onto the active run: later requests
   * overwrite the desired state and join at most one trailing refresh, which
   * is skipped entirely when it matches what was just fetched. Warm pools
   * resolve on cached state while their REST refresh continues in flight,
   * covered by the active-sync window so provider work never overlaps.
   */
  async sync(channels = [], channelIdMap = {}) {
    return this.#requestSync({ channels, channelIdMap }, false);
  }

  #requestSync({ channels, channelIdMap }, waitForRefresh) {
    if (this.#disposed) return Promise.resolve(this.stats());

    if (this.#activeSync) {
      this.#pendingSync = { channels, channelIdMap };
      this.#trailingSync ??= this.#activeSync.restDone.then(() => this.#drainTrailingSync());
      return this.#trailingSync;
    }

    let settleSession;
    const session = { restDone: new Promise(resolve => { settleSession = resolve; }) };
    this.#activeSync = session;
    const run = (async () => {
      try {
        const wanted = this.#normalizeWanted(channels);
        for (const key of [...this.#channels.keys()]) {
          if (!wanted.has(key)) this.#dropChannel(key);
        }
        for (const [key, label] of wanted) {
          if (!this.#channels.has(key)) this.#channels.set(key, this.#emptyState(label));
          else this.#channels.get(key).label = label;
          const login = key.slice(1);
          const id = channelIdMap?.[login] ?? channelIdMap?.[key] ?? null;
          if (id) {
            this.#channels.get(key).twitchId = String(id);
            this.#twitchIdToChannel.set(String(id), key);
          }
        }

        await this.#hydrateFromCache();
        for (const key of this.#channels.keys()) this.#rebuild(key, { persist: false, emit: false });

        this.#ensureListeners();
        this.#resubscribe();
        this.#ensurePoller();

        // A fresh state still shows provider globals in its view, so only the
        // awaited cold path (or an explicit trailing pass) guarantees that
        // channel data has landed before resolving.
        const rest = this.#refreshRest({ reason: 'sync' });
        rest
          .catch(e => console.error(`[Emotes] background refresh failed: ${e.message || e}`))
          .then(() => {
            if (this.#activeSync === session) this.#activeSync = null;
            settleSession();
          });

        if (waitForRefresh || this.#isCold()) await rest;
        return this.stats();
      } catch (err) {
        if (this.#activeSync === session) this.#activeSync = null;
        settleSession();
        throw err;
      }
    })();
    return run;
  }

  /** Latest-wins follow-up pass after an active run settles. */
  #drainTrailingSync() {
    const queued = this.#pendingSync;
    this.#pendingSync = null;
    this.#trailingSync = null;
    if (!queued || this.#disposed) return Promise.resolve(this.stats());
    if (this.#matchesCurrentState(queued)) {
      console.log('[Emotes] sync coalesced: channel state unchanged');
      return Promise.resolve(this.stats());
    }
    return this.#requestSync(queued, true);
  }

  #normalizeWanted(channels) {
    const wanted = new Map();
    for (const ch of channels) {
      const key = channelKey(ch);
      if (!key) continue;
      wanted.set(key, ch);
    }
    return wanted;
  }

  #matchesCurrentState({ channels, channelIdMap }) {
    const wanted = this.#normalizeWanted(channels);
    if (wanted.size !== this.#channels.size) return false;
    for (const [key] of wanted) {
      const state = this.#channels.get(key);
      if (!state) return false;
      const login = key.slice(1);
      const id = channelIdMap?.[login] ?? channelIdMap?.[key] ?? null;
      if ((id ? String(id) : null) !== (state.twitchId ? String(state.twitchId) : null)) return false;
    }
    return true;
  }

  dispose() {
    this.#disposed = true;
    if (this.#pollTimer) {
      this.#timer.clearInterval(this.#pollTimer);
      this.#pollTimer = null;
    }
    for (const timer of this.#persistTimers.values()) this.#timer.clearTimeout(timer);
    this.#persistTimers.clear();
    this.#sevenTv?.dispose();
    this.#bttv?.dispose();
    this.#sevenTv = this.#bttv = null;
    this.#listeners.clear();
    this.#nativeNames.clear();
  }

  on(event, listener) {
    if (event !== 'update' || typeof listener !== 'function') return () => {};
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  stats() {
    return {
      channels: Object.fromEntries([...this.#channels].map(([k, v]) => [k, v.view.tokens.length])),
      total: this.#unionView.tokens.length
    };
  }

  getEmoteMap(channel) {
    if (!channel) return { ...this.#unionAssets };
    const state = this.#channels.get(channelKey(channel));
    return state ? { ...state.assets } : {};
  }

  /* ── In-Memory Chat Operations ───────────────────────────── */

  ingestMessage({ channel, text, tags = null, prefix = '' } = {}) {
    const raw = typeof text === 'string' ? text : '';
    const view = this.#view(channel);
    const emoteIdMap = this.#twitchEmoteIds(raw, tags);
    this.#rememberNativeNames(channel, Object.keys(emoteIdMap));
    const twitchNames = this.#nativeNames.get(channelKey(channel)) || new Set(Object.keys(emoteIdMap));

    const textForLogs = this.#flag(view, raw, twitchNames);
    const body = prefix ? raw.slice(prefix.length).replace(/^,\s*/, '').trim() : raw;
    const textForAi = prefix ? this.#flag(view, body, twitchNames) : textForLogs;

    const trimmed = textForAi.trim();
    return {
      textForAi,
      textForLogs,
      emoteIdMap,
      isEmoteOnly: trimmed.length > 0 && EMOTE_ONLY.test(trimmed)
    };
  }

  decorateReply(channel, rawReply, { appendEmote = true, maxLength = null } = {}) {
    const raw = String(rawReply ?? '');
    const hasTaggedEmote = /(?<!\S)emote:\S+/.test(raw);
    const view = this.#view(channel);
    const hasBareEmote = Boolean(view.space) && raw.split(URL_SPLIT).some(segment => {
      if (/^https?:\/\//.test(segment)) return false;
      view.space.lastIndex = 0;
      return view.space.test(segment);
    });
    let out = raw.replace(/(?<!\S)emote:/g, '').replace(/\s+/g, ' ').trim();
    if (!out) return out;

    out = this.#spaceEmotes(view, out);

    if (appendEmote && this.#cfg.appendEnabled && !hasTaggedEmote && !hasBareEmote) {
      const emote = this.#randomEmote(view);
      if (emote && (!maxLength || out.length + emote.length + 1 <= maxLength)) {
        out = `${out} ${emote}`;
      }
    }
    return out;
  }

  getHarnessInstructions() {
    return getEmoteHarness(this.#cfg.appendEnabled);
  }

  /**
   * Tag recognized channel emotes in arbitrary text as `emote:NAME`.
   * Idempotent: existing `emote:NAME` tokens are left untouched (same
   * `(?<!\S)` boundary as ingest). Null/empty input and unhydrated
   * channels return the original text without throwing.
   */
  flagText(channel, text) {
    if (text == null || text === '') return text;
    return this.#flag(this.#view(channel), String(text), this.#nativeNames.get(channelKey(channel)) || new Set());
  }

  /** Prepare completed model text for memory; model-written markers are not evidence. */
  prepareModelText(channel, text) {
    return this.flagText(channel, this.decorateReply(channel, text, { appendEmote: false }));
  }

  /* ── Internal State & Helpers ────────────────────────────── */

  #emptyState(label) {
    return {
      label,
      twitchId: null,
      sevenTvSetId: null,
      ffzEtag: null,
      lastDeltaAt: { '7tv': 0, bttv: 0, ffz: 0 },
      channelAssets: { '7tv': new Map(), bttv: new Map(), ffz: new Map() },
      idIndex: { '7tv': new Map(), bttv: new Map() },
      assets: {},
      view: EMPTY_VIEW
    };
  }

  #coerceAssets(list, _provider) {
    const out = [];
    for (const item of list || []) {
      if (item?.name) {
        out.push(item);
      }
    }
    return out;
  }

  #readChannelFetch(raw, provider) {
    if (raw && typeof raw === 'object' && !Array.isArray(raw) && Array.isArray(raw.emotes)) {
      return {
        emoteSetId: raw.emoteSetId || null,
        etag: raw.etag || null,
        emotes: this.#coerceAssets(raw.emotes, provider)
      };
    }
    return { emoteSetId: null, etag: null, emotes: this.#coerceAssets(raw, provider) };
  }

  #merge(state) {
    const assets = {};
    const ingest = new Set();
    const pool = new Set();
    const write = (map, intoPool) => {
      for (const [name, asset] of map) {
        ingest.add(name);
        assets[name] = { url: asset.url || '', provider: asset.provider };
        if (intoPool) pool.add(name);
      }
    };
    // Collision precedence: FFZ global < BTTV global < 7TV global < FFZ channel < BTTV channel < 7TV channel
    write(this.#globals.ffz, this.#cfg.globals.ffz);
    write(this.#globals.bttv, this.#cfg.globals.bttv);
    write(this.#globals['7tv'], this.#cfg.globals['7tv']);
    write(state.channelAssets.ffz, true);
    write(state.channelAssets.bttv, true);
    write(state.channelAssets['7tv'], true);
    return { assets, ingest, pool };
  }

  #rebuild(key, { persist = true, emit = true } = {}) {
    const state = this.#channels.get(key);
    if (!state) return;
    const merged = this.#merge(state);
    state.assets = merged.assets;
    state.view = this.#compile(merged.ingest, merged.pool);
    this.#rebuildUnion();
    if (persist) this.#persist(key).catch(e => console.error(`[Emotes] cache write failed: ${e.message || e}`));
    if (emit) this.#emitUpdate(key);
  }

  #rebuildUnion() {
    const unionIngest = new Set();
    const unionPool = new Set();
    const unionAssets = {};
    for (const state of this.#channels.values()) {
      for (const token of state.view.tokens) unionIngest.add(token);
      for (const token of state.view.pool) unionPool.add(token);
      Object.assign(unionAssets, state.assets);
    }
    for (const p of PLATFORMS) {
      for (const [name, asset] of this.#globals[p]) {
        unionIngest.add(name);
        if (this.#cfg.globals[p]) unionPool.add(name);
        if (!unionAssets[name]) unionAssets[name] = { url: asset.url || '', provider: asset.provider };
      }
    }
    this.#unionView = this.#compile(unionIngest, unionPool);
    this.#unionAssets = unionAssets;
  }

  #view(channel) {
    const key = channelKey(channel);
    return (key && this.#channels.get(key)?.view) || this.#unionView;
  }

  #isCold() {
    if (this.#channels.size === 0) return false;
    for (const state of this.#channels.values()) {
      if (state.view.tokens.length === 0) return true;
    }
    return false;
  }

  #dropChannel(key) {
    this.#nativeNames.delete(key);
    const state = this.#channels.get(key);
    if (!state) return;
    if (state.sevenTvSetId) this.#setIdToChannel.delete(state.sevenTvSetId);
    if (state.twitchId) this.#twitchIdToChannel.delete(state.twitchId);
    this.#channels.delete(key);
  }

  #emitUpdate(key) {
    const state = this.#channels.get(key);
    if (!state) return;
    const payload = { channel: state.label || key, emotes: { ...state.assets } };
    for (const fn of this.#listeners) {
      try { fn(payload); } catch (e) { console.error(`[Emotes] update listener failed: ${e.message || e}`); }
    }
  }

  /* ── Redis Hydration & Persistence ───────────────────────── */

  async #hydrateFromCache() {
    if (!this.#storage) return;
    try {
      const globalSnap = await this.#storage.getJson(CACHE_GLOBALS);
      if (globalSnap && typeof globalSnap === 'object') {
        for (const p of PLATFORMS) {
          if (globalSnap[p] && typeof globalSnap[p] === 'object') {
            this.#globals[p] = new Map(Object.entries(globalSnap[p]));
          }
        }
      }
    } catch (e) {
      console.error(`[Emotes] globals hydration failed: ${e.message || e}`);
    }

    await Promise.all([...this.#channels.keys()].map(async (key) => {
      try {
        const snap = await this.#storage.getJson(this.#cfg.cachePrefix + key.slice(1));
        if (!snap || typeof snap !== 'object') return;
        const state = this.#channels.get(key);
        if (!state) return;
        if (snap.twitchId) {
          state.twitchId = String(snap.twitchId);
          this.#twitchIdToChannel.set(state.twitchId, key);
        }
        if (snap.sevenTvSetId) {
          state.sevenTvSetId = String(snap.sevenTvSetId);
          this.#setIdToChannel.set(state.sevenTvSetId, key);
        }
        if (snap.ffzEtag) state.ffzEtag = snap.ffzEtag;
        if (snap.channelAssets && typeof snap.channelAssets === 'object') {
          for (const p of PLATFORMS) {
            if (snap.channelAssets[p]) {
              state.channelAssets[p] = new Map(Object.entries(snap.channelAssets[p]));
            }
          }
        } else if (snap.assets && typeof snap.assets === 'object') {
          for (const [name, asset] of Object.entries(snap.assets)) {
            const p = asset?.provider;
            if (p && state.channelAssets[p]) {
              state.channelAssets[p].set(name, { name, url: asset.url || '', provider: p, id: asset.id || null });
            }
          }
        }
        this.#reindex(state);
      } catch (e) {
        console.error(`[Emotes] channel hydration ${key} failed: ${e.message || e}`);
      }
    }));
  }

  async #persist(key) {
    if (!this.#storage) return;
    const state = this.#channels.get(key);
    if (!state) return;
    return await this.#storage.setJson(this.#cfg.cachePrefix + key.slice(1), {
      updatedAt: Date.now(),
      tokens: state.view.tokens,
      pool: state.view.pool,
      assets: state.assets,
      twitchId: state.twitchId,
      sevenTvSetId: state.sevenTvSetId,
      ffzEtag: state.ffzEtag,
      channelAssets: {
        '7tv': Object.fromEntries(state.channelAssets['7tv']),
        bttv: Object.fromEntries(state.channelAssets.bttv),
        ffz: Object.fromEntries(state.channelAssets.ffz)
      }
    });
  }

  #schedulePersist(key, retry = true) {
    const active = this.#persistTimers.get(key);
    if (active) this.#timer.clearTimeout(active);
    const timer = this.#timer.setTimeout(async () => {
      this.#persistTimers.delete(key);
      try {
        const persisted = await this.#persist(key);
        if (persisted === false) throw new Error('storage unavailable');
      } catch (e) {
        console.error(`[Emotes] cache write failed: ${e.message || e}`);
        if (retry && !this.#disposed) this.#schedulePersist(key, false);
      }
    }, this.#cfg.persistDebounceMs);
    timer?.unref?.();
    this.#persistTimers.set(key, timer);
  }

  async #persistGlobals() {
    if (!this.#storage) return;
    await this.#storage.setJson(CACHE_GLOBALS, {
      updatedAt: Date.now(),
      '7tv': Object.fromEntries(this.#globals['7tv']),
      bttv: Object.fromEntries(this.#globals.bttv),
      ffz: Object.fromEntries(this.#globals.ffz)
    });
  }

  #reindex(state) {
    state.idIndex['7tv'] = new Map();
    state.idIndex.bttv = new Map();
    for (const [name, asset] of state.channelAssets['7tv']) {
      if (asset.id) state.idIndex['7tv'].set(String(asset.id), name);
    }
    for (const [name, asset] of state.channelAssets.bttv) {
      if (asset.id) state.idIndex.bttv.set(String(asset.id), name);
    }
  }

  /* ── REST Refresh ────────────────────────────────────────── */

  async #refreshRest({ providers = PLATFORMS, reason = 'sync' } = {}) {
    const ids = [...new Set([...this.#channels.values()].map(s => s.twitchId).filter(Boolean))];
    // Snapshot of what this fetch actually asked for. Response handlers must
    // never touch channels added afterwards — their IDs were not in the request.
    const targets = new Set(
      [...this.#channels]
        .filter(([key, state]) => state.twitchId && ids.includes(String(state.twitchId)))
    );
    const opts = { timeoutMs: this.#cfg.timeoutMs };
    const startedAt = Date.now();
    const jobs = [];

    for (const p of providers) {
      const provider = this.#providers[p];
      if (!provider) continue;

      jobs.push(this.#guard(`${provider.name} global`, () => provider.fetchGlobal(opts), [])
        .then(list => {
          this.#globals[p] = new Map(
            this.#coerceAssets(list, p).map(a => [a.name, a])
          );
        }));

      jobs.push(this.#guard(`${provider.name} channel`, () => provider.fetchChannel(ids, opts), new Map())
        .then(map => {
          const byId = map instanceof Map ? map : new Map();
          for (const [key, state] of targets) {
            if (this.#channels.get(key) !== state) continue;
            if (state.lastDeltaAt[p] > startedAt) continue; // Live update was newer
            const parsed = this.#readChannelFetch(byId.get(String(state.twitchId)), p);
            if (p === '7tv' && parsed.emoteSetId) {
              if (state.sevenTvSetId) this.#setIdToChannel.delete(state.sevenTvSetId);
              state.sevenTvSetId = parsed.emoteSetId;
              this.#setIdToChannel.set(parsed.emoteSetId, key);
            }
            if (p === 'ffz' && parsed.etag) {
              state.ffzEtag = parsed.etag;
            }
            this.#replaceProviderSet(state, p, parsed.emotes);
          }
        }));
    }

    await Promise.all(jobs);
    await this.#persistGlobals().catch(() => {});
    for (const key of this.#channels.keys()) {
      this.#rebuild(key, { persist: true, emit: true });
      const n = this.#channels.get(key).view.tokens.length;
      console.log(`[Emotes] ${key}: ${n} recognized (${reason})`);
    }
    this.#resubscribe();
  }

  #replaceProviderSet(state, provider, emotes) {
    state.channelAssets[provider] = new Map();
    for (const asset of emotes) state.channelAssets[provider].set(asset.name, asset);
    this.#reindex(state);
  }

  /* ── Live Deltas ─────────────────────────────────────────── */

  #applySevenTvDispatch(d) {
    if (d?.type !== 'emote_set.update') return;
    const setId = d.body?.id ? String(d.body.id) : null;
    const key = setId && this.#setIdToChannel.get(setId);
    const state = key && this.#channels.get(key);
    if (!state) return;

    let changed = false;
    for (const row of d.body.pulled || []) {
      if (row?.key && row.key !== 'emotes') continue;
      const rawId = row?.old_value?.id ?? row?.value?.id;
      const id = rawId != null ? String(rawId) : null;
      const name = (row?.old_value?.name ?? row?.old_value?.data?.name)
        || (id ? state.idIndex['7tv'].get(id) : null);
      if (!name) continue;
      const prev = state.channelAssets['7tv'].get(name);
      state.channelAssets['7tv'].delete(name);
      const prevId = prev?.id != null ? String(prev.id) : id;
      if (prevId) state.idIndex['7tv'].delete(prevId);
      changed = true;
    }
    for (const row of d.body.updated || []) {
      if (row?.key && row.key !== 'emotes') continue;
      const rawOldId = row?.old_value?.id ?? row?.value?.id;
      const oldId = rawOldId != null ? String(rawOldId) : null;
      const oldName = (row?.old_value?.name ?? row?.old_value?.data?.name)
        || (oldId ? state.idIndex['7tv'].get(oldId) : null);
      const next = assetFrom7tvEmote(row?.value || {});
      if (oldName) {
        const prev = state.channelAssets['7tv'].get(oldName);
        state.channelAssets['7tv'].delete(oldName);
        const prevId = prev?.id != null ? String(prev.id) : oldId;
        if (prevId) state.idIndex['7tv'].delete(prevId);
      }
      if (next) {
        state.channelAssets['7tv'].set(next.name, next);
        if (next.id) state.idIndex['7tv'].set(String(next.id), next.name);
      }
      changed = true;
    }
    for (const row of d.body.pushed || []) {
      if (row?.key && row.key !== 'emotes') continue;
      const next = assetFrom7tvEmote(row?.value || {});
      if (!next) continue;
      state.channelAssets['7tv'].set(next.name, next);
      if (next.id) state.idIndex['7tv'].set(String(next.id), next.name);
      changed = true;
    }
    if (!changed) return;
    state.lastDeltaAt['7tv'] = Date.now();
    this.#rebuild(key, { persist: false });
    this.#schedulePersist(key);
  }

  #applyBttvEvent(name, data) {
    const twitchId = String(data?.channel || '').replace(/^twitch:/, '');
    const key = this.#twitchIdToChannel.get(twitchId);
    const state = key && this.#channels.get(key);
    if (!state) return;

    if (name === 'emote_create' || name === 'emote_update') {
      const asset = assetFromBttvEmote(data.emote || {});
      if (!asset) return;
      const oldName = state.idIndex.bttv.get(String(asset.id));
      if (oldName && oldName !== asset.name) state.channelAssets.bttv.delete(oldName);
      state.channelAssets.bttv.set(asset.name, asset);
      state.idIndex.bttv.set(String(asset.id), asset.name);
    } else if (name === 'emote_delete') {
      const id = data.emoteId != null ? String(data.emoteId) : null;
      const oldName = id ? state.idIndex.bttv.get(id) : null;
      if (!oldName) return;
      state.channelAssets.bttv.delete(oldName);
      state.idIndex.bttv.delete(id);
    } else {
      return;
    }
    state.lastDeltaAt.bttv = Date.now();
    this.#rebuild(key, { persist: false });
    this.#schedulePersist(key);
  }

  async #pollFfz() {
    for (const [key, state] of this.#channels) {
      if (!state.twitchId) continue;
      try {
        const result = await fetchFfzRoomConditional(state.twitchId, {
          etag: state.ffzEtag,
          timeoutMs: this.#cfg.timeoutMs,
          fetchImpl: this.#fetch
        });
        if (result.status === 304) continue;
        state.ffzEtag = result.etag || state.ffzEtag;
        state.lastDeltaAt.ffz = Date.now();
        this.#replaceProviderSet(state, 'ffz', result.emotes || []);
        this.#rebuild(key);
      } catch (e) {
        console.error(`[Emotes] FFZ poll ${key} failed: ${e.message || e}`);
      }
    }
  }

  /* ── Listeners & Maintenance ─────────────────────────────── */

  #ensureListeners() {
    if (!this.#wsImpl) return;
    if (!this.#sevenTv) {
      this.#sevenTv = new SevenTvEventListener({
        wsImpl: this.#wsImpl,
        timerImpl: this.#timer,
        random: this.#cfg.random,
        onDispatch: (d) => this.#applySevenTvDispatch(d)
      });
    }
    if (!this.#bttv) {
      this.#bttv = new BttvEventListener({
        wsImpl: this.#wsImpl,
        timerImpl: this.#timer,
        random: this.#cfg.random,
        onEvent: (n, d) => this.#applyBttvEvent(n, d)
      });
    }
  }

  #resubscribe() {
    const setIds = [...this.#channels.values()].map(s => s.sevenTvSetId).filter(Boolean);
    const twitchIds = [...this.#channels.values()].map(s => s.twitchId).filter(Boolean);
    this.#sevenTv?.setSubscriptions(setIds);
    this.#bttv?.setChannels(twitchIds);
  }

  #ensurePoller() {
    if (this.#pollTimer) return;
    this.#pollTimer = this.#timer.setInterval(() => {
      return this.#onMaintenance().catch(e => console.error(`[Emotes] maintenance failed: ${e.message || e}`));
    }, this.#cfg.pollMs);
    this.#pollTimer?.unref?.();
  }

  async #onMaintenance() {
    await this.#pollFfz();
    const stale = [];
    const now = Date.now();
    const isStale = (listener) => {
      if (!listener) return false;
      if (listener.connected) return false;
      const last = listener.lastMessageAt || listener.openedAt || 0;
      return last ? (now - last >= this.#cfg.restFallbackMs) : true;
    };
    if (isStale(this.#sevenTv)) stale.push('7tv');
    if (isStale(this.#bttv)) stale.push('bttv');
    if (stale.length) await this.#refreshRest({ providers: stale, reason: 'rest-fallback' });
  }

  /* ── Text & Regex Internals ──────────────────────────────── */

  #compile(ingestSet, poolSet = ingestSet) {
    const tokens = [...ingestSet].sort((a, b) => b.length - a.length || a.localeCompare(b));
    if (tokens.length === 0) return EMPTY_VIEW;
    const alt = tokens.map(escapeRe).join('|');
    return {
      tokens,
      match: new RegExp(`(?<!\\S)(${alt})(?!\\S)`, 'g'),
      space: new RegExp(`(?<![${WORD}])(${alt})(?![${WORD}])`, 'gu'),
      pool: [...poolSet].sort((a, b) => a.localeCompare(b))
    };
  }

  async #guard(label, fn, fallback) {
    const { timeoutMs } = this.#cfg;
    let timer;
    try {
      return await Promise.race([
        Promise.resolve().then(fn),
        new Promise((_, reject) => {
          timer = this.#timer.setTimeout(() => reject(new Error(`timed out after ${timeoutMs}ms`)), timeoutMs);
          timer.unref?.();
        })
      ]);
    } catch (e) {
      console.error(`[Emotes] ${label} failed: ${e.message || e}`);
      return fallback;
    } finally {
      this.#timer.clearTimeout(timer);
    }
  }

  #twitchEmoteIds(message, tags) {
    const out = {};
    const emotes = tags && typeof tags === 'object' ? tags.emotes : null;
    if (!message || !emotes || typeof emotes !== 'object') return out;

    for (const [emoteId, ranges] of Object.entries(emotes)) {
      if (!Array.isArray(ranges) || ranges.length === 0 || typeof ranges[0] !== 'string') continue;
      const [s, e] = ranges[0].split('-').map(n => Number.parseInt(n, 10));
      if (!Number.isFinite(s) || !Number.isFinite(e) || s < 0 || e < s || e >= message.length) continue;
      const name = message.substring(s, e + 1).trim();
      if (name) out[name] = String(emoteId);
    }
    return out;
  }

  // Twitch tags verify native names. Keep bounded, channel-local evidence for
  // later conversational text; subscriber emotes never enter the append pool.
  #rememberNativeNames(channel, names) {
    const key = channelKey(channel);
    if (!key || names.length === 0) return;
    let known = this.#nativeNames.get(key);
    if (!known) this.#nativeNames.set(key, known = new Set());
    for (const name of names) {
      known.delete(name);
      known.add(name);
      if (known.size > MAX_OBSERVED_TWITCH_EMOTES) known.delete(known.values().next().value);
    }
  }

  #flag(view, text, twitchNames) {
    if (!text) return text || '';
    let out = text;

    if (twitchNames.size > 0) {
      const alt = [...twitchNames].sort((a, b) => b.length - a.length).map(escapeRe).join('|');
      out = out.replace(new RegExp(`(?<!\\S)(${alt})(?!\\S)`, 'g'), m => `emote:${m}`);
    }
    if (view.match) {
      view.match.lastIndex = 0;
      out = out.replace(view.match, m => `emote:${m}`);
    }
    return out;
  }

  #spaceEmotes(view, text) {
    if (!this.#cfg.spacing || !view.space) return text;
    // Never touch URLs — an emote name can legitimately appear inside a media link.
    const spaced = text.split(URL_SPLIT).map(segment => {
      if (/^https?:\/\//.test(segment)) return segment;
      view.space.lastIndex = 0;
      return segment.replace(view.space, (m, _g, offset, whole) => {
        const before = offset > 0 ? whole[offset - 1] : '';
        const after = whole[offset + m.length] || '';
        return `${before && !/\s/.test(before) ? ' ' : ''}${m}${after && !/\s/.test(after) ? ' ' : ''}`;
      });
    }).join('');
    return spaced.replace(/ {2,}/g, ' ').trim();
  }

  #randomEmote(view) {
    if (view.pool.length === 0) return '';
    return view.pool[Math.floor(this.#cfg.random() * view.pool.length)] || '';
  }

  /**
   * Hot-reloads runtime emote settings (auto-appending).
   * @param {object} settings
   */
  reloadSettings({ appendEnabled } = {}) {
    if (appendEnabled !== undefined) this.#cfg.appendEnabled = Boolean(appendEnabled);
    for (const key of this.#channels.keys()) {
      this.#rebuild(key, { persist: false, emit: true });
    }
  }
}

export default EmotePool;
