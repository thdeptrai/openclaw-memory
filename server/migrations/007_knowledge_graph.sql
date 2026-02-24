-- Knowledge Graph — Entity + Relationship tables
-- Enables graph-based memory retrieval like mem0

-- Named entities extracted from conversations
CREATE TABLE IF NOT EXISTS entities (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name        VARCHAR(500) NOT NULL,
    entity_type VARCHAR(50) NOT NULL DEFAULT 'unknown',  -- person, project, technology, organization, concept
    description TEXT DEFAULT '',
    agent_id    VARCHAR(50),
    metadata    JSONB DEFAULT '{}',
    first_seen  TIMESTAMPTZ DEFAULT NOW(),
    last_seen   TIMESTAMPTZ DEFAULT NOW(),
    mention_count INT DEFAULT 1,
    UNIQUE(name, entity_type, agent_id)
);

CREATE INDEX IF NOT EXISTS idx_entities_name ON entities(name);
CREATE INDEX IF NOT EXISTS idx_entities_agent_id ON entities(agent_id);
CREATE INDEX IF NOT EXISTS idx_entities_type ON entities(entity_type);

-- Relationships between entities
CREATE TABLE IF NOT EXISTS relationships (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    source_entity_id UUID NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
    target_entity_id UUID NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
    relation_type   VARCHAR(100) NOT NULL,  -- 'uses', 'prefers', 'works_on', 'knows', 'related_to'
    description     TEXT DEFAULT '',
    strength        REAL DEFAULT 0.5 CHECK (strength >= 0 AND strength <= 1),
    source_memory_id UUID,  -- which memory this relationship was extracted from
    agent_id        VARCHAR(50),
    created_at      TIMESTAMPTZ DEFAULT NOW(),
    updated_at      TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(source_entity_id, target_entity_id, relation_type, agent_id)
);

CREATE INDEX IF NOT EXISTS idx_relationships_source ON relationships(source_entity_id);
CREATE INDEX IF NOT EXISTS idx_relationships_target ON relationships(target_entity_id);
CREATE INDEX IF NOT EXISTS idx_relationships_agent_id ON relationships(agent_id);
