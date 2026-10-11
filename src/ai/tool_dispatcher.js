export const MAX_TOOL_TURNS = 4;
export const DEFAULT_TOOL_TIMEOUT_MS = 3500;

const SEARCH_TOOL_NAMES = new Set(['search_web', 'web_search']);
const DEFAULT_SEARCH_NAME = 'search_web';
const DEFAULT_SEARCH_DESCRIPTION =
    'Search the web for real-time facts, current events, live stats, and breaking news.';
const DEFAULT_SEARCH_PARAMETERS = {
    type: 'object',
    properties: {
        query: { type: 'string', description: 'The search query' }
    },
    required: ['query']
};
const TOOL_BUDGET_MESSAGE =
    'Answer the current request using the information already retrieved.';

export class ToolDispatcher {
    #tools;
    #searchProvider;
    #searchMode;
    #fetchImpl;
    #defaultTimeoutMs;
    #streamActionsPolicy;

    constructor({
        tools = [],
        searchProvider = null,
        searchMode = 'off',
        streamActionsPolicy = {},
        fetchImpl = (...a) => globalThis.fetch(...a),
        defaultTimeoutMs = DEFAULT_TOOL_TIMEOUT_MS
    } = {}) {
        this.#tools = Array.isArray(tools) ? tools.filter(Boolean) : [];
        this.#searchProvider = searchProvider || null;
        this.#applySearchMode(searchMode);
        this.#streamActionsPolicy = { enabled: true, ...streamActionsPolicy };
        this.#fetchImpl = fetchImpl;
        this.#defaultTimeoutMs = Number(defaultTimeoutMs) > 0
            ? Number(defaultTimeoutMs)
            : DEFAULT_TOOL_TIMEOUT_MS;

        this.#validateToolDeclarations();
    }

    get searchMode() {
        return this.#searchMode;
    }

    get streamActionsPolicy() {
        return { ...this.#streamActionsPolicy };
    }

    setStreamActionsPolicy(policy = {}) {
        this.#streamActionsPolicy = { ...this.#streamActionsPolicy, ...policy };
    }

    reloadSearchMode(searchMode, searchProvider = this.#searchProvider) {
        this.#searchProvider = searchProvider || null;
        this.#applySearchMode(searchMode);
        this.#validateToolDeclarations();
    }

    #applySearchMode(searchMode) {
        const normalized = searchMode === 'tavily' ? 'custom' : searchMode;
        this.#searchMode = normalized === 'google' || normalized === 'custom' ? normalized : 'off';
    }

    #validateToolDeclarations() {
        const seen = new Set();
        const customSearchName = this.#searchMode === 'custom' && this.#searchProvider
            ? (this.#searchProvider.name || DEFAULT_SEARCH_NAME)
            : null;

        if (customSearchName) {
            seen.add(customSearchName);
        }

        for (const tool of this.#tools) {
            if (!tool?.name || typeof tool.name !== 'string') {
                throw new Error('Tool declaration missing valid string name');
            }
            if (this.#searchMode === 'google' && SEARCH_TOOL_NAMES.has(tool.name)) {
                // In google mode, conflicting search tool names are stripped during compilation
                continue;
            }
            if (seen.has(tool.name)) {
                throw new Error(`Duplicate tool declaration name: "${tool.name}"`);
            }
            seen.add(tool.name);
        }
    }

    static resolveSearchMode({
        searchGrounding = null,
        enableSearchGrounding = false,
        searchProvider = null
    } = {}) {
        const supplied = searchGrounding !== null && searchGrounding !== undefined;
        const explicit = String(searchGrounding ?? '').trim().toLowerCase();
        if (supplied && explicit === '') return 'off';
        if (explicit === 'tavily') {
            return searchProvider ? 'custom' : 'off';
        }
        if (explicit === 'google' || explicit === 'custom' || explicit === 'off') {
            if (explicit === 'custom' && !searchProvider) return 'off';
            return explicit;
        }
        if (searchProvider) return 'custom';
        if (enableSearchGrounding === true || enableSearchGrounding === 'true') return 'google';
        return 'off';
    }

