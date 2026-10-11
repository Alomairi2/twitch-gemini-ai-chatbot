import { BotError } from '../utils/error_handler.js';

const STATUS_CODES = {
    invalid_argument: 400, unauthenticated: 401, permission_denied: 403,
    not_found: 404, resource_exhausted: 429, internal: 500,
    unavailable: 503, deadline_exceeded: 504,
    invalid_request: 400, parameter_unknown: 400, invalid_api_key: 401,
    failed_precondition: 400, authentication: 401, authentication_error: 401, permission_error: 403,
    model_not_found: 404,
    rate_limit_exceeded: 429, quota_exceeded: 429, too_many_requests: 429,
    api_error: 500, unimplemented: 501, server_error: 500, service_unavailable: 503
};

const RPC_STATUS_CODES = { 3: 400, 4: 504, 5: 404, 7: 403, 8: 429, 13: 500, 14: 503, 16: 401 };

// Interactions can report a failed execution inside an HTTP 200 response.
// Reject it before dispatching tools, returning media, or committing memory.
export function assertInteractionSucceeded(interaction, { allowIncompleteText = false } = {}) {
    const errors = [
        ...(interaction?.errors || []),
        ...(interaction?.steps || []).flatMap(step => step.error ? [step.error] : [])
    ];
    if (errors.length) {
        const detail = errors.map(error => `${error.code || ''} ${error.message || ''}`).join('; ');
        if (/safety|blocked|prohibited|responsible.ai/i.test(detail)) {
            throw new BotError('CONTENT_BLOCKED');
        }
        const error = errors[0];
        const status = STATUS_CODES[String(error.code).toLowerCase()] || RPC_STATUS_CODES[error.code];
        const key = status >= 500 ? (status === 504 ? 'HTTP_504' : 'HTTP_500') : status ? `HTTP_${status}` : 'UNKNOWN_ERROR';
        throw new BotError(key, {
            status, cause: new Error(detail)
        });
    }
    const incompleteText = allowIncompleteText && interaction?.status === 'incomplete'
        && !interaction.steps?.some(step => step.type === 'function_call')
        && interaction.steps?.findLast(step => step.type === 'model_output')?.content
            ?.some(part => part.type === 'text' && part.text?.trim());
    if (!['completed', 'requires_action'].includes(interaction?.status) && !incompleteText) {
        throw new BotError(interaction?.status === 'cancelled' ? 'REQUEST_ABORTED' : 'GEMINI_EMPTY_RESPONSE');
    }
}
