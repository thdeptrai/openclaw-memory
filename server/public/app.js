/* ============================================================
   Memolo Memory Dashboard v2.0 — Application Logic
   Real-time SSE updates, Conversations, Activity Feed, Toasts
   ============================================================ */

const API = '';  // Same origin

// ============ STATE ============

let currentLogFilter = 'all';
let currentMemoryFilter = 'all';
let currentActorFilter = 'all'; // 'all' | 'user' | 'assistant'
let currentStatusFilter = 'all'; // 'all' | 'active' | 'superseded'
let allLogs = [];
let allMemories = [];
let allConversations = [];
let selectedConvId = null;
let logAutoScroll = true;
let evtSource = null;
let reconnectAttempts = 0;
let sseReady = false; // suppress toasts during SSE catch-up replay

// ============ PAGE NAVIGATION ============

function showPage(page) {
    document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
    document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));

    document.getElementById(`page-${page}`).classList.add('active');
    document.querySelector(`.nav-item[data-page="${page}"]`).classList.add('active');

    // Load page-specific data
    if (page === 'conversations') loadConversations();
    if (page === 'agents') loadAgentsFull();
    if (page === 'memories') loadMemoriesFull();
    if (page === 'knowledge') loadKnowledge();
    if (page === 'settings') loadSettings();
}

// ============ API HELPERS ============

async function api(method, path, body = null) {
    const opts = { method, headers: { 'Content-Type': 'application/json' } };
    if (body) opts.body = JSON.stringify(body);
    const res = await fetch(`${API}${path}`, opts);
    return res.json();
}

// ============ SSE CONNECTION ============

function initSSE() {
    connectSSE();
    loadInitialLogs();
    updateSSEStatus('connecting');

    // Track user scroll in log containers
    ['dash-logs-list', 'logs-full-list'].forEach(id => {
        const container = document.getElementById(id);
        if (container) {
            container.addEventListener('scroll', () => {
                const atBottom = container.scrollHeight - container.scrollTop - container.clientHeight < 40;
                logAutoScroll = atBottom;
            });
        }
    });
}

function connectSSE() {
    if (evtSource) evtSource.close();

    evtSource = new EventSource('/api/logs/stream');

    evtSource.onopen = () => {
        reconnectAttempts = 0;
        updateSSEStatus('connected');
        // Delay sseReady so catch-up events don't trigger toasts
        sseReady = false;
        setTimeout(() => { sseReady = true; }, 2000);
    };

    evtSource.onmessage = (event) => {
        try {
            const msg = JSON.parse(event.data);
            if (msg.type === 'connected') return;
            handleSSEEvent(msg);
        } catch { /* ignore */ }
    };

    evtSource.onerror = () => {
        evtSource.close();
        reconnectAttempts++;
        updateSSEStatus('disconnected');
        const delay = Math.min(1000 * Math.pow(2, reconnectAttempts), 30000);
        setTimeout(connectSSE, delay);
    };
}

function updateSSEStatus(status) {
    const el = document.getElementById('sse-status');
    if (!el) return;
    const dot = el.querySelector('.sse-dot');
    const text = el.querySelector('span:last-child');
    dot.className = 'sse-dot ' + (status === 'connected' ? '' : status === 'connecting' ? 'connecting' : 'disconnected');
    text.textContent = `SSE: ${status}`;
}

// ============ SSE EVENT HANDLER ============

function handleSSEEvent(msg) {
    switch (msg.type) {
        case 'log':
            addLogEntry(msg.data);
            break;
        case 'exchange:new':
            addActivityItem('💾', 'Exchange Stored', `${msg.data.agentId} — "${truncate(msg.data.userMessage, 60)}"`, 'memory', msg.data.timestamp);
            if (sseReady) showToast('💾', 'New Exchange', `${msg.data.agentId}: ${truncate(msg.data.userMessage, 80)}`);
            loadDashMemories(); // refresh
            break;
        case 'memory:new': {
            const actorIcon = msg.data.actorId === 'assistant' ? '🤖' : '👤';
            const actorLabel = msg.data.actorId === 'assistant' ? 'Agent' : 'User';
            const typeIcon = msg.data.type === 'fact' ? '✅' : '🔮';
            addActivityItem(typeIcon, `${actorLabel} ${capitalize(msg.data.type)} Extracted`, truncate(msg.data.content, 80), 'summarizer', msg.data.timestamp);
            break;
        }
        case 'summarize:done':
            addActivityItem('🧠', 'Summarization Complete', `${msg.data.factsCount} facts, ${msg.data.decisionsCount} decisions`, 'summarizer', msg.data.timestamp);
            if (sseReady) showToast('🧠', 'Summarization Done', `${msg.data.factsCount} facts extracted`);
            break;
        case 'agent:new':
            addActivityItem('🤖', 'New Agent', `${msg.data.name} (${msg.data.agentId})`, 'memory', msg.data.timestamp);
            if (sseReady) showToast('🤖', 'Agent Registered', msg.data.name);
            loadStats(); // refresh
            break;
        case 'stats:update':
            updateStatsFromSSE(msg.data);
            break;
    }
}

// ============ STATS ============

async function loadStats() {
    try {
        const [health, agents] = await Promise.all([
            api('GET', '/api/health'),
            api('GET', '/api/memory/agents'),
        ]);

        // Health
        const isHealthy = health.status === 'healthy';
        document.getElementById('stat-health').textContent = isHealthy ? '✓' : '✗';
        document.getElementById('stat-health-detail').textContent =
            Object.entries(health.checks).map(([k, v]) => `${k}: ${v}`).join(' · ');
        document.getElementById('health-dot').className = `health-dot ${isHealthy ? '' : 'unhealthy'}`;
        document.getElementById('health-text').textContent = isHealthy ? 'All systems healthy' : 'Issues detected';

        // Agent count badge
        if (agents.success) {
            document.getElementById('nav-agent-count').textContent = agents.data.length;
            document.getElementById('stat-agents').textContent = agents.data.length;
            document.getElementById('stat-agents-detail').textContent = `${agents.data.length} registered`;
            renderAgentsList(agents.data, 'agents-list');
        }
    } catch (err) {
        console.error('Failed to load stats:', err);
    }
}

function updateStatsFromSSE(data) {
    if (!data || !data.totalExchanges) return;

    const setWithFlash = (id, value) => {
        const el = document.getElementById(id);
        if (el && el.textContent !== String(value)) {
            el.textContent = value;
            const card = el.closest('.stat-card');
            if (card) {
                card.classList.remove('flash');
                void card.offsetWidth; // Force reflow
                card.classList.add('flash');
            }
        }
    };

    setWithFlash('stat-exchanges', data.totalExchanges);
    document.getElementById('stat-exchanges-detail').textContent =
        `${data.totalConversations || 0} conversations`;

    setWithFlash('stat-memories', data.activeMemories);
    const superseded = data.supersededMemories || 0;
    document.getElementById('stat-memories-detail').textContent =
        `${data.activeMemories} active · ${superseded} superseded`;

    setWithFlash('stat-agents', data.registeredAgents);
    document.getElementById('stat-agents-detail').textContent =
        `${data.sseClients || 0} SSE clients connected`;

    document.getElementById('nav-memory-count').textContent = data.activeMemories || 0;
    document.getElementById('nav-agent-count').textContent = data.registeredAgents || 0;
    document.getElementById('nav-conv-count').textContent = data.totalConversations || 0;
}

