"use client";

import { ScrollArea } from "@/components/ui/scroll-area";
import { Input } from "@/components/ui/input";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from "@/components/ui/accordion";
import { Bot, User, MessageSquare, Brain, Clock, Search, Hash } from "lucide-react";
import useSWR from "swr";
import { fetcher } from "@/lib/api";
import { useState } from "react";
import { formatDistanceToNow, format } from "date-fns";

export default function Conversations() {
    const [search, setSearch] = useState("");
    const [selectedConvId, setSelectedConvId] = useState<string | null>(null);

    const { data: convRes } = useSWR<{ success: boolean, data: any[] }>("/api/memory/conversations?limit=100", fetcher, { refreshInterval: 15000 });
    const allConversations = convRes?.data || [];

    const filteredConversations = allConversations.filter(c =>
        (c.title || c.topic || "").toLowerCase().includes(search.toLowerCase()) ||
        (c.agent_name || c.agent_id || "").toLowerCase().includes(search.toLowerCase()) ||
        (c.id || "").toLowerCase().includes(search.toLowerCase())
    );

    const { data: threadRes, isValidating: isLoadingThread } = useSWR<{ success: boolean, data: any }>(
        selectedConvId ? `/api/memory/conversations/${selectedConvId}` : null,
        fetcher
    );
    const selectedConv = threadRes?.data;
    const exchanges = selectedConv?.exchanges || [];
    const memories = selectedConv?.memories || [];

    const getInitials = (name: string) => name ? name.split(/[-_\s]/).map(w => w[0]).join('').toUpperCase().slice(0, 2) : "??";

    // Agent color map (consistent per agent)
    const agentColors = ["from-indigo-500 to-purple-500", "from-emerald-500 to-teal-500", "from-orange-500 to-amber-500", "from-pink-500 to-rose-500", "from-cyan-500 to-blue-500"];
    const getAgentColor = (agentId: string) => {
        let hash = 0;
        for (let i = 0; i < agentId.length; i++) hash = ((hash << 5) - hash) + agentId.charCodeAt(i);
        return agentColors[Math.abs(hash) % agentColors.length];
    };

    return (
        <div className="flex h-[calc(100vh)] p-6 gap-6">
            {/* Left List */}
            <div className="w-[380px] flex flex-col gap-4 border-r pr-6">
                <div className="shrink-0">
                    <div className="flex items-center justify-between mb-3">
                        <div>
                            <h2 className="text-2xl font-bold tracking-tight">Conversations</h2>
                            <p className="text-xs text-muted-foreground mt-0.5">
                                {allConversations.length} total threads
                            </p>
                        </div>
                    </div>
                    <div className="relative">
                        <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                        <Input
                            type="search"
                            placeholder="Search by topic, agent, or ID..."
                            className="pl-9"
                            value={search}
                            onChange={(e) => setSearch(e.target.value)}
                        />
                    </div>
                </div>
                <ScrollArea className="flex-1">
                    {allConversations.length === 0 ? (
                        <div className="text-sm text-muted-foreground text-center mt-10">
                            <MessageSquare className="h-10 w-10 mx-auto mb-3 opacity-30" />
                            <p>No conversations yet</p>
                            <p className="text-xs mt-1">Conversations appear when agents store exchanges</p>
                        </div>
                    ) : filteredConversations.length === 0 ? (
                        <div className="text-sm text-muted-foreground text-center mt-10">
                            No conversations matching &quot;{search}&quot;
                        </div>
                    ) : (
                        <div className="flex flex-col gap-2 pr-4">
                            {filteredConversations.map(c => {
                                const agentName = c.agent_name || c.agent_id || 'unknown';
                                const isActive = c.status === 'active';
                                const isSelected = c.id === selectedConvId;
                                const title = c.topic || c.title || `Conversation`;
                                const exchangeCount = parseInt(c.exchange_count || '0');
                                const memoryCount = parseInt(c.memory_count || '0');
                                const lastActive = c.last_exchange_at || c.updated_at || c.created_at;
                                const createdAt = c.created_at;

                                return (
                                    <div
                                        key={c.id}
                                        onClick={() => setSelectedConvId(c.id)}
                                        className={`group relative p-3.5 rounded-xl cursor-pointer transition-all duration-200 ${isSelected
                                            ? 'bg-accent ring-1 ring-primary/30 shadow-sm'
                                            : 'hover:bg-accent/60'
                                            }`}
                                    >
                                        {/* Active indicator */}
                                        {isSelected && (
                                            <span className="absolute left-0 top-1/2 -translate-y-1/2 w-1 h-8 bg-primary rounded-r-full" />
                                        )}

                                        <div className="flex gap-3">
                                            {/* Agent Avatar */}
                                            <Avatar className="h-10 w-10 shrink-0 rounded-lg">
                                                <AvatarFallback className={`bg-gradient-to-br ${getAgentColor(c.agent_id || '')} text-white text-xs font-bold rounded-lg`}>
                                                    {getInitials(agentName)}
                                                </AvatarFallback>
                                            </Avatar>

                                            <div className="flex-1 min-w-0">
                                                {/* Top row: agent name + time */}
                                                <div className="flex items-center justify-between gap-2">
                                                    <div className="flex items-center gap-1.5 min-w-0">
                                                        <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${isActive ? 'bg-green-500 shadow-[0_0_6px_rgba(34,197,94,0.5)]' : 'bg-muted-foreground/40'}`} />
                                                        <span className="text-sm font-semibold truncate">{agentName}</span>
                                                    </div>
                                                    <span className="text-[10px] text-muted-foreground shrink-0 tabular-nums">
                                                        {formatDistanceToNow(new Date(lastActive), { addSuffix: true })}
                                                    </span>
                                                </div>

                                                {/* Topic */}
                                                <p className="text-xs text-muted-foreground mt-1 line-clamp-2 leading-relaxed" title={title}>
                                                    {title}
                                                </p>

                                                {/* Bottom row: metadata badges */}
                                                <div className="flex items-center gap-2 mt-2">
                                                    <div className="flex items-center gap-1 text-[10px] text-muted-foreground bg-muted/50 px-1.5 py-0.5 rounded">
                                                        <MessageSquare className="h-2.5 w-2.5" />
                                                        {exchangeCount}
                                                    </div>
                                                    {memoryCount > 0 && (
                                                        <div className="flex items-center gap-1 text-[10px] text-purple-400 bg-purple-500/10 px-1.5 py-0.5 rounded">
                                                            <Brain className="h-2.5 w-2.5" />
                                                            {memoryCount}
                                                        </div>
                                                    )}
                                                    <div className="flex items-center gap-1 text-[10px] text-muted-foreground/60 ml-auto" title={`ID: ${c.id}`}>
                                                        <Hash className="h-2.5 w-2.5" />
                                                        {c.id.slice(0, 8)}
                                                    </div>
                                                </div>
                                            </div>
                                        </div>
                                    </div>
                                );
                            })}
                        </div>
                    )}
                </ScrollArea>
            </div>

            {/* Right Thread View */}
            <div className="flex-1 flex flex-col min-h-0 overflow-hidden">
                {/* Thread header */}
                <div className="shrink-0 border-b pb-4 mb-0">
                    {selectedConv ? (
                        <div className="flex items-center gap-4">
                            <Avatar className="h-10 w-10 rounded-lg">
                                <AvatarFallback className={`bg-gradient-to-br ${getAgentColor(selectedConv.agent_id || '')} text-white text-sm font-bold rounded-lg`}>
                                    {getInitials(selectedConv.agent_name || selectedConv.agent_id || '')}
                                </AvatarFallback>
                            </Avatar>
                            <div className="flex-1 min-w-0">
                                <h3 className="text-lg font-semibold truncate">
                                    {selectedConv.agent_name || selectedConv.agent_id || 'Conversation'}
                                </h3>
                                <div className="flex items-center gap-3 text-xs text-muted-foreground mt-0.5">
                                    <span className="flex items-center gap-1">
                                        <MessageSquare className="h-3 w-3" />
                                        {exchanges.length} exchanges
                                    </span>
                                    <span className="flex items-center gap-1">
                                        <Brain className="h-3 w-3" />
                                        {memories.length} memories
                                    </span>
                                    <span className="flex items-center gap-1 font-mono">
                                        <Hash className="h-3 w-3" />
                                        {selectedConv.id.slice(0, 12)}
                                    </span>
                                    {selectedConv.created_at && (
                                        <span className="flex items-center gap-1">
                                            <Clock className="h-3 w-3" />
                                            {format(new Date(selectedConv.created_at), "MMM d, yyyy HH:mm")}
                                        </span>
                                    )}
                                </div>
                            </div>
                        </div>
                    ) : (
                        <h3 className="text-lg font-semibold text-muted-foreground">Select a conversation</h3>
                    )}
                </div>

                {/* Messages */}
                <ScrollArea className="flex-1 min-h-0">
                    <div className="flex flex-col gap-6 w-full max-w-3xl mx-auto py-6 px-4">
                        {!selectedConvId ? (
                            <div className="text-muted-foreground text-sm text-center mt-20 flex flex-col items-center gap-3">
                                <MessageSquare className="h-12 w-12 opacity-20" />
                                <p>Select a conversation to view exchanges</p>
                            </div>
                        ) : isLoadingThread ? (
                            <div className="text-muted-foreground text-sm text-center mt-20">
                                Loading thread...
                            </div>
                        ) : exchanges.length === 0 ? (
                            <div className="text-muted-foreground text-sm text-center mt-20">
                                No messages in this conversation yet.
                            </div>
                        ) : (
                            <>
                                {exchanges.map((ex: any, i: number) => (
                                    <div key={ex.id || i} className="flex flex-col gap-4">
                                        {/* User Bubble */}
                                        <div className="flex flex-col items-end w-full mt-4">
                                            <div className="flex items-start gap-3 w-full justify-end">
                                                <div className="bg-primary/90 text-primary-foreground text-sm p-3 rounded-tl-xl rounded-tr-xl rounded-bl-xl rounded-br-sm max-w-[80%] shadow-sm whitespace-pre-wrap">
                                                    {ex.user_message}
                                                </div>
                                                <Avatar className="h-8 w-8 shrink-0">
                                                    <AvatarFallback className="bg-primary/20"><User size={14} /></AvatarFallback>
                                                </Avatar>
                                            </div>
                                            <span className="text-[10px] text-muted-foreground mt-1 mr-11">
                                                {ex.sequence_num ? `#${ex.sequence_num} · ` : ''}{formatDistanceToNow(new Date(ex.created_at), { addSuffix: true })}
                                            </span>
                                        </div>

                                        {/* Agent Bubble */}
                                        <div className="flex flex-col items-start w-full mt-2">
                                            <div className="flex items-start gap-3 w-full justify-start">
                                                <Avatar className="h-8 w-8 shrink-0 border-2 border-purple-500/20 rounded-lg">
                                                    <AvatarFallback className="bg-muted rounded-md"><Bot size={14} /></AvatarFallback>
                                                </Avatar>
                                                <div className="bg-muted text-foreground text-sm p-3 rounded-tl-xl rounded-tr-xl rounded-br-xl rounded-bl-sm max-w-[80%] shadow-sm whitespace-pre-wrap">
                                                    {ex.agent_response}
                                                </div>
                                            </div>
                                        </div>
                                    </div>
                                ))}
                            </>
                        )}
                    </div>
                </ScrollArea>

                {/* Extracted Knowledge — STICKY bottom panel */}
                {selectedConvId && (
                    <div className="shrink-0 border-t bg-muted/20 backdrop-blur-sm">
                        <Accordion type="single" collapsible className="w-full px-4">
                            <AccordionItem value="knowledge" className="border-b-0">
                                <AccordionTrigger className="py-3 text-sm hover:no-underline font-semibold">
                                    <div className="flex items-center gap-2 text-muted-foreground">
                                        <span className="text-orange-500 bg-orange-500/10 p-1.5 rounded-md">🧠</span>
                                        Extracted Knowledge ({memories.length})
                                    </div>
                                </AccordionTrigger>
                                <AccordionContent>
                                    <div className="bg-background rounded-md p-4 text-xs border border-border shadow-sm space-y-3 max-h-[250px] overflow-y-auto">
                                        {memories.length === 0 ? (
                                            <div className="text-muted-foreground text-center py-4">No knowledge extracted yet.</div>
                                        ) : (
                                            memories.map((m: any) => (
                                                <div key={m.id} className="flex items-start gap-2">
                                                    <Badge variant="outline" className={`text-[10px] mt-0.5 shrink-0 uppercase ${m.type === 'fact' ? 'bg-green-500/10 text-green-500 border-green-500/20' : m.type === 'preference' ? 'bg-yellow-500/10 text-yellow-600 border-yellow-500/20' : 'bg-purple-500/10 text-purple-500 border-purple-500/20'}`}>
                                                        {m.type || 'MEMORY'}
                                                    </Badge>
                                                    <Badge variant="outline" className={`text-[10px] mt-0.5 shrink-0 uppercase ${(m.memory_type || 'knowledge') === 'profile' ? 'bg-pink-500/10 text-pink-500 border-pink-500/20' :
                                                            (m.memory_type || 'knowledge') === 'event' ? 'bg-cyan-500/10 text-cyan-500 border-cyan-500/20' :
                                                                (m.memory_type || 'knowledge') === 'behavior' ? 'bg-amber-500/10 text-amber-500 border-amber-500/20' :
                                                                    'bg-emerald-500/10 text-emerald-500 border-emerald-500/20'
                                                        }`}>
                                                        {m.memory_type || 'knowledge'}
                                                    </Badge>
                                                    <span className="text-muted-foreground leading-relaxed">{m.content}</span>
                                                </div>
                                            ))
                                        )}
                                    </div>
                                </AccordionContent>
                            </AccordionItem>
                        </Accordion>
                    </div>
                )}
            </div>
        </div>
    );
}