    #allowedForCaller(tool, caller) {
        const tier = tool?.tokenTier;
        if (tier === 'broadcaster' || tier === 'moderator') {
            return !!(caller?.isBroadcaster || caller?.isMod);
        }
        return true;
    }

    compileTools({ hasWebpageUrls = false, disableMultimedia = false, disableTools = false, caller, channelContext } = {}) {
        if (disableTools) return undefined;
        if (disableMultimedia) return undefined;

        const compiled = [];
        if (hasWebpageUrls) compiled.push({ type: 'url_context' });
        if (this.#searchMode === 'google') compiled.push({ type: 'google_search' });

        const declarations = this.#compileFunctionDeclarations(caller, channelContext);
        if (declarations.length > 0) {
            compiled.push(...declarations);
        }
        return compiled.length > 0 ? compiled : undefined;
    }

    hasGoogleSearch(tools) {
        if (!Array.isArray(tools)) return false;
        return tools.some(t => t?.type === 'google_search');
    }

    withoutFunctionDeclarations(tools) {
        if (!tools?.length) return tools;
        const filtered = tools.filter(t => t.type !== 'function');
        return filtered.length > 0 ? filtered : undefined;
    }

    withoutGoogleSearch(tools) {
        if (!tools?.length) return tools;
        const filtered = tools.filter(t => t?.type !== 'google_search');
        return filtered.length > 0 ? filtered : undefined;
    }

    #compileFunctionDeclarations(caller, channelContext) {
        const decls = [];
        const searchTool = this.#customSearchTool();
        if (searchTool) decls.push(this.#toDeclaration(searchTool));

        const policy = { ...this.#streamActionsPolicy };
        for (const tool of this.#tools) {
            if (!tool?.name) continue;
            if (this.#searchMode === 'google' && SEARCH_TOOL_NAMES.has(tool.name)) continue;
            if (searchTool && tool.name === searchTool.name) continue;
            if (!this.#allowedForCaller(tool, caller)) continue;
            if (tool.streamActionFamily) {
                if (policy.enabled === false) continue;
                if (policy[`${tool.streamActionFamily}_enabled`] === false) continue;
                if (tool.requiresLive && channelContext?.isLive === false) continue;
            }
            decls.push(this.#toDeclaration(tool));
        }
        return decls;
    }

    #customSearchTool() {
        if (this.#searchMode !== 'custom' || !this.#searchProvider) return null;
        const provider = this.#searchProvider;
        if (typeof provider.isAvailable === 'function' && !provider.isAvailable()) {
            return null;
        }
        return {
            name: provider.name || DEFAULT_SEARCH_NAME,
            description: provider.description || DEFAULT_SEARCH_DESCRIPTION,
            parameters: provider.parameters || DEFAULT_SEARCH_PARAMETERS,
            timeoutMs: provider.timeoutMs,
            execute: async (args, context) => provider.search(args?.query, context)
        };
    }

    #toDeclaration(tool) {
        return {
            type: 'function',
            name: tool.name,
            description: tool.description || '',
            parameters: tool.parameters || { type: 'object', properties: {} }
        };
    }

    #lookupTool(name) {
        const searchTool = this.#customSearchTool();
        if (searchTool && searchTool.name === name) return searchTool;
        if (this.#searchMode === 'google' && SEARCH_TOOL_NAMES.has(name)) return null;
        return this.#tools.find(t => t.name === name) || null;
    }

    #extractFunctionCalls(result) {
        return (result?.steps || []).filter(step => step.type === 'function_call').map(step => ({
            name: step.name, args: this.#normalizeArgs(step.arguments), id: step.id
        }));
    }

    #normalizeArgs(args) {
        if (args == null) return {};
        if (typeof args === 'string') {
            try { return JSON.parse(args); } catch { return { raw: args }; }
        }
        return args;
    }

    async executeTurnLoop({
        contents,
        tools,
        invokeModel,
        context = {},
        maxTurns = MAX_TOOL_TURNS
    }) {
        const workingContents = [...contents];
        const limit = Math.max(1, parseInt(maxTurns, 10) || MAX_TOOL_TURNS);
        let result = null;
        let turnCount = 0;

        for (let turn = 0; turn < limit; turn++) {
            const isLast = turn === limit - 1;
            const turnTools = (isLast && turn > 0)
                ? this.withoutFunctionDeclarations(tools)
                : tools;

            // Force text synthesis on the last call of a multi-turn loop.
            if (isLast && turn > 0) {
                workingContents.push({
                    type: 'user_input',
                    content: [{ type: 'text', text: TOOL_BUDGET_MESSAGE }]
                });
            }

            result = await invokeModel({ contents: workingContents, tools: turnTools });
            turnCount += 1;

            const functionCalls = this.#extractFunctionCalls(result);
            if (functionCalls.length === 0) {
                return { result, turnCount, workingContents, stopped: 'text' };
            }
            if (isLast) {
                return { result, turnCount, workingContents, stopped: 'ceiling' };
            }

            const responseParts = await this.#dispatchFunctionCalls(functionCalls, context);
            const fatalPart = responseParts.find((p) => p?.result?.fatal);
            if (fatalPart) {
                const response = fatalPart.result;
                return {
                    result,
                    turnCount,
                    workingContents,
                    stopped: 'error',
                    errorKey: response.errorKey || response.error
                };
            }

            // Replay the complete timeline unchanged, including opaque thought
            // signatures and built-in tool steps, before our function results.
            workingContents.push(...(result.steps || []), ...responseParts);
        }

        return { result, turnCount, workingContents, stopped: 'ceiling' };
    }

    async #dispatchFunctionCalls(functionCalls, context) {
        return Promise.all(functionCalls.map(fc => this.#executeOne(fc, context)));
    }

    async #executeOne(fc, context) {
        const trace = context?.trace;
        const started = performance.now();
        trace?.event?.('tool.started', { name: fc.name });
        const tool = this.#lookupTool(fc.name);
        if (!tool) {
            trace?.event?.('tool.finished', {
                name: fc.name,
                outcome: 'failed',
                durationMs: performance.now() - started,
                reason: 'unknown tool'
            });
            return this.#functionResponse(fc, { error: `Unknown tool: ${fc.name}` });
        }
        if (!this.#allowedForCaller(tool, context?.caller)) {
            trace?.event?.('tool.finished', {
                name: tool.name,
                outcome: 'failed',
                durationMs: performance.now() - started,
                reason: 'permission denied'
            });
            return this.#functionResponse(fc, { error: 'You do not have permission to use this tool.' });
        }

        const timeoutMs = Number(tool.timeoutMs) > 0 ? Number(tool.timeoutMs) : this.#defaultTimeoutMs;
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);

        try {
            const payload = await Promise.race([
                Promise.resolve().then(() => tool.execute(fc.args, {
                    ...context,
                    fetchImpl: this.#fetchImpl,
                    signal: controller.signal
                })),
                this.#timeoutPromise(controller.signal, tool.name, timeoutMs)
            ]);
            trace?.event?.('tool.finished', {
                name: tool.name,
                outcome: payload?.error ? 'failed' : 'succeeded',
                durationMs: performance.now() - started,
                reason: payload?.error ? String(payload.error) : undefined
            });
            return this.#safeFunctionResponse(fc, payload);
        } catch (err) {
            const timedOut = controller.signal.aborted;
            trace?.event?.('tool.finished', {
                name: tool.name,
                outcome: 'failed',
                durationMs: performance.now() - started,
                reason: timedOut ? `timed out after ${timeoutMs}ms` : (err?.message || String(err))
            });
            if (timedOut && tool.tokenTier) {
                return this.#functionResponse(fc, {
                    error: 'HELIX_ACTION_TIMEOUT',
                    errorKey: 'HELIX_ACTION_TIMEOUT',
                    fatal: true
                });
            }
            const message = timedOut
                ? `Tool ${tool.name} timed out after ${timeoutMs}ms`
                : (err?.message || String(err));
            return this.#functionResponse(fc, { error: message });
        } finally {
            clearTimeout(timer);
        }
    }

    #timeoutPromise(signal, name, timeoutMs) {
        return new Promise((_, reject) => {
            const fail = () => reject(new Error(`Tool ${name} timed out after ${timeoutMs}ms`));
            if (signal.aborted) fail();
            else signal.addEventListener('abort', fail, { once: true });
        });
    }

    #safeFunctionResponse(fc, payload) {
        if (payload && typeof payload === 'object' && payload.error != null && !('output' in payload)) {
            const response = { error: String(payload.error) };
            if (payload.errorKey) response.errorKey = String(payload.errorKey);
            if (payload.fatal) response.fatal = true;
            return this.#functionResponse(fc, response);
        }
        const response = { output: payload ?? null };
        try {
            JSON.stringify(response);
        } catch {
            return this.#functionResponse(fc, { error: 'Tool result could not be serialized' });
        }
        return this.#functionResponse(fc, response);
    }

    #functionResponse(fc, response) {
        return {
            type: 'function_result', name: fc.name, call_id: fc.id,
            result: response, ...(response.error ? { is_error: true } : {})
        };
    }
}

export default ToolDispatcher;
