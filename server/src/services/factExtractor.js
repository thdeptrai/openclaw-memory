/**
 * ============================================================
 *  Fact Extractor — Real-time atomic fact extraction from exchanges
 *  Inspired by mem0's approach:
 *    - Separate USER vs AGENT extraction prompts
 *    - Penalty-reinforced focus to prevent cross-contamination
 *    - Returns actorId for source attribution
 * ============================================================
 */
const config = require('../config');
const runtimeConfig = require('../runtimeConfig');
const llmService = require('./llmService');

// ============ CONTEXT WINDOW MANAGEMENT ============

const CHARS_PER_TOKEN = 3.5; // Vietnamese + mixed content estimate

/**
 * Estimate token count from text.
 */
function estimateTokens(text) {
    if (!text) return 0;
    return Math.ceil(text.length / CHARS_PER_TOKEN);
}

/**
 * Get max input token budget for current provider.
 * MiniMax M2.5: 200K context window, 128K max output.
 * Ollama: depends on model, typically 8-32K.
 */
function getMaxInputTokens() {
    const provider = runtimeConfig.get('llm.provider') || 'minimax';
    if (provider === 'minimax') {
        return runtimeConfig.get('minimax.maxInputTokens') || 16000;
    }
    return 28000; // Ollama default
}

/**
 * Progressively truncate prompt components to fit within the token budget.
 * Strategy: shrink user content first, then memories, then system prompt.
 *
 * @param {string} systemPrompt
 * @param {string} userPrompt
 * @param {object} parts - { messages: string[], memories: string[] } — the variable parts
 * @returns {{ systemPrompt: string, userPrompt: string, truncated: boolean }}
 */
function fitToContextWindow(systemPrompt, userPrompt, parts = {}) {
    const maxTokens = getMaxInputTokens();
    const totalTokens = estimateTokens(systemPrompt) + estimateTokens(userPrompt);

    if (totalTokens <= maxTokens) {
        return { systemPrompt, userPrompt, truncated: false };
    }

    console.warn(`⚠️ Prompt exceeds context window: ${totalTokens} tokens > ${maxTokens} budget. Truncating...`);

    // Strategy 1: Shorten system prompt (keep first 800 chars)
    let shortened = systemPrompt;
    if (estimateTokens(systemPrompt) > 300) {
        shortened = systemPrompt.substring(0, 1000);
    }

    // Strategy 2: Shorten user prompt content
    let shorterUser = userPrompt;
    // Progressively shorten — try 3000, 2000, 1200, 800 char limits
    for (const limit of [3000, 2000, 1200, 800]) {
        if (estimateTokens(shortened) + estimateTokens(shorterUser) <= maxTokens) break;
        shorterUser = truncatePromptContent(userPrompt, limit);
    }

    const finalTokens = estimateTokens(shortened) + estimateTokens(shorterUser);
    if (finalTokens > maxTokens) {
        // Last resort: hard truncate user prompt to fit
        const availableChars = Math.floor((maxTokens - estimateTokens(shortened)) * CHARS_PER_TOKEN);
        shorterUser = shorterUser.substring(0, Math.max(200, availableChars));
    }

    console.log(`  → Truncated: ${totalTokens} → ${estimateTokens(shortened) + estimateTokens(shorterUser)} tokens`);
    return { systemPrompt: shortened, userPrompt: shorterUser, truncated: true };
}

/**
 * Truncate the dynamic parts of a user prompt (messages, memories)
 * while preserving the template structure.
 */
function truncatePromptContent(prompt, maxCharsPerField) {
    // Shorten content between "User:" and "Agent:" markers
    let result = prompt.replace(
        /User: (.+?)\nAgent: (.+?)\n/gs,
        (match, userMsg, agentMsg) => {
            const u = userMsg.substring(0, maxCharsPerField);
            const a = agentMsg.substring(0, maxCharsPerField);
            return `User: ${u}\nAgent: ${a}\n`;
        }
    );

    // Shorten existing memories section (keep fewer items)
    const memorySection = result.match(/EXISTING MEMORIES:\n([\s\S]*?)\n\n/)?.[1];
    if (memorySection) {
        const lines = memorySection.split('\n').filter(l => l.trim());
        if (lines.length > 5) {
            const kept = lines.slice(0, 5).map(l => l.substring(0, maxCharsPerField)).join('\n');
            result = result.replace(memorySection, kept);
        }
    }

    return result;
}

