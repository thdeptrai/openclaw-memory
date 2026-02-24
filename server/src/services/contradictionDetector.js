/**
 * Contradiction Detector
 * 
 * Detects when new memories conflict with existing ones in the same topic.
 * When a contradiction is found, the older memory is marked as superseded.
 * 
 * Strategy: After summarizer extracts facts/decisions, embed each new memory
 * and search for similar existing memories. If similarity > threshold AND
 * content semantically differs (same topic, different conclusion), supersede.
 */

const db = require('../models');
const vectorStore = require('./vectorStore');
const embeddingService = require('./embeddingService');
const eventBus = require('./eventBus');

// Similarity threshold — memories must be very similar to be considered potential contradictions
const SIMILARITY_THRESHOLD = 0.82;

// Types that can contradict each other
const CONTRADICTABLE_TYPES = ['fact', 'decision'];

/**
 * Check new memories against existing ones for contradictions.
 * Called after summarization creates new memories.
 * 
 * @param {Array} newMemories - Array of { id, type, content, topic, scope }
 * @param {string} agentId
 * @returns {Array} List of superseded memory pairs
 */
async function detectAndSupersede(newMemories, agentId) {
    const superseded = [];

    for (const newMem of newMemories) {
        if (!CONTRADICTABLE_TYPES.includes(newMem.type)) continue;

        try {
            // Embed the new memory content
            const embedding = await embeddingService.generateEmbedding(newMem.content);

            // Search for similar existing memories
            const similar = await vectorStore.searchSimilar(embedding, {
                limit: 5,
                agentId,
                scoreThreshold: SIMILARITY_THRESHOLD,
            });

            // Check each similar result for potential contradiction
            for (const match of similar) {
                // Skip self-match
                if (match.id === newMem.id) continue;

                // Skip if different type (fact vs decision)
                if (match.payload.type !== newMem.type) continue;

                // Skip already superseded
                if (match.payload.superseded) continue;

                // Same topic check — only supersede within same topic
                const matchTopic = match.payload.topic || 'general';
                const newTopic = newMem.topic || 'general';
                if (matchTopic !== newTopic && matchTopic !== 'general' && newTopic !== 'general') continue;

                // High similarity + same topic + same type = likely contradiction or update
                // The newer memory supersedes the older one
                const matchCreatedAt = match.payload.created_at ? new Date(match.payload.created_at) : new Date(0);
                const isOlder = matchCreatedAt < new Date();

                if (isOlder && match.score >= SIMILARITY_THRESHOLD) {
                    // Supersede the older memory
                    try {
                        await db.supersedeMemory(match.id, newMem.id);
                        // DELETE old vector from Qdrant so it's no longer recalled
                        const vectorStore = require('./vectorStore');
                        await vectorStore.deleteVector(match.id);

                        superseded.push({
                            oldMemoryId: match.id,
                            oldContent: match.payload.content?.substring(0, 100),
                            newMemoryId: newMem.id,
                            newContent: newMem.content.substring(0, 100),
                            similarity: match.score,
                            topic: newTopic,
                        });

                        eventBus.emit('memory:superseded', {
                            oldMemoryId: match.id,
                            newMemoryId: newMem.id,
                            similarity: match.score,
                            topic: newTopic,
                            agentId,
                        });

                        console.log(`🔄 Memory superseded: "${match.payload.content?.substring(0, 50)}..." → "${newMem.content.substring(0, 50)}..." (similarity: ${match.score.toFixed(3)})`);
                    } catch (err) {
                        console.warn('⚠️ Failed to supersede memory:', err.message);
                    }
                }
            }
        } catch (err) {
            console.warn('⚠️ Contradiction detection failed for memory:', err.message);
        }
    }

    if (superseded.length > 0) {
        console.log(`✅ Contradiction detection: ${superseded.length} memories superseded`);
    }

    return superseded;
}

module.exports = { detectAndSupersede };
