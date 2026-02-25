const runtimeConfig = require('../runtimeConfig');

// ============ EMBEDDING CACHE ============
// LRU cache to avoid redundant Ollama calls for identical text.
// Node.js is single-threaded so Map operations are safe.
const embeddingCache = new Map();
const MAX_CACHE_SIZE = 500;
const CACHE_KEY_LENGTH = 300; // normalize cache key to first 300 chars

function getCacheKey(text) {
    return text.substring(0, CACHE_KEY_LENGTH).trim();
}

/**
 * Generate embeddings using Ollama local API (with LRU cache)
 */
async function generateEmbedding(text) {
    // Check cache first
    const key = getCacheKey(text);
    if (embeddingCache.has(key)) {
        return embeddingCache.get(key);
    }

    try {
        const baseUrl = runtimeConfig.get('ollama.baseUrl');
        const embedModel = runtimeConfig.get('ollama.embedModel');
        const response = await fetch(`${baseUrl}/api/embeddings`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                model: embedModel,
                prompt: text,
                keep_alive: '10m',
            }),
            signal: AbortSignal.timeout(60000),
        });

        if (!response.ok) {
            throw new Error(`Ollama API error: ${response.status} ${response.statusText}`);
        }

        const data = await response.json();
        const embedding = data.embedding;

        // Store in cache (evict oldest if full)
        if (embeddingCache.size >= MAX_CACHE_SIZE) {
            const firstKey = embeddingCache.keys().next().value;
            embeddingCache.delete(firstKey);
        }
        embeddingCache.set(key, embedding);

        return embedding;
    } catch (error) {
        console.error('❌ Embedding generation failed:', error.message);
        throw error;
    }
}

/**
 * Generate embeddings for multiple texts
 */
async function generateEmbeddings(texts) {
    const results = [];
    for (const text of texts) {
        const embedding = await generateEmbedding(text);
        results.push(embedding);
    }
    return results;
}

/**
 * Check if Ollama is available
 */
async function checkOllamaHealth() {
    try {
        const baseUrl = runtimeConfig.get('ollama.baseUrl');
        const embedModel = runtimeConfig.get('ollama.embedModel');
        const response = await fetch(`${baseUrl}/api/tags`);
        if (!response.ok) return false;
        const data = await response.json();
        const hasModel = data.models?.some(m => m.name.includes(embedModel));
        return { available: true, hasModel };
    } catch {
        return { available: false, hasModel: false };
    }
}

module.exports = {
    generateEmbedding,
    generateEmbeddings,
    checkOllamaHealth,
};
