/**
 * ============================================================
 *  Memory Deduplicator — Intelligent ADD/UPDATE/DELETE decisions
 *  Inspired by mem0's architecture:
 *    1. Content hash pre-check (skip LLM for exact duplicates)
 *    2. Embed all facts → search all → SINGLE batched LLM call
 *    3. UUID → integer mapping (prevents LLM hallucination)
 *    4. Embedding reuse map (avoids redundant Ollama calls)
 *    5. NONE action updates session metadata
 *    6. old_memory tracking for audit trail
 * ============================================================
 */
const crypto = require('crypto');
const config = require('../config');
const runtimeConfig = require('../runtimeConfig');
const llmService = require('./llmService');
const embeddingService = require('./embeddingService');
const vectorStore = require('./vectorStore');
const db = require('../models');
const eventBus = require('./eventBus');

// ============ PROMPTS (mem0-inspired with old_memory tracking) ============

const DEDUP_SYSTEM_PROMPT = `You are a smart memory manager which controls the memory of a system.
You can perform four operations: (1) ADD into memory, (2) UPDATE memory, (3) DELETE from memory, (4) NONE (no change).

Compare newly retrieved facts with existing memories. For each new fact, decide:
- ADD: The fact is genuinely new information not in any existing memory. Generate a new integer ID.
- UPDATE: An existing memory CONTRADICTS or is CORRECTED by the new fact. Merge both into an improved version. Keep the SAME ID.
- DELETE: The new fact explicitly says something is no longer true, making an existing memory obsolete. Keep the SAME ID.
- NONE: The fact is already fully covered by an existing memory (same meaning, possibly different wording). No action needed.

RULES:
1. STRONGLY prefer NONE over UPDATE when the meaning is the same. Only use UPDATE when the new fact adds genuinely new detail or CONTRADICTS the existing memory.
2. NEVER use UPDATE just because the wording is slightly different. If the core information is the same, use NONE.
3. When UPDATEing, combine old memory + new fact into ONE improved sentence.
4. Keep the ORIGINAL LANGUAGE (Vietnamese → Vietnamese).
5. Return ONLY valid JSON — no markdown, no explanations.
6. Use ONLY the integer IDs from the existing memories list. Do NOT invent new IDs for UPDATE/DELETE.
7. For CONTRADICTIONS (e.g., "used to live in A, now lives in B"), use UPDATE to replace the old fact with the new one.
8. Each new fact should produce EXACTLY ONE action entry. Do not skip any facts.`;

const DEDUP_USER_TEMPLATE = `EXISTING MEMORIES:
{{EXISTING_MEMORIES}}

NEW FACTS:
{{NEW_FACTS}}

For each new fact, decide the action. Return JSON:
{
  "memory": [
    {
      "id": "<integer ID — use existing ID for UPDATE/DELETE, or new sequential ID for ADD>",
      "text": "<memory content>",
      "event": "ADD | UPDATE | DELETE | NONE",
      "old_memory": "<old memory text — required for UPDATE, omit for others>",
      "fact_index": 0
    }
  ]
}

Return ONLY the JSON object.`;

// ============ MAIN DEDUP ============

/**
 * Process a list of new facts against existing memories.
 * Pipeline: hash-check → embed → search → LLM decide → apply.
 * 
 * Returns an embeddingMap so callers can reuse embeddings without re-generating.
 * 
 * @param {string[]} facts - New facts to process
 * @param {object} context - { agentId, conversationId, topic, scope, entities, actorId }
 * @returns {Promise<{added: number, updated: number, deleted: number, skipped: number, memories: object[], embeddingMap: object}>}
 */
