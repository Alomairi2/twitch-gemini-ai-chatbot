// Product choices shared by config, the engine, and the dashboard selector.
export const CHAT_MODELS = Object.freeze([
    Object.freeze({ id: 'gemini-3.8-flash', label: 'Gemini 3.8 Flash' }),
    Object.freeze({ id: 'gemini-3.7-flash', label: 'Gemini 3.7 Flash' })
]);
export const DEFAULT_CHAT_MODEL = CHAT_MODELS[0].id;

export function normalizeChatModel(value) {
    const model = String(value || '').trim().replace(/^models\//, '');
    return CHAT_MODELS.some(choice => choice.id === model) ? model : DEFAULT_CHAT_MODEL;
}