// ============ ACTIVITY FEED ============

function addActivityItem(icon, title, desc, source = '', eventTime = null) {
    const feed = document.getElementById('activity-feed');
    if (!feed) return;

    // Remove empty state
    const empty = feed.querySelector('.empty-state');
    if (empty) empty.remove();

    // Use event's original timestamp if available, otherwise current time
    const ts = eventTime ? new Date(eventTime) : new Date();
    const timeStr = ts.toLocaleTimeString('en-GB', { hour12: false });

    const div = document.createElement('div');
    div.className = 'activity-item';
    div.innerHTML = `
    <span class="activity-icon">${icon}</span>
    <div class="activity-body">
      <div class="activity-title">${escHtml(title)}</div>
      <div class="activity-desc">${escHtml(desc)}</div>
    </div>
    ${source ? `<span class="activity-source ${source}">${source}</span>` : ''}
    <span class="activity-time">${timeStr}</span>
  `;

    feed.insertBefore(div, feed.firstChild);

    // Limit entries
    while (feed.children.length > 100) {
        feed.removeChild(feed.lastChild);
    }
}

function clearActivityFeed() {
    document.getElementById('activity-feed').innerHTML =
        '<div class="empty-state"><span class="icon">⚡</span> Feed cleared</div>';
}

// ============ TOAST NOTIFICATIONS ============

function showToast(icon, title, desc) {
    const container = document.getElementById('toast-container');
    if (!container) return;

    const toast = document.createElement('div');
    toast.className = 'toast';
    toast.innerHTML = `
    <span class="toast-icon">${icon}</span>
    <div class="toast-body">
      <div class="toast-title">${escHtml(title)}</div>
      <div class="toast-desc">${escHtml(desc)}</div>
    </div>
    <span class="toast-time">now</span>
  `;

    container.appendChild(toast);

    // Auto dismiss after 5s
    setTimeout(() => {
        toast.classList.add('hiding');
        setTimeout(() => toast.remove(), 300);
    }, 5000);

    // Limit toasts
    while (container.children.length > 5) {
        container.removeChild(container.firstChild);
    }
}

// ============ AGENTS ============

const AGENT_COLORS = [
    '#58a6ff', '#bc8cff', '#3fb950', '#d29922', '#f85149',
    '#39d2c0', '#f778ba', '#79c0ff', '#d2a8ff', '#56d364',
];

function getAgentColor(id) {
    let hash = 0;
    for (const c of id) hash = ((hash << 5) - hash + c.charCodeAt(0)) | 0;
    return AGENT_COLORS[Math.abs(hash) % AGENT_COLORS.length];
}

function getInitials(name) {
    return name.split(/[-_\s]/).map(w => w[0]).join('').toUpperCase().slice(0, 2);
}

let agentKeyVisibility = {};

function renderAgentsList(agents, containerId) {
    const container = document.getElementById(containerId);
    if (!agents.length) {
        container.innerHTML = '<div class="empty-state"><span class="icon">🤖</span> No agents registered yet. Connect an agent via the SDK to get started.</div>';
        return;
    }

    container.innerHTML = agents.map(a => {
        const convCount = a.conversation_count || a.conversations || 0;
        const exCount = a.exchange_count || a.exchanges || 0;
        const lastActive = a.last_active_at || a.updated_at || a.created_at;
        const apiKey = a.api_key || '';
        const isVisible = agentKeyVisibility[a.id] || false;

        // Mask key: show first 8 + last 4 chars
        const maskedKey = apiKey.length > 12
            ? apiKey.slice(0, 8) + '••••••••' + apiKey.slice(-4)
            : '••••••••••••';

        const showFull = containerId === 'agents-full-list';
        const keySection = showFull ? `
      <div class="agent-key-section">
        <div class="agent-key-row">
          <span class="agent-key-label">🔑 API Key</span>
          <code class="agent-key-value" id="agent-key-${a.id}">${isVisible ? escHtml(apiKey) : maskedKey}</code>
          <div class="agent-key-actions">
            <button class="btn-icon" onclick="toggleAgentKeyVisibility('${a.id}')" title="${isVisible ? 'Hide' : 'Show'}">
              ${isVisible ? '🙈' : '👁️'}
            </button>
            <button class="btn-icon" onclick="copyAgentKey('${a.id}', '${escHtml(apiKey)}')" title="Copy to clipboard">
              📋
            </button>
            <button class="btn-icon btn-icon-danger" onclick="regenerateAgentKey('${a.id}', '${escHtml(a.name || a.id)}')" title="Regenerate key (invalidates old key)">
              🔄
            </button>
          </div>
        </div>
      </div>
    ` : '';

        return `
    <div class="agent-item">
      <div class="agent-avatar" style="background: ${getAgentColor(a.id)}">${getInitials(a.name || a.id)}</div>
      <div class="agent-info">
        <div class="agent-name">${escHtml(a.name || a.id)}</div>
        <div class="agent-meta">ID: ${escHtml(a.id)}</div>
        <div class="agent-stats">
          <span title="Conversations">💬 ${convCount} conversations</span>
          <span title="Exchanges">📝 ${exCount} exchanges</span>
          <span title="Last active">🕐 ${timeAgo(lastActive)}</span>
        </div>
        ${keySection}
      </div>
    </div>
  `;
    }).join('');
}

function toggleAgentKeyVisibility(agentId) {
    agentKeyVisibility[agentId] = !agentKeyVisibility[agentId];
    loadAgentsFull();
}

function copyAgentKey(agentId, key) {
    navigator.clipboard.writeText(key).then(() => {
        showToast(`📋 API key for ${agentId} copied`, 'success');
    }).catch(() => {
        showToast('❌ Failed to copy', 'error');
    });
}

async function regenerateAgentKey(agentId, agentName) {
    if (!confirm(`⚠️ Regenerate API key for "${agentName}"?\n\nThe old key will be invalidated immediately. Any agent using the old key will lose access.`)) return;

    try {
        const res = await fetch(`/api/memory/agents/${agentId}/regenerate-key`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
        });
        const json = await res.json();

        if (json.success) {
            showToast(`🔑 New key generated for ${agentName}`, 'success');
            agentKeyVisibility[agentId] = true; // Show the new key
            await loadAgentsFull();
        } else {
            showToast(`❌ Failed: ${json.error}`, 'error');
        }
    } catch (err) {
        showToast(`❌ Error: ${err.message}`, 'error');
    }
}

async function loadAgentsFull() {
    const res = await api('GET', '/api/memory/agents');
    if (res.success) {
        renderAgentsList(res.data, 'agents-full-list');
    }
}

// ============ CONVERSATIONS ============

async function loadConversations() {
    try {
        const res = await api('GET', '/api/memory/conversations?limit=100');
        if (res.success && res.data) {
            allConversations = res.data;
            renderConversationList(allConversations);
        }
    } catch {
        document.getElementById('conv-list').innerHTML =
            '<div class="empty-state"><span class="icon">💬</span> Failed to load</div>';
    }
}