async function deduplicateAndStore(facts, context) {
    const { agentId, conversationId, topic = 'general', scope = 'unknown', entities = [], actorId = 'user' } = context;

    if (!facts || facts.length === 0) {
        return { added: 0, updated: 0, deleted: 0, skipped: 0, memories: [], embeddingMap: {} };
    }

    // ====== Step 0: Content hash pre-check (skip LLM for exact duplicates) ======
    const factsToProcess = [];
    const hashSkipped = [];
    const contentHashes = {};

    for (const fact of facts) {
        const hash = crypto.createHash('md5').update(fact).digest('hex');
        contentHashes[fact] = hash;

        try {
            const existing = await db.findMemoryByHash(hash, agentId);
            if (existing) {
                hashSkipped.push(fact);
                // Link existing memory to current conversation (many-to-many)
                await db.linkMemoryToConversation(existing.id, conversationId).catch(() => { });
                console.log(`  ⚡ Hash match — skipped exact duplicate: "${fact.substring(0, 60)}..."`);
            } else {
                factsToProcess.push(fact);
            }
        } catch {
            // Hash check failed — process normally
            factsToProcess.push(fact);
        }
    }

    if (factsToProcess.length === 0) {
        return {
            added: 0, updated: 0, deleted: 0,
            skipped: facts.length,
            memories: [],
            embeddingMap: {},
        };
    }

    // ====== Step 1: Embed all new facts (parallel) ======
    // This embedding map is reused downstream to avoid re-embedding
    const embeddingMap = {};
    const embedResults = await Promise.allSettled(
        factsToProcess.map(async (fact) => {
            const emb = await embeddingService.generateEmbedding(fact);
            return { fact, emb };
        })
    );
    for (const result of embedResults) {
        if (result.status === 'fulfilled') {
            embeddingMap[result.value.fact] = result.value.emb;
        } else {
            console.warn(`⚠️ Failed to embed fact: ${result.reason?.message}`);
        }
    }

    // ====== Step 2: Search similar existing memories (parallel) ======
    const existingMemories = new Map(); // id → {id, content, score}
    const factsWithEmbeddings = factsToProcess.filter(f => embeddingMap[f]);
    const searchResults = await Promise.allSettled(
        factsWithEmbeddings.map(async (fact) => {
            const similar = await vectorStore.searchSimilar(embeddingMap[fact], {
                limit: 5,
                agentId,
                type: 'fact',
                scoreThreshold: 0.35,
            });
            return similar;
        })
    );
    for (const result of searchResults) {
        if (result.status === 'fulfilled') {
            for (const hit of result.value) {
                if (!existingMemories.has(hit.id)) {
                    existingMemories.set(hit.id, {
                        id: hit.id,
                        content: hit.payload?.content || '',
                        type: hit.payload?.type || 'fact',
                        score: hit.score,
                    });
                }
            }
        }
    }

    // ====== Step 3: If no similar memories exist, just ADD all facts ======
    if (existingMemories.size === 0) {
        const memories = [];
        for (const fact of factsToProcess) {
            const mem = await addNewMemory(fact, embeddingMap[fact], context, contentHashes[fact]);
            if (mem) memories.push(mem);
        }
        return {
            added: memories.length, updated: 0, deleted: 0,
            skipped: hashSkipped.length,
            memories,
            embeddingMap,
        };
    }

    // ====== Step 4: SINGLE batched LLM dedup decision (mem0 pattern) ======
    let actions;
    try {
        actions = await callOllamaForDedup(factsToProcess, existingMemories);
    } catch (err) {
        console.warn('⚠️ Dedup LLM failed, falling back to ADD-all:', err.message);
        const memories = [];
        for (const fact of factsToProcess) {
            const mem = await addNewMemory(fact, embeddingMap[fact], context, contentHashes[fact]);
            if (mem) memories.push(mem);
        }
        return {
            added: memories.length, updated: 0, deleted: 0,
            skipped: hashSkipped.length,
            memories,
            embeddingMap,
        };
    }

    // ====== Step 5: Apply actions ======
    const result = await applyActions(actions, factsToProcess, embeddingMap, existingMemories, context, contentHashes);
    result.skipped += hashSkipped.length;
    result.embeddingMap = embeddingMap;
    return result;
}

// ============ APPLY ACTIONS ============