// Timeout read dynamically from runtimeConfig

// ============ PROMPTS ============

// USER facts — extracts info about the USER only (mem0 pattern)
const USER_FACT_SYSTEM_PROMPT = `You are a Personal Memory Curator. Your job is to extract ONLY high-value, long-lasting facts about the USER from conversations.

You must be VERY SELECTIVE — most exchanges contain NO facts worth remembering. Quality over quantity.

=== WHAT TO REMEMBER (extract these) ===
1. PREFERENCES: "Tao thích PostgreSQL hơn MySQL", "Tao dùng VS Code"
2. PERSONAL INFO: name, location, timezone, language, relationships
3. DECISIONS MADE: "OK dùng TypeScript", "Chốt dùng Redis cho cache"
4. TECHNICAL ENVIRONMENT: OS, tools, frameworks, versions in use
5. WORK STYLE / RULES: "Luôn chạy test trước commit", "Tao muốn code clean"
6. LONG-TERM GOALS: "Tao đang build hệ thống memory cho AI"
7. FEEDBACK / EVALUATIONS: "Cách này chậm quá", "UI này đẹp"
8. AGREEMENTS: When user says "OK", "được", "ừ" to a specific agent proposal → extract the DECISION, not the acknowledgment
   Example: Agent: "Dùng Redis cho cache nhé?" User: "OK" → Fact: "User đồng ý dùng Redis cho caching"

=== WHAT TO IGNORE (never extract) ===
1. GREETINGS/FILLER: "hi", "ok", "cảm ơn", "được rồi", "hmm" (unless confirming a decision)
2. QUESTIONS (from either party): A question is NOT a fact. "Docker có hỗ trợ X không?" = not a fact
3. AGENT'S WORDS: Never extract what the AGENT said as a user fact
4. DEBUGGING/ERRORS: "Error: port 3000 in use", stack traces, specific error messages
5. TEMPORARY STATE: "Server đang down", "Đang build lại", "File vừa tạo xong"
6. PROCEDURAL ACTIONS: "Đã push code", "Đã chạy npm install", "Đã restart server"
7. HYPOTHETICALS: "Nếu dùng Go thì...", "Có thể thử...", "Maybe..."
8. CODE SNIPPETS: Don't save code blocks or commands as facts
9. AGENT QUESTIONS rephrased as user facts: Agent asks "Bạn muốn X?" → Do NOT create "User muốn X"
10. UNANSWERED QUESTIONS: If user asks something but doesn't state a preference, skip it

=== TRICKY CASES (pay attention) ===
- Agent suggests X, user says "OK/ừ/được" → ✅ Extract: "User chọn X" (this IS a decision)
- Agent suggests X, user ignores or changes topic → ❌ No fact (not confirmed)
- User asks "X hay Y?" → ❌ No fact yet (just a question)
- User says "Dùng X đi" → ✅ Extract: "User quyết định dùng X"
- User says "Tao đã cài X" → ✅ Extract: "User đã cài đặt X" (environment info)
- User says "Fix lỗi Y đi" → ❌ Not a fact (this is a task instruction)
- User says "Tao thường dùng X cho project" → ✅ Preference worth remembering

=== OUTPUT RULES ===
1. Each fact = ONE complete sentence, understandable WITHOUT the conversation
2. Keep ORIGINAL LANGUAGE (Vietnamese → Vietnamese)
3. Be SPECIFIC: include names, tools, versions, numbers
4. If nothing worth remembering → return empty facts array []
5. Return ONLY valid JSON, no markdown
6. When in doubt, DON'T extract. False negatives are better than false positives.`;

