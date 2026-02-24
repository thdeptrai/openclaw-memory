/**
 * ============================================================
 *  Batch Processor — Queues exchanges and flushes periodically
 *
 *  Instead of 1 LLM call per exchange, this module:
 *    1. Enqueues incoming exchanges into an in-memory buffer
 *    2. Every N seconds (configurable), flushes the buffer
 *    3. Groups exchanges by agentId
 *    4. Calls extractAndDedupBatch() once per agent group
 *
 *  Result: dramatically fewer LLM calls for cloud providers
 *  (MiniMax charges per prompt, not per token).
 * ============================================================
 */
const runtimeConfig = require('../runtimeConfig');
const factExtractor = require('./factExtractor');
const memoryDeduplicator = require('./memoryDeduplicator');
const embeddingService = require('./embeddingService');
const vectorStore = require('./vectorStore');
const graphService = require('./graphService');
const db = require('../models');
const eventBus = require('./eventBus');

// ============ QUEUE ============
let _memoriesSinceConsolidation = 0; // tracks new memories → triggers KB rebuild at threshold

// Map<agentId, Array<ExchangeEntry>>
const queue = new Map();
let flushTimer = null;
let isProcessing = false;
let totalEnqueued = 0;
let totalFlushed = 0;

/**
 * @typedef {Object} ExchangeEntry
 * @property {string} agentId
 * @property {string} conversationId
 * @property {string} userMessage
 * @property {string} agentResponse
 * @property {string} topic
 */

/**
 * Enqueue an exchange for batch processing.
 * If batch mode is disabled, processes immediately (legacy behavior).
 *
 * @param {ExchangeEntry} entry
 */
function enqueue(entry) {
    const enabled = runtimeConfig.get('batch.enabled');
    if (!enabled) {
        // Fallback: process immediately (1 call per exchange)
        setImmediate(() => processImmediately(entry));
        return;
    }

    const { agentId } = entry;
    if (!queue.has(agentId)) {
        queue.set(agentId, []);
    }
    queue.get(agentId).push(entry);
    totalEnqueued++;

    // Start timer if not already running
    if (!flushTimer) {
        const intervalMs = runtimeConfig.get('batch.intervalMs') || 10000;
        flushTimer = setInterval(() => flush(), intervalMs);
        // Don't keep the process alive just for the timer
        if (flushTimer.unref) flushTimer.unref();
    }
}

/**
 * Flush all queued exchanges — called by timer or on shutdown.
 */
async function flush() {
    if (isProcessing) return; // skip if previous flush still running
    if (getTotalQueued() === 0) return;

    isProcessing = true;
    const snapshot = new Map(queue);
    queue.clear(); // release queue for new entries while processing

    const maxBatchSize = runtimeConfig.get('batch.maxSize') || 10;

    try {
        for (const [agentId, entries] of snapshot) {
            // Split into chunks of maxBatchSize
            for (let i = 0; i < entries.length; i += maxBatchSize) {
                const batch = entries.slice(i, i + maxBatchSize);
                try {
                    await processBatch(agentId, batch);
                    totalFlushed += batch.length;
                } catch (err) {
                    console.error(`⚠️ Batch process failed for ${agentId} (${batch.length} exchanges):`, err.message);
                    // Don't re-queue — the exchanges are already stored in PG,
                    // they just won't get fact extraction this time
                }
            }
        }
    } finally {
        isProcessing = false;
    }
}

/**
 * Process a batch of exchanges for a single agent.
 * 1. Collect existing memories via vector search (1 embedding call)
 * 2. Call extractAndDedupBatch (1 LLM call for all exchanges)
 * 3. Apply resulting actions
 */
