const SECRET_KEY = /^(?:api[-_]?key|authorization|credential|password|secret|token|access[-_]?token|refresh[-_]?token|auth[-_]?token)$/i;

const noop = () => {};

const NOOP_INVOCATION_TRACE = Object.freeze({
    id: null,
    enabled: false,
    event: noop,
    nextGeminiCall: () => 0,
    markFailed: noop,
    markRejected: noop,
    terminal: noop,
    get outcomeHint() { return null; },
    get terminalState() { return null; }
});

export const NOOP_EXECUTION_TRACE = Object.freeze({
    enabled: false,
    begin: () => NOOP_INVOCATION_TRACE
});

function byteCountFromBase64(data) {
    const value = String(data || '');
    if (!value) return 0;
    const padding = value.endsWith('==') ? 2 : value.endsWith('=') ? 1 : 0;
    return Math.max(0, Math.floor((value.length * 3) / 4) - padding);
}

function makeSanitizer(redactions) {
    const secrets = [...new Set((redactions || [])
        .map((value) => String(value || ''))
        .filter((value) => value.length >= 4))];

    const redactText = (value) => {
        let result = String(value ?? '');
        for (const secret of secrets) {
            result = result.split(secret).join('[REDACTED]');
        }
        return result;
    };

    const sanitize = (value, key = '', seen = new WeakSet()) => {
        if (SECRET_KEY.test(key)) return '[REDACTED]';
        if (typeof value === 'string') return redactText(value);
        if (value == null || typeof value !== 'object') return value;
        if (seen.has(value)) return '[Circular]';
        seen.add(value);

        if (Array.isArray(value)) {
            const result = value.map((item) => sanitize(item, '', seen));
            seen.delete(value);
            return result;
        }

        const result = {};
        for (const [childKey, child] of Object.entries(value)) {
            if (childKey === 'data' && ['image', 'audio', 'video', 'document'].includes(value.type)) {
                result[childKey] = typeof child === 'string'
                    ? `[binary omitted: ${byteCountFromBase64(child).toLocaleString('en-US')} bytes, ${child.length.toLocaleString('en-US')} base64 chars]`
                    : '[binary omitted]';
                continue;
            }
            result[childKey] = sanitize(child, childKey, seen);
        }
        seen.delete(value);
        return result;
    };

    return { redactText, sanitize };
}

function json(value, sanitize) {
    try {
        const rendered = JSON.stringify(sanitize(value));
        return rendered === undefined ? String(value) : rendered;
    } catch {
        return '[unrenderable value]';
    }
}

function scalar(value, sanitize) {
    if (typeof value === 'string') return sanitize(value);
    return json(value, (item) => item);
}

function multiline(lines, label, value, sanitize) {
    const rendered = sanitize(String(value ?? ''));
    const parts = rendered.split(/\r?\n/);
    lines.push(parts[0] ? `${label}: ${parts[0]}` : `${label}:`);
    const continuationIndent = `${label.match(/^\s*/)?.[0] || ''}  `;
    for (const part of parts.slice(1)) lines.push(part ? `${continuationIndent}${part}` : '');
}

function textBlock(lines, value, sanitize, indent = '  ') {
    const rendered = sanitize(String(value ?? ''));
    for (const part of rendered.split(/\r?\n/)) {
        lines.push(part ? `${indent}${part}` : '');
    }
}

function renderSteps(lines, steps, tools, prefix = 'steps') {
    if (!Array.isArray(steps)) {
        lines.push(`${prefix}: ${json(steps, tools.sanitize)}`);
        return;
    }
    steps.forEach((step, index) => {
        const path = `${prefix}[${index}]`;
        lines.push(`${path} ${tools.redactText(step?.type || 'unknown')}`);
        for (const [key, value] of Object.entries(step || {})) {
            if (key === 'type') continue;
            if (key === 'content' && Array.isArray(value)) {
                value.forEach((part, partIndex) => {
                    if (part.type === 'text') multiline(lines, `${path}.content[${partIndex}] text`, part.text, tools.redactText);
                    else lines.push(`${path}.content[${partIndex}]: ${json(part, tools.sanitize)}`);
                });
            } else {
                lines.push(`${path}.${key}: ${json(value, tools.sanitize)}`);
            }
        }
    });
}

function schemaType(schema) {
    if (!schema || typeof schema !== 'object') return 'unknown';
    const type = Array.isArray(schema.type) ? schema.type.join('|') : schema.type;
    if (type === 'array') return `array<${schemaType(schema.items)}>`;
    if (type) return String(type);
    if (Array.isArray(schema.enum)) return 'enum';
    if (Array.isArray(schema.oneOf)) return 'oneOf';
    if (Array.isArray(schema.anyOf)) return 'anyOf';
    return 'unknown';
}

