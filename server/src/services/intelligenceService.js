const crypto = require('crypto');
const db = require('../models');
const vectorStore = require('./vectorStore');
const embeddingService = require('./embeddingService');
const config = require('../config');
const runtimeConfig = require('../runtimeConfig');
const llmService = require('./llmService');

/**
 * Intelligence Service — Handles scoring, decay, dedup, and permissions
 */
class IntelligenceService {

    // ==================== IMPORTANCE SCORING ====================

    /**
     * Boost importance when a memory is accessed
     */
    async boostOnAccess(memoryId) {
        await db.query(
            `UPDATE memories
       SET importance_score = LEAST(importance_score + 0.05, 1.0),
           access_count = COALESCE(access_count, 0) + 1,
           last_accessed_at = NOW()
       WHERE id = $1`,
            [memoryId]
        );
    }

    /**
     * Apply time-based decay to all memories
     * Memories that haven't been accessed recently lose importance
     */
    async applyDecay() {
        const result = await db.query(`
      UPDATE memories
      SET decay_factor = GREATEST(
        0.1,
        CASE
          WHEN last_accessed_at IS NULL THEN
            1.0 - (EXTRACT(EPOCH FROM (NOW() - created_at)) / 86400.0) * 0.01
          ELSE
            1.0 - (EXTRACT(EPOCH FROM (NOW() - last_accessed_at)) / 86400.0) * 0.005
        END
      ),
      importance_score = GREATEST(
        0.1,
        importance_score * GREATEST(
          0.1,
          CASE
            WHEN last_accessed_at IS NULL THEN
              1.0 - (EXTRACT(EPOCH FROM (NOW() - created_at)) / 86400.0) * 0.01
            ELSE
              1.0 - (EXTRACT(EPOCH FROM (NOW() - last_accessed_at)) / 86400.0) * 0.005
          END
        )
      )
      WHERE importance_score > 0.1
      RETURNING id
    `);

        console.log(`📉 Decay applied to ${result.rowCount} memories`);
        return result.rowCount;
    }

    // NOTE: detectAndMergeDuplicates removed — real-time dedup via combined prompt handles this

    // KB methods removed (Mem0 style — facts in Qdrant are the knowledge base)

    // ==================== PERMISSIONS ====================

    /**
     * Check if an agent can read memories from another agent
     */
    async canAgentRead(requestingAgentId, targetAgentId) {
        // Same agent always allowed
        if (requestingAgentId === targetAgentId) return true;

        // Check explicit permissions
        const result = await db.query(
            `SELECT * FROM agent_permissions
       WHERE agent_id = $1 AND can_read_from = $2`,
            [requestingAgentId, targetAgentId]
        );

        // If no explicit permission, default to shared memories only
        return result.rows.length > 0;
    }

    /**
     * Grant read permission between agents
     */
    async grantPermission(agentId, canReadFrom, level = 'read') {
        await db.query(
            `INSERT INTO agent_permissions (agent_id, can_read_from, permission_level)
       VALUES ($1, $2, $3)
       ON CONFLICT (agent_id, can_read_from) DO UPDATE SET permission_level = $3`,
            [agentId, canReadFrom, level]
        );
    }

    /**
     * Revoke permission
     */
    async revokePermission(agentId, canReadFrom) {
        await db.query(
            `DELETE FROM agent_permissions WHERE agent_id = $1 AND can_read_from = $2`,
            [agentId, canReadFrom]
        );
    }

    /**
     * Grant all-to-all read permissions for a list of agents
     */
    async grantTeamAccess(agentIds) {
        for (const a of agentIds) {
            for (const b of agentIds) {
                if (a !== b) {
                    await this.grantPermission(a, b);
                }
            }
        }
    }

    /**
     * Get memories respecting visibility & permissions
     */
    async getAccessibleMemories(requestingAgentId, query, limit = 20) {
        // Get agents this one can read from
        const perms = await db.query(
            `SELECT can_read_from FROM agent_permissions WHERE agent_id = $1`,
            [requestingAgentId]
        );
        const allowedAgents = [requestingAgentId, ...perms.rows.map(r => r.can_read_from)];

        const placeholders = allowedAgents.map((_, i) => `$${i + 2}`).join(', ');
        const result = await db.query(
            `SELECT * FROM memories
       WHERE merged_into IS NULL
         AND (visibility = 'shared' OR source_agent_id IN (${placeholders}))
         AND content ILIKE $1
       ORDER BY importance_score DESC, created_at DESC
       LIMIT $${allowedAgents.length + 2}`,
            [`%${query}%`, ...allowedAgents, limit]
        );

        return result.rows;
    }
}

module.exports = new IntelligenceService();