// AGENT facts — extracts info about the AGENT/ASSISTANT only
const AGENT_FACT_SYSTEM_PROMPT = `You are an Assistant Memory Curator. Extract ONLY significant DECISIONS and RECOMMENDATIONS the assistant made.

=== WHAT TO REMEMBER ===
1. DECISIONS: "Agent quyết định dùng Redis cho caching" (concrete technical choices)
2. RECOMMENDATIONS ACCEPTED: Agent suggested X and user agreed → save as decision
3. SOLUTIONS PROVIDED: "Agent đã fix lỗi bằng cách thay đổi UUID thành TEXT" (significant changes)

=== WHAT TO IGNORE ===
1. QUESTIONS the agent asks: "Bạn muốn dùng gì?" is NOT a fact
2. PROCEDURAL EXPLANATIONS: step-by-step instructions, how-to guides
3. CODE SNIPPETS: specific code the agent wrote
4. GENERIC KNOWLEDGE: things any AI would know ("PostgreSQL is a relational database")
5. ACKNOWLEDGMENTS: "OK, tôi sẽ làm", "Được, để tôi xem"
6. STATUS UPDATES: "Đã tạo file", "Đã push code", "Server đã restart"

=== OUTPUT RULES ===
1. Each fact = ONE complete sentence about the ASSISTANT's decisions/actions
2. Keep ORIGINAL LANGUAGE. Return ONLY valid JSON.
3. If nothing significant → return empty array.
4. Be VERY selective — only save decisions that affect future interactions.`;

const FACT_EXTRACTION_USER_TEMPLATE = `Extract atomic facts from this exchange.

Each fact should be:
- Self-contained (understandable without context)
- Specific (include names, numbers, tools, versions)
- Written as a statement about the {{ACTOR_TYPE}}
- EXACTLY ONE piece of information per fact (never combine multiple facts into one)

Example:
User: "Tao thich TypeScript va tao dang song o Ha Noi"
Correct: ["User thích dùng TypeScript", "User đang sống ở Hà Nội"]
Wrong: ["User thích TypeScript và đang sống ở Hà Nội"]

EXCHANGE:
User: {{USER_MESSAGE}}
Agent: {{AGENT_RESPONSE}}

Return JSON:
{
  "facts": ["one atomic fact per entry", "another separate atomic fact"],
  "entities": ["tech/tool/person mentioned"],
  "topic": "main topic of the exchange"
}

Return ONLY the JSON object, no other text.`;

// ============ MAIN EXTRACTION ============

/**
 * Extract atomic facts from a single user-agent exchange.
 * Returns BOTH user facts and agent facts with actor attribution.
 * 
 * @param {string} userMessage - The user's message
 * @param {string} agentResponse - The agent's response
 * @param {object} options - { extractAgentFacts: false }
 * @returns {Promise<{facts: string[], entities: string[], topic: string, actorId: string, agentFacts?: string[]}>}
 */
async function extractFacts(userMessage, agentResponse, options = {}) {
    const { extractAgentFacts = false } = options;

    // Skip trivial exchanges
    if (userMessage.length < 15 && agentResponse.length < 50) {
        return { facts: [], entities: [], topic: 'general', actorId: 'user' };
    }

    const results = { facts: [], entities: [], topic: 'general', actorId: 'user' };

    // Extract USER facts (primary)
    try {
        const userResult = await callOllamaForFacts(userMessage, agentResponse, 'user');
        results.facts = Array.isArray(userResult.facts) ? userResult.facts.filter(f => f && f.length > 10) : [];
        results.entities = Array.isArray(userResult.entities) ? userResult.entities : [];
        results.topic = userResult.topic || 'general';
        results.actorId = 'user';
    } catch (err) {
        console.warn('⚠️ User fact extraction LLM failed, using local fallback:', err.message);
        const fallback = localFactExtraction(userMessage, agentResponse);
        results.facts = fallback.facts;
        results.entities = fallback.entities;
    }

    // Extract AGENT facts (optional — for remembering what the assistant decided/recommended)
    const agentFactMinLen = runtimeConfig.get('memory.agentFactMinResponseLength');
    if (extractAgentFacts && agentResponse.length > agentFactMinLen) {
        try {
            const agentResult = await callOllamaForFacts(userMessage, agentResponse, 'agent');
            results.agentFacts = Array.isArray(agentResult.facts) ? agentResult.facts.filter(f => f && f.length > 10) : [];
        } catch {
            // Agent fact extraction is optional — silently skip
            results.agentFacts = [];
        }
    }

    return results;
}