async function applyActions(actions, facts, embeddingMap, existingMemories, context, contentHashes = {}) {
    const result = { added: 0, updated: 0, deleted: 0, skipped: 0, memories: [] };

    // Convert existingMemories map back to UUID mapping
    const memoryEntries = Array.from(existingMemories.entries());
    const intToUuid = {};
    memoryEntries.forEach(([uuid], idx) => {
        intToUuid[String(idx)] = uuid;
    });

    for (const action of actions) {
        try {
            const factIdx = action.fact_index;
            if (factIdx < 0 || factIdx >= facts.length) continue;

            const fact = facts[factIdx];
            const embedding = embeddingMap[fact]; // REUSE — no re-embed

            switch (action.event || action.action) {
                case 'ADD': {
                    const content = action.text || action.merged_content || fact;
                    const mem = await addNewMemory(content, embedding, context, contentHashes[fact]);
                    if (mem) {
                        result.memories.push(mem);
                        result.added++;
                        await db.addMemoryHistory({
                            memoryId: mem.id, event: 'ADD', newContent: content,
                            changedBy: context.agentId || 'fact_extractor',
                            changeReason: 'fact_extraction',
                            metadata: { fact_index: factIdx, reason: action.reason },
                        }).catch(() => { });
                    }
                    break;
                }

                case 'UPDATE': {
                    const oldUuid = intToUuid[String(action.id ?? action.memory_id)];
                    const mergedContent = action.text || action.merged_content;
                    if (!oldUuid || !mergedContent) {
                        // Can't update without target or content — just ADD
                        const mem = await addNewMemory(fact, embedding, context, contentHashes[fact]);
                        if (mem) {
                            result.memories.push(mem);
                            result.added++;
                        }
                        break;
                    }

                    // Reuse embedding if merged content is same as fact, otherwise generate new
                    let mergedEmbedding = embeddingMap[mergedContent] || embeddingMap[fact];
                    if (mergedContent !== fact && !embeddingMap[mergedContent]) {
                        try {
                            mergedEmbedding = await embeddingService.generateEmbedding(mergedContent);
                            embeddingMap[mergedContent] = mergedEmbedding; // cache for reuse
                        } catch (err) {
                            console.warn('⚠️ Failed to embed merged content, reusing fact embedding:', err.message);
                        }
                    }

                    const newHash = crypto.createHash('md5').update(mergedContent).digest('hex');
                    const newMem = await addNewMemory(mergedContent, mergedEmbedding, context, newHash);
                    if (newMem) {
                        // Mark old memory as superseded in PG
                        await db.supersedeMemory(oldUuid, newMem.id);
                        // Migrate all conversation links from old memory → new memory
                        await db.migrateMemoryLinks(oldUuid, newMem.id).catch(() => { });
                        // DELETE old vector from Qdrant so it's no longer recalled
                        await vectorStore.deleteVector(oldUuid);
                        // Insert new vector with merged embedding
                        try {
                            await vectorStore.upsertVector(newMem.id, mergedEmbedding, {
                                memory_id: newMem.id,
                                agent_id: context.agentId,
                                type: newMem.type,
                                content: mergedContent,
                                conversation_id: context.conversationId,
                                importance_score: 0.75,
                                topic: context.topic || 'general',
                                scope: context.scope || 'unknown',
                                created_at: new Date().toISOString(),
                            });
                        } catch (err) {
                            console.warn('⚠️ Failed to index updated memory:', err.message);
                        }

                        result.memories.push(newMem);
                        result.updated++;
                        console.log(`  🔄 Updated memory: "${oldUuid.substring(0, 8)}..." → "${newMem.id.substring(0, 8)}..."`);
                        // Audit trail with old_memory tracking (mem0 pattern)
                        const oldMem = existingMemories.get(oldUuid);
                        await db.addMemoryHistory({
                            memoryId: newMem.id, event: 'UPDATE',
                            oldContent: oldMem?.content || action.old_memory || null,
                            newContent: mergedContent,
                            changedBy: context.agentId || 'fact_extractor',
                            changeReason: 'dedup_merge',
                            metadata: { old_memory_id: oldUuid, reason: action.reason, old_memory: action.old_memory },
                        }).catch(() => { });
                    }
                    break;
                }

                case 'DELETE': {
                    const delUuid = intToUuid[String(action.id ?? action.memory_id)];
                    if (delUuid) {
                        try {
                            const oldMem = existingMemories.get(delUuid);
                            // Delete from Qdrant by point ID and by filter (belt-and-suspenders)
                            await vectorStore.deleteVector(delUuid);
                            await vectorStore.deleteByFilter('memory_id', delUuid);
                            console.log(`  🗑️ Deleted obsolete memory: ${delUuid.substring(0, 8)}...`);
                            result.deleted++;
                            await db.addMemoryHistory({
                                memoryId: delUuid, event: 'DELETE',
                                oldContent: oldMem?.content || null,
                                changedBy: context.agentId || 'fact_extractor',
                                changeReason: 'contradiction',
                                metadata: { reason: action.reason },
                            }).catch(() => { });
                        } catch (err) {
                            console.warn(`⚠️ Failed to delete memory: ${err.message}`);
                        }
                    }
                    break;
                }

                case 'NONE': {
                    // Link existing memory to current conversation (many-to-many)
                    const noneUuid = intToUuid[String(action.id ?? action.memory_id)];
                    if (noneUuid && context.conversationId) {
                        await db.linkMemoryToConversation(noneUuid, context.conversationId).catch(() => { });
                    }
                    result.skipped++;
                    break;
                }
                default:
                    result.skipped++;
                    break;
            }
        } catch (err) {
            console.warn(`⚠️ Error applying action: ${err.message}`);
        }
    }

    return result;
}

