const config = require('../config');
const runtimeConfig = require('../runtimeConfig');
const llmService = require('./llmService');

/**
 * ============================================================
 *  Memolo Summarizer
 *  Primary: Ollama local LLM
 *  Fallback: Local extraction (pattern-based)
 *
 *  Long conversation handling: Progressive Reduction
 *  Step 1: Raw text → check token limit
 *  Step 2: Strip code blocks → re-check
 *  Step 3: Truncate exchanges → re-check
 *  Step 4: Chunk + summarize separately → merge results
 * ============================================================
 */

// Context budget: reserve tokens for system prompt + user prompt template + output
const SYSTEM_PROMPT_TOKENS = 200;
const USER_TEMPLATE_TOKENS = 500;
const OUTPUT_TOKENS = 2000;
const MAX_CONTEXT_TOKENS = parseInt(process.env.MAX_CONTEXT_TOKENS || '28000'); // qwen2.5:7b = 32K, keep safe margin
const MAX_CONVERSATION_TOKENS = MAX_CONTEXT_TOKENS - SYSTEM_PROMPT_TOKENS - USER_TEMPLATE_TOKENS - OUTPUT_TOKENS;

// ============ TOKEN ESTIMATION ============

/**
 * Estimate token count from text.
 * Vietnamese + mixed content: ~3.5 chars per token on average.
 * This is intentionally conservative (overestimates) to avoid overflow.
 */
function estimateTokens(text) {
    if (!text) return 0;
    return Math.ceil(text.length / 3.5);
}

// ============ PROGRESSIVE REDUCTION ============

/**
 * Strip code blocks from text, keeping only signatures and comments.
 * Handles both markdown fenced blocks (```...```) and indented code.
 *
 * Example:
 *   ```javascript
 *   // Setup express server
 *   const app = express();
 *   app.get('/api/health', (req, res) => {
 *     const status = checkDb();
 *     res.json({ status });
 *   });
 *   ```
 *
 * Becomes:
 *   [code: javascript] // Setup express server | app.get('/api/health', ...) [/code]
 */
