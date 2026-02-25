"use client";

import { createContext, useContext, useEffect, useState, useCallback, useRef } from "react";
import { API_URL, SSE_URL } from "@/lib/api";
import { useSWRConfig } from "swr";
import { toast } from "sonner";

export type LogLevel = "info" | "warn" | "error" | "debug" | "system";

export interface SSELog {
    id?: string;
    timestamp: string;
    level: LogLevel;
    source: string;
    message: string;
    metadata?: Record<string, any>;
}

export interface SystemStatus {
    sse: "connected" | "connecting" | "disconnected";
    health: "ok" | "checking" | "error";
}

export interface SystemStats {
    totalConversations: number;
    totalExchanges: number;
    activeMemories: number;
    supersededMemories: number;
    registeredAgents: number;
    sseClients: number;
}

export interface ActivityItem {
    id: string;
    icon: string;
    title: string;
    description: string;
    source: string;
    timestamp: Date;
}

interface StreamContextType {
    logs: SSELog[];
    status: SystemStatus;
    stats: SystemStats | null;
    activities: ActivityItem[];
    clearLogs: () => void;
    clearActivities: () => void;
}

const StreamContext = createContext<StreamContextType>({
    logs: [],
    status: { sse: "disconnected", health: "checking" },
    stats: null,
    activities: [],
    clearLogs: () => { },
    clearActivities: () => { },
});

export function StreamProvider({ children }: { children: React.ReactNode }) {
    const [logs, setLogs] = useState<SSELog[]>([]);
    const [status, setStatus] = useState<SystemStatus>({ sse: "disconnected", health: "checking" });
    const [stats, setStats] = useState<SystemStats | null>(null);
    const [activities, setActivities] = useState<ActivityItem[]>([]);
    const { mutate } = useSWRConfig();

    const eventSourceRef = useRef<EventSource | null>(null);

    const addActivity = useCallback((icon: string, title: string, description: string, source: string, ts?: string) => {
        setActivities(prev => [{
            id: Math.random().toString(36).substring(7),
            icon,
            title,
            description,
            source,
            timestamp: ts ? new Date(ts) : new Date()
        }, ...prev].slice(0, 100)); // Keep last 100
    }, []);

    const clearLogs = useCallback(() => setLogs([]), []);
    const clearActivities = useCallback(() => setActivities([]), []);

    const connect = useCallback(() => {
        if (eventSourceRef.current && eventSourceRef.current.readyState !== EventSource.CLOSED) {
            return;
        }

        setStatus(s => ({ ...s, sse: "connecting" }));

        try {
            const source = new EventSource(`${SSE_URL}/api/logs/stream`);
            eventSourceRef.current = source;

            source.onopen = () => {
                setStatus(s => ({ ...s, sse: "connected" }));
                // Backfill: fetch existing logs from REST API so refresh doesn't lose history
                fetch(`${API_URL}/api/logs?limit=200`)
                    .then(r => r.json())
                    .then(data => {
                        if (data.success && Array.isArray(data.data) && data.data.length > 0) {
                            setLogs(prev => {
                                // Merge: keep any SSE logs that arrived during fetch, append historical
                                const existingIds = new Set(prev.map(l => l.id || l.timestamp));
                                const newLogs = data.data.filter((l: SSELog) => !existingIds.has(l.id || l.timestamp));
                                return [...prev, ...newLogs].slice(0, 500);
                            });
                        }
                    })
                    .catch(() => { /* ignore backfill errors */ });
            };

            source.onmessage = (event) => {
                try {
                    const msg = JSON.parse(event.data);
                    if (msg.type === 'connected') return;

                    switch (msg.type) {
                        case 'log':
                            setLogs(prev => [msg.data, ...prev].slice(0, 500));
                            break;
                        case 'exchange:new':
                            addActivity('💬', 'Exchange Stored', `${msg.data.agentId}: ${msg.data.userMessage?.substring(0, 60)}...`, 'memory', msg.data.timestamp);
                            toast('💬 New Exchange', { description: `${msg.data.agentId}: ${msg.data.userMessage?.substring(0, 80) || ''}` });
                            // Instant revalidation: refresh exchanges and conversations
                            mutate((key: string) => typeof key === 'string' && (key.includes('/exchanges') || key.includes('/conversations')), undefined, { revalidate: true });
                            break;
                        case 'memory:new': {
                            const actorLabel = msg.data.actorId === 'assistant' ? 'Agent' : 'User';
                            const typeIcon = msg.data.type === 'fact' ? '✅' : '🔮';
                            addActivity(typeIcon, `${actorLabel} ${msg.data.type} Extracted`, msg.data.content?.substring(0, 80), 'extractor', msg.data.timestamp);
                            toast.success(`${typeIcon} Memory Extracted`, { description: msg.data.content?.substring(0, 100) || '' });
                            // Instant revalidation: refresh memories list
                            mutate((key: string) => typeof key === 'string' && key.includes('/memories'), undefined, { revalidate: true });
                            break;
                        }
                        case 'agent:new':
                            addActivity('🤖', 'Agent Registered', `${msg.data.name} (${msg.data.agentId})`, 'system', msg.data.timestamp);
                            toast.info(`🤖 Agent Registered`, { description: `${msg.data.name} (${msg.data.agentId})` });
                            // Instant revalidation: refresh agents list
                            mutate((key: string) => typeof key === 'string' && key.includes('/agents'), undefined, { revalidate: true });
                            break;
                        case 'stats:update':
                            setStats(msg.data);
                            break;
                    }
                } catch (e) {
                    console.error("Failed to parse SSE message", e);
                }
            };

            source.onerror = (err) => {
                source.close();
                setStatus(s => ({ ...s, sse: "disconnected", health: "error" }));

                // Auto reconnect
                setTimeout(connect, 5000);
            };
        } catch (e) {
            setStatus(s => ({ ...s, sse: "disconnected", health: "error" }));
        }
    }, [addActivity, mutate]);

    useEffect(() => {
        connect();

        // Initial health check
        fetch(`${API_URL}/api/health`)
            .then(res => res.json())
            .then(data => {
                if (data.status === 'healthy') {
                    setStatus(s => ({ ...s, health: "ok" }));
                } else {
                    setStatus(s => ({ ...s, health: "error" }));
                }
            })
            .catch(() => setStatus(s => ({ ...s, health: "error" })));

        return () => {
            if (eventSourceRef.current) {
                eventSourceRef.current.close();
            }
        };
    }, [connect]);

    return (
        <StreamContext.Provider value={{ logs, status, stats, activities, clearLogs, clearActivities }}>
            {children}
        </StreamContext.Provider>
    );
}

export function useMemoloStream() {
    return useContext(StreamContext);
}
