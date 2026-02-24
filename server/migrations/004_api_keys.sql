-- Migration 004: Per-agent API keys
-- Adds api_key column to agents table for LAN authentication

ALTER TABLE agents ADD COLUMN IF NOT EXISTS api_key VARCHAR(64) UNIQUE;

-- Index for fast API key lookups during auth
CREATE INDEX IF NOT EXISTS idx_agents_api_key ON agents(api_key) WHERE api_key IS NOT NULL;
