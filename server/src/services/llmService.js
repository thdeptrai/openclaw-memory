/**
 * ============================================================
 *  Centralized LLM Service — Supports multiple providers
 *
 *  Providers:
 *    - ollama: Local Ollama instance (default)
 *    - minimax: MiniMax M2.5 via Anthropic-compatible API
 *
 *  All LLM calls across the system go through this service.
 * ============================================================
 */
const runtimeConfig = require('../runtimeConfig');

// ============ PROVIDER: OLLAMA ============

async function callOllamaProvider(messages, options = {}) {
    const model = options.model || runtimeConfig.get('ollama.chatModel') || 'qwen2.5:7b';
    const url = `${runtimeConfig.get('ollama.baseUrl')}/api/chat`;
    const timeout = options.timeout || 180000;

    const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            model,
            messages,
            stream: false,
            keep_alive: '10m',
            options: {
                temperature: options.temperature ?? 0.1,
                num_predict: options.maxTokens || 2000,
            },
        }),
        signal: AbortSignal.timeout(timeout),
    });

    if (!response.ok) {
        const errorText = await response.text().catch(() => 'unknown');
        throw new Error(`Ollama HTTP ${response.status}: ${errorText.substring(0, 200)}`);
    }

    const data = await response.json();
    return data.message?.content || '';
}

// ============ PROVIDER: MINIMAX M2.5 ============

async function callMiniMaxProvider(messages, options = {}) {
    const apiKey = runtimeConfig.get('minimax.apiKey');
    if (!apiKey) {
        throw new Error('MiniMax API key not configured. Set MINIMAX_API_KEY env var.');
    }

    const model = options.model || runtimeConfig.get('minimax.model') || 'MiniMax-M2.5';
    const url = runtimeConfig.get('minimax.baseUrl') || 'https://api.minimax.io/anthropic/v1/messages';
    const timeout = options.timeout || 120000;

    // Convert OpenAI-style messages to Anthropic format
    let systemPrompt = '';
    const anthropicMessages = [];

    for (const msg of messages) {
        if (msg.role === 'system') {
            systemPrompt = msg.content;
        } else {
            anthropicMessages.push({
                role: msg.role,
                content: [{ type: 'text', text: msg.content }],
            });
        }
    }

    const response = await fetch(url, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'x-api-key': apiKey,
            'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
            model,
            max_tokens: options.maxTokens || 4000,
            system: systemPrompt || 'You are a helpful assistant.',
            messages: anthropicMessages,
        }),
        signal: AbortSignal.timeout(timeout),
    });

    if (!response.ok) {
        const errorText = await response.text().catch(() => 'unknown');
        // Detect context window overflow specifically
        if (response.status === 400 && errorText.includes('context window exceeds')) {
            const err = new Error(`MiniMax context window exceeded: ${errorText.substring(0, 200)}`);
            err.code = 'CONTEXT_WINDOW_EXCEEDED';
            err.status = 400;
            throw err;
        }
        throw new Error(`MiniMax HTTP ${response.status}: ${errorText.substring(0, 300)}`);
    }

    const data = await response.json();

    // Anthropic response format: { content: [{ type: "text", text: "..." }] }
    let content = '';
    if (data.content && Array.isArray(data.content)) {
        content = data.content
            .filter(c => c.type === 'text')
            .map(c => c.text)
            .join('');
    } else {
        content = data.text || data.content || '';
    }

    // Debug: log when content is empty
    if (!content) {
        console.warn(`⚠️ MiniMax returned empty content. stop_reason: ${data.stop_reason || 'unknown'}, model: ${data.model || 'unknown'}, usage: ${JSON.stringify(data.usage || {})}, content_blocks: ${JSON.stringify((data.content || []).length)}`);
    }

    return content;
}

// ============ MAIN ENTRY POINT ============

/**
 * Call the configured LLM provider.
 *
 * @param {Array<{role: string, content: string}>} messages - Chat messages (system, user, assistant)
 * @param {object} options
 * @param {string}  [options.model]       - Override model name
 * @param {number}  [options.temperature] - Temperature (default 0.1)
 * @param {number}  [options.maxTokens]   - Max output tokens (default 2000)
 * @param {number}  [options.timeout]     - Timeout in ms
 * @param {string}  [options.purpose]     - Purpose tag for logging (e.g. 'fact_extract', 'dedup')
 * @returns {Promise<string>} Raw text response from LLM
 */
