/**
 * ============================================================
 *  Graph Service — Knowledge Graph (entity + relationship CRUD)
 *  Provides graph-based memory storage and traversal.
 *  
 *  Entities: Named things (people, projects, technologies)
 *  Relationships: Typed links between entities 
 *    (e.g. "User" --uses--> "TypeScript")
 * ============================================================
 */
const db = require('../models');
const eventBus = require('./eventBus');

// ============ ENTITY OPERATIONS ============

/**
 * Upsert an entity — create or update mention count + last_seen.
 */
async function upsertEntity(name, entityType, agentId, description = '') {
    const normalizedName = name.trim();
    if (!normalizedName) return null;

    const result = await db.query(
        `INSERT INTO entities (name, entity_type, agent_id, description)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (name, entity_type, agent_id) 
     DO UPDATE SET 
        last_seen = NOW(),
        mention_count = entities.mention_count + 1,
        description = CASE WHEN LENGTH($4) > LENGTH(entities.description) THEN $4 ELSE entities.description END
     RETURNING *`,
        [normalizedName, entityType || 'unknown', agentId, description]
    );
    return result.rows[0];
}

/**
 * Get or create multiple entities at once.
 */
async function upsertEntities(entities, agentId) {
    const results = [];
    for (const ent of entities) {
        const entity = await upsertEntity(
            ent.name,
            ent.type || 'unknown',
            agentId,
            ent.description || ''
        );
        if (entity) results.push(entity);
    }
    return results;
}

/**
 * Get all entities for an agent.
 */
async function getEntities(agentId, { type = null, limit = 100 } = {}) {
    let sql = 'SELECT * FROM entities WHERE agent_id = $1';
    const params = [agentId];
    if (type) {
        sql += ' AND entity_type = $2';
        params.push(type);
    }
    sql += ' ORDER BY mention_count DESC, last_seen DESC LIMIT $' + (params.length + 1);
    params.push(limit);

    const result = await db.query(sql, params);
    return result.rows;
}

/**
 * Search entities by name (fuzzy).
 */
async function searchEntities(query, agentId = null, limit = 20) {
    let sql = `SELECT * FROM entities WHERE name ILIKE $1`;
    const params = [`%${query}%`];
    if (agentId) {
        sql += ' AND agent_id = $2';
        params.push(agentId);
    }
    sql += ` ORDER BY mention_count DESC LIMIT $${params.length + 1}`;
    params.push(limit);

    const result = await db.query(sql, params);
    return result.rows;
}

// ============ RELATIONSHIP OPERATIONS ============

/**
 * Upsert a relationship between two entities.
 */
async function upsertRelationship(sourceEntityId, targetEntityId, relationType, { description = '', strength = 0.5, sourceMemoryId = null, agentId = null } = {}) {
    const result = await db.query(
        `INSERT INTO relationships (source_entity_id, target_entity_id, relation_type, description, strength, source_memory_id, agent_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (source_entity_id, target_entity_id, relation_type, agent_id) 
     DO UPDATE SET 
        description = CASE WHEN LENGTH($4) > LENGTH(relationships.description) THEN $4 ELSE relationships.description END,
        strength = GREATEST(relationships.strength, $5),
        updated_at = NOW()
     RETURNING *`,
        [sourceEntityId, targetEntityId, relationType, description, strength, sourceMemoryId, agentId]
    );
    return result.rows[0];
}

/**
 * Get all relationships for an entity (both directions).
 */
async function getEntityRelationships(entityId, { direction = 'both', limit = 50 } = {}) {
    let sql;
    const params = [entityId, limit];

    if (direction === 'outgoing') {
        sql = `SELECT r.*, e.name as target_name, e.entity_type as target_type 
               FROM relationships r 
               JOIN entities e ON e.id = r.target_entity_id 
               WHERE r.source_entity_id = $1 
               ORDER BY r.strength DESC LIMIT $2`;
    } else if (direction === 'incoming') {
        sql = `SELECT r.*, e.name as source_name, e.entity_type as source_type 
               FROM relationships r 
               JOIN entities e ON e.id = r.source_entity_id 
               WHERE r.target_entity_id = $1 
               ORDER BY r.strength DESC LIMIT $2`;
    } else {
        sql = `SELECT r.*, 
                 se.name as source_name, se.entity_type as source_type,
                 te.name as target_name, te.entity_type as target_type
               FROM relationships r
               JOIN entities se ON se.id = r.source_entity_id
               JOIN entities te ON te.id = r.target_entity_id
               WHERE r.source_entity_id = $1 OR r.target_entity_id = $1
               ORDER BY r.strength DESC LIMIT $2`;
    }

    const result = await db.query(sql, params);
    return result.rows;
}