function renderConversationList(conversations) {
    const container = document.getElementById('conv-list');
    if (!conversations.length) {
        container.innerHTML = '<div class="empty-state"><span class="icon">💬</span> No conversations yet. Start chatting with an agent to see conversations here.</div>';
        return;
    }

    container.innerHTML = conversations.map(c => {
        const agentName = c.agent_name || c.agent_id || 'unknown';
        const isActive = c.status === 'active';
        const isSelected = c.id === selectedConvId;
        // Use topic as title, fallback to first message snippet, then Conv ID
        const title = c.topic || c.title || `Conv ${c.id.slice(0, 8)}`;
        const statusText = isActive ? 'Active' : 'Ended';
        return `
      <div class="conv-item ${isSelected ? 'active' : ''}" onclick="loadConversationThread('${c.id}', '${escAttr(agentName)}')">
        <div class="conv-avatar" style="background: ${getAgentColor(c.agent_id || 'x')}">${getInitials(agentName)}</div>
        <div class="conv-info">
          <div class="conv-title">${escHtml(title)}</div>
          <div class="conv-subtitle">
            <span class="conv-status ${isActive ? 'active' : 'ended'}" title="${statusText}"></span>
            ${escHtml(agentName)}
            ${c.exchange_count ? `<span class="conv-badge" title="Number of exchanges in this conversation">${c.exchange_count} exchanges</span>` : ''}
            ${c.topic ? `<span class="conv-topic-badge" title="Topic: ${escAttr(c.topic)}">${escHtml(c.topic)}</span>` : ''}
          </div>
        </div>
        <span class="conv-time">${timeAgo(c.updated_at || c.created_at)}</span>
      </div>
    `;
    }).join('');
}

function filterConversations(query) {
    if (!query.trim()) {
        renderConversationList(allConversations);
        return;
    }
    const q = query.toLowerCase();
    const filtered = allConversations.filter(c =>
        (c.title || '').toLowerCase().includes(q) ||
        (c.agent_name || '').toLowerCase().includes(q) ||
        (c.agent_id || '').toLowerCase().includes(q)
    );
    renderConversationList(filtered);
}

async function loadConversationThread(convId, agentName) {
    selectedConvId = convId;

    // Highlight selected in list
    document.querySelectorAll('.conv-item').forEach(el => el.classList.remove('active'));
    event.currentTarget?.classList?.add('active');

    // Update header
    document.getElementById('conv-thread-title').textContent = `💬 ${agentName || 'Conversation'}`;
    document.getElementById('conv-thread-actions').style.display = 'flex';
    document.getElementById('conv-thread-meta').textContent = `ID: ${convId.slice(0, 12)}...`;

    // Load exchanges
    const threadEl = document.getElementById('conv-thread');
    threadEl.innerHTML = '<div class="empty-state"><span class="icon">⏳</span> Loading...</div>';

    try {
        const res = await api('GET', `/api/memory/conversations/${convId}`);
        if (!res.success) {
            threadEl.innerHTML = '<div class="empty-state"><span class="icon">❌</span> Failed to load</div>';
            return;
        }

        const conv = res.data;
        const exchanges = conv.exchanges || [];

        if (!exchanges.length) {
            threadEl.innerHTML = '<div class="empty-state"><span class="icon">💬</span> No exchanges yet</div>';
            return;
        }

        threadEl.innerHTML = exchanges.map((ex, i) => `
        <div class="thread-message">
          <div class="thread-message-user">
            <div class="thread-msg-avatar user">👤</div>
            <div class="thread-msg-body">
              <div class="thread-msg-header">
                <span class="thread-msg-name user">User</span>
                <span class="thread-msg-time">#${ex.sequence_num || i + 1} · ${timeAgo(ex.created_at)}</span>
              </div>
              <div class="thread-msg-content">${escHtml(ex.user_message)}</div>
            </div>
          </div>
          <div class="thread-message-agent" style="margin-top: 10px">
            <div class="thread-msg-avatar agent">🤖</div>
            <div class="thread-msg-body">
              <div class="thread-msg-header">
                <span class="thread-msg-name agent">${escHtml(agentName)}</span>
              </div>
              <div class="thread-msg-content">${escHtml(ex.agent_response)}</div>
            </div>
          </div>
        </div>
        ${i < exchanges.length - 1 ? '<div class="thread-divider">•</div>' : ''}
      `).join('');

        // Scroll to bottom
        threadEl.scrollTop = threadEl.scrollHeight;

        // Render summaries
        const summaries = conv.summaries || [];
        const summarySection = document.getElementById('conv-summary');
        const summaryContent = document.getElementById('conv-summary-content');
        if (summaries.length > 0) {
            summarySection.style.display = 'block';
            summaryContent.innerHTML = summaries.map(s => {
                const facts = s.facts_extracted || [];
                const decisions = s.decisions_made || [];
                return `
                    <div class="conv-summary-card">
                        <div class="conv-summary-text">${escHtml(s.summary_text || 'No summary text')}</div>
                        ${facts.length ? `
                            <div class="conv-summary-facts">
                                <div class="conv-summary-label">📌 Key Facts</div>
                                <ul>${facts.map(f => `<li>${escHtml(f)}</li>`).join('')}</ul>
                            </div>
                        ` : ''}
                        ${decisions.length ? `
                            <div class="conv-summary-decisions">
                                <div class="conv-summary-label">🔮 Decisions</div>
                                <ul>${decisions.map(d => `<li>${escHtml(d)}</li>`).join('')}</ul>
                            </div>
                        ` : ''}
                        <div class="conv-summary-meta">Exchanges #${s.from_sequence}–#${s.to_sequence} · ${timeAgo(s.created_at)}</div>
                    </div>
                `;
            }).join('');
        } else {
            summarySection.style.display = 'none';
        }

        // Load summaries/knowledge
        loadConversationKnowledge(conv.memories || []);

    } catch (err) {
        threadEl.innerHTML = `<div class="empty-state"><span class="icon">❌</span> Error: ${err.message}</div>`;
    }
}

async function loadConversationKnowledge(memories) {
    const section = document.getElementById('conv-knowledge');
    const list = document.getElementById('conv-knowledge-list');

    if (!memories.length) {
        section.style.display = 'none';
        return;
    }

    section.style.display = 'block';
    list.innerHTML = memories.map(m => {
        const typeIcon = m.type === 'fact' ? '✅' : m.type === 'decision' ? '🔮' : m.type === 'preference' ? '⭐' : '📝';
        const typeLabel = m.type || 'memory';
        const actorIcon = m.actor_id === 'assistant' ? '🤖' : '👤';
        return `<span class="conv-knowledge-tag" title="${typeLabel} (${actorIcon} ${m.actor_id || 'user'})">${typeIcon} ${escHtml(typeLabel)}: ${escHtml(truncate(m.content, 90))}</span>`;
    }).join('');
}

// ============ MEMORIES / EXCHANGES ============

