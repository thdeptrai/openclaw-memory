-- OpenClaw Memory System — Phase 4: Intelligence Layer

-- Add visibility/permission to memories
ALTER TABLE memories ADD COLUMN IF NOT EXISTS visibility VARCHAR(30) DEFAULT 'shared';
-- Values: 'shared' (all agents), 'private' (only source agent), 'team:NAME' (team-based)

-- Add decay tracking
ALTER TABLE memories ADD COLUMN IF NOT EXISTS access_count INT DEFAULT 0;
ALTER TABLE memories ADD COLUMN IF NOT EXISTS decay_factor FLOAT DEFAULT 1.0;

-- Add duplicate detection tracking
ALTER TABLE memories ADD COLUMN IF NOT EXISTS content_hash VARCHAR(64);
ALTER TABLE memories ADD COLUMN IF NOT EXISTS merged_into UUID;

-- Create index for visibility-based queries
CREATE INDEX IF NOT EXISTS idx_memories_visibility ON memories(visibility);
CREATE INDEX IF NOT EXISTS idx_memories_content_hash ON memories(content_hash);

-- Agent permissions table
CREATE TABLE IF NOT EXISTS agent_permissions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id VARCHAR(50) REFERENCES agents(id) ON DELETE CASCADE,
  can_read_from VARCHAR(50) REFERENCES agents(id) ON DELETE CASCADE,
  permission_level VARCHAR(20) DEFAULT 'read',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(agent_id, can_read_from)
);

-- Knowledge base (consolidated high-level knowledge)
CREATE TABLE IF NOT EXISTS knowledge_base (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  topic VARCHAR(300) NOT NULL UNIQUE,
  content TEXT NOT NULL,
  source_memory_ids UUID[] DEFAULT '{}',
  source_agent_ids TEXT[] DEFAULT '{}',
  confidence_score FLOAT DEFAULT 0.5,
  last_updated TIMESTAMPTZ DEFAULT NOW(),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_knowledge_topic ON knowledge_base(topic);