async function processBatch(agentId, entries) {
    const t0 = Date.now();
    const provider = runtimeConfig.get('llm.provider') || 'minimax';

    if (provider !== 'minimax') {
        // For Ollama (local), process individually since there's no per-call cost
        for (const entry of entries) {
            await processImmediately(entry);
        }
        return;
    }

    // === Step 1: Collect existing memories for dedup context ===
    let existingMemories = new Map();
    try {
        // Build a combined query from all exchanges for broader context search
        const combinedText = entries
            .map(e => e.userMessage.substring(0, 200) + ' ' + e.agentResponse.substring(0, 200))
            .join(' ')
            .substring(0, 1000);

        const contextEmb = await embeddingService.generateEmbedding(combinedText);
        const similar = await vectorStore.searchSimilar(contextEmb, {
            limit: 10,
            agentId,
            type: 'fact',
            scoreThreshold: 0.35,
        });
        for (const hit of similar) {
            existingMemories.set(hit.id, {
                id: hit.id,
                content: hit.payload?.content || '',
                type: hit.payload?.type || 'fact',
            });
        }
    } catch (err) {
        console.warn('⚠️ Batch: existing memory search failed:', err.message);
    }

    // === Step 2: Single combined LLM call for all exchanges ===
    const exchanges = entries.map(e => ({
        userMessage: e.userMessage,
        agentResponse: e.agentResponse,
    }));

    const combinedResult = await factExtractor.extractAndDedupBatch(exchanges, existingMemories);
    const { user_facts, agent_facts, entities, topic: extractedTopic, _existingMemoryEntries } = combinedResult;

    // === Step 3: Apply actions ===
    const allFacts = [
        ...user_facts.map(f => ({ ...f, actorId: 'user' })),
        ...agent_facts.map(f => ({ ...f, actorId: 'assistant' })),
    ];

    let added = 0, updated = 0, deleted = 0, skipped = 0;

    // Use the first entry's conversationId/topic as default context
    const defaultConvId = entries[0]?.conversationId;
    const defaultTopic = entries[0]?.topic || extractedTopic || 'general';

    for (const factEntry of allFacts) {
        const action = (factEntry.action || 'ADD').toUpperCase();
        const context = {
            agentId,
            conversationId: defaultConvId,
            topic: defaultTopic,
            scope: 'unknown',
            entities,
            actorId: factEntry.actorId,
        };

        if (action === 'NONE') {
            skipped++;
            continue;
        }

        if (action === 'ADD') {
            try {
                const emb = await embeddingService.generateEmbedding(factEntry.text);
                await memoryDeduplicator.addNewMemoryDirect(factEntry.text, emb, context);
                added++;
            } catch (err) {
                console.warn(`⚠️ Batch: failed to add fact: ${err.message}`);
            }
        } else if (action === 'UPDATE' && factEntry.old_memory_id !== null && factEntry.old_memory_id !== undefined) {
            try {
                const memIdx = parseInt(factEntry.old_memory_id);
                if (_existingMemoryEntries && _existingMemoryEntries[memIdx]) {
                    const [oldUuid] = _existingMemoryEntries[memIdx];
                    const emb = await embeddingService.generateEmbedding(factEntry.text);
                    const newMem = await memoryDeduplicator.addNewMemoryDirect(factEntry.text, emb, context);
                    if (newMem) {
                        await db.supersedeMemory(oldUuid, newMem.id);
                        await db.migrateMemoryLinks(oldUuid, newMem.id).catch(() => { });
                        await vectorStore.deleteVector(oldUuid);
                        updated++;
                    }
                } else {
                    const emb = await embeddingService.generateEmbedding(factEntry.text);
                    await memoryDeduplicator.addNewMemoryDirect(factEntry.text, emb, context);
                    added++;
                }
            } catch (err) {
                console.warn(`⚠️ Batch: failed to update fact: ${err.message}`);
            }
        } else if (action === 'DELETE' && factEntry.old_memory_id !== null && factEntry.old_memory_id !== undefined) {
            try {
                const memIdx = parseInt(factEntry.old_memory_id);
                if (_existingMemoryEntries && _existingMemoryEntries[memIdx]) {
                    const [oldUuid] = _existingMemoryEntries[memIdx];
                    await db.supersedeMemory(oldUuid, null);
                    await vectorStore.deleteVector(oldUuid);
                    deleted++;
                }
            } catch (err) {
                console.warn(`⚠️ Batch: failed to delete fact: ${err.message}`);
            }
        }
    }

    const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
    const totalFacts = user_facts.length + agent_facts.length;
    console.log(`  📦 Batch flush: ${entries.length} exchanges → ${totalFacts} facts (${added} add, ${updated} upd, ${deleted} del, ${skipped} skip) in ${elapsed}s [1 LLM call]`);

    eventBus.push('info', `📦 Batch: ${entries.length} exchanges → ${totalFacts} facts (${added} new) via 1 LLM call`, {
        source: 'batch_processor',
        agentId,
    });

    // === Step 4: Graph processing ===
    if (entities.length > 0) {
        try {
            const allFactTexts = allFacts.map(f => f.text);
            await graphService.processExtractedGraph(entities, allFactTexts, agentId);
        } catch (graphErr) {
            console.warn('⚠️ Batch: graph processing error:', graphErr.message);
        }
    }

    // === Step 5: Auto-consolidate KB if enough new memories ===
    if (added > 0) {
        _memoriesSinceConsolidation += added;
        const KB_CONSOLIDATION_THRESHOLD = 20;
        if (_memoriesSinceConsolidation >= KB_CONSOLIDATION_THRESHOLD) {
            _memoriesSinceConsolidation = 0;
            // Run async — don't block the batch response
            setImmediate(async () => {
                try {
                    const intelligenceService = require('./intelligenceService');
                    console.log('📚 Auto-consolidating KB (threshold reached)...');
                    await intelligenceService.consolidateKnowledge();
                } catch (err) {
                    console.warn('⚠️ Auto KB consolidation failed:', err.message);
                }
            });
        }
    }
}