function renderExchange(ex) {
    const agentId = ex.agent_id || ex.source_agent_id || '—';
    const topic = ex.topic || '';
    return `
    <div class="memory-item" data-type="exchange" onclick="toggleExpand(this)">
      <div class="memory-header">
        <span class="memory-type exchange" title="Memory type: exchange">💬 exchange</span>
        <span class="memory-agent-tag" title="Agent ID">${escHtml(agentId)}</span>
        ${topic ? `<span class="memory-topic-tag" title="Topic">${escHtml(topic)}</span>` : ''}
        <span class="memory-time">${timeAgo(ex.created_at)}</span>
      </div>
      <div class="memory-content">
        <div style="margin-bottom:6px"><strong style="color:#58a6ff">👤 User:</strong> ${escHtml(truncate(ex.user_message, 200))}</div>
        <div><strong style="color:#3fb950">🤖 Agent:</strong> ${escHtml(truncate(ex.agent_response, 200))}</div>
      </div>
      <span class="expand-btn">▼ Show full</span>
      <div class="memory-detail">
        <div class="memory-detail-content">
          <div class="detail-row"><span class="detail-label">ID</span><span class="detail-value">${ex.id || '—'}</span></div>
          <div class="detail-row"><span class="detail-label">Conversation</span><span class="detail-value">${ex.conversation_id || '—'}</span></div>
          <div class="detail-row"><span class="detail-label">Sequence</span><span class="detail-value">#${ex.sequence_num || '—'}</span></div>
          ${topic ? `<div class="detail-row"><span class="detail-label">Topic</span><span class="detail-value">${escHtml(topic)}</span></div>` : ''}
          <div class="detail-row"><span class="detail-label">Created</span><span class="detail-value">${ex.created_at || '—'}</span></div>
          <div class="full-text"><strong style="color:#58a6ff">👤 User:</strong>\n${escHtml(ex.user_message)}\n\n<strong style="color:#3fb950">🤖 Agent:</strong>\n${escHtml(ex.agent_response)}</div>
        </div>
      </div>
    </div>
  `;
}

function renderMemory(m) {
    if (m.user_message) return renderExchange(m);
    const type = m.type || 'exchange';
    const score = m.importance_score || m.importanceScore || 0.5;
    const topic = m.topic || m.metadata?.topic || '';
    const scope = m.scope || m.metadata?.scope || '';
    const domain = m.domain || m.metadata?.domain || '';
    const actorId = m.actor_id || m.actorId || 'user';
    const contentHash = m.content_hash || m.contentHash || '';
    const isSuperseded = !!(m.superseded_by);
    const status = m.status || (isSuperseded ? 'superseded' : 'active');
    const typeIcon = type === 'fact' ? '✅' : type === 'decision' ? '🔮' : type === 'preference' ? '⭐' : '📝';
    const scoreColor = score >= 0.7 ? 'high' : score >= 0.4 ? 'medium' : 'low';
    const actorIcon = actorId === 'assistant' ? '🤖' : '👤';
    const actorClass = actorId === 'assistant' ? 'actor-assistant' : 'actor-user';
    const actorLabel = actorId === 'assistant' ? 'Assistant' : 'User';
    const statusBadge = isSuperseded
        ? '<span class="memory-status-badge superseded" title="This memory has been superseded by a newer version">🔄 superseded</span>'
        : '<span class="memory-status-badge active" title="This memory is current and active">● active</span>';
    const itemClass = isSuperseded ? 'memory-item superseded' : 'memory-item';
    return `
    <div class="${itemClass}" data-type="${type}" data-actor="${actorId}" data-status="${status}" onclick="toggleExpand(this)">
      <div class="memory-header">
        ${statusBadge}
        <span class="memory-type ${type}" title="Memory type: ${type}">${typeIcon} ${type}</span>
        <span class="memory-actor-badge ${actorClass}" title="Source: ${actorLabel}">${actorIcon} ${actorLabel}</span>
        <span class="memory-agent-tag" title="Source agent">${escHtml(m.source_agent_id || m.agentId || '—')}</span>
        ${topic ? `<span class="memory-topic-tag" title="Topic: ${escAttr(topic)}">${escHtml(topic)}</span>` : ''}
        <span class="memory-time">${timeAgo(m.created_at || m.createdAt)}</span>
      </div>
      <div class="memory-content">${escHtml(truncate(m.content, 300))}</div>
      <div class="memory-score" title="Importance score — how significant this memory is for future recall">
        <span class="score-label-prefix">Importance:</span>
        <div class="score-bar"><div class="score-fill score-${scoreColor}" style="width: ${score * 100}%"></div></div>
        <span class="score-label score-text-${scoreColor}">${(score * 100).toFixed(0)}%</span>
      </div>
      <span class="expand-btn">▼ Show full</span>
      <div class="memory-detail">
        <div class="memory-detail-content">
          <div class="detail-row"><span class="detail-label">ID</span><span class="detail-value">${m.id || '—'}</span></div>
          <div class="detail-row"><span class="detail-label">Status</span><span class="detail-value">${statusBadge}</span></div>
          <div class="detail-row"><span class="detail-label">Type</span><span class="detail-value">${typeIcon} ${type}</span></div>
          <div class="detail-row"><span class="detail-label">Source</span><span class="detail-value"><span class="memory-actor-badge ${actorClass}">${actorIcon} ${actorLabel}</span></span></div>
          <div class="detail-row"><span class="detail-label">Agent</span><span class="detail-value">${m.source_agent_id || m.agentId || '—'}</span></div>
          <div class="detail-row"><span class="detail-label">Conversation</span><span class="detail-value">${m.source_conversation_id || m.conversation_id || '—'}</span></div>
          ${isSuperseded ? `<div class="detail-row"><span class="detail-label">Superseded By</span><span class="detail-value" style="font-family:monospace;font-size:11px;color:#f85149">${m.superseded_by}</span></div>` : ''}
          ${topic ? `<div class="detail-row"><span class="detail-label">Topic</span><span class="detail-value">${escHtml(topic)}</span></div>` : ''}
          ${scope ? `<div class="detail-row"><span class="detail-label">Scope</span><span class="detail-value">${escHtml(scope)}</span></div>` : ''}
          ${domain ? `<div class="detail-row"><span class="detail-label">Domain</span><span class="detail-value">${escHtml(domain)}</span></div>` : ''}
          <div class="detail-row"><span class="detail-label">Importance</span><span class="detail-value score-text-${scoreColor}">${(score * 100).toFixed(0)}%</span></div>
          ${contentHash ? `<div class="detail-row"><span class="detail-label">Hash</span><span class="detail-value" style="font-family:monospace;font-size:11px;color:var(--text-muted)">${contentHash}</span></div>` : ''}
          <div class="detail-row"><span class="detail-label">Created</span><span class="detail-value">${m.created_at || m.createdAt || '—'}</span></div>
          ${m.tags && m.tags.length ? `<div class="detail-row"><span class="detail-label">Tags</span><span class="detail-value">${m.tags.map(t => `<span class="memory-tag">${escHtml(t)}</span>`).join(' ')}</span></div>` : ''}
          <div class="full-text">${escHtml(m.content)}</div>
        </div>
      </div>
    </div>
  `;
}

function toggleExpand(el) {
    el.classList.toggle('expanded');
    const btn = el.querySelector('.expand-btn');
    if (btn) btn.textContent = el.classList.contains('expanded') ? '▲ Collapse' : '▼ Show full';
}

