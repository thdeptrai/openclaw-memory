/**
 * ============================================================
 *  Search Reranker — LLM-based reranking of search results
 *  Improves recall quality by scoring each result's relevance
 *  to the query using a lightweight LLM pass.
 * ============================================================
 */
const config = require('../config');
const runtimeConfig = require('../runtimeConfig');
const llmService = require('./llmService');

const RERANK_SYSTEM_PROMPT = `You are a RELEVANCE SCORER. Given a QUERY and candidate MEMORIES, rate each memory's relevance from 0.0 to 1.0.

RULES:
1. Score 0.8-1.0 = directly answers the query
2. Score 0.5-0.7 = somewhat related, provides useful context
3. Score 0.2-0.4 = tangentially related
4. Score 0.0-0.1 = irrelevant
5. Return ONLY valid JSON
6. Consider semantic meaning, not just keyword overlap`;

const RERANK_USER_TEMPLATE = `QUERY: "{{QUERY}}"

CANDIDATE MEMORIES:
{{MEMORIES}}

Score each memory. Return JSON:
{
  "scores": [
    {"index": 0, "score": 0.85, "reason": "brief reason"}
  ]
}

Return ONLY the JSON object.`;

/**
 * Rerank a list of memory results against a query.
 * Returns the same items, sorted by relevance score.
 * 
 * @param {string} query - The search/recall query
 * @param {Array} memories - Array of {id, content, score, ...} objects
 * @param {object} options - { limit, minScore }
 * @returns {Promise<Array>} Reranked memories with `rerankScore` field
 */
async function rerank(query, memories, { limit = 10, minScore = 0.2 } = {}) {
    if (!runtimeConfig.get('reranking.enabled') || !memories || memories.length === 0) {
        return memories;
    }

    // Skip LLM reranking for cloud providers (per-request billing — save API calls)
    const provider = runtimeConfig.get('llm.provider') || 'minimax';
    if (provider !== 'ollama') {
        console.log(`  ⏭️ Skipping LLM reranking (provider: ${provider}, using vector scores)`);
        return memories.slice(0, limit);
    }

    // Don't bother reranking very small result sets
    if (memories.length <= 2) {
        return memories;
    }

    // Cap at 20 candidates to keep the LLM call fast
    const candidates = memories.slice(0, 20);

    try {
        const scores = await callOllamaForRerank(query, candidates);

        // Apply scores and sort
        const scored = candidates.map((mem, idx) => {
            const scoreEntry = scores.find(s => s.index === idx);
            return {
                ...mem,
                rerankScore: scoreEntry ? scoreEntry.score : mem.score || 0.5,
                rerankReason: scoreEntry?.reason || '',
            };
        });

        // Sort by rerank score (descending), then filter by minScore
        const reranked = scored
            .filter(m => m.rerankScore >= minScore)
            .sort((a, b) => b.rerankScore - a.rerankScore)
            .slice(0, limit);

        return reranked;
    } catch (err) {
        console.warn('⚠️ Reranking failed, returning original order:', err.message);
        return memories.slice(0, limit);
    }
}

// ============ OLLAMA RERANK CALL ============

async function callOllamaForRerank(query, memories) {
    const memoriesForPrompt = memories
        .map((m, idx) => `[${idx}] ${(m.content || m.payload?.content || '').substring(0, 200)}`)
        .join('\n');

    const userPrompt = RERANK_USER_TEMPLATE
        .replace('{{QUERY}}', query)
        .replace('{{MEMORIES}}', memoriesForPrompt);

    const parsed = await llmService.chatJSON(RERANK_SYSTEM_PROMPT, userPrompt, {
        maxTokens: 1000,
        timeout: runtimeConfig.get('reranking.timeout'),
        purpose: 'rerank',
    });

    return parsed.scores || [];
}

// ============ JSON PARSER ============

function parseJsonResponse(text) {
    if (!text || typeof text !== 'string') {
        throw new Error('Empty rerank response');
    }

    text = text.replace(/<think>[\s\S]*?<\/think>/g, '').trim();

    const codeBlockMatch = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
    if (codeBlockMatch) {
        try { return JSON.parse(codeBlockMatch[1]); } catch { /* fall through */ }
    }

    try { return JSON.parse(text); } catch { /* fall through */ }

    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
        try { return JSON.parse(jsonMatch[0]); } catch { /* fall through */ }
    }

    throw new Error(`Could not parse rerank JSON: ${text.substring(0, 200)}`);
}

module.exports = {
    rerank,
    get ENABLE_RERANKING() { return runtimeConfig.get('reranking.enabled'); },
};