function stripCodeBlocks(text) {
    if (!text) return text;

    // Strip markdown fenced code blocks
    let result = text.replace(/```(\w*)\n([\s\S]*?)```/g, (match, lang, code) => {
        const lines = code.split('\n');
        const kept = [];

        for (const line of lines) {
            const trimmed = line.trim();
            // Keep: comments, function/class declarations, imports
            if (
                trimmed.startsWith('//') ||
                trimmed.startsWith('#') ||
                trimmed.startsWith('/*') ||
                trimmed.startsWith('*') ||
                /^(async\s+)?(function|class|const\s+\w+\s*=\s*(async\s+)?\(|export|import|module\.exports|def\s|from\s)/.test(trimmed) ||
                /^(app|router|server)\.(get|post|put|delete|use|listen)\s*\(/.test(trimmed)
            ) {
                // Truncate long lines (e.g., full function bodies on one line)
                kept.push(trimmed.substring(0, 120));
            }
        }

        const langLabel = lang ? `: ${lang}` : '';
        if (kept.length > 0) {
            return `[code${langLabel}] ${kept.join(' | ')} [/code]`;
        }
        return `[code${langLabel} — ${lines.length} lines omitted]`;
    });

    return result;
}

/**
 * Truncate individual exchanges to max character limits.
 * Preserves the beginning and end of long messages (most info is at edges).
 */
function truncateExchange(exchange, maxUserChars = 500, maxAgentChars = 1500) {
    let userMsg = exchange.user_message || '';
    let agentResp = exchange.agent_response || '';

    if (userMsg.length > maxUserChars) {
        const half = Math.floor(maxUserChars / 2);
        userMsg = userMsg.substring(0, half) + '\n[...truncated...]\n' + userMsg.substring(userMsg.length - half);
    }

    if (agentResp.length > maxAgentChars) {
        const half = Math.floor(maxAgentChars / 2);
        agentResp = agentResp.substring(0, half) + '\n[...truncated...]\n' + agentResp.substring(agentResp.length - half);
    }

    return { ...exchange, user_message: userMsg, agent_response: agentResp };
}

/**
 * Format exchanges into conversation text.
 */
function formatExchanges(exchanges) {
    return exchanges.map((ex, i) =>
        `[${i + 1}] User: ${ex.user_message}\nAgent: ${ex.agent_response}`
    ).join('\n\n');
}

/**
 * Merge multiple summarization results into one.
 * Deduplicates facts/decisions/preferences by content similarity.
 */
function mergeResults(results) {
    const merged = {
        summary: results.map(r => r.summary).filter(Boolean).join(' '),
        facts: [],
        decisions: [],
        preferences: [],
        action_items: [],
        entities: [],
        topics: [],
    };

    for (const r of results) {
        if (r.facts) merged.facts.push(...r.facts);
        if (r.decisions) merged.decisions.push(...r.decisions);
        if (r.preferences) merged.preferences.push(...r.preferences);
        if (r.action_items) merged.action_items.push(...r.action_items);
        if (r.entities) merged.entities.push(...r.entities);
        if (r.topics) merged.topics.push(...r.topics);
    }

    // Deduplicate arrays (simple exact match)
    merged.facts = [...new Set(merged.facts)];
    merged.decisions = [...new Set(merged.decisions)];
    merged.preferences = [...new Set(merged.preferences)];
    merged.action_items = [...new Set(merged.action_items)];
    merged.entities = [...new Set(merged.entities)];
    merged.topics = [...new Set(merged.topics)];

    return merged;
}

// ============ MAIN ENTRY ============

/**
 * Summarize conversation exchanges using Progressive Reduction:
 *   Step 1: Try raw text (fast path, works for 90%+ cases)
 *   Step 2: Strip code blocks → retry
 *   Step 3: Truncate exchanges → retry
 *   Step 4: Chunk into groups → summarize each → merge
 *   Fallback: Local extraction (no LLM)
 */
async function summarizeExchanges(exchanges) {
    // For cloud providers (per-request billing), skip LLM and use local extraction
    // Facts are already captured by the combined extract+dedup call
    const provider = runtimeConfig.get('llm.provider') || 'minimax';
    if (provider !== 'ollama') {
        console.log(`  ⏭️ Using local extraction for summarization (provider: ${provider}, saving API call)`);
        return localExtraction(exchanges);
    }

    // === Step 1: Try raw text ===
    const rawText = formatExchanges(exchanges);
    const rawTokens = estimateTokens(rawText);

    if (rawTokens <= MAX_CONVERSATION_TOKENS) {
        console.log(`📝 Summarizing ${exchanges.length} exchanges (${rawTokens} tokens, within limit)`);
        return await trySummarize(rawText, exchanges);
    }

    console.log(`⚠️ Conversation too long: ${rawTokens} tokens > ${MAX_CONVERSATION_TOKENS} limit`);

    // === Step 2: Strip code blocks ===
    const strippedExchanges = exchanges.map(ex => ({
        ...ex,
        user_message: stripCodeBlocks(ex.user_message),
        agent_response: stripCodeBlocks(ex.agent_response),
    }));
    const strippedText = formatExchanges(strippedExchanges);
    const strippedTokens = estimateTokens(strippedText);

    if (strippedTokens <= MAX_CONVERSATION_TOKENS) {
        console.log(`✂️ Code stripping reduced to ${strippedTokens} tokens (was ${rawTokens})`);
        return await trySummarize(strippedText, exchanges);
    }

    console.log(`⚠️ Still too long after code stripping: ${strippedTokens} tokens`);

    // === Step 3: Truncate exchanges ===
    const truncatedExchanges = strippedExchanges.map(ex => truncateExchange(ex));
    const truncatedText = formatExchanges(truncatedExchanges);
    const truncatedTokens = estimateTokens(truncatedText);

    if (truncatedTokens <= MAX_CONVERSATION_TOKENS) {
        console.log(`📐 Truncation reduced to ${truncatedTokens} tokens (was ${strippedTokens})`);
        return await trySummarize(truncatedText, exchanges);
    }

    console.log(`⚠️ Still too long after truncation: ${truncatedTokens} tokens → chunking`);

    // === Step 4: Chunk and summarize separately ===
    return await chunkAndSummarize(truncatedExchanges);
}

/**
 * Try to summarize text via Ollama, fall back to local extraction.
 */
async function trySummarize(conversationText, originalExchanges) {
    try {
        const result = await callOllama(buildPrompt(conversationText));
        if (result) {
            console.log('✅ Summarized via Ollama local');
            return result;
        }
    } catch (err) {
        console.warn('⚠️ Ollama summarization failed:', err.message);
    }

    console.log('ℹ️ Using local extraction fallback');
    return localExtraction(originalExchanges);
}

/**
 * Split exchanges into chunks that fit within token limit,
 * summarize each chunk, then merge results.
 */
async function chunkAndSummarize(exchanges) {
    const chunks = [];
    let currentChunk = [];
    let currentTokens = 0;

    for (const ex of exchanges) {
        const exText = `User: ${ex.user_message}\nAgent: ${ex.agent_response}`;
        const exTokens = estimateTokens(exText);

        if (currentTokens + exTokens > MAX_CONVERSATION_TOKENS && currentChunk.length > 0) {
            chunks.push(currentChunk);
            currentChunk = [];
            currentTokens = 0;
        }

        currentChunk.push(ex);
        currentTokens += exTokens;
    }

    if (currentChunk.length > 0) {
        chunks.push(currentChunk);
    }

    console.log(`🔀 Split into ${chunks.length} chunks: ${chunks.map(c => c.length + ' exchanges').join(', ')}`);

    const results = [];
    for (let i = 0; i < chunks.length; i++) {
        const chunkText = formatExchanges(chunks[i]);
        console.log(`  → Summarizing chunk ${i + 1}/${chunks.length} (${estimateTokens(chunkText)} tokens)`);

        try {
            const result = await callOllama(buildPrompt(chunkText));
            if (result) {
                results.push(result);
                continue;
            }
        } catch (err) {
            console.warn(`  ⚠️ Chunk ${i + 1} Ollama failed:`, err.message);
        }

        // Fallback for this chunk
        results.push(localExtraction(chunks[i]));
    }

    const merged = mergeResults(results);
    console.log(`✅ Merged ${results.length} chunk results: ${merged.facts.length} facts, ${merged.decisions.length} decisions`);
    return merged;
}

// ============ PROMPT BUILDER ============

function buildPrompt(conversationText) {
    const template = config.summarizer.userPromptTemplate;
    return template.replace('{{CONVERSATION}}', conversationText);
}

// ============ LLM CALL (via centralized llmService) ============

/**
 * Call LLM for summarization via centralized llmService.
 * Supports Ollama + MiniMax (auto-selected by llm.provider config).
 */
async function callOllama(prompt) {
    return llmService.chatJSON(config.summarizer.systemPrompt, prompt, {
        maxTokens: 2000,
        timeout: runtimeConfig.get('summarizer.timeout'),
        purpose: 'summarization',
    });
}

// ============ LOCAL EXTRACTION (offline fallback) ============

/**
 * Enhanced local extraction — no LLM needed
 * Better pattern matching than the original keyword-only approach
 */
function localExtraction(exchanges) {
    const allUserText = exchanges.map(ex => ex.user_message).join(' ');
    const allAgentText = exchanges.map(ex => ex.agent_response).join(' ');
    const allText = allUserText + ' ' + allAgentText;

    // --- Topics via keyword detection ---
    const topics = [];
    const topicKeywords = {
        'API': 'API Development', 'database': 'Database', 'frontend': 'Frontend',
        'backend': 'Backend', 'testing': 'Testing', 'deploy': 'Deployment',
        'security': 'Security', 'authentication': 'Authentication',
        'Docker': 'Docker/Containers', 'CI/CD': 'CI/CD', 'design': 'Design',
        'performance': 'Performance', 'monitoring': 'Monitoring',
        'React': 'React', 'Node': 'Node.js', 'Python': 'Python',
        'TypeScript': 'TypeScript', 'PostgreSQL': 'PostgreSQL',
        'memory': 'Memory System', 'AI': 'AI/ML', 'plugin': 'Plugin',
        'Ollama': 'Ollama', 'Qdrant': 'Qdrant', 'embedding': 'Embeddings',
    };

    for (const [keyword, topic] of Object.entries(topicKeywords)) {
        if (allText.toLowerCase().includes(keyword.toLowerCase())) {
            topics.push(topic);
        }
    }

    // --- Summary from first + last exchange ---
    const firstEx = exchanges[0];
    const lastEx = exchanges[exchanges.length - 1];
    const summaryParts = [`Conversation about: ${firstEx.user_message.substring(0, 120)}`];
    if (exchanges.length > 1) {
        summaryParts.push(`${exchanges.length} exchanges total, ending with: ${lastEx.user_message.substring(0, 80)}`);
    }

    // --- Facts: extract full key sentences from agent responses ---
    const facts = [];
    exchanges.forEach(ex => {
        const sentences = ex.agent_response.split(/[.!?]\s+/);
        sentences.forEach(s => {
            const trimmed = s.trim();
            if (trimmed.length > 20 && trimmed.length < 300) {
                facts.push(trimmed);
            }
        });
    });

    // --- Decisions: detect recommendation patterns ---
    const decisionPatterns = [
        /(?:đề xuất|khuyên|recommend|suggest|nên dùng|sử dụng|chọn|dùng|use)\s+(.{10,150})/gi,
    ];
    const decisions = [];
    exchanges.forEach(ex => {
        for (const pattern of decisionPatterns) {
            const matches = ex.agent_response.matchAll(pattern);
            for (const m of matches) {
                decisions.push(m[0].substring(0, 200));
            }
        }
    });

    // --- Preferences: user "want/like/prefer" patterns ---
    const preferences = [];
    const prefPatterns = [
        /(?:tao muốn|tao thích|i want|i prefer|i like|muốn|thích)\s+(.{10,150})/gi,
    ];
    exchanges.forEach(ex => {
        for (const pattern of prefPatterns) {
            const matches = ex.user_message.matchAll(pattern);
            for (const m of matches) {
                preferences.push(m[0].substring(0, 200));
            }
        }
    });

    return {
        summary: summaryParts.join('. '),
        facts: [...new Set(facts)].slice(0, 10),
        decisions: [...new Set(decisions)].slice(0, 5),
        preferences: [...new Set(preferences)].slice(0, 5),
        action_items: [],
        entities: [],
        topics: [...new Set(topics)].slice(0, 8),
    };
}

// ============ JSON PARSER ============

/**
 * Parse JSON from LLM response (handles markdown code blocks, extra text, think tags)
 */
function parseJsonResponse(text) {
    if (!text || typeof text !== 'string') {
        throw new Error('Empty or invalid response text');
    }

    // Strip <think>...</think> blocks
    text = text.replace(/<think>[\s\S]*?<\/think>/g, '').trim();

    // Try to extract JSON from markdown code block
    const codeBlockMatch = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
    if (codeBlockMatch) {
        try {
            return JSON.parse(codeBlockMatch[1]);
        } catch { /* fall through */ }
    }

    // Try direct JSON parse
    try {
        return JSON.parse(text);
    } catch { /* fall through */ }

    // Try to find JSON object in text
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
        try {
            return JSON.parse(jsonMatch[0]);
        } catch { /* fall through */ }
    }

    // Try to find JSON array in text
    const arrayMatch = text.match(/\[[\s\S]*\]/);
    if (arrayMatch) {
        try {
            return JSON.parse(arrayMatch[0]);
        } catch { /* fall through */ }
    }

    throw new Error(`Could not parse JSON from LLM response: ${text.substring(0, 200)}`);
}

module.exports = {
    summarizeExchanges,
    callOllama,
    localExtraction,
    // Exported for testing
    estimateTokens,
    stripCodeBlocks,
    truncateExchange,
    mergeResults,
    MAX_CONVERSATION_TOKENS,
};