// ============ HELPERS ============

async function addNewMemory(content, embedding, context, contentHash = null) {
    const { agentId, conversationId, topic = 'general', scope = 'unknown', actorId = 'user' } = context;

    const mem = await db.addMemory({
        type: 'fact',
        content,
        sourceConversationId: conversationId,
        sourceAgentId: agentId,
        importanceScore: 0.7,
        tags: context.entities || [],
        topic,
        scope,
        category: null,
        contentHash,
        actorId,
    });

    // Link memory to conversation (many-to-many junction table)
    await db.linkMemoryToConversation(mem.id, conversationId).catch(() => { });

    // Index in Qdrant — REUSE embedding from caller (no redundant Ollama call)
    if (embedding) {
        try {
            await vectorStore.upsertVector(mem.id, embedding, {
                memory_id: mem.id,
                agent_id: agentId,
                type: 'fact',
                content: content.substring(0, 500),
                conversation_id: conversationId,
                importance_score: 0.7,
                topic,
                scope,
                created_at: new Date().toISOString(),
            });
        } catch (err) {
            console.warn('⚠️ Failed to index fact in Qdrant:', err.message);
        }
    }

    // Emit event
    eventBus.emit('memory:new', {
        memoryId: mem.id,
        type: 'fact',
        content: content.substring(0, 200),
        agentId,
        conversationId,
        topic,
        source: 'fact_extractor',
    });

    return mem;
}

// ============ OLLAMA DEDUP CALL (single batched call — mem0 pattern) ============

async function callOllamaForDedup(facts, existingMemoriesMap) {
    // Map UUIDs → integers to prevent LLM hallucination (mem0 trick)
    const memoryEntries = Array.from(existingMemoriesMap.entries());
    const existingForPrompt = memoryEntries.length > 0
        ? memoryEntries.map(([, mem], idx) => `[${idx}] ${mem.content}`).join('\n')
        : '(none — all facts are new)';
    const factsForPrompt = facts.map((f, idx) => `[${idx}] ${f}`).join('\n');

    const userPrompt = DEDUP_USER_TEMPLATE
        .replace('{{EXISTING_MEMORIES}}', existingForPrompt)
        .replace('{{NEW_FACTS}}', factsForPrompt);

    const parsed = await llmService.chatJSON(DEDUP_SYSTEM_PROMPT, userPrompt, {
        maxTokens: 1500,
        timeout: runtimeConfig.get('factExtraction.dedupTimeout'),
        purpose: 'dedup',
    });

    // Support both mem0 format {"memory": [...]} and old format {"actions": [...]}
    const actions = parsed.memory || parsed.actions || [];

    // Normalize: ensure each action has fact_index
    return actions.map((a, i) => ({
        ...a,
        fact_index: a.fact_index ?? i,
        event: a.event || a.action || 'NONE',
    }));
}

// ============ JSON PARSER ============

function parseJsonResponse(text) {
    if (!text || typeof text !== 'string') {
        throw new Error('Empty or invalid dedup response');
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

    throw new Error(`Could not parse JSON from dedup response: ${text.substring(0, 200)}`);
}

module.exports = {
    deduplicateAndStore,
    addNewMemoryDirect: addNewMemory,
    // Exported for testing
    callOllamaForDedup,
    applyActions,
};