/**
 * Process a single exchange immediately (legacy/Ollama fallback).
 * This is the old setImmediate behavior, extracted here for reuse.
 */
async function processImmediately(entry) {
    const { agentId, conversationId, userMessage, agentResponse, topic } = entry;
    const t0 = Date.now();
    const provider = runtimeConfig.get('llm.provider') || 'minimax';

    try {
        if (provider === 'minimax') {
            // Combined extract + dedup (1 LLM call)
            let existingMemories = new Map();
            try {
                const contextEmb = await embeddingService.generateEmbedding(
                    userMessage.substring(0, 500) + ' ' + agentResponse.substring(0, 500)
                );
                const similar = await vectorStore.searchSimilar(contextEmb, {
                    limit: 15,
                    agentId,
                    type: 'fact',
                    scoreThreshold: 0.35,
                });
                for (const hit of similar) {
                    existingMemories.set(hit.id, {
                        id: hit.id,
                        content: hit.payload?.content || '',
                        type: hit.payload?.type || 'fact',
                    });
                }
            } catch (err) {
                console.warn('⚠️ Existing memory search failed:', err.message);
            }

            const combinedResult = await factExtractor.extractAndDedup(userMessage, agentResponse, existingMemories);
            const { user_facts, agent_facts, entities, topic: extractedTopic, _existingMemoryEntries } = combinedResult;

            const allFacts = [
                ...user_facts.map(f => ({ ...f, actorId: 'user' })),
                ...agent_facts.map(f => ({ ...f, actorId: 'assistant' })),
            ];

            let added = 0, updated = 0, deleted = 0, skipped = 0;
            for (const factEntry of allFacts) {
                const action = (factEntry.action || 'ADD').toUpperCase();
                const context = {
                    agentId, conversationId,
                    topic: extractedTopic || topic || 'general',
                    scope: 'unknown', entities,
                    actorId: factEntry.actorId,
                };

                if (action === 'NONE') { skipped++; continue; }

                if (action === 'ADD') {
                    try {
                        const emb = await embeddingService.generateEmbedding(factEntry.text);
                        await memoryDeduplicator.addNewMemoryDirect(factEntry.text, emb, context);
                        added++;
                    } catch (err) { console.warn(`⚠️ Failed to add fact: ${err.message}`); }
                } else if (action === 'UPDATE' && factEntry.old_memory_id != null) {
                    try {
                        const memIdx = parseInt(factEntry.old_memory_id);
                        if (_existingMemoryEntries && _existingMemoryEntries[memIdx]) {
                            const [oldUuid] = _existingMemoryEntries[memIdx];
                            const emb = await embeddingService.generateEmbedding(factEntry.text);
                            const newMem = await memoryDeduplicator.addNewMemoryDirect(factEntry.text, emb, context);
                            if (newMem) {
                                await db.supersedeMemory(oldUuid, newMem.id);
                                await db.migrateMemoryLinks(oldUuid, newMem.id).catch(() => { });
                                await vectorStore.deleteVector(oldUuid);
                                updated++;
                            }
                        } else {
                            const emb = await embeddingService.generateEmbedding(factEntry.text);
                            await memoryDeduplicator.addNewMemoryDirect(factEntry.text, emb, context);
                            added++;
                        }
                    } catch (err) { console.warn(`⚠️ Failed to update fact: ${err.message}`); }
                } else if (action === 'DELETE' && factEntry.old_memory_id != null) {
                    try {
                        const memIdx = parseInt(factEntry.old_memory_id);
                        if (_existingMemoryEntries && _existingMemoryEntries[memIdx]) {
                            const [oldUuid] = _existingMemoryEntries[memIdx];
                            await db.supersedeMemory(oldUuid, null);
                            await vectorStore.deleteVector(oldUuid);
                            deleted++;
                        }
                    } catch (err) { console.warn(`⚠️ Failed to delete fact: ${err.message}`); }
                }
            }

            const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
            console.log(`  ✅ Combined extract+dedup: ${allFacts.length} facts → ${added} add, ${updated} upd, ${deleted} del, ${skipped} skip (${elapsed}s)`);

            if (entities.length > 0) {
                try {
                    await graphService.processExtractedGraph(entities, allFacts.map(f => f.text), agentId);
                } catch (graphErr) { console.warn('⚠️ Graph processing error:', graphErr.message); }
            }
        } else {
            // Ollama: separate extract + dedup
            const extractResult = await factExtractor.extractFacts(userMessage, agentResponse, { extractAgentFacts: true });
            const { facts, entities, topic: extractedTopic, actorId: factActorId, agentFacts } = extractResult;

            if (facts.length > 0) {
                const dedupResult = await memoryDeduplicator.deduplicateAndStore(facts, {
                    agentId, conversationId,
                    topic: extractedTopic || topic || 'general',
                    scope: 'unknown', entities,
                    actorId: factActorId || 'user',
                });
                const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
                console.log(`  ✅ User facts: ${facts.length} → ${dedupResult.added} add, ${dedupResult.updated} upd (${elapsed}s)`);

                if (entities.length > 0) {
                    try { await graphService.processExtractedGraph(entities, facts, agentId); }
                    catch (graphErr) { console.warn('⚠️ Graph error:', graphErr.message); }
                }
            }

            if (agentFacts && agentFacts.length > 0) {
                try {
                    await memoryDeduplicator.deduplicateAndStore(agentFacts, {
                        agentId, conversationId,
                        topic: extractedTopic || topic || 'general',
                        scope: 'unknown', entities,
                        actorId: 'assistant',
                    });
                } catch (err) { console.warn('⚠️ Agent fact error:', err.message); }
            }
        }
    } catch (err) {
        console.error('⚠️ Fact extraction pipeline error:', err.message);
    }
}

// ============ STATS + LIFECYCLE ============

function getTotalQueued() {
    let count = 0;
    for (const entries of queue.values()) count += entries.length;
    return count;
}

function getStats() {
    return {
        queued: getTotalQueued(),
        totalEnqueued,
        totalFlushed,
        isProcessing,
        agents: [...queue.keys()],
    };
}

/**
 * Graceful shutdown — flush remaining items.
 */
async function shutdown() {
    if (flushTimer) {
        clearInterval(flushTimer);
        flushTimer = null;
    }
    if (getTotalQueued() > 0) {
        console.log(`📦 Batch: flushing ${getTotalQueued()} remaining exchanges on shutdown...`);
        await flush();
    }
}

// Register shutdown handlers
process.on('SIGTERM', () => shutdown().catch(console.error));
process.on('SIGINT', () => shutdown().catch(console.error));

module.exports = {
    enqueue,
    flush,
    getStats,
    shutdown,
};
