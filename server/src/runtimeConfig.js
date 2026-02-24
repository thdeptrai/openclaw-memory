/**
 * ============================================================
 *  Runtime Config Store — Mutable settings that services read at call time
 *  
 *  Initialized from config.js defaults.
 *  Updated via Settings API (PUT /api/config).
 *  In-memory only — resets to env-based defaults on restart.
 * ============================================================
 */
const config = require('./config');

// Deep-clone the initial values from config.js
const defaults = {
    // LLM Provider
    'llm.provider': process.env.LLM_PROVIDER || 'minimax',

    // Ollama
    'ollama.chatModel': config.ollama.chatModel,
    'ollama.embedModel': config.ollama.embedModel,
    'ollama.baseUrl': config.ollama.baseUrl,

    // MiniMax M2.5
    'minimax.apiKey': process.env.MINIMAX_API_KEY || '',
    'minimax.model': process.env.MINIMAX_MODEL || 'MiniMax-M2.5',
    'minimax.baseUrl': process.env.MINIMAX_BASE_URL || 'https://api.minimax.io/anthropic/v1/messages',

    // Feature Toggles
    'factExtraction.enabled': config.factExtraction.enabled,
    'factExtraction.extractAgentFacts': true,
    'reranking.enabled': config.reranking.enabled,
    'graph.enabled': config.graph.enabled,

    // Timeouts (ms)
    'factExtraction.timeout': config.factExtraction.timeout,
    'factExtraction.dedupTimeout': config.factExtraction.dedupTimeout,
    'reranking.timeout': config.reranking.timeout,
    'summarizer.timeout': parseInt(process.env.OLLAMA_TIMEOUT || '180000'),

    // Memory Parameters
    'memory.summarizeAfterExchanges': config.memory.summarizeAfterExchanges,
    'memory.vectorScoreThreshold': 0.3,
    'memory.agentFactMinResponseLength': 100,

    // Scheduler Intervals (ms)
    'scheduler.summarizationSweep': 2 * 60 * 1000,
    'scheduler.memoryDecay': 6 * 60 * 60 * 1000,
    'scheduler.duplicateDetection': 2 * 60 * 60 * 1000,


    // Batch Processing (reduces LLM API calls for cloud providers)
    'batch.enabled': true,
    'batch.intervalMs': 10000,  // flush every 10s
    'batch.maxSize': 10,        // max exchanges per LLM call

    // MiniMax Context Window
    'minimax.maxInputTokens': 1600,  // ~2013 total - 400 output reserve
};

// Mutable runtime store
const store = { ...defaults };