async function loadDashMemories() {
    try {
        const res = await api('GET', '/api/memory/exchanges?limit=10');
        if (res.success && res.data) {
            renderFilteredMemories('dash-memories-list', res.data);
        }
    } catch {
        document.getElementById('dash-memories-list').innerHTML =
            '<div class="empty-state"><span class="icon">💾</span> No exchanges yet</div>';
    }
}

function renderFilteredMemories(containerId, items) {
    const container = document.getElementById(containerId);
    if (!items.length) {
        container.innerHTML = '<div class="empty-state"><span class="icon">💾</span> No data found</div>';
        return;
    }
    container.innerHTML = items.map(renderMemory).join('');
}

async function searchDashMemories(query) {
    if (!query.trim()) { loadDashMemories(); return; }
    try {
        const res = await api('POST', '/api/memory/search', { query, limit: 20 });
        const memories = res.data || res;
        renderFilteredMemories('dash-memories-list', Array.isArray(memories) ? memories : []);
    } catch { }
}

async function loadMemoriesFull() {
    try {
        // Use /api/memory/memories for full PG data (includes superseded_by, all fields)
        const [exRes, memRes] = await Promise.all([
            api('GET', '/api/memory/exchanges?limit=100'),
            api('GET', '/api/memory/memories?limit=200'),
        ]);
        const exchanges = (exRes.success && exRes.data) ? exRes.data : [];
        const memories = (memRes.success && memRes.data) ? memRes.data : [];
        allMemories = [...exchanges, ...memories];
        const seen = new Set();
        allMemories = allMemories.filter(m => {
            const id = m.id;
            if (seen.has(id)) return false;
            seen.add(id);
            return true;
        });
        // Sort by timestamp, newest first
        allMemories.sort((a, b) => {
            const ta = new Date(a.created_at || a.createdAt || 0).getTime();
            const tb = new Date(b.created_at || b.createdAt || 0).getTime();
            return tb - ta;
        });
        applyMemoryFilters();
    } catch {
        document.getElementById('memories-full-list').innerHTML =
            '<div class="empty-state"><span class="icon">💾</span> Failed to load data</div>';
    }
}

let searchDebounce = null;
function debounceSearchMemories(query) {
    clearTimeout(searchDebounce);
    searchDebounce = setTimeout(async () => {
        if (!query.trim()) { loadMemoriesFull(); return; }
        const res = await api('POST', '/api/memory/search', { query, limit: 100 });
        const mems = res.data || res;
        allMemories = Array.isArray(mems) ? mems : [];
        applyMemoryFilters();
    }, 300);
}

function filterMemoryType(type, btn) {
    currentMemoryFilter = type;
    btn.parentElement.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    applyMemoryFilters();
}

function filterMemoryActor(actor, btn) {
    currentActorFilter = actor;
    btn.parentElement.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    applyMemoryFilters();
}

function filterMemoryStatus(status, btn) {
    currentStatusFilter = status;
    btn.parentElement.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    applyMemoryFilters();
}

function applyMemoryFilters() {
    let filtered = allMemories;
    // Type filter
    if (currentMemoryFilter !== 'all') {
        if (currentMemoryFilter === 'exchange') {
            filtered = filtered.filter(m => m.user_message);
        } else {
            filtered = filtered.filter(m => m.type === currentMemoryFilter);
        }
    }
    // Actor filter (user vs assistant)
    if (currentActorFilter !== 'all') {
        filtered = filtered.filter(m => {
            const actor = m.actor_id || m.actorId || 'user';
            return actor === currentActorFilter;
        });
    }
    // Status filter (active vs superseded)
    if (currentStatusFilter !== 'all') {
        filtered = filtered.filter(m => {
            const isSuperseded = !!(m.superseded_by);
            if (currentStatusFilter === 'active') return !isSuperseded && !m.user_message;
            if (currentStatusFilter === 'superseded') return isSuperseded;
            return true;
        });
    }
    renderFilteredMemories('memories-full-list', filtered);
}

// ============ KNOWLEDGE ============

async function loadKnowledge() {
    try {
        const res = await api('GET', '/api/intelligence/knowledge');
        const container = document.getElementById('knowledge-list');
        if (!res.success || !res.data.length) {
            container.innerHTML = '<div class="empty-state"><span class="icon">📚</span> No knowledge entries yet.<br><small style="color:var(--text-muted)">Click "🔄 Run Consolidation" above to analyze stored memories and generate knowledge entries.</small></div>';
            return;
        }
        container.innerHTML = res.data.map(k => {
            const conf = (k.confidence_score || 0);
            const confColor = conf >= 0.7 ? 'high' : conf >= 0.4 ? 'medium' : 'low';
            return `
      <div class="knowledge-item">
        <div class="knowledge-header">
          <span class="knowledge-topic-badge">${escHtml(k.topic)}</span>
          <span class="knowledge-confidence score-text-${confColor}" title="Confidence: how reliable this knowledge is">Confidence: ${(conf * 100).toFixed(0)}%</span>
          <span class="knowledge-updated">Updated: ${timeAgo(k.last_updated)}</span>
        </div>
        <div class="knowledge-content">${escHtml(k.content)}</div>
        ${k.source_count ? `<div class="knowledge-sources">📋 Based on ${k.source_count} source memories</div>` : ''}
      </div>
    `;
        }).join('');
    } catch {
        document.getElementById('knowledge-list').innerHTML =
            '<div class="empty-state"><span class="icon">📚</span> Failed to load knowledge base</div>';
    }
}

function searchKnowledge(query) {
    const items = document.querySelectorAll('#knowledge-list .knowledge-item');
    items.forEach(item => {
        const text = item.textContent.toLowerCase();
        item.style.display = text.includes(query.toLowerCase()) ? '' : 'none';
    });
}

async function runConsolidation() {
    const btn = document.getElementById('btn-consolidate');
    const originalText = btn.textContent;
    btn.textContent = '⏳ Running...';
    btn.disabled = true;
    try {
        const res = await api('POST', '/api/intelligence/run', { tasks: ['consolidate'] });
        if (res.success) {
            showToast('🧠', 'Consolidation Complete', 'Knowledge base updated successfully');
            loadKnowledge(); // Refresh
        } else {
            showToast('❌', 'Consolidation Failed', res.error || 'Unknown error');
        }
    } catch (err) {
        showToast('❌', 'Consolidation Error', err.message);
    } finally {
        btn.textContent = originalText;
        btn.disabled = false;
    }
}

// ============ LOGS ============

async function loadInitialLogs() {
    try {
        const res = await api('GET', '/api/logs?limit=200');
        if (res.success && res.data) {
            res.data.reverse().forEach(entry => addLogEntry(entry, false));
        }
    } catch { }
}

function addLogEntry(entry, animate = true) {
    allLogs.push(entry);
    if (allLogs.length > 1000) allLogs.shift();

    document.getElementById('nav-log-count').textContent = allLogs.length;

    renderLogEntry(entry, 'dash-logs-list', animate);
    renderLogEntry(entry, 'logs-full-list', animate);
}

