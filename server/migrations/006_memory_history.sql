-- Memory History — Audit trail for all memory mutations
-- Tracks ADD, UPDATE, DELETE events with full before/after content

CREATE TABLE IF NOT EXISTS memory_history (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    memory_id   UUID NOT NULL,
    event       VARCHAR(10) NOT NULL CHECK (event IN ('ADD', 'UPDATE', 'DELETE')),
    old_content TEXT,
    new_content TEXT,
    changed_by  VARCHAR(255),  -- agent_id or 'system' or 'fact_extractor'
    change_reason TEXT,         -- 'dedup_merge', 'contradiction', 'manual', 'summarization'
    metadata    JSONB DEFAULT '{}',
    created_at  TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_memory_history_memory_id ON memory_history(memory_id);
CREATE INDEX IF NOT EXISTS idx_memory_history_created_at ON memory_history(created_at);
