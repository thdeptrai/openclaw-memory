const os = require('os');
const path = require('path');
const express = require('express');
const cors = require('cors');
const morgan = require('morgan');

// EventBus MUST be required first to intercept console.log
const eventBus = require('./services/eventBus');

const config = require('./config');
const apiKeyAuth = require('./middleware/apiKeyAuth');
const vectorStore = require('./services/vectorStore');
const scheduler = require('./services/scheduler');
const memoryRoutes = require('./routes/memory');
const intelligenceRoutes = require('./routes/intelligence');
const logRoutes = require('./routes/logs');
const healthRoutes = require('./routes/health');
const graphRoutes = require('./routes/graph');
const configRoutes = require('./routes/config');
const app = express();

// Middleware
app.use(cors());
app.use(express.json({ limit: '10mb' }));

// Morgan → eventBus (so HTTP logs appear in Live Logs dashboard)
app.use(morgan(':method :url :status :response-time ms', {
    stream: {
        write: (msg) => {
            const clean = msg.trim();
            // Parse status code for log level
            const statusMatch = clean.match(/\s(\d{3})\s/);
            const status = statusMatch ? parseInt(statusMatch[1]) : 200;
            if (status >= 500) {
                eventBus.push('error', `⚡ ${clean}`, { source: 'http' });
            } else if (status >= 400) {
                eventBus.push('warn', `⚡ ${clean}`, { source: 'http' });
            } else {
                eventBus.push('info', `⚡ ${clean}`, { source: 'http' });
            }
        },
    },
}));

// API Key authentication (before routes, after CORS/JSON)
app.use(apiKeyAuth);

// Serve dashboard static files
app.use(express.static(path.join(__dirname, '..', 'public')));

// API Routes
app.use('/api/memory', memoryRoutes);
app.use('/api/intelligence', intelligenceRoutes);
app.use('/api/logs', logRoutes);
app.use('/api/health', healthRoutes);
app.use('/api/graph', graphRoutes);
app.use('/api/config', configRoutes);

// API info endpoint
app.get('/api', (req, res) => {
    res.json({
        name: 'Memolo Memory Server',
        version: '1.2.0',
        auth: config.security.masterKey ? 'enabled' : 'disabled',
        docs: {
            store: 'POST /api/memory/store',
            recall: 'POST /api/memory/recall',
            search: 'POST /api/memory/search',
            summarize: 'POST /api/memory/summarize',
            conversations: 'GET /api/memory/conversations/:id',
            endConversation: 'POST /api/memory/conversations/:id/end',
            agentMemories: 'GET /api/memory/agents/:agentId/recent',
            registerAgent: 'POST /api/memory/agents/register',
            listAgents: 'GET /api/memory/agents',
            permissions: 'POST /api/intelligence/permissions/grant',
            runIntelligence: 'POST /api/intelligence/run',
            knowledgeBase: 'GET /api/intelligence/knowledge',
            health: 'GET /api/health',
        },
    });
});

/**
 * Get all LAN IP addresses for display on startup
 */
function getLanAddresses() {
    const interfaces = os.networkInterfaces();
    const addresses = [];
    for (const [name, addrs] of Object.entries(interfaces)) {
        for (const addr of addrs) {
            if (addr.family === 'IPv4' && !addr.internal) {
                addresses.push({ name, address: addr.address });
            }
        }
    }
    return addresses;
}

// Initialize and start
async function start() {
    try {
        // Initialize Qdrant collection
        await vectorStore.initCollection();
        console.log('✅ Qdrant initialized');

        // Start intelligence scheduler
        scheduler.start();
        console.log('✅ Intelligence scheduler started');

        // Bind to 0.0.0.0 for LAN access
        const host = '0.0.0.0';
        app.listen(config.server.port, host, () => {
            const lanAddrs = getLanAddresses();
            const authStatus = config.security.masterKey ? '🔒 ENABLED' : '🔓 DISABLED (dev mode)';

            console.log(`
╔══════════════════════════════════════════════════╗
║        🧠 Memolo Memory Server v1.2             ║
║        Port: ${config.server.port}                                ║
║        Auth: ${authStatus}              ║
║        Intelligence Layer: ACTIVE                ║
╚══════════════════════════════════════════════════╝
      `);
            console.log('📡 Access URLs:');
            console.log(`   Local:     http://localhost:${config.server.port}`);
            for (const { name, address } of lanAddrs) {
                console.log(`   LAN (${name}): http://${address}:${config.server.port}`);
            }
            console.log('');
            console.log('📋 Key endpoints:');
            console.log('   POST /api/memory/store        — Store exchange');
            console.log('   POST /api/memory/recall       — Recall memories');
            console.log('   POST /api/memory/agents/register — Register agent (returns API key)');
            console.log('   GET  /api/health              — Health check (no auth)');
            console.log('');
        });
    } catch (error) {
        console.error('❌ Failed to start server:', error.message);
        process.exit(1);
    }
}

start();

module.exports = app;