// ============ OLLAMA CALL ============

async function callOllamaForFacts(userMessage, agentResponse, actorType = 'user') {
    const systemPrompt = actorType === 'agent' ? AGENT_FACT_SYSTEM_PROMPT : USER_FACT_SYSTEM_PROMPT;
    const userPrompt = FACT_EXTRACTION_USER_TEMPLATE
        .replace('{{USER_MESSAGE}}', userMessage.substring(0, 2000))
        .replace('{{AGENT_RESPONSE}}', agentResponse.substring(0, 2000))
        .replace('{{ACTOR_TYPE}}', actorType);

    return llmService.chatJSON(systemPrompt, userPrompt, {
        maxTokens: 2000,
        timeout: runtimeConfig.get('factExtraction.timeout'),
        purpose: `${actorType}_fact_extract`,
    });
}

// ============ LOCAL FALLBACK ============

function localFactExtraction(userMessage, agentResponse) {
    const facts = [];
    const entities = [];

    const preferencePatterns = [
        /(?:tôi|mình|tao|I)\s+(?:thích|muốn|cần|dùng|sử dụng|prefer|want|need|use|like)\s+(.+)/gi,
        /(?:tôi|mình|tao|I)\s+(?:là|am|work|làm)\s+(.+)/gi,
        /(?:chọn|choose|pick|selected|dùng|use)\s+(\S+)\s+(?:thay vì|instead of|rather than|hơn)\s+/gi,
    ];

    for (const pattern of preferencePatterns) {
        const matches = userMessage.matchAll(pattern);
        for (const match of matches) {
            facts.push(match[0].trim());
        }
    }

    const techPatterns = /\b(React|Vue|Angular|Node\.?js|Express|Docker|PostgreSQL|Redis|MongoDB|TypeScript|Python|Rust|Go|Kubernetes|AWS|Azure|GCP|Prisma|Sequelize|TypeORM|Qdrant|Ollama|Vite|Next\.?js|FastAPI|Django|Flask)\b/gi;
    const techMatches = `${userMessage} ${agentResponse}`.matchAll(techPatterns);
    for (const match of techMatches) {
        if (!entities.includes(match[1])) {
            entities.push(match[1]);
        }
    }

    return { facts, entities, topic: 'general' };
}

// ============ JSON PARSER ============