function renderSchemaProperties(lines, schema, tools, indent) {
    if (!schema || typeof schema !== 'object') {
        lines.push(`${indent}schema: ${json(schema, tools.sanitize)}`);
        return;
    }

    const required = new Set(Array.isArray(schema.required) ? schema.required : []);
    const properties = schema.properties && typeof schema.properties === 'object'
        ? Object.entries(schema.properties)
        : [];

    if (properties.length === 0) lines.push(`${indent}(no parameters)`);
    for (const [name, property] of properties) {
        const isRequired = required.has(name);
        const description = typeof property?.description === 'string'
            ? ` — ${tools.redactText(property.description)}`
            : '';
        lines.push(`${indent}${tools.redactText(name)} (${isRequired ? 'required' : 'optional'}): ${schemaType(property)}${description}`);

        const constraints = Object.fromEntries(Object.entries(property || {}).filter(
            ([key]) => !['type', 'description', 'properties', 'required'].includes(key)
        ));
        if (Object.keys(constraints).length > 0) {
            lines.push(`${indent}  constraints: ${json(constraints, tools.sanitize)}`);
        }
        if (property?.properties) {
            renderSchemaProperties(lines, property, tools, `${indent}  `);
        }
    }

    const schemaMetadata = Object.fromEntries(Object.entries(schema).filter(
        ([key]) => !['type', 'description', 'properties', 'required'].includes(key)
    ));
    if (Object.keys(schemaMetadata).length > 0) {
        lines.push(`${indent}schema constraints: ${json(schemaMetadata, tools.sanitize)}`);
    }
}

function renderFunctionDeclaration(lines, declaration, declarationIndex, tools) {
    if (!declaration || typeof declaration !== 'object') {
        lines.push(`    function[${declarationIndex}]: ${json(declaration, tools.sanitize)}`);
        return;
    }

    const schema = declaration.parameters;
    const required = new Set(Array.isArray(schema?.required) ? schema.required : []);
    const properties = schema?.properties && typeof schema.properties === 'object'
        ? Object.entries(schema.properties)
        : [];
    const signature = properties.map(([name, property]) => (
        `${tools.redactText(name)}${required.has(name) ? '' : '?'}: ${schemaType(property)}`
    )).join(', ');
    const name = tools.redactText(declaration.name || '<unnamed>');
    lines.push(`    function[${declarationIndex}] ${name}(${signature})`);
    if (typeof declaration.description === 'string') {
        multiline(lines, '      description', declaration.description, tools.redactText);
    }
    renderSchemaProperties(lines, schema, tools, '      ');

    const remaining = Object.fromEntries(Object.entries(declaration).filter(
        ([key]) => !['type', 'name', 'description', 'parameters'].includes(key)
    ));
    if (Object.keys(remaining).length > 0) {
        lines.push(`      metadata: ${json(remaining, tools.sanitize)}`);
    }
}

function renderTools(lines, configuredTools, tools) {
    lines.push('Tools (available)');
    if (!Array.isArray(configuredTools) || configuredTools.length === 0) {
        lines.push('  (none)');
        return;
    }

    configuredTools.forEach((tool, toolIndex) => {
        if (!tool || typeof tool !== 'object') {
            lines.push(`  tool[${toolIndex}]: ${json(tool, tools.sanitize)}`);
            return;
        }

        if (tool.type === 'function') renderFunctionDeclaration(lines, tool, toolIndex, tools);
        else lines.push(`  tool[${toolIndex}]: ${json(tool, tools.sanitize)}`);
    });
}

function renderSystemInstruction(lines, instruction, tools) {
    lines.push('System instruction (trusted)');
    if (instruction == null || instruction === '') {
        lines.push('  (none)');
    } else if (typeof instruction === 'string') {
        textBlock(lines, instruction, tools.redactText);
    } else {
        lines.push(`  ${json(instruction, tools.sanitize)}`);
    }
}

function renderGenerationConfig(lines, config, tools) {
    lines.push('Generation config');
    if (!config || typeof config !== 'object') {
        lines.push(`  ${json(config, tools.sanitize)}`);
        return;
    }

    const entries = Object.entries(config);
    if (entries.length === 0) lines.push('  (defaults)');
    for (const [key, value] of entries) {
        lines.push(`  ${key}: ${json(value, tools.sanitize)}`);
    }
}

