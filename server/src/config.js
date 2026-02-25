require('dotenv').config();

module.exports = {
  server: {
    port: parseInt(process.env.PORT || '7437'),
    env: process.env.NODE_ENV || 'development',
  },

  security: {
    masterKey: process.env.MEMOLO_MASTER_KEY || '',
  },

  postgres: {
    host: process.env.PG_HOST || 'localhost',
    port: parseInt(process.env.PG_PORT || '5432'),
    user: process.env.PG_USER || 'memolo',
    password: process.env.PG_PASSWORD || 'memolo_secret',
    database: process.env.PG_DATABASE || 'memolo',
  },

  qdrant: {
    host: process.env.QDRANT_HOST || 'localhost',
    port: parseInt(process.env.QDRANT_PORT || '6333'),
    collectionName: 'memory_embeddings',
  },

  ollama: {
    baseUrl: process.env.OLLAMA_BASE_URL || 'http://localhost:11434',
    embedModel: process.env.OLLAMA_EMBED_MODEL || 'qwen3-embedding:8b',
  },

  memory: {
    embeddingDimensions: parseInt(process.env.EMBEDDING_DIMENSIONS || '4096'),
  },

  factExtraction: {
    enabled: process.env.ENABLE_FACT_EXTRACTION !== 'false',
    timeout: parseInt(process.env.FACT_EXTRACT_TIMEOUT || '60000'),
    dedupTimeout: parseInt(process.env.DEDUP_TIMEOUT || '60000'),
  },

  reranking: {
    enabled: process.env.ENABLE_RERANKING === 'true', // default: false (only works with Ollama provider)
    timeout: parseInt(process.env.RERANK_TIMEOUT || '30000'),
  },

  graph: {
    enabled: process.env.ENABLE_GRAPH !== 'false', // default: true
  },
};
