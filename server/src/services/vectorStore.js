const { QdrantClient } = require('@qdrant/js-client-rest');
const config = require('../config');

const client = new QdrantClient({
    host: config.qdrant.host,
    port: config.qdrant.port,
});

const COLLECTION = config.qdrant.collectionName;

/**
 * Initialize Qdrant collection if it doesn't exist
 */
async function initCollection() {
    try {
        const collections = await client.getCollections();
        const exists = collections.collections.some(c => c.name === COLLECTION);

        if (!exists) {
            await client.createCollection(COLLECTION, {
                vectors: {
                    size: config.memory.embeddingDimensions,
                    distance: 'Cosine',
                },
                optimizers_config: {
                    default_segment_number: 2,
                },
            });

            // Create payload indexes for filtering
            await client.createPayloadIndex(COLLECTION, {
                field_name: 'agent_id',
                field_schema: 'keyword',
            });
            await client.createPayloadIndex(COLLECTION, {
                field_name: 'type',
                field_schema: 'keyword',
            });
            await client.createPayloadIndex(COLLECTION, {
                field_name: 'conversation_id',
                field_schema: 'keyword',
            });
            await client.createPayloadIndex(COLLECTION, {
                field_name: 'topic',
                field_schema: 'keyword',
            });
            await client.createPayloadIndex(COLLECTION, {
                field_name: 'scope',
                field_schema: 'keyword',
            });

            console.log(`✅ Qdrant collection "${COLLECTION}" created`);
        } else {
            console.log(`✅ Qdrant collection "${COLLECTION}" already exists`);
        }
    } catch (error) {
        console.error('❌ Qdrant init failed:', error.message);
        throw error;
    }
}

/**
 * Upsert a vector with payload
 */
async function upsertVector(id, embedding, payload) {
    await client.upsert(COLLECTION, {
        wait: false, // Data is immediately searchable; skip waiting for fsync
        points: [
            {
                id,
                vector: embedding,
                payload,
            },
        ],
    });
}

/**
 * Semantic search — find similar vectors
 */
async function searchSimilar(embedding, { limit = 10, agentId = null, excludeAgentId = null, type = null, conversationId = null, topic = null, scoreThreshold = 0.3 } = {}) {
    const filter = { must: [] };

    if (agentId) {
        filter.must.push({ key: 'agent_id', match: { value: agentId } });
    }
    if (excludeAgentId) {
        filter.must_not = [{ key: 'agent_id', match: { value: excludeAgentId } }];
    }
    if (type) {
        filter.must.push({ key: 'type', match: { value: type } });
    }
    if (conversationId) {
        filter.must.push({ key: 'conversation_id', match: { value: conversationId } });
    }
    if (topic) {
        filter.must.push({ key: 'topic', match: { value: topic } });
    }

    const searchParams = {
        vector: embedding,
        limit,
        with_payload: true,
        score_threshold: scoreThreshold,
    };

    if (filter.must.length > 0 || filter.must_not) {
        searchParams.filter = filter;
    }

    const results = await client.search(COLLECTION, searchParams);
    return results;
}

/**
 * Delete a single vector by point ID (used when superseding memories)
 */
async function deleteVector(pointId) {
    try {
        await client.delete(COLLECTION, {
            wait: true,
            points: [pointId],
        });
    } catch (err) {
        console.warn(`⚠️ Failed to delete vector ${pointId}:`, err.message);
    }
}

/**
 * Delete vectors by filter
 */
async function deleteByFilter(filterKey, filterValue) {
    await client.delete(COLLECTION, {
        wait: true,
        filter: {
            must: [{ key: filterKey, match: { value: filterValue } }],
        },
    });
}

/**
 * Check Qdrant health
 */
async function checkHealth() {
    try {
        await client.getCollections();
        return true;
    } catch {
        return false;
    }
}

module.exports = {
    client,
    initCollection,
    upsertVector,
    searchSimilar,
    deleteVector,
    deleteByFilter,
    checkHealth,
};
