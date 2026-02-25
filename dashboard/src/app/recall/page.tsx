"use client";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Search, RefreshCw, Copy, Code, ChevronDown } from "lucide-react";
import {
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
} from "@/components/ui/select";
import { Label } from "@/components/ui/label";
import { useState, useCallback } from "react";
import { API_URL } from "@/lib/api";
import { toast } from "sonner";

interface RecallResult {
    semanticMemories?: any[];
    crossAgentMemories?: any[];
    categorySummaries?: any[];
    conversationProfile?: Record<string, any>;
}

export default function RecallTest() {
    const [query, setQuery] = useState("");
    const [agentId, setAgentId] = useState("");
    const [conversationId, setConversationId] = useState("");
    const [topic, setTopic] = useState("");
    const [limit, setLimit] = useState(10);
    const [format, setFormat] = useState("raw");

    const [loading, setLoading] = useState(false);
    const [results, setResults] = useState<RecallResult | null>(null);
    const [contextText, setContextText] = useState<string | null>(null);
    const [rawJson, setRawJson] = useState<any>(null);
    const [showJson, setShowJson] = useState(false);
    const [elapsed, setElapsed] = useState<number | null>(null);
    const [searchedQuery, setSearchedQuery] = useState("");

    const executeRecall = useCallback(async () => {
        if (!query.trim()) {
            toast("Please enter a query");
            return;
        }

        setLoading(true);
        setResults(null);
        setContextText(null);
        setSearchedQuery(query);
        const t0 = performance.now();

        try {
            const body: Record<string, any> = { query: query.trim(), limit };
            if (agentId.trim()) body.agentId = agentId.trim();
            if (conversationId.trim()) body.conversationId = conversationId.trim();
            if (topic.trim()) body.topic = topic.trim();
            if (format === "context") body.format = "context";

            const res = await fetch(`${API_URL}/api/memory/recall`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(body),
            });
            const json = await res.json();
            const ms = Math.round(performance.now() - t0);
            setElapsed(ms);
            setRawJson(json);

            if (!json.success) {
                toast.error(json.error || "Recall failed");
                return;
            }

            if (format === "context" && json.context) {
                setContextText(json.context);
                setResults(json.raw || null);
            } else {
                setResults(json.data || null);
            }
        } catch (err: any) {
            toast.error("Failed: " + err.message);
        } finally {
            setLoading(false);
        }
    }, [query, agentId, conversationId, topic, limit, format]);

    const handleKeyDown = (e: React.KeyboardEvent) => {
        if (e.key === "Enter") executeRecall();
    };

    const copyContext = () => {
        if (contextText) {
            navigator.clipboard.writeText(contextText);
            toast.success("Context copied to clipboard");
        }
    };

    // Count total results
    const totalCount = results
        ? (results.semanticMemories?.length || 0) +
        (results.crossAgentMemories?.length || 0)
        : 0;

    const sections = [
        { key: "semanticMemories" as const, label: "🧠 Semantic Memories", description: "Extracted facts via vector search" },
        { key: "crossAgentMemories" as const, label: "🔗 Cross-Agent Memories", description: "Memories from other agents" },
        { key: "categorySummaries" as const, label: "📂 Category Summaries", description: "High-level summaries by category" },
    ];

    const renderScore = (score: number | undefined) => {
        if (score === undefined) return null;
        const pct = (score * 100).toFixed(1);
        const cls = score >= 0.7 ? "text-green-500" : score >= 0.5 ? "text-yellow-500" : "text-red-400";
        return <span className={`font-mono text-xs font-bold ${cls}`}>{pct}%</span>;
    };

    const renderMemoryItem = (item: any, sectionKey: string) => {
        const payload = item.payload || item;
        const content = payload.content || payload.user_message || JSON.stringify(payload);
        const itemAgentId = payload.agent_id || "";
        const importance = payload.importance_score;
        const tags: string[] = payload.content_tags || [];
        const itemTopic = payload.topic || "";

        return (
            <div key={item.id || Math.random()} className="border rounded-lg p-4 bg-muted/20 hover:bg-muted/40 transition-colors space-y-2">
                <div className="flex items-center gap-2 flex-wrap">
                    {renderScore(item.score)}
                    {(item.memoryType || payload.memory_type) && (
                        <Badge variant="outline" className={`text-[10px] ${(item.memoryType || payload.memory_type) === 'profile' ? 'bg-pink-500/10 text-pink-500 border-pink-500/20' :
                                (item.memoryType || payload.memory_type) === 'event' ? 'bg-cyan-500/10 text-cyan-500 border-cyan-500/20' :
                                    (item.memoryType || payload.memory_type) === 'behavior' ? 'bg-amber-500/10 text-amber-500 border-amber-500/20' :
                                        'bg-emerald-500/10 text-emerald-500 border-emerald-500/20'
                            }`}>
                            {item.memoryType || payload.memory_type || 'knowledge'}
                        </Badge>
                    )}
                    {itemAgentId && (
                        <Badge variant="outline" className="text-[10px] bg-purple-500/10 text-purple-500 border-purple-500/20">{itemAgentId}</Badge>
                    )}
                    {itemTopic && (
                        <Badge variant="outline" className="text-[10px] bg-blue-500/10 text-blue-500 border-blue-500/20">{itemTopic}</Badge>
                    )}
                    {importance !== undefined && (
                        <span className="text-[10px] text-muted-foreground">⚡{(importance * 100).toFixed(0)}</span>
                    )}
                </div>
                <p className="text-sm text-foreground whitespace-pre-wrap">{content}</p>
                {tags.length > 0 && (
                    <div className="flex gap-1 flex-wrap">
                        {tags.map((t, i) => (
                            <Badge key={i} variant="secondary" className="text-[9px]">{t}</Badge>
                        ))}
                    </div>
                )}
            </div>
        );
    };



    return (
        <div className="p-8 space-y-6 max-w-[1200px] mx-auto h-[100vh] flex flex-col">
            <div>
                <h2 className="text-3xl font-bold tracking-tight">Recall Playground</h2>
                <p className="text-muted-foreground">
                    Test memory recall — enter a query to see what the system retrieves based on vector similarity
                </p>
            </div>

            {/* Query Engine */}
            <Card className="bg-muted/20 border-primary/20">
                <CardContent className="p-6">
                    <div className="flex gap-4">
                        <div className="flex-1 relative">
                            <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground h-5 w-5" />
                            <Input
                                placeholder="Enter your query... e.g. 'What coding style does the user prefer?'"
                                className="w-full pl-10 h-12 text-lg bg-background shadow-sm"
                                value={query}
                                onChange={(e) => setQuery(e.target.value)}
                                onKeyDown={handleKeyDown}
                            />
                        </div>
                        <Button
                            size="lg"
                            className="h-12 px-8 font-semibold text-base gap-2"
                            onClick={executeRecall}
                            disabled={loading}
                        >
                            {loading ? (
                                <><RefreshCw className="h-5 w-5 animate-spin" /> Recalling...</>
                            ) : (
                                <><RefreshCw className="h-5 w-5" /> Recall</>
                            )}
                        </Button>
                    </div>

                    <div className="grid grid-cols-1 md:grid-cols-5 gap-4 mt-6">
                        <div className="space-y-2">
                            <Label className="text-xs text-muted-foreground">Agent ID</Label>
                            <Input
                                placeholder="All agents"
                                className="h-8 text-xs bg-background"
                                value={agentId}
                                onChange={(e) => setAgentId(e.target.value)}
                            />
                        </div>
                        <div className="space-y-2">
                            <Label className="text-xs text-muted-foreground">Conversation ID</Label>
                            <Input
                                placeholder="All conversations"
                                className="h-8 text-xs bg-background"
                                value={conversationId}
                                onChange={(e) => setConversationId(e.target.value)}
                            />
                        </div>
                        <div className="space-y-2">
                            <Label className="text-xs text-muted-foreground">Topic</Label>
                            <Input
                                placeholder="Auto-detect"
                                className="h-8 text-xs bg-background"
                                value={topic}
                                onChange={(e) => setTopic(e.target.value)}
                            />
                        </div>
                        <div className="space-y-2">
                            <Label className="text-xs text-muted-foreground">Limit</Label>
                            <Input
                                type="number"
                                value={limit}
                                min={1}
                                max={50}
                                className="h-8 text-xs bg-background"
                                onChange={(e) => setLimit(parseInt(e.target.value) || 10)}
                            />
                        </div>
                        <div className="space-y-2">
                            <Label className="text-xs text-muted-foreground">Format</Label>
                            <Select value={format} onValueChange={setFormat}>
                                <SelectTrigger className="h-8 text-xs bg-background">
                                    <SelectValue placeholder="Format" />
                                </SelectTrigger>
                                <SelectContent>
                                    <SelectItem value="raw" className="text-xs">Raw (structured)</SelectItem>
                                    <SelectItem value="context" className="text-xs">Context (for LLM)</SelectItem>
                                </SelectContent>
                            </Select>
                        </div>
                    </div>
                </CardContent>
            </Card>

            {/* Results Area */}
            <div className="flex gap-6 flex-1 min-h-0">
                <Card className="flex-1 flex flex-col min-h-0">
                    <CardHeader className="py-4 border-b">
                        <div className="flex items-center justify-between">
                            <CardTitle className="text-lg flex items-center gap-2">
                                <span>🔍</span> Search Results
                            </CardTitle>
                            {elapsed !== null && (
                                <div className="flex items-center gap-3 text-xs text-muted-foreground">
                                    <span>🔍 <strong className="text-foreground">{totalCount}</strong> results in <strong className="text-foreground">{elapsed}ms</strong></span>
                                    <span className="text-muted-foreground/60 truncate max-w-[200px]">Query: &quot;{searchedQuery}&quot;</span>
                                    {rawJson && (
                                        <Button
                                            variant="ghost"
                                            size="sm"
                                            className="h-6 text-[10px] gap-1"
                                            onClick={() => setShowJson(!showJson)}
                                        >
                                            <Code className="h-3 w-3" /> {showJson ? "Hide" : "Show"} JSON
                                        </Button>
                                    )}
                                </div>
                            )}
                        </div>
                    </CardHeader>
                    <CardContent className="p-0 flex-1 overflow-hidden">
                        <ScrollArea className="h-full p-6">
                            {/* No results yet */}
                            {!results && !contextText && !loading && (
                                <div className="flex flex-col items-center justify-center h-full text-muted-foreground opacity-70 mt-20">
                                    <Search className="h-12 w-12 mb-4" />
                                    <p>Enter a query above to test memory recall</p>
                                </div>
                            )}

                            {/* Loading */}
                            {loading && (
                                <div className="flex flex-col items-center justify-center h-full text-muted-foreground mt-20">
                                    <RefreshCw className="h-10 w-10 animate-spin mb-4 opacity-50" />
                                    <p>Searching memories...</p>
                                </div>
                            )}

                            {/* Context format */}
                            {contextText && !loading && (
                                <div className="space-y-4">
                                    <div className="flex items-center justify-between">
                                        <h4 className="font-semibold text-sm">📄 LLM Context String</h4>
                                        <Button variant="outline" size="sm" className="h-7 text-xs gap-1" onClick={copyContext}>
                                            <Copy className="h-3 w-3" /> Copy
                                        </Button>
                                    </div>
                                    <pre className="bg-muted/40 border rounded-lg p-4 text-xs font-mono whitespace-pre-wrap max-h-[400px] overflow-y-auto">
                                        {contextText}
                                    </pre>
                                </div>
                            )}

                            {/* Structured results */}
                            {results && !loading && (
                                <div className="space-y-6">
                                    {sections.map(({ key, label }) => {
                                        const items = results[key];
                                        if (!Array.isArray(items) || items.length === 0) return null;
                                        // Category summaries render differently
                                        if (key === 'categorySummaries') {
                                            return (
                                                <div key={key} className="space-y-3">
                                                    <div className="flex items-center gap-2">
                                                        <h4 className="font-semibold text-sm">{label}</h4>
                                                        <Badge variant="secondary" className="text-[10px]">{items.length}</Badge>
                                                    </div>
                                                    <div className="space-y-2">
                                                        {items.map((cat: any, i: number) => (
                                                            <div key={i} className="border rounded-lg p-4 bg-muted/20 space-y-1">
                                                                <div className="flex items-center gap-2">
                                                                    <Badge variant="outline" className="text-[10px] bg-indigo-500/10 text-indigo-500 border-indigo-500/20">
                                                                        📂 {cat.name}
                                                                    </Badge>
                                                                    <span className="text-[10px] text-muted-foreground">{cat.memoryCount} memories</span>
                                                                </div>
                                                                <p className="text-sm text-foreground">{cat.summary}</p>
                                                            </div>
                                                        ))}
                                                    </div>
                                                </div>
                                            );
                                        }
                                        return (
                                            <div key={key} className="space-y-3">
                                                <div className="flex items-center gap-2">
                                                    <h4 className="font-semibold text-sm">{label}</h4>
                                                    <Badge variant="secondary" className="text-[10px]">{items.length}</Badge>
                                                </div>
                                                <div className="space-y-2">
                                                    {items.map((item: any) =>
                                                        renderMemoryItem(item, key)
                                                    )}
                                                </div>
                                            </div>
                                        );
                                    })}

                                    {/* Conversation Profile */}
                                    {results.conversationProfile && Object.keys(results.conversationProfile).length > 0 && (
                                        <div className="space-y-3">
                                            <h4 className="font-semibold text-sm">👤 Conversation Profile</h4>
                                            <pre className="bg-muted/40 border rounded-lg p-4 text-xs font-mono whitespace-pre-wrap">
                                                {JSON.stringify(results.conversationProfile, null, 2)}
                                            </pre>
                                        </div>
                                    )}

                                    {totalCount === 0 && (
                                        <div className="flex flex-col items-center justify-center text-muted-foreground mt-10 opacity-70">
                                            <span className="text-3xl mb-2">🤷</span>
                                            <p className="text-sm">No memories found for this query</p>
                                        </div>
                                    )}
                                </div>
                            )}
                        </ScrollArea>
                    </CardContent>
                </Card>

                {/* JSON Viewer */}
                {showJson && rawJson && (
                    <Card className="w-[400px] flex flex-col min-h-0 bg-secondary/30">
                        <CardHeader className="py-4 border-b">
                            <div className="flex items-center justify-between">
                                <CardTitle className="text-sm flex items-center gap-2">
                                    <span>📦</span> Raw JSON Response
                                </CardTitle>
                                <Button variant="ghost" size="sm" className="h-6 text-[10px] uppercase" onClick={() => setShowJson(false)}>
                                    Hide JSON
                                </Button>
                            </div>
                        </CardHeader>
                        <CardContent className="p-0 flex-1 overflow-hidden">
                            <ScrollArea className="h-full">
                                <pre className="p-4 text-xs font-mono text-muted-foreground w-full overflow-x-auto whitespace-pre-wrap">
                                    {JSON.stringify(rawJson, null, 2)}
                                </pre>
                            </ScrollArea>
                        </CardContent>
                    </Card>
                )}
            </div>
        </div>
    );
}