// Setting metadata for validation and UI
const settingsMeta = {
    'llm.provider': { label: 'LLM Provider', group: 'LLM Models', type: 'select', options: ['ollama', 'minimax'], description: 'Active LLM provider for all chat/extraction tasks' },
    'ollama.chatModel': { label: 'Ollama Chat Model', group: 'LLM Models', type: 'string', description: 'Ollama model for chat/extraction tasks' },
    'ollama.embedModel': { label: 'Embedding Model', group: 'LLM Models', type: 'string', description: 'Ollama model for generating embeddings' },
    'ollama.baseUrl': { label: 'Ollama Base URL', group: 'LLM Models', type: 'string', description: 'Ollama API endpoint' },
    'minimax.apiKey': { label: 'MiniMax API Key', group: 'LLM Models', type: 'string', sensitive: true, description: 'MiniMax API key (x-api-key header)' },
    'minimax.model': { label: 'MiniMax Model', group: 'LLM Models', type: 'string', description: 'MiniMax model name (e.g. MiniMax-M2.5)' },
    'minimax.baseUrl': { label: 'MiniMax Base URL', group: 'LLM Models', type: 'string', description: 'MiniMax API endpoint' },

    'factExtraction.enabled': { label: 'Fact Extraction', group: 'Feature Toggles', type: 'boolean', description: 'Enable real-time fact extraction from exchanges' },
    'factExtraction.extractAgentFacts': { label: 'Extract Agent Facts', group: 'Feature Toggles', type: 'boolean', description: 'Extract facts from assistant responses (in addition to user messages)' },
    'reranking.enabled': { label: 'Memory Reranking', group: 'Feature Toggles', type: 'boolean', description: 'Enable LLM-based reranking of search results for better relevance' },
    'graph.enabled': { label: 'Knowledge Graph', group: 'Feature Toggles', type: 'boolean', description: 'Enable entity/relationship graph building from extracted facts' },

    'factExtraction.timeout': { label: 'Fact Extract Timeout', group: 'Timeouts', type: 'number', min: 5000, max: 300000, unit: 'ms', description: 'Max time for LLM fact extraction call' },
    'factExtraction.dedupTimeout': { label: 'Dedup Timeout', group: 'Timeouts', type: 'number', min: 5000, max: 300000, unit: 'ms', description: 'Max time for LLM deduplication call' },
    'reranking.timeout': { label: 'Rerank Timeout', group: 'Timeouts', type: 'number', min: 5000, max: 300000, unit: 'ms', description: 'Max time for LLM reranking call' },
    'summarizer.timeout': { label: 'Summarizer Timeout', group: 'Timeouts', type: 'number', min: 10000, max: 600000, unit: 'ms', description: 'Max time for summarization LLM call' },

    'memory.summarizeAfterExchanges': { label: 'Summarize After N Exchanges', group: 'Memory', type: 'number', min: 1, max: 50, description: 'Number of exchanges before triggering conversation summarization' },
    'memory.vectorScoreThreshold': { label: 'Vector Score Threshold', group: 'Memory', type: 'number', min: 0.0, max: 1.0, step: 0.05, description: 'Minimum cosine similarity score for vector search results (lower = more results but less relevant)' },
    'memory.agentFactMinResponseLength': { label: 'Agent Fact Min Response Length', group: 'Memory', type: 'number', min: 10, max: 500, description: 'Minimum agent response length (chars) to trigger agent fact extraction' },

    'scheduler.summarizationSweep': { label: 'Summarization Sweep', group: 'Scheduler', type: 'number', min: 30000, max: 3600000, unit: 'ms', description: 'How often to check for missed summarizations' },
    'scheduler.memoryDecay': { label: 'Memory Decay', group: 'Scheduler', type: 'number', min: 60000, max: 86400000, unit: 'ms', description: 'How often to apply memory importance decay' },
    'scheduler.duplicateDetection': { label: 'Duplicate Detection', group: 'Scheduler', type: 'number', min: 60000, max: 86400000, unit: 'ms', description: 'How often to scan for and merge duplicate memories' },


    'batch.enabled': { label: 'Batch Processing', group: 'Batch', type: 'boolean', description: 'Queue exchanges and process in batches to reduce LLM API calls (recommended for cloud providers like MiniMax)' },
    'batch.intervalMs': { label: 'Batch Interval', group: 'Batch', type: 'number', min: 1000, max: 60000, unit: 'ms', description: 'How often to flush the batch queue and send to LLM' },
    'batch.maxSize': { label: 'Max Batch Size', group: 'Batch', type: 'number', min: 1, max: 50, description: 'Maximum exchanges per batch LLM call' },
    'minimax.maxInputTokens': { label: 'MiniMax Input Token Budget', group: 'LLM Models', type: 'number', min: 500, max: 8000, description: 'Max input tokens for MiniMax (context window limit minus output reserve)' },
};

module.exports = {
    /**
     * Get a runtime config value
     * @param {string} key - dot-notation key like 'ollama.chatModel'
     * @returns {*} current value
     */
    get(key) {
        return store[key] !== undefined ? store[key] : defaults[key];
    },

    /**
     * Set a runtime config value (validates against metadata)
     * @param {string} key
     * @param {*} value
     * @returns {{ success: boolean, error?: string }}
     */
    set(key, value) {
        const meta = settingsMeta[key];
        if (!meta) return { success: false, error: `Unknown setting: ${key}` };

        // Type validation
        if (meta.type === 'boolean' && typeof value !== 'boolean') {
            return { success: false, error: `${key} must be boolean` };
        }
        if (meta.type === 'number') {
            const num = Number(value);
            if (isNaN(num)) return { success: false, error: `${key} must be a number` };
            if (meta.min !== undefined && num < meta.min) return { success: false, error: `${key} min is ${meta.min}` };
            if (meta.max !== undefined && num > meta.max) return { success: false, error: `${key} max is ${meta.max}` };
            value = num;
        }
        if (meta.type === 'select' && meta.options) {
            if (!meta.options.includes(value)) {
                return { success: false, error: `${key} must be one of: ${meta.options.join(', ')}` };
            }
        }
        if (meta.type === 'string' && typeof value !== 'string') {
            return { success: false, error: `${key} must be a string` };
        }

        store[key] = value;
        return { success: true };
    },

    /**
     * Get all settings with their metadata and current values
     */
    getAll() {
        const result = {};
        for (const [key, meta] of Object.entries(settingsMeta)) {
            let value = store[key];
            // Mask sensitive values (API keys, passwords) — show first 4 + last 4 chars
            if (meta.sensitive && typeof value === 'string' && value.length > 8) {
                value = value.slice(0, 4) + '***' + value.slice(-4);
            } else if (meta.sensitive && typeof value === 'string' && value.length > 0) {
                value = '***';
            }
            result[key] = {
                ...meta,
                value,
                default: defaults[key],
            };
        }
        return result;
    },

    /**
     * Reset a single setting to its default
     */
    reset(key) {
        if (defaults[key] !== undefined) {
            store[key] = defaults[key];
            return { success: true };
        }
        return { success: false, error: `Unknown setting: ${key}` };
    },

    /**
     * Reset all settings to defaults
     */
    resetAll() {
        Object.assign(store, { ...defaults });
        return { success: true };
    },

    settingsMeta,
};