// ============ GRAPH QUERIES ============

/**
 * Get the neighborhood of an entity — the entity + all connected entities + relationships.
 * Useful for recall: "what do we know about X?"
 */
async function getEntityNeighborhood(entityNameOrId, agentId, depth = 1) {
    // Find the entity first
    let entity;
    const byId = await db.query('SELECT * FROM entities WHERE id::text = $1', [entityNameOrId]);
    if (byId.rows.length > 0) {
        entity = byId.rows[0];
    } else {
        const byName = await db.query(
            'SELECT * FROM entities WHERE LOWER(name) = LOWER($1) AND agent_id = $2',
            [entityNameOrId, agentId]
        );
        entity = byName.rows[0];
    }

    if (!entity) return { entity: null, relationships: [], neighbors: [] };

    // Get relationships
    const relationships = await getEntityRelationships(entity.id);

    // Get neighbor entities
    const neighborIds = new Set();
    for (const rel of relationships) {
        if (rel.source_entity_id !== entity.id) neighborIds.add(rel.source_entity_id);
        if (rel.target_entity_id !== entity.id) neighborIds.add(rel.target_entity_id);
    }

    let neighbors = [];
    if (neighborIds.size > 0) {
        const result = await db.query(
            `SELECT * FROM entities WHERE id = ANY($1::uuid[])`,
            [Array.from(neighborIds)]
        );
        neighbors = result.rows;
    }

    return { entity, relationships, neighbors };
}

/**
 * Get the full graph for an agent (for visualization).
 */
async function getAgentGraph(agentId, limit = 200) {
    const entities = await db.query(
        'SELECT * FROM entities WHERE agent_id = $1 ORDER BY mention_count DESC LIMIT $2',
        [agentId, limit]
    );
    const relationships = await db.query(
        'SELECT * FROM relationships WHERE agent_id = $1 ORDER BY strength DESC LIMIT $2',
        [agentId, limit * 2]
    );

    return {
        entities: entities.rows,
        relationships: relationships.rows,
    };
}

// ============ EXTRACTION HELPER ============

/**
 * Process extracted entities and relationships from fact extractor.
 * Called after fact extraction — syncs entities + relationships into the graph.
 */
async function processExtractedGraph(entities, facts, agentId, memoryId = null) {
    if (!entities || entities.length === 0) return;

    // 1. Deduplicate entities by name (avoid UNIQUE constraint conflicts in parallel upserts)
    const uniqueEntities = new Map();
    for (const ent of entities) {
        const name = (ent.name || ent).toString().trim().toLowerCase();
        if (name && !uniqueEntities.has(name)) {
            uniqueEntities.set(name, ent);
        }
    }

    // 2. Upsert all unique entities (parallel — each is independent after dedup)
    const entityMap = {}; // name → entity row
    const upsertResults = await Promise.allSettled(
        Array.from(uniqueEntities.values()).map(async (ent) => {
            return await upsertEntity(ent.name || ent, ent.type || 'unknown', agentId, ent.description || '');
        })
    );
    for (const result of upsertResults) {
        if (result.status === 'fulfilled' && result.value) {
            entityMap[result.value.name.toLowerCase()] = result.value;
        }
    }

    // 3. Auto-detect relationships from facts that mention multiple entities
    // (sequential — relationship pairs are small and depend on entity IDs above)
    const entityNames = Object.keys(entityMap);
    for (const fact of facts) {
        const factLower = fact.toLowerCase();
        const mentionedEntities = entityNames.filter(name => factLower.includes(name));

        if (mentionedEntities.length >= 2) {
            for (let i = 0; i < mentionedEntities.length; i++) {
                for (let j = i + 1; j < mentionedEntities.length; j++) {
                    const sourceEntity = entityMap[mentionedEntities[i]];
                    const targetEntity = entityMap[mentionedEntities[j]];
                    if (sourceEntity && targetEntity) {
                        await upsertRelationship(
                            sourceEntity.id,
                            targetEntity.id,
                            'related_to',
                            {
                                description: fact.substring(0, 200),
                                strength: 0.6,
                                sourceMemoryId: memoryId,
                                agentId,
                            }
                        );
                    }
                }
            }
        }
    }

    eventBus.push('info', `🕸️ Graph updated: ${Object.keys(entityMap).length} entities`, {
        source: 'graph_service',
        agentId,
    });
}

module.exports = {
    // Entity CRUD
    upsertEntity,
    upsertEntities,
    getEntities,
    searchEntities,
    // Relationship CRUD
    upsertRelationship,
    getEntityRelationships,
    // Graph queries
    getEntityNeighborhood,
    getAgentGraph,
    // Extraction integration
    processExtractedGraph,
};