function renderLogEntry(entry, containerId, animate) {
    const container = document.getElementById(containerId);
    if (!container) return;

    const empty = container.querySelector('.empty-state');
    if (empty) empty.remove();

    if (currentLogFilter !== 'all' && entry.level !== currentLogFilter) return;

    const div = document.createElement('div');
    div.className = 'log-entry';
    if (!animate) div.style.animation = 'none';
    div.dataset.level = entry.level;

    const source = entry.source ? `<span class="log-source">${entry.source}</span>` : '';

    div.innerHTML = `
    <span class="log-time">${formatLogTime(entry.timestamp)}</span>
    <span class="log-level ${entry.level}">${entry.level}</span>
    ${source}
    <span class="log-message">${escHtml(entry.message)}</span>
  `;

    container.appendChild(div);

    if (logAutoScroll) {
        container.scrollTop = container.scrollHeight;
    }

    while (container.children.length > 500) {
        container.removeChild(container.firstChild);
    }
}

function filterLogs(level, btn) {
    currentLogFilter = level;
    btn.parentElement.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');

    ['dash-logs-list', 'logs-full-list'].forEach(id => {
        const container = document.getElementById(id);
        if (!container) return;
        container.innerHTML = '';
        allLogs.forEach(entry => {
            if (level === 'all' || entry.level === level) {
                renderLogEntry(entry, id, false);
            }
        });
    });
}

function clearLogs() {
    allLogs = [];
    ['dash-logs-list', 'logs-full-list'].forEach(id => {
        const el = document.getElementById(id);
        if (el) el.innerHTML = '<div class="empty-state"><span class="icon">📋</span> Logs cleared</div>';
    });
}

// ============ UTILS ============

function escHtml(str) {
    if (!str) return '';
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
}

function escAttr(str) {
    if (!str) return '';
    return str.replace(/'/g, "\\'").replace(/"/g, '&quot;');
}

function truncate(str, len) {
    if (!str) return '';
    return str.length > len ? str.substring(0, len) + '...' : str;
}

function capitalize(str) {
    if (!str) return '';
    return str.charAt(0).toUpperCase() + str.slice(1);
}

function timeAgo(dateStr) {
    if (!dateStr) return '—';
    const seconds = Math.floor((Date.now() - new Date(dateStr).getTime()) / 1000);
    if (seconds < 60) return `${seconds}s ago`;
    if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
    if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
    return `${Math.floor(seconds / 86400)}d ago`;
}

function formatLogTime(dateStr) {
    if (!dateStr) return '';
    const d = new Date(dateStr);
    return d.toLocaleTimeString('en-GB', { hour12: false });
}

// ============ INIT ============

async function init() {
    // Load initial data
    await loadStats();
    await loadDashMemories();

    // Start SSE
    initSSE();

    // No more polling! Stats come via SSE stats:update events
    // Only do a fallback health check every 60s
    setInterval(loadStats, 60000);
}

init();

// ============ SETTINGS ============

let settingsData = {};
let settingsModified = {};

async function loadSettings() {
    try {
        const res = await fetch(`/api/config`);
        const json = await res.json();
        if (json.success) {
            settingsData = json.data;
            settingsModified = {};
            renderMemoloApiKeysPanel();
            renderSettingsForm();
        }
    } catch (err) {
        console.error('Failed to load settings:', err);
    }
}

// ============ API KEYS PANEL ============

async function renderMemoloApiKeysPanel() {
    // Update master key status from the info endpoint
    try {
        const res = await fetch('/api');
        const json = await res.json();
        const statusEl = document.getElementById('master-key-status');
        if (statusEl && json) {
            const authEnabled = json.auth === 'enabled';
            const statusColor = authEnabled ? '#10b981' : '#f59e0b';
            const statusIcon = authEnabled ? '✓' : '⚠';
            const statusText = authEnabled ? 'Enabled' : 'Disabled (dev mode)';
            statusEl.style.color = statusColor;
            statusEl.innerHTML = `<span class="api-key-status-dot" style="background: ${statusColor}"></span><span>${statusIcon} ${statusText}</span>`;
        }
    } catch { }

    // Update agent keys count
    try {
        const res = await api('GET', '/api/memory/agents');
        const countEl = document.getElementById('agent-keys-count');
        if (countEl && res.success) {
            const count = res.data.length;
            countEl.innerHTML = `<span>🤖 ${count} agent${count !== 1 ? 's' : ''} registered</span>`;
        }
    } catch { }
}

