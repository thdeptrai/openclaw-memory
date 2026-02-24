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
 * MiniMax has a small context window (~2013 tokens total, reserve 400 for output).
 * Ollama has much larger context windows.
 */
function getMaxInputTokens() {
    const provider = runtimeConfig.get('llm.provider') || 'minimax';
    if (provider === 'minimax') {
        return runtimeConfig.get('minimax.maxInputTokens') || 1600;
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
const USER_FACT_SYSTEM_PROMPT = `You are a Personal Information Organizer, specialized in accurately storing facts, user memories, and preferences.
Your primary role is to extract relevant pieces of information from the USER's messages and organize them into distinct, manageable facts.

[IMPORTANT]: YOU WILL BE PENALIZED IF YOU INCLUDE INFORMATION FROM ASSISTANT OR SYSTEM MESSAGES.

Types of Information to Remember:
1. Personal Preferences: likes, dislikes, specific preferences (food, tools, activities)
2. Important Personal Details: names, relationships, important dates
3. Plans and Intentions: upcoming events, goals, plans shared
4. Activity Preferences: dining, travel, hobbies, services
5. Health/Wellness: dietary restrictions, fitness, wellness info
6. Professional Details: job titles, work habits, career goals
7. Technical Preferences: preferred tools, frameworks, coding styles, IDE settings
8. Miscellaneous: favorite books, movies, brands, other details

CRITICAL RULES:
1. Each fact MUST be a COMPLETE sentence — understandable WITHOUT the conversation.
2. Include specific values, numbers, tool names, config details — never vague.
3. Keep the ORIGINAL LANGUAGE (Vietnamese → Vietnamese output).
4. ONLY extract facts from the USER's messages. NEVER from assistant messages.
5. ONLY extract information EXPLICITLY stated. Do NOT infer or hallucinate.
6. If exchange is just a greeting or has no meaningful user info, return empty facts array.
7. Return ONLY valid JSON — no markdown, no explanations.
8. ONE FACT = ONE ATOMIC STATEMENT. Never combine multiple pieces of information into a single fact.
   BAD: "User likes TypeScript and lives in Hanoi" (2 facts combined)
   GOOD: ["User thích dùng TypeScript", "User đang sống ở Hà Nội"] (2 separate facts)`;

// AGENT facts — extracts info about the AGENT/ASSISTANT only (mem0 pattern)
const AGENT_FACT_SYSTEM_PROMPT = `You are an Assistant Information Organizer, specialized in accurately storing facts, preferences, and characteristics about the AI assistant from conversations.
Your primary role is to extract relevant pieces of information about the assistant from conversations.

[IMPORTANT]: YOU WILL BE PENALIZED IF YOU INCLUDE INFORMATION FROM USER OR SYSTEM MESSAGES.

Types of Information to Remember:
1. Assistant's Capabilities: skills, knowledge areas, tasks it can perform
2. Assistant's Approach: how it handles different types of tasks
3. Assistant's Preferences: mentioned likes, suggestions, recommended approaches
4. Decisions Made: technical decisions, recommendations given
5. Knowledge Areas: subjects or fields demonstrated knowledge in

CRITICAL RULES:
1. Each fact MUST be a COMPLETE sentence — understandable WITHOUT the conversation.
2. Keep the ORIGINAL LANGUAGE (Vietnamese → Vietnamese output).
3. ONLY extract facts from the ASSISTANT's messages. NEVER from user messages.
4. ONLY extract information EXPLICITLY stated. Do NOT infer or hallucinate.
5. If exchange has no meaningful assistant info, return empty facts array.
6. Return ONLY valid JSON.`;

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
        maxTokens: 1000,
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

const COMBINED_SYSTEM_PROMPT = `You are a Memory Manager that performs TWO tasks in ONE pass:
1. EXTRACT atomic facts from a user-agent exchange (both user facts and agent facts)
2. DEDUPLICATE: compare extracted facts against existing memories and decide actions

EXTRACTION RULES:
- Extract facts about the USER from the user's messages (preferences, personal info, plans, etc.)
- Extract facts about the ASSISTANT from the agent's responses (decisions, recommendations, knowledge)
- Each fact = ONE atomic statement, self-contained
- Keep ORIGINAL LANGUAGE (Vietnamese → Vietnamese)
- Only extract EXPLICITLY stated information

DEDUP RULES:
- For each extracted fact, compare with EXISTING MEMORIES
- ADD: genuinely new information not in any existing memory
- UPDATE: an existing memory is CONTRADICTED or CORRECTED by the new fact. Provide old_memory_id.
- NONE: fact is already covered by an existing memory (same meaning)
- DELETE: fact explicitly says something is no longer true. Provide old_memory_id.
- STRONGLY prefer NONE over UPDATE when meaning is the same
- When UPDATEing, write the merged/improved text

Return ONLY valid JSON.`;

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
        maxTokens: getMaxInputTokens() < 2000 ? 500 : 2000,
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
        maxTokens: getMaxInputTokens() < 2000 ? 500 : 2000,
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

