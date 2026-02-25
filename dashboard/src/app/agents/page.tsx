"use client";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Bot, Activity, BrainCircuit, Eye, EyeOff, Copy, RefreshCw, Key } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import useSWR from "swr";
import { fetcher, API_URL } from "@/lib/api";
import { formatDistanceToNow } from "date-fns";
import { useState } from "react";
import { toast } from "sonner";

export default function Agents() {
    const { data: agentsRes, isLoading, mutate } = useSWR<{ success: boolean, data: any[] }>("/api/memory/agents", fetcher, { refreshInterval: 15000 });
    const agents = agentsRes?.data || [];
    const [visibleKeys, setVisibleKeys] = useState<Record<string, boolean>>({});
    const [regenerating, setRegenerating] = useState<string | null>(null);

    const getInitials = (name: string) => name ? name.split(/[-_\s]/).map(w => w[0]).join('').toUpperCase().slice(0, 2) : "🤖";

    const toggleKeyVisibility = (agentId: string) => {
        setVisibleKeys(prev => ({ ...prev, [agentId]: !prev[agentId] }));
    };

    const copyKey = (agentId: string, key: string) => {
        navigator.clipboard.writeText(key).then(() => {
            toast.success(`API key for ${agentId} copied to clipboard`);
        }).catch(() => {
            toast.error("Failed to copy");
        });
    };

    const regenerateKey = async (agentId: string, agentName: string) => {
        if (!confirm(`⚠️ Regenerate API key for "${agentName}"?\n\nThe old key will be invalidated immediately. Any agent using the old key will lose access.`)) {
            return;
        }

        setRegenerating(agentId);
        try {
            const res = await fetch(`${API_URL}/api/memory/agents/${agentId}/regenerate-key`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
            });
            const json = await res.json();
            if (json.success) {
                toast.success(`New API key generated for ${agentName}`);
                setVisibleKeys(prev => ({ ...prev, [agentId]: true })); // Show the new key
                mutate();
            } else {
                toast.error("Failed: " + (json.error || "Unknown error"));
            }
        } catch (err: any) {
            toast.error("Error: " + err.message);
        } finally {
            setRegenerating(null);
        }
    };

    const maskKey = (key: string) => {
        if (!key || key.length <= 12) return "••••••••••••";
        return key.slice(0, 8) + "••••••••" + key.slice(-4);
    };

    return (
        <div className="p-8 space-y-8 max-w-6xl mx-auto">
            <div>
                <h2 className="text-3xl font-bold tracking-tight">Agents</h2>
                <p className="text-muted-foreground">
                    All registered AI agents and their activity
                </p>
            </div>

            <div className="grid gap-6 md:grid-cols-2 lg:grid-cols-3">
                {isLoading ? (
                    <div className="col-span-full py-20 text-center border-2 border-dashed rounded-xl border-muted">
                        <Bot className="h-10 w-10 text-muted-foreground mx-auto mb-4 animate-pulse opacity-50" />
                        <p className="text-muted-foreground text-sm">Loading agents...</p>
                    </div>
                ) : agents.length === 0 ? (
                    <div className="col-span-full py-20 text-center border-2 border-dashed rounded-xl border-muted">
                        <Bot className="h-10 w-10 text-muted-foreground mx-auto mb-4 opacity-50" />
                        <p className="text-muted-foreground text-sm">Waiting for agents to register...</p>
                    </div>
                ) : (
                    agents.map((agent: any) => {
                        const apiKey = agent.api_key || "";
                        const isVisible = visibleKeys[agent.id] || false;
                        const isRegen = regenerating === agent.id;

                        return (
                            <Card key={agent.id} className="hover:border-primary/50 transition-colors group">
                                <CardHeader className="flex flex-row items-start gap-4 space-y-0">
                                    <Avatar className="h-12 w-12 rounded-lg border-2 border-primary/20 bg-primary/5">
                                        <AvatarFallback className="bg-transparent text-primary font-bold">
                                            {getInitials(agent.name || agent.id)}
                                        </AvatarFallback>
                                    </Avatar>
                                    <div className="flex flex-col">
                                        <CardTitle className="text-lg truncate max-w-[150px]" title={agent.name || agent.id}>
                                            {agent.name || agent.id}
                                        </CardTitle>
                                        <span className="text-[10px] text-muted-foreground font-mono mt-1 truncate max-w-[150px]" title={agent.id}>
                                            ID: {agent.id}
                                        </span>
                                    </div>
                                </CardHeader>
                                <CardContent className="space-y-4">
                                    <div className="flex gap-2 text-xs">
                                        <Badge variant="secondary" className="font-normal">
                                            <Activity className="h-3 w-3 mr-1" /> {agent.conversation_count || agent.conversations || 0} convs
                                        </Badge>
                                        <Badge variant="outline" className="font-normal border-purple-500/30 text-purple-500">
                                            <BrainCircuit className="h-3 w-3 mr-1" /> {agent.exchange_count || agent.exchanges || 0} msgs
                                        </Badge>
                                    </div>

                                    {/* API Key Section */}
                                    <div className="pt-3 border-t space-y-2">
                                        <div className="flex items-center gap-1 text-xs text-muted-foreground">
                                            <Key size={12} /> <span className="font-semibold">API Key</span>
                                        </div>
                                        <div className="flex items-center gap-1">
                                            <code className="flex-1 text-[10px] bg-muted px-2 py-1 rounded font-mono truncate">
                                                {isVisible ? apiKey : maskKey(apiKey)}
                                            </code>
                                            <Button
                                                variant="ghost"
                                                size="icon"
                                                className="h-6 w-6 shrink-0"
                                                onClick={() => toggleKeyVisibility(agent.id)}
                                                title={isVisible ? "Hide" : "Show"}
                                            >
                                                {isVisible ? <EyeOff size={12} /> : <Eye size={12} />}
                                            </Button>
                                            <Button
                                                variant="ghost"
                                                size="icon"
                                                className="h-6 w-6 shrink-0"
                                                onClick={() => copyKey(agent.id, apiKey)}
                                                title="Copy to clipboard"
                                            >
                                                <Copy size={12} />
                                            </Button>
                                            <Button
                                                variant="ghost"
                                                size="icon"
                                                className="h-6 w-6 shrink-0 text-destructive hover:text-destructive"
                                                onClick={() => regenerateKey(agent.id, agent.name || agent.id)}
                                                disabled={isRegen}
                                                title="Regenerate key (invalidates old key)"
                                            >
                                                <RefreshCw size={12} className={isRegen ? "animate-spin" : ""} />
                                            </Button>
                                        </div>
                                    </div>

                                    <div className="pt-2 border-t text-xs text-muted-foreground flex justify-between items-center">
                                        <span>Last active</span>
                                        <span>
                                            {agent.last_active || agent.updated_at
                                                ? formatDistanceToNow(new Date(agent.last_active || agent.updated_at), { addSuffix: true })
                                                : "N/A"
                                            }
                                        </span>
                                    </div>
                                </CardContent>
                            </Card>
                        );
                    })
                )}
            </div>
        </div>
    );
}