function renderSettingsForm() {
    const container = document.getElementById('settings-container');
    if (!container) return;

    // Group settings by group name
    const groups = {};
    for (const [key, meta] of Object.entries(settingsData)) {
        const group = meta.group || 'Other';
        if (!groups[group]) groups[group] = [];
        groups[group].push({ key, ...meta });
    }

    const groupIcons = {
        'LLM Models': '🤖',
        'Feature Toggles': '🔀',
        'Timeouts': '⏱️',
        'Memory': '🧠',
        'Scheduler': '📅',
    };

    // Get current provider info for the status banner
    const currentProvider = (settingsModified['llm.provider'] !== undefined ? settingsModified['llm.provider'] : settingsData['llm.provider']?.value) || 'ollama';
    const currentModel = currentProvider === 'minimax'
        ? (settingsModified['minimax.model'] !== undefined ? settingsModified['minimax.model'] : settingsData['minimax.model']?.value) || 'MiniMax-M2.5'
        : (settingsModified['ollama.chatModel'] !== undefined ? settingsModified['ollama.chatModel'] : settingsData['ollama.chatModel']?.value) || 'qwen2.5:7b';

    let html = '';
    for (const [groupName, items] of Object.entries(groups)) {
        const icon = groupIcons[groupName] || '⚙️';
        html += `<div class="settings-group">`;
        html += `<div class="settings-group-header">${icon} ${groupName}</div>`;

        // Show Active LLM status banner for LLM Models group
        if (groupName === 'LLM Models') {
            const providerIcon = currentProvider === 'minimax' ? '☁️' : '🖥️';
            const providerLabel = currentProvider === 'minimax' ? 'MiniMax (Cloud)' : 'Ollama (Local)';
            const providerColor = currentProvider === 'minimax' ? '#6366f1' : '#10b981';
            html += `<div class="llm-status-banner" style="background: linear-gradient(135deg, ${providerColor}22, ${providerColor}11); border: 1px solid ${providerColor}44; border-radius: 12px; padding: 16px 20px; margin: 12px 16px 4px;">`;
            html += `<div style="display: flex; align-items: center; gap: 12px;">`;
            html += `<div style="font-size: 28px;">${providerIcon}</div>`;
            html += `<div>`;
            html += `<div style="font-size: 11px; text-transform: uppercase; letter-spacing: 1px; color: ${providerColor}; font-weight: 600; margin-bottom: 2px;">Active LLM Provider</div>`;
            html += `<div style="font-size: 18px; font-weight: 700; color: var(--text-primary);">${providerLabel}</div>`;
            html += `<div style="font-size: 13px; color: var(--text-secondary); margin-top: 2px;">Model: <strong>${currentModel}</strong></div>`;
            html += `</div></div></div>`;
        }

        html += `<div class="settings-group-body">`;

        for (const item of items) {
            const isModified = settingsModified[item.key] !== undefined;
            const isDefault = item.value === item.default;

            // Dim irrelevant provider settings
            const isOllamaField = item.key.startsWith('ollama.');
            const isMiniMaxField = item.key.startsWith('minimax.');
            const isDimmed = (currentProvider === 'minimax' && isOllamaField && item.key !== 'ollama.embedModel' && item.key !== 'ollama.baseUrl')
                || (currentProvider === 'ollama' && isMiniMaxField);

            html += `<div class="setting-row${isModified ? ' modified' : ''}${isDimmed ? ' dimmed' : ''}">`;
            html += `<div class="setting-info">`;
            html += `<div class="setting-label">${item.label}`;
            if (!isDefault) html += ` <span class="setting-custom-badge">custom</span>`;
            if (isDimmed) html += ` <span class="setting-inactive-badge">inactive</span>`;
            html += `</div>`;
            html += `<div class="setting-description">${item.description || ''}</div>`;
            html += `</div>`;
            html += `<div class="setting-control">`;

            if (item.type === 'boolean') {
                const checked = (settingsModified[item.key] !== undefined ? settingsModified[item.key] : item.value) ? 'checked' : '';
                html += `<label class="toggle-switch">`;
                html += `<input type="checkbox" ${checked} onchange="onSettingChange('${item.key}', this.checked)">`;
                html += `<span class="toggle-slider"></span>`;
                html += `</label>`;
            } else if (item.type === 'select' && item.options) {
                const val = settingsModified[item.key] !== undefined ? settingsModified[item.key] : item.value;
                html += `<select class="setting-select" onchange="onSettingChange('${item.key}', this.value)">`;
                for (const opt of item.options) {
                    const label = opt === 'ollama' ? '🖥️ Ollama (Local)' : opt === 'minimax' ? '☁️ MiniMax (Cloud)' : opt;
                    html += `<option value="${opt}" ${val === opt ? 'selected' : ''}>${label}</option>`;
                }
                html += `</select>`;
            } else if (item.type === 'number') {
                const val = settingsModified[item.key] !== undefined ? settingsModified[item.key] : item.value;
                const step = item.step || (item.max <= 1 ? 0.05 : 1);
                const unit = item.unit ? ` <span class="setting-unit">${formatUnit(val, item.unit)}</span>` : '';
                html += `<div class="number-input-group">`;
                html += `<input type="number" class="setting-input" value="${val}" `;
                html += `min="${item.min !== undefined ? item.min : ''}" max="${item.max !== undefined ? item.max : ''}" step="${step}" `;
                html += `onchange="onSettingChange('${item.key}', parseFloat(this.value))">`;
                html += unit;
                html += `</div>`;
            } else {
                const val = settingsModified[item.key] !== undefined ? settingsModified[item.key] : item.value;
                // Mask API keys
                const inputType = item.key.includes('apiKey') || item.key.includes('Key') ? 'password' : 'text';
                html += `<input type="${inputType}" class="setting-input setting-input-text" value="${val}" `;
                html += `onchange="onSettingChange('${item.key}', this.value)"`;
                html += `${inputType === 'password' ? ' autocomplete="off"' : ''}>`;
            }

            // Reset single setting button
            if (!isDefault) {
                html += `<button class="btn-reset-single" onclick="resetSingleSetting('${item.key}')" title="Reset to default: ${item.default}">↩</button>`;
            }

            html += `</div>`; // setting-control
            html += `</div>`; // setting-row
        }

        html += `</div>`; // settings-group-body
        html += `</div>`; // settings-group
    }

    container.innerHTML = html;
}

function formatUnit(value, unit) {
    if (unit === 'ms') {
        if (value >= 3600000) return `${(value / 3600000).toFixed(1)}h`;
        if (value >= 60000) return `${(value / 60000).toFixed(1)}m`;
        if (value >= 1000) return `${(value / 1000).toFixed(1)}s`;
        return `${value}ms`;
    }
    return unit;
}

function onSettingChange(key, value) {
    settingsModified[key] = value;
    // Mark the row as modified visually
    renderSettingsForm();
}

async function saveSettings() {
    if (Object.keys(settingsModified).length === 0) {
        showToast('No changes to save', 'info');
        return;
    }

    try {
        const res = await fetch(`/api/config`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ settings: settingsModified }),
        });
        const json = await res.json();

        if (json.success) {
            showToast(`✅ Saved ${Object.keys(settingsModified).length} setting(s)`, 'success');
            settingsModified = {};
            // Reload to get fresh values
            await loadSettings();
        } else {
            showToast(`❌ Error: ${json.errors?.join(', ') || 'Unknown error'}`, 'error');
        }
    } catch (err) {
        showToast(`❌ Failed to save: ${err.message}`, 'error');
    }
}

async function resetAllSettings() {
    if (!confirm('Reset ALL settings to their defaults?')) return;

    try {
        const res = await fetch(`/api/config/reset`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ all: true }),
        });
        const json = await res.json();
        if (json.success) {
            showToast('🔄 All settings reset to defaults', 'success');
            settingsModified = {};
            await loadSettings();
        }
    } catch (err) {
        showToast(`❌ Failed to reset: ${err.message}`, 'error');
    }
}

async function resetSingleSetting(key) {
    try {
        const res = await fetch(`/api/config/reset`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ key }),
        });
        const json = await res.json();
        if (json.success) {
            delete settingsModified[key];
            showToast(`↩ Reset ${key}`, 'info');
            await loadSettings();
        }
    } catch (err) {
        showToast(`❌ Failed to reset: ${err.message}`, 'error');
    }
}

// ============ RECALL PLAYGROUND ============

let lastRecallResponse = null;

// Handle Enter key in query input
document.addEventListener('DOMContentLoaded', () => {
    const queryInput = document.getElementById('recall-query');
    if (queryInput) {
        queryInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') executeRecall();
        });
    }
});

async function executeRecall() {
    const query = document.getElementById('recall-query').value.trim();
    if (!query) {
        showToast('Please enter a query', 'info');
        return;
    }

    const agentId = document.getElementById('recall-agent').value.trim() || undefined;
    const conversationId = document.getElementById('recall-conv').value.trim() || undefined;
    const topic = document.getElementById('recall-topic').value.trim() || undefined;
    const limit = parseInt(document.getElementById('recall-limit').value) || 10;
    const format = document.getElementById('recall-format').value;

    const btn = document.getElementById('recall-btn');
    const resultsDiv = document.getElementById('recall-results');

    btn.disabled = true;
    btn.textContent = '⏳ Recalling...';
    resultsDiv.innerHTML = '<div class="empty-state"><span class="icon">⏳</span> Searching memories...</div>';

    const t0 = performance.now();

    try {
        const body = { query, limit };
        if (agentId) body.agentId = agentId;
        if (conversationId) body.conversationId = conversationId;
        if (topic) body.topic = topic;
        if (format === 'context') body.format = 'context';

        const res = await fetch('/api/memory/recall', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
        });
        const json = await res.json();
        const elapsed = (performance.now() - t0).toFixed(0);

        lastRecallResponse = json;

        if (!json.success) {
            resultsDiv.innerHTML = `<div class="empty-state"><span class="icon">❌</span> Error: ${json.error || 'Unknown error'}</div>`;
            return;
        }

        if (format === 'context' && json.context) {
            renderContextFormat(json, elapsed, query);
        } else {
            renderRecallResults(json.data, elapsed, query);
        }

    } catch (err) {
        resultsDiv.innerHTML = `<div class="empty-state"><span class="icon">❌</span> Failed: ${err.message}</div>`;
    } finally {
        btn.disabled = false;
        btn.textContent = '🔍 Recall';
    }
}