function parseJsonResponse(text) {
    if (!text || typeof text !== 'string') {
        throw new Error('Empty or invalid response text');
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

    throw new Error(`Could not parse JSON from fact extraction response: ${text.substring(0, 200)}`);
}

// ============ COMBINED EXTRACT + DEDUP (MiniMax optimization — 1 LLM call) ============

const COMBINED_SYSTEM_PROMPT = `You are a Memory Manager. Extract ONLY high-value facts worth remembering long-term, then deduplicate against existing memories.

Be VERY SELECTIVE — most exchanges have 0-2 facts. Quality over quantity.

=== USER FACTS: Things the USER stated/decided ===
REMEMBER: preferences, decisions, personal info, environment, goals, work style, feedback
IGNORE: questions, greetings, "ok"/"hmm", debugging errors, temporary state, task instructions

SPECIAL: If agent proposes X and user agrees ("ok", "ừ", "được") → extract as user decision:
  Agent: "Dùng Redis nhé?" User: "OK" → user_fact: "User đồng ý dùng Redis"
  Agent: "Dùng Redis nhé?" User: (changes topic) → NO fact (not confirmed)

=== AGENT FACTS: Significant decisions/recommendations the AGENT made ===
REMEMBER: concrete technical decisions, accepted recommendations, significant solutions
IGNORE: questions asked, procedural steps, code snippets, status updates, generic explanations

=== NEVER EXTRACT ===
- Questions from either party ("Bạn muốn dùng gì?" is NOT a fact)
- Greetings/filler without decisions ("hi", "cảm ơn", "được rồi")
- Debugging: error messages, stack traces, port conflicts
- Temporary state: "đang build", "server down", "file vừa tạo"
- Procedural: "chạy npm install", "đã push code", "đã restart"
- Hypothetical: "nếu...", "có thể...", "maybe..."
- Code blocks or specific commands
- Rephrased versions of the other party's words

=== DEDUP RULES ===
- ADD: genuinely new information
- UPDATE: existing memory is CONTRADICTED (provide old_memory_id)
- NONE: already covered by existing memory (STRONGLY prefer this)
- DELETE: explicitly stated something is no longer true

=== OUTPUT ===
- Each fact = ONE complete sentence, self-contained, original language
- When in doubt, DON'T extract. Empty arrays are fine.
- Return ONLY valid JSON.`;

const COMBINED_USER_TEMPLATE = `EXCHANGE:
User: {{USER_MESSAGE}}
Agent: {{AGENT_RESPONSE}}

EXISTING MEMORIES:
{{EXISTING_MEMORIES}}

Extract facts AND decide dedup actions. Return JSON:
{
  "user_facts": [
    { "text": "fact about the user", "action": "ADD|UPDATE|NONE|DELETE", "old_memory_id": null }
  ],
  "agent_facts": [
    { "text": "fact about the assistant", "action": "ADD|UPDATE|NONE|DELETE", "old_memory_id": null }
  ],
  "entities": ["tech/tool/person mentioned"],
  "topic": "main topic"
}

For UPDATE/DELETE, set old_memory_id to the [N] index of the existing memory being changed.
Return ONLY the JSON object.`;

/**
 * Combined extract + dedup for cloud providers (MiniMax).
 * Does user facts + agent facts + dedup decisions in 1 LLM call.
 *
 * @param {string} userMessage
 * @param {string} agentResponse
 * @param {Map} existingMemories - Map of id → {id, content} from vector search
 * @returns {Promise<{user_facts: Array, agent_facts: Array, entities: string[], topic: string}>}
 */
async function extractAndDedup(userMessage, agentResponse, existingMemories = new Map()) {
    // Build existing memories text for prompt
    const memoryEntries = Array.from(existingMemories.entries());
    const maxMems = getMaxInputTokens() < 2000 ? 5 : 15; // fewer memories for small context windows
    const limitedEntries = memoryEntries.slice(0, maxMems);
    const existingForPrompt = limitedEntries.length > 0
        ? limitedEntries.map(([, mem], idx) => `[${idx}] ${mem.content.substring(0, 200)}`).join('\n')
        : '(none — all facts are new)';

    // Adaptive message truncation based on context window
    const maxMsgChars = getMaxInputTokens() < 2000 ? 500 : 3000;
    let userPrompt = COMBINED_USER_TEMPLATE
        .replace('{{USER_MESSAGE}}', userMessage.substring(0, maxMsgChars))
        .replace('{{AGENT_RESPONSE}}', agentResponse.substring(0, maxMsgChars))
        .replace('{{EXISTING_MEMORIES}}', existingForPrompt);

    // Context window protection
    const fitted = fitToContextWindow(COMBINED_SYSTEM_PROMPT, userPrompt);

    const result = await llmService.chatJSON(fitted.systemPrompt, fitted.userPrompt, {
        maxTokens: 4000,
        timeout: runtimeConfig.get('factExtraction.timeout') * 2,
        purpose: 'combined_extract_dedup',
    });

    return {
        user_facts: Array.isArray(result.user_facts) ? result.user_facts.filter(f => f && f.text && f.text.length > 10) : [],
        agent_facts: Array.isArray(result.agent_facts) ? result.agent_facts.filter(f => f && f.text && f.text.length > 10) : [],
        entities: Array.isArray(result.entities) ? result.entities : [],
        topic: result.topic || 'general',
        _existingMemoryEntries: memoryEntries, // pass through for action resolution
    };
}

// ============ BATCH EXTRACT + DEDUP (multiple exchanges → 1 LLM call) ============

const BATCH_USER_TEMPLATE = `EXCHANGES:
{{EXCHANGES}}

EXISTING MEMORIES:
{{EXISTING_MEMORIES}}

Extract facts from ALL exchanges AND decide dedup actions. Return JSON:
{
  "user_facts": [
    { "text": "fact about the user", "action": "ADD|UPDATE|NONE|DELETE", "old_memory_id": null }
  ],
  "agent_facts": [
    { "text": "fact about the assistant", "action": "ADD|UPDATE|NONE|DELETE", "old_memory_id": null }
  ],
  "entities": ["tech/tool/person mentioned"],
  "topic": "main topic"
}

For UPDATE/DELETE, set old_memory_id to the [N] index of the existing memory being changed.
Return ONLY the JSON object.`;

/**
 * Batch extract + dedup: process multiple exchanges in 1 LLM call.
 *
 * @param {Array<{userMessage: string, agentResponse: string}>} exchanges
 * @param {Map} existingMemories
 * @returns {Promise<{user_facts: Array, agent_facts: Array, entities: string[], topic: string}>}
 */
async function extractAndDedupBatch(exchanges, existingMemories = new Map()) {
    const memoryEntries = Array.from(existingMemories.entries());
    const maxMems = getMaxInputTokens() < 2000 ? 5 : 15;
    const limitedEntries = memoryEntries.slice(0, maxMems);
    const existingForPrompt = limitedEntries.length > 0
        ? limitedEntries.map(([, mem], idx) => `[${idx}] ${mem.content.substring(0, 150)}`).join('\n')
        : '(none — all facts are new)';

    // Build exchanges section — adaptive truncation
    const maxMsgChars = getMaxInputTokens() < 2000
        ? Math.max(100, Math.floor(400 / exchanges.length)) // share budget across exchanges
        : 1500;

    const exchangesText = exchanges.map((ex, i) =>
        `[Exchange ${i + 1}]\nUser: ${ex.userMessage.substring(0, maxMsgChars)}\nAgent: ${ex.agentResponse.substring(0, maxMsgChars)}`
    ).join('\n\n');

    let userPrompt = BATCH_USER_TEMPLATE
        .replace('{{EXCHANGES}}', exchangesText)
        .replace('{{EXISTING_MEMORIES}}', existingForPrompt);

    // Context window protection
    const fitted = fitToContextWindow(COMBINED_SYSTEM_PROMPT, userPrompt);

    const result = await llmService.chatJSON(fitted.systemPrompt, fitted.userPrompt, {
        maxTokens: 4000,
        timeout: runtimeConfig.get('factExtraction.timeout') * 3, // more time for batch
        purpose: 'batch_extract_dedup',
    });

    return {
        user_facts: Array.isArray(result.user_facts) ? result.user_facts.filter(f => f && f.text && f.text.length > 10) : [],
        agent_facts: Array.isArray(result.agent_facts) ? result.agent_facts.filter(f => f && f.text && f.text.length > 10) : [],
        entities: Array.isArray(result.entities) ? result.entities : [],
        topic: result.topic || 'general',
        _existingMemoryEntries: memoryEntries,
    };
}

module.exports = {
    extractFacts,
    extractAndDedup,
    extractAndDedupBatch,
    localFactExtraction,
    parseJsonResponse,
    estimateTokens,
    fitToContextWindow,
    USER_FACT_SYSTEM_PROMPT,
    AGENT_FACT_SYSTEM_PROMPT,
};

