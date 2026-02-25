-- ============================================================
-- Migration 012: Memory Types + Categories + Reinforcement
-- Adds typed memory classification (profile/event/knowledge/behavior)
-- Adds hierarchical category system
-- Adds memory reinforcement counting
-- ============================================================

-- 1. Add memory_type column (finer classification than existing 'type')
ALTER TABLE memories ADD COLUMN IF NOT EXISTS memory_type VARCHAR(20) DEFAULT 'knowledge';
ALTER TABLE memories ADD COLUMN IF NOT EXISTS reinforcement_count INT DEFAULT 0;
CREATE INDEX IF NOT EXISTS idx_memories_memory_type ON memories (memory_type);

-- 2. Categories table — hierarchical grouping per agent
CREATE TABLE IF NOT EXISTS memory_categories (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    agent_id VARCHAR(50) REFERENCES agents(id) ON DELETE CASCADE,
    name VARCHAR(100) NOT NULL,
    description TEXT DEFAULT '',
    summary TEXT DEFAULT '',
    summary_updated_at TIMESTAMPTZ,
    memory_count INT DEFAULT 0,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(agent_id, name)
);

-- 3. Memory ↔ Category junction (many-to-many)
CREATE TABLE IF NOT EXISTS memory_category_items (
    memory_id UUID REFERENCES memories(id) ON DELETE CASCADE,
    category_id UUID REFERENCES memory_categories(id) ON DELETE CASCADE,
    assigned_at TIMESTAMPTZ DEFAULT NOW(),
    PRIMARY KEY (memory_id, category_id)
);

CREATE INDEX IF NOT EXISTS idx_mc_items_category ON memory_category_items(category_id);
CREATE INDEX IF NOT EXISTS idx_mc_items_memory ON memory_category_items(memory_id);