async function chat(messages, options = {}) {
    const provider = runtimeConfig.get('llm.provider') || 'minimax';
    const purpose = options.purpose || 'general';
    const t0 = Date.now();

    let content;
    try {
        switch (provider) {
            case 'minimax':
                content = await callMiniMaxProvider(messages, options);
                break;
            case 'ollama':
            default:
                content = await callOllamaProvider(messages, options);
                break;
        }
    } catch (err) {
        const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
        const isTimeout = err.name === 'TimeoutError' || err.message?.includes('aborted') || err.message?.includes('timeout');
        const isContextOverflow = err.code === 'CONTEXT_WINDOW_EXCEEDED';

        // Retry once with extended timeout on first timeout
        if (isTimeout && !options._retried) {
            console.warn(`⚠️ LLM [${provider}] timed out after ${elapsed}s for ${purpose}. Retrying...`);
            return chat(messages, { ...options, timeout: (options.timeout || 180000) * 2, _retried: true });
        }

        // Context window overflow: truncate messages and retry once
        if (isContextOverflow && !options._truncated) {
            console.warn(`⚠️ LLM [${provider}] context window exceeded for ${purpose}. Truncating and retrying...`);
            const truncated = messages.map(msg => ({
                ...msg,
                content: msg.content.length > 1500 ? msg.content.substring(0, 1500) : msg.content,
            }));
            return chat(truncated, { ...options, _truncated: true });
        }

        throw new Error(`LLM [${provider}] failed for ${purpose} after ${elapsed}s: ${err.message}`);
    }

    const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
    const model = options.model || runtimeConfig.get(provider === 'minimax' ? 'minimax.model' : 'ollama.chatModel') || provider;
    console.log(`  ⏱️ LLM [${provider}] ${purpose} in ${elapsed}s (model: ${model})`);

    if (!content) {
        // Retry once for empty content (MiniMax sometimes returns empty on first try)
        if (!options._emptyRetried) {
            console.warn(`⚠️ LLM [${provider}] returned empty content for ${purpose}. Retrying...`);
            return chat(messages, { ...options, _emptyRetried: true });
        }
        throw new Error(`LLM [${provider}] returned empty content for ${purpose}`);
    }

    return content;
}

/**
 * Convenience: call LLM with system + user prompt, return parsed JSON.
 */
async function chatJSON(systemPrompt, userPrompt, options = {}) {
    const content = await chat([
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
    ], options);

    return parseJsonResponse(content);
}

/**
 * Parse JSON from LLM response (handles markdown code blocks, trailing text, etc.)
 */
function parseJsonResponse(text) {
    if (!text || typeof text !== 'string') return {};

    // Strip markdown code fences
    let cleaned = text.replace(/```(?:json)?\s*/gi, '').replace(/```\s*/g, '').trim();

    // Try direct parse first
    try { return JSON.parse(cleaned); } catch { /* continue */ }

    // Try extracting JSON object or array
    const jsonMatch = cleaned.match(/(\{[\s\S]*\}|\[[\s\S]*\])/);
    if (jsonMatch) {
        try { return JSON.parse(jsonMatch[1]); } catch { /* continue */ }
    }

    // Aggressive cleanup: remove trailing non-JSON text
    const lastBrace = Math.max(cleaned.lastIndexOf('}'), cleaned.lastIndexOf(']'));
    if (lastBrace > 0) {
        const truncated = cleaned.substring(0, lastBrace + 1);
        try { return JSON.parse(truncated); } catch { /* continue */ }
    }

    // Repair truncated JSON (common with max_tokens cutoff)
    // Strategy: find last complete array item, close brackets

    // Case 1: truncated array e.g. [{...},{"text":"abc...
    if (cleaned.startsWith('[')) {
        const lastCompleteObj = cleaned.lastIndexOf('},');
        if (lastCompleteObj > 0) {
            const repaired = cleaned.substring(0, lastCompleteObj + 1) + ']';
            try {
                const result = JSON.parse(repaired);
                console.log(`  🔧 Repaired truncated JSON array: recovered ${result.length} entries`);
                return result;
            } catch { /* continue */ }
        }
        const lastObj = cleaned.lastIndexOf('}');
        if (lastObj > 0) {
            try {
                const repaired2 = cleaned.substring(0, lastObj + 1) + ']';
                const result2 = JSON.parse(repaired2);
                console.log(`  🔧 Repaired truncated JSON array: recovered ${result2.length} entries`);
                return result2;
            } catch { /* give up */ }
        }
    }

    // Case 2: truncated object with arrays e.g. {"user_facts":[{...},{"text":"abc...
    if (cleaned.startsWith('{')) {
        // Try closing at each "}]" from the end
        let pos = cleaned.length;
        while (pos > 0) {
            pos = cleaned.lastIndexOf('}', pos - 1);
            if (pos <= 0) break;
            // Try closing: "...}]}" or "...}]}"
            for (const suffix of ['}', ']}', ']}']) {
                try {
                    const repaired = cleaned.substring(0, pos + 1) + suffix;
                    const result = JSON.parse(repaired);
                    console.log(`  🔧 Repaired truncated JSON object`);
                    return result;
                } catch { /* continue */ }
            }
        }
        // Last resort: find last "}," in an array, close array + object
        const lastItem = cleaned.lastIndexOf('},');
        if (lastItem > 0) {
            const repaired = cleaned.substring(0, lastItem + 1) + ']}';
            try {
                const result = JSON.parse(repaired);
                console.log(`  🔧 Repaired truncated JSON object (array fallback)`);
                return result;
            } catch { /* give up */ }
        }
    }

    console.warn('⚠️ Could not parse JSON from LLM response:', text.substring(0, 200));
    return {};
}

module.exports = {
    chat,
    chatJSON,
    parseJsonResponse,
};