function renderSafetySettings(lines, settings, tools) {
    lines.push('Safety settings');
    if (!Array.isArray(settings) || settings.length === 0) {
        lines.push('  (none)');
        return;
    }

    settings.forEach((setting, index) => {
        if (!setting || typeof setting !== 'object') {
            lines.push(`  [${index}]: ${json(setting, tools.sanitize)}`);
            return;
        }
        const category = tools.redactText(setting.type || '<unspecified>');
        const threshold = tools.redactText(setting.threshold || '<unspecified>');
        lines.push(`  [${index}] ${category}: ${threshold}`);
        const remaining = Object.fromEntries(Object.entries(setting).filter(
            ([key]) => !['type', 'threshold'].includes(key)
        ));
        if (Object.keys(remaining).length > 0) {
            lines.push(`    metadata: ${json(remaining, tools.sanitize)}`);
        }
    });
}

function renderGeminiRequest({ call, request, policy }, tools) {
    const lines = [`Gemini call ${call} request`];
    if (!request || typeof request !== 'object') {
        lines.push(`request: ${json(request, tools.sanitize)}`);
        return lines;
    }
    lines.push('Application deadline', `  deadline: ${Number(policy?.deadlineMs || 0)}ms`, '  attempts: 1');
    lines.push('Model', `  name: ${scalar(request.model, tools.redactText)}`);
    renderSystemInstruction(lines, request.system_instruction, tools);
    lines.push('Input (ordered)');
    renderSteps(lines, request.input, tools, '  input');
    renderTools(lines, request.tools, tools);
    renderSafetySettings(lines, request.safety_settings, tools);
    renderGenerationConfig(lines, request.generation_config, tools);
    for (const [key, value] of Object.entries(request)) {
        if (!['model', 'input', 'system_instruction', 'tools', 'safety_settings', 'generation_config'].includes(key)) {
            lines.push(`${key}: ${json(value, tools.sanitize)}`);
        }
    }
    return lines;
}

function renderGeminiResponse({ call, response }, tools) {
    const lines = [`Gemini call ${call} response`];
    if (!response || typeof response !== 'object') {
        lines.push(`response: ${json(response, tools.sanitize)}`);
        return lines;
    }
    renderSteps(lines, response.steps, tools);
    for (const [key, value] of Object.entries(response)) {
        if (!['steps', 'sdkHttpResponse'].includes(key)) lines.push(`${key}: ${json(value, tools.sanitize)}`);
    }
    return lines;
}

function renderEvent(type, details, tools) {
    const duration = details.durationMs == null ? '' : ` after ${Number(details.durationMs).toFixed(1)}ms`;
    switch (type) {
        case 'invocation.started':
            return [
                `Invocation ${details.kind}${details.command ? ` ${tools.redactText(details.command)}` : ''}`,
                `Requester ${tools.redactText(details.requester || 'unknown')} in ${tools.redactText(details.channel || 'unknown')}`,
                `Route classified as ${details.kind}${details.mediaType ? ` (${details.mediaType})` : ''}`
            ];
        case 'response.intended':
            return [`Intended response: ${tools.redactText(details.text || '')}`];
        case 'response.delivered':
            return [`Delivered response: ${tools.redactText(details.text || '')}`];
        case 'twitch.send.started':
            return [`Twitch send started${details.reply ? ' (reply)' : ''}`];
        case 'twitch.send.accepted':
            return [`Twitch Helix send accepted${duration}`];
        case 'twitch.send.failed':
            return [`Twitch Helix send failed${duration}: ${tools.redactText(details.reason || 'unknown error')}`];
        case 'gemini.request':
            return renderGeminiRequest(details, tools);
        case 'gemini.response':
            return renderGeminiResponse(details, tools);
        case 'gemini.failed':
            return [`Gemini call ${details.call} failed${duration}: ${tools.redactText(details.reason || 'unknown error')}`];
        case 'gemini.attempt.succeeded':
            return [`Gemini call ${details.call} accepted on key #${details.keySlot}${duration}`];
        case 'tool.started':
            return [`Local tool ${tools.redactText(details.name || '<unknown>')} started`];
        case 'tool.finished':
            return [`Local tool ${tools.redactText(details.name || '<unknown>')} ${details.outcome || 'finished'}${duration}${details.reason ? `: ${tools.redactText(details.reason)}` : ''}`];
        case 'media.target': {
            const options = details.options && Object.keys(details.options).length > 0
                ? ` options=${json(details.options, tools.sanitize)}`
                : '';
            return [`Media target type=${details.mediaType} provider=${details.provider || '<none>'} model=${details.model || '<none>'}${options}`];
        }
        case 'media.generation.started':
            return [`Media generation started (${details.provider}/${details.model})`];
        case 'media.generation.succeeded':
            return [`Media generation succeeded${duration}: ${details.mimeType || 'unknown MIME'}, ${Number(details.bytes || 0).toLocaleString('en-US')} bytes`];
        case 'media.generation.failed':
            return [`Media generation failed${duration}: ${tools.redactText(details.reason || 'unknown error')}`];
        case 'upload.started':
            return [`CDN upload ${details.host} started`];
        case 'upload.succeeded':
            return [`CDN upload ${details.host} succeeded${duration}: ${tools.redactText(details.url || '')}`];
        case 'upload.failed':
            return [`CDN upload ${details.host} failed${duration}: ${tools.redactText(details.reason || 'unknown error')}`];
        case 'media.presentation.started':
            return ['Gemini media presentation started'];
        case 'media.presentation.finished':
            return [`Gemini media presentation ${details.outcome || 'finished'}${duration}`];
        case 'stage.rejected':
            return [`Rejected stage: ${tools.redactText(details.reason || 'unspecified')}`];
        case 'stage.failed':
            return [`Failed stage: ${tools.redactText(details.reason || 'unspecified')}`];
        case 'terminal':
            return [`Terminal ${details.outcome}${duration}${details.reason ? `: ${tools.redactText(details.reason)}` : ''}`];
        default:
            return [`${type}: ${json(details, tools.sanitize)}`];
    }
}