function renderRecallResults(data, elapsed, query) {
    const container = document.getElementById('recall-results');

    const sections = [
        { key: 'semanticMemories', label: '🧠 Semantic Memories', icon: '🧠', description: 'Vector similarity search results' },
        { key: 'recentExchanges', label: '💬 Recent Exchanges', icon: '💬', description: 'Recent conversation context' },
        { key: 'crossAgentMemories', label: '🔗 Cross-Agent Memories', icon: '🔗', description: 'Memories from other agents' },
        { key: 'summaries', label: '📝 Summaries', icon: '📝', description: 'Conversation summaries' },
        { key: 'knowledgeBase', label: '📚 Knowledge Base', icon: '📚', description: 'Knowledge graph entries' },
    ];

    // Count total results
    let totalCount = 0;
    for (const s of sections) {
        const arr = data[s.key];
        if (Array.isArray(arr)) totalCount += arr.length;
    }

    let html = `<div class="recall-summary-bar">`;
    html += `<span>🔍 <strong>${totalCount}</strong> results in <strong>${elapsed}ms</strong></span>`;
    html += `<span class="recall-query-echo">Query: "${escapeHtml(query)}"</span>`;
    html += `<button class="btn" onclick="toggleRawJson()">📦 Show JSON</button>`;
    html += `</div>`;

    for (const section of sections) {
        const items = data[section.key];
        if (!Array.isArray(items) || items.length === 0) continue;

        html += `<div class="recall-section">`;
        html += `<div class="recall-section-header">${section.label} <span class="badge">${items.length}</span></div>`;
        html += `<div class="recall-section-body">`;

        for (const item of items) {
            html += renderRecallItem(item, section.key);
        }

        html += `</div></div>`;
    }

    // Conversation profile if present
    if (data.conversationProfile && Object.keys(data.conversationProfile).length > 0) {
        html += `<div class="recall-section">`;
        html += `<div class="recall-section-header">👤 Conversation Profile</div>`;
        html += `<div class="recall-section-body">`;
        html += `<div class="recall-item"><pre class="recall-profile-json">${escapeHtml(JSON.stringify(data.conversationProfile, null, 2))}</pre></div>`;
        html += `</div></div>`;
    }

    if (totalCount === 0) {
        html += `<div class="empty-state"><span class="icon">🤷</span> No memories found for this query</div>`;
    }

    container.innerHTML = html;
}

function renderRecallItem(item, sectionKey) {
    let html = `<div class="recall-item">`;

    if (sectionKey === 'semanticMemories' || sectionKey === 'crossAgentMemories') {
        const score = item.score !== undefined ? (item.score * 100).toFixed(1) : null;
        const payload = item.payload || item;
        const content = payload.content || payload.user_message || JSON.stringify(payload);
        const agentId = payload.agent_id || '';
        const importance = payload.importance_score;
        const tags = payload.content_tags || [];
        const topic = payload.topic || '';

        html += `<div class="recall-item-header">`;
        if (score !== null) {
            const scoreClass = score >= 70 ? 'high' : score >= 50 ? 'mid' : 'low';
            html += `<span class="recall-score ${scoreClass}">${score}%</span>`;
        }
        if (agentId) html += `<span class="recall-agent-tag">${escapeHtml(agentId)}</span>`;
        if (topic) html += `<span class="recall-topic-tag">${escapeHtml(topic)}</span>`;
        if (importance !== undefined) html += `<span class="recall-importance">⚡${(importance * 100).toFixed(0)}</span>`;
        html += `</div>`;
        html += `<div class="recall-item-content">${escapeHtml(content)}</div>`;
        if (tags.length > 0) {
            html += `<div class="recall-tags">${tags.map(t => `<span class="recall-tag">${escapeHtml(t)}</span>`).join('')}</div>`;
        }
    } else if (sectionKey === 'recentExchanges') {
        const userMsg = item.user_message || '';
        const agentMsg = item.agent_response || '';
        html += `<div class="recall-exchange">`;
        html += `<div class="recall-exchange-user"><span class="role-label">User:</span> ${escapeHtml(userMsg)}</div>`;
        if (agentMsg) html += `<div class="recall-exchange-agent"><span class="role-label">Agent:</span> ${escapeHtml(agentMsg.substring(0, 300))}${agentMsg.length > 300 ? '...' : ''}</div>`;
        html += `</div>`;
    } else if (sectionKey === 'summaries') {
        const summary = item.summary || item.content || JSON.stringify(item);
        html += `<div class="recall-item-content recall-summary-text">${escapeHtml(summary)}</div>`;
    } else if (sectionKey === 'knowledgeBase') {
        const subject = item.subject || '';
        const predicate = item.predicate || '';
        const object = item.object || '';
        html += `<div class="recall-knowledge-triple">`;
        html += `<span class="knowledge-subject">${escapeHtml(subject)}</span>`;
        html += `<span class="knowledge-predicate">${escapeHtml(predicate)}</span>`;
        html += `<span class="knowledge-object">${escapeHtml(object)}</span>`;
        html += `</div>`;
    } else {
        html += `<div class="recall-item-content">${escapeHtml(JSON.stringify(item, null, 2))}</div>`;
    }

    html += `</div>`;
    return html;
}

function renderContextFormat(json, elapsed, query) {
    const container = document.getElementById('recall-results');
    const rawCount = json.raw ? Object.values(json.raw).reduce((sum, arr) => sum + (Array.isArray(arr) ? arr.length : 0), 0) : 0;

    let html = `<div class="recall-summary-bar">`;
    html += `<span>🔍 <strong>${rawCount}</strong> memories → context in <strong>${elapsed}ms</strong></span>`;
    html += `<span class="recall-query-echo">Query: "${escapeHtml(query)}"</span>`;
    html += `<button class="btn" onclick="toggleRawJson()">📦 Show JSON</button>`;
    html += `</div>`;

    html += `<div class="recall-section">`;
    html += `<div class="recall-section-header">📄 LLM Context String</div>`;
    html += `<div class="recall-section-body">`;
    html += `<div class="recall-item">`;
    html += `<div class="recall-context-box">`;
    html += `<button class="btn recall-copy-btn" onclick="copyContext()">📋 Copy</button>`;
    html += `<pre class="recall-context-pre">${escapeHtml(json.context)}</pre>`;
    html += `</div></div>`;
    html += `</div></div>`;

    container.innerHTML = html;
}

function copyContext() {
    if (!lastRecallResponse || !lastRecallResponse.context) return;
    navigator.clipboard.writeText(lastRecallResponse.context).then(() => {
        showToast('📋 Context copied to clipboard', 'success');
    });
}

function toggleRawJson() {
    const panel = document.getElementById('recall-raw-json');
    const pre = document.getElementById('recall-json-content');
    if (panel.style.display === 'none') {
        panel.style.display = 'block';
        pre.textContent = JSON.stringify(lastRecallResponse, null, 2);
    } else {
        panel.style.display = 'none';
    }
}

function escapeHtml(str) {
    if (typeof str !== 'string') return String(str);
    return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
