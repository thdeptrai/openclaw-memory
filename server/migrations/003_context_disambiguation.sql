-- ============================================================
-- Migration 003: Context Disambiguation
-- Adds conversation profiles, memory topic/scope, supersession
-- ============================================================

-- Conversation Profile: accumulated context about what's being discussed
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS profile JSONB DEFAULT '{}';

-- Memory context: topic namespace + scope classification
ALTER TABLE memories ADD COLUMN IF NOT EXISTS topic VARCHAR(100) DEFAULT 'general';
ALTER TABLE memories ADD COLUMN IF NOT EXISTS scope VARCHAR(20) DEFAULT 'unknown';
ALTER TABLE memories ADD COLUMN IF NOT EXISTS category VARCHAR(50);
ALTER TABLE memories ADD COLUMN IF NOT EXISTS superseded_by UUID;

-- Index for topic-scoped queries
CREATE INDEX IF NOT EXISTS idx_memories_topic ON memories (topic);
CREATE INDEX IF NOT EXISTS idx_memories_scope ON memories (scope);
CREATE INDEX IF NOT EXISTS idx_memories_superseded ON memories (superseded_by) WHERE superseded_by IS NOT NULL;