class InvocationTrace {
    #emit;
    #clock;
    #started;
    #geminiCalls = 0;
    #outcomeHint = null;
    #terminalState = null;

    constructor({ id, emit, clock, details }) {
        this.id = id;
        this.enabled = true;
        this.#emit = emit;
        this.#clock = clock;
        this.#started = clock();
        this.event('invocation.started', details);
    }

    event(type, details = {}) {
        if (this.#terminalState) return;
        try {
            this.#emit(this.id, type, details);
        } catch {
            // Trace output is observational and must never affect execution.
        }
    }

    nextGeminiCall() {
        this.#geminiCalls += 1;
        return this.#geminiCalls;
    }

    markFailed(reason) {
        if (this.#terminalState) return;
        if (this.#outcomeHint?.outcome === 'failed') return;
        this.#outcomeHint = { outcome: 'failed', reason: String(reason || 'operation failed') };
        this.event('stage.failed', { reason: this.#outcomeHint.reason });
    }

    markRejected(reason) {
        if (this.#terminalState || this.#outcomeHint?.outcome === 'failed') return;
        this.#outcomeHint = { outcome: 'rejected', reason: String(reason || 'operation rejected') };
        this.event('stage.rejected', { reason: this.#outcomeHint.reason });
    }

    terminal(outcome = null, reason = null) {
        if (this.#terminalState) return;
        const selected = outcome
            ? { outcome, reason }
            : (this.#outcomeHint || { outcome: 'completed', reason: null });
        this.#terminalState = selected.outcome;
        try {
            this.#emit(this.id, 'terminal', {
                outcome: selected.outcome,
                reason: selected.reason || undefined,
                durationMs: Math.max(0, this.#clock() - this.#started)
            });
        } catch {
            // Trace output is observational and must never affect execution.
        }
    }

    get outcomeHint() { return this.#outcomeHint; }
    get terminalState() { return this.#terminalState; }
}

export class ExecutionTrace {
    #sink;
    #renderer;
    #clock;
    #counter = 0;
    #tools;

    constructor({ sink = (line) => console.log(line), renderer = renderEvent, clock = () => performance.now(), redactions = [] } = {}) {
        this.enabled = true;
        this.#sink = typeof sink === 'function' ? sink : noop;
        this.#renderer = typeof renderer === 'function' ? renderer : renderEvent;
        this.#clock = clock;
        this.#tools = makeSanitizer(redactions);
    }

    begin(details = {}) {
        this.#counter += 1;
        const id = `T${String(this.#counter).padStart(3, '0')}`;
        return new InvocationTrace({
            id,
            clock: this.#clock,
            details,
            emit: (traceId, type, eventDetails) => this.#emit(traceId, type, eventDetails)
        });
    }

    #emit(id, type, details) {
        let rendered;
        try {
            rendered = this.#renderer(type, details, this.#tools);
        } catch {
            return;
        }
        const lines = Array.isArray(rendered) ? rendered : [rendered];
        for (const renderedLine of lines) {
            for (const physicalLine of String(renderedLine ?? '').split(/\r?\n/)) {
                try {
                    this.#sink(physicalLine ? `[${id}] ${physicalLine}` : `[${id}]`);
                } catch {
                    // A failing sink cannot escape the trace boundary.
                }
            }
        }
    }
}

export function createExecutionTrace({ enabled = false, ...options } = {}) {
    return enabled ? new ExecutionTrace(options) : NOOP_EXECUTION_TRACE;
}

export function createCaptureExecutionTrace(options = {}) {
    const lines = [];
    const trace = new ExecutionTrace({ ...options, sink: (line) => lines.push(line) });
    return { trace, lines };
}
