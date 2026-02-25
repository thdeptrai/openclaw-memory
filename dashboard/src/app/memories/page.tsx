"use client";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from "@/components/ui/accordion";
import { Progress } from "@/components/ui/progress";
import {
    Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger
} from "@/components/ui/dialog";
import {
    Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { Label } from "@/components/ui/label";
import { Slider } from "@/components/ui/slider";
import { Plus, Clock, Fingerprint, Box, Tag, Trash2 } from "lucide-react";
import useSWR from "swr";
import { fetcher, apiCall, API_URL } from "@/lib/api";
import { useState, useRef, useCallback } from "react";
import { formatDistanceToNow, format } from "date-fns";
import { toast } from "sonner";

export default function Memories() {
    const [search, setSearch] = useState("");
    const [typeFilter, setTypeFilter] = useState("all");
    const [memoryTypeFilter, setMemoryTypeFilter] = useState("all");
    const [actorFilter, setActorFilter] = useState("all");
    const [statusFilter, setStatusFilter] = useState("all");
    const [isSearching, setIsSearching] = useState(false);
    const [searchResults, setSearchResults] = useState<any[] | null>(null);
    const searchTimeout = useRef<NodeJS.Timeout | null>(null);

    // Add Memory Dialog state
    const [addOpen, setAddOpen] = useState(false);
    const [addType, setAddType] = useState("fact");
    const [addTopic, setAddTopic] = useState("general");
    const [addContent, setAddContent] = useState("");
    const [addTags, setAddTags] = useState("");
    const [addImportance, setAddImportance] = useState(70);
    const [addLoading, setAddLoading] = useState(false);

    const { data: memRes, isLoading, mutate } = useSWR<{ success: boolean, data: any[] }>("/api/memory/memories?limit=500", fetcher, { refreshInterval: 15000 });
    const allMemories = memRes?.data || [];

    // Use search results if searching, otherwise use all memories
    const baseMemories = searchResults !== null ? searchResults : allMemories;

    const filteredMemories = baseMemories.filter(m => {
        const matchesType = typeFilter === "all" || m.type === typeFilter;
        const matchesMemoryType = memoryTypeFilter === "all" || (m.memory_type || 'knowledge') === memoryTypeFilter;

        let actor = "user";
        if (m.source_agent_id) actor = "assistant";
        if (m.actor_id === "manual") actor = "manual";
        const matchesActor = actorFilter === "all" || actor === actorFilter;

        const isSuperseded = !!m.superseded_by;
        let matchesStatus = true;
        if (statusFilter === "active") matchesStatus = !isSuperseded;
        if (statusFilter === "superseded") matchesStatus = isSuperseded;

        return matchesType && matchesMemoryType && matchesActor && matchesStatus;
    });

    // Debounced semantic search
    const handleSearch = useCallback((value: string) => {
        setSearch(value);
        if (searchTimeout.current) clearTimeout(searchTimeout.current);

        if (!value.trim()) {
            setSearchResults(null);
            setIsSearching(false);
            return;
        }

        setIsSearching(true);
        searchTimeout.current = setTimeout(async () => {
            try {
                const res = await fetch(`${API_URL}/api/memory/search`, {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ query: value, limit: 100 }),
                });
                const json = await res.json();
                const mems = json.data || json;
                setSearchResults(Array.isArray(mems) ? mems : []);
            } catch {
                setSearchResults([]);
            } finally {
                setIsSearching(false);
            }
        }, 300);
    }, []);

    // Add Memory handler
    const handleAddMemory = async () => {
        if (!addContent.trim()) {
            toast("Please enter the memory content");
            return;
        }
        setAddLoading(true);
        try {
            const tags = addTags ? addTags.split(",").map(t => t.trim()).filter(Boolean) : [];
            const res = await fetch(`${API_URL}/api/memory/memories/add`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    content: addContent.trim(),
                    type: addType,
                    topic: addTopic.trim() || "general",
                    tags,
                    importance: addImportance / 100,
                }),
            });
            const json = await res.json();
            if (json.success) {
                toast.success(`Memory added: "${addContent.substring(0, 50)}..."`);
                setAddOpen(false);
                setAddContent("");
                setAddTags("");
                setAddImportance(70);
                mutate();
            } else {
                toast.error("Failed: " + (json.error || "Unknown error"));
            }
        } catch (e: any) {
            toast.error("Error: " + e.message);
        } finally {
            setAddLoading(false);
        }
    };

    // Delete Memory handler
    const handleDeleteMemory = async (memoryId: string) => {
        if (!confirm("Are you sure you want to permanently delete this memory?\n\nThis will remove it from both the database and vector store.")) {
            return;
        }
        try {
            const res = await fetch(`${API_URL}/api/memory/${memoryId}`, { method: "DELETE" });
            const json = await res.json();
            if (json.success) {
                toast.success("Memory deleted successfully");
                mutate();
            } else {
                toast.error("Delete failed: " + (json.error || "Unknown error"));
            }
        } catch (e: any) {
            toast.error("Error: " + e.message);
        }
    };

    const getTypeColor = (type: string) => {
        switch (type) {
            case 'fact': return 'bg-green-500/10 text-green-500 border-green-500/20';
            case 'decision': return 'bg-purple-500/10 text-purple-500 border-purple-500/20';
            case 'preference': return 'bg-yellow-500/10 text-yellow-600 border-yellow-500/20';
            default: return 'bg-blue-500/10 text-blue-500 border-blue-500/20';
        }
    };

    const getTypeEmoji = (type: string) => {
        switch (type) {
            case 'fact': return '✅ ';
            case 'decision': return '🔮 ';
            case 'preference': return '⭐ ';
            default: return '💬 ';
        }
    };

    const getMemoryTypeColor = (mt: string) => {
        switch (mt) {
            case 'profile': return 'bg-pink-500/10 text-pink-500 border-pink-500/20';
            case 'event': return 'bg-cyan-500/10 text-cyan-500 border-cyan-500/20';
            case 'knowledge': return 'bg-emerald-500/10 text-emerald-500 border-emerald-500/20';
            case 'behavior': return 'bg-amber-500/10 text-amber-500 border-amber-500/20';
            default: return 'bg-gray-500/10 text-gray-500 border-gray-500/20';
        }
    };

    const getMemoryTypeIcon = (mt: string) => {
        switch (mt) {
            case 'profile': return '👤';
            case 'event': return '📅';
            case 'knowledge': return '📚';
            case 'behavior': return '🔄';
            default: return '💡';
        }
    };

    return (
        <div className="p-8 space-y-6 max-w-[1400px] mx-auto">
            <div className="flex justify-between items-start">
                <div>
                    <h2 className="text-3xl font-bold tracking-tight">Memories</h2>
                    <p className="text-muted-foreground">
                        All stored memories across agents — click to expand, manage your knowledge base
                    </p>
                </div>
            </div>

            <Card>
                <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-4">
                    <CardTitle className="flex items-center gap-2">
                        <span>💾</span> Memory Store
                    </CardTitle>
                    <div className="flex items-center gap-4">
                        {/* Add Memory Dialog */}
                        <Dialog open={addOpen} onOpenChange={setAddOpen}>
                            <DialogTrigger asChild>
                                <Button className="gap-2 bg-primary">
                                    <Plus size={16} /> Add Memory
                                </Button>
                            </DialogTrigger>
                            <DialogContent className="sm:max-w-[500px]">
                                <DialogHeader>
                                    <DialogTitle>✏️ Add Custom Memory</DialogTitle>
                                    <DialogDescription>
                                        Manually add a knowledge item to the memory store
                                    </DialogDescription>
                                </DialogHeader>
                                <div className="space-y-4 py-4">
                                    <div className="grid grid-cols-2 gap-4">
                                        <div className="space-y-2">
                                            <Label>Type</Label>
                                            <Select value={addType} onValueChange={setAddType}>
                                                <SelectTrigger>
                                                    <SelectValue />
                                                </SelectTrigger>
                                                <SelectContent>
                                                    <SelectItem value="fact">✅ Fact</SelectItem>
                                                    <SelectItem value="decision">🔮 Decision</SelectItem>
                                                    <SelectItem value="preference">⭐ Preference</SelectItem>
                                                </SelectContent>
                                            </Select>
                                        </div>
                                        <div className="space-y-2">
                                            <Label>Topic</Label>
                                            <Input
                                                placeholder="e.g. general, project-name"
                                                value={addTopic}
                                                onChange={(e) => setAddTopic(e.target.value)}
                                            />
                                        </div>
                                    </div>
                                    <div className="space-y-2">
                                        <Label>Content</Label>
                                        <textarea
                                            className="flex min-h-[80px] w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
                                            rows={3}
                                            placeholder="Enter your knowledge... e.g. 'User thích dùng PostgreSQL hơn MySQL'"
                                            value={addContent}
                                            onChange={(e) => setAddContent(e.target.value)}
                                        />
                                    </div>
                                    <div className="grid grid-cols-2 gap-4">
                                        <div className="space-y-2">
                                            <Label>Tags (comma separated)</Label>
                                            <Input
                                                placeholder="e.g. database, preference"
                                                value={addTags}
                                                onChange={(e) => setAddTags(e.target.value)}
                                            />
                                        </div>
                                        <div className="space-y-2">
                                            <Label>Importance: {addImportance}%</Label>
                                            <Slider
                                                value={[addImportance]}
                                                onValueChange={([v]) => setAddImportance(v)}
                                                min={0}
                                                max={100}
                                                step={1}
                                                className="mt-2"
                                            />
                                        </div>
                                    </div>
                                </div>
                                <DialogFooter>
                                    <Button variant="outline" onClick={() => setAddOpen(false)}>Cancel</Button>
                                    <Button onClick={handleAddMemory} disabled={addLoading}>
                                        {addLoading ? "⏳ Adding..." : "➕ Add Memory"}
                                    </Button>
                                </DialogFooter>
                            </DialogContent>
                        </Dialog>

                        <Input
                            placeholder="Search all memories..."
                            className="w-[260px]"
                            value={search}
                            onChange={(e) => handleSearch(e.target.value)}
                        />
                    </div>
                </CardHeader>
                <div className="border-b px-6 pb-4">
                    {/* Filters */}
                    <div className="flex gap-4 items-center overflow-x-auto pb-2">
                        <Tabs value={typeFilter} onValueChange={setTypeFilter} className="w-[400px]">
                            <TabsList className="grid w-full grid-cols-5 h-9">
                                <TabsTrigger value="all" className="text-xs">All</TabsTrigger>
                                <TabsTrigger value="fact" className="text-xs">✅ Facts</TabsTrigger>
                                <TabsTrigger value="decision" className="text-xs">🔮 Decisions</TabsTrigger>
                                <TabsTrigger value="preference" className="text-xs">⭐ Prefs</TabsTrigger>
                                <TabsTrigger value="exchange" className="text-xs">💬 Exch</TabsTrigger>
                            </TabsList>
                        </Tabs>

                        <div className="h-6 w-px bg-border" />

                        <Tabs value={actorFilter} onValueChange={setActorFilter} className="w-[300px]">
                            <TabsList className="grid w-full grid-cols-4 h-9">
                                <TabsTrigger value="all" className="text-xs">All</TabsTrigger>
                                <TabsTrigger value="user" className="text-xs">👤 User</TabsTrigger>
                                <TabsTrigger value="assistant" className="text-xs">🤖 Asst</TabsTrigger>
                                <TabsTrigger value="manual" className="text-xs">✏️ Man</TabsTrigger>
                            </TabsList>
                        </Tabs>

                        <div className="h-6 w-px bg-border" />

                        <Tabs value={statusFilter} onValueChange={setStatusFilter} className="w-[250px]">
                            <TabsList className="grid w-full grid-cols-3 h-9">
                                <TabsTrigger value="all" className="text-xs">All Status</TabsTrigger>
                                <TabsTrigger value="active" className="text-xs">● Active</TabsTrigger>
                                <TabsTrigger value="superseded" className="text-xs">🔄 Superseded</TabsTrigger>
                            </TabsList>
                        </Tabs>

                        <div className="h-6 w-px bg-border" />

                        <Tabs value={memoryTypeFilter} onValueChange={setMemoryTypeFilter} className="w-[400px]">
                            <TabsList className="grid w-full grid-cols-5 h-9">
                                <TabsTrigger value="all" className="text-xs">All Types</TabsTrigger>
                                <TabsTrigger value="profile" className="text-xs">👤 Profile</TabsTrigger>
                                <TabsTrigger value="event" className="text-xs">📅 Event</TabsTrigger>
                                <TabsTrigger value="knowledge" className="text-xs">📚 Know</TabsTrigger>
                                <TabsTrigger value="behavior" className="text-xs">🔄 Behav</TabsTrigger>
                            </TabsList>
                        </Tabs>
                    </div>
                </div>
                <CardContent className="p-0">
                    <ScrollArea className="h-[650px] rounded-b-xl">
                        {isLoading || isSearching ? (
                            <div className="h-32 flex items-center justify-center text-muted-foreground">
                                {isSearching ? "Searching..." : "Loading memory store..."}
                            </div>
                        ) : filteredMemories.length === 0 ? (
                            <div className="h-32 flex items-center justify-center text-muted-foreground">
                                No memories found matching filters.
                            </div>
                        ) : (
                            <Accordion type="single" collapsible className="w-full">
                                {filteredMemories.map((mem: any) => {
                                    const isSuperseded = !!mem.superseded_by;
                                    const actorBadge = mem.actor_id === 'manual' ? '✏️ MANUAL' : (mem.source_agent_id ? '🤖 ASST' : '👤 USER');
                                    const actorClass = mem.actor_id === 'manual' ? 'bg-orange-500/10 text-orange-500 border-orange-500/20' : (mem.source_agent_id ? 'bg-purple-500/10 text-purple-500 border-purple-500/20' : 'bg-blue-500/10 text-blue-500 border-blue-500/20');
                                    const parsedTags = Array.isArray(mem.tags) ? mem.tags : typeof mem.tags === 'string' ? mem.tags.replace(/[{}]/g, '').split(',').filter(Boolean) : [];

                                    return (
                                        <AccordionItem key={mem.id} value={mem.id} className={`border-b px-6 py-2 hover:bg-muted/30 transition-colors ${isSuperseded ? 'opacity-60' : ''}`}>
                                            <AccordionTrigger className="hover:no-underline py-2">
                                                <div className="flex flex-col gap-3 w-full pr-4">
                                                    <div className="flex items-center gap-2 flex-wrap">
                                                        <Badge variant="outline" className={`${getTypeColor(mem.type)} text-[10px] shrink-0 uppercase`}>
                                                            {getTypeEmoji(mem.type)} {mem.type || 'MEMORY'}
                                                        </Badge>
                                                        <Badge variant="outline" className={`${actorClass} text-[10px] shrink-0 uppercase`}>
                                                            {actorBadge}
                                                        </Badge>
                                                        <Badge variant="outline" className={`${getMemoryTypeColor(mem.memory_type || 'knowledge')} text-[10px] shrink-0 uppercase`}>
                                                            {getMemoryTypeIcon(mem.memory_type || 'knowledge')} {mem.memory_type || 'knowledge'}
                                                        </Badge>
                                                        {mem.agent_name && (
                                                            <Badge variant="secondary" className="text-[10px] shrink-0">Agent: {mem.agent_name}</Badge>
                                                        )}
                                                        <Badge variant="secondary" className="text-[10px] shrink-0">Topic: {mem.topic || 'general'}</Badge>
                                                        {(mem.reinforcement_count > 0) && (
                                                            <Badge variant="outline" className="text-[10px] shrink-0 bg-indigo-500/10 text-indigo-500 border-indigo-500/20">
                                                                🔁 {mem.reinforcement_count}x recalled
                                                            </Badge>
                                                        )}

                                                        {isSuperseded && (
                                                            <Badge variant="outline" className="border-red-500/30 text-red-500 bg-red-500/5 text-[10px] shrink-0">🔄 SUPERSEDED</Badge>
                                                        )}

                                                        <span className="text-xs text-muted-foreground ml-auto flex items-center gap-1">
                                                            <Clock size={12} /> {formatDistanceToNow(new Date(mem.created_at), { addSuffix: true })}
                                                        </span>
                                                    </div>

                                                    <div className="flex items-center justify-between w-full">
                                                        <div className={`text-sm font-medium text-left max-w-[70%] ${isSuperseded ? 'line-through text-muted-foreground' : ''}`}>
                                                            {mem.content}
                                                        </div>

                                                        <div className="flex items-center gap-2 w-32 shrink-0">
                                                            <span className="text-[10px] text-muted-foreground">Imp: {Math.round((mem.importance_score || 0) * 100)}%</span>
                                                            <Progress value={(mem.importance_score || 0) * 100} className={`h-1.5 [&>div]:${isSuperseded ? 'bg-muted-foreground' : 'bg-primary'}`} />
                                                        </div>
                                                    </div>
                                                </div>
                                            </AccordionTrigger>
                                            <AccordionContent>
                                                <div className="mt-2 text-xs bg-background rounded-md border p-4 grid grid-cols-2 gap-x-8 gap-y-3">
                                                    <div className="col-span-2">
                                                        <span className="text-muted-foreground font-semibold block mb-1">Full Content</span>
                                                        <div className={`p-2 bg-muted/40 rounded text-foreground ${isSuperseded ? 'line-through text-muted-foreground' : ''}`}>
                                                            {mem.content}
                                                        </div>
                                                    </div>

                                                    <div className="flex flex-col gap-1">
                                                        <span className="text-muted-foreground flex items-center gap-1"><Fingerprint size={12} /> Memory ID</span>
                                                        <code className="text-[10px] bg-muted px-1 py-0.5 rounded flex items-center justify-between group cursor-copy" title="Copy ID">
                                                            {mem.id.slice(0, 16)}...
                                                        </code>
                                                    </div>
                                                    <div className="flex flex-col gap-1">
                                                        <span className="text-muted-foreground flex items-center gap-1"><Box size={12} /> Status</span>
                                                        {isSuperseded ? (
                                                            <span className="text-red-500 flex items-center gap-1">○ Superseded</span>
                                                        ) : (
                                                            <span className="text-green-500 flex items-center gap-1">● Active</span>
                                                        )}
                                                    </div>
                                                    <div className="flex flex-col gap-1">
                                                        <span className="text-muted-foreground flex items-center gap-1"><Clock size={12} /> Created At</span>
                                                        <span>{format(new Date(mem.created_at), 'yyyy-MM-dd HH:mm:ss')}</span>
                                                    </div>
                                                    <div className="flex flex-col gap-1">
                                                        <span className="text-muted-foreground flex items-center gap-1"><Tag size={12} /> Tags</span>
                                                        <div className="flex gap-1 flex-wrap">
                                                            {parsedTags.length > 0 ? parsedTags.map((tag: string, i: number) => (
                                                                <Badge key={i} variant="outline" className="text-[9px]">{tag}</Badge>
                                                            )) : <span className="text-muted-foreground">-</span>}
                                                        </div>
                                                    </div>

                                                    {isSuperseded && (
                                                        <div className="col-span-2 flex flex-col gap-1 mt-2">
                                                            <span className="text-muted-foreground flex items-center gap-1"><Box size={12} /> Superseded By</span>
                                                            <code className="text-[10px] bg-red-500/10 text-red-500 px-1 py-0.5 rounded self-start">{mem.superseded_by}</code>
                                                        </div>
                                                    )}

                                                    <div className="col-span-2 pt-2 mt-2 border-t flex justify-end gap-2">
                                                        <Button
                                                            variant="destructive"
                                                            size="sm"
                                                            className="h-7 text-xs gap-1"
                                                            onClick={(e) => {
                                                                e.stopPropagation();
                                                                handleDeleteMemory(mem.id);
                                                            }}
                                                        >
                                                            <Trash2 size={12} /> Delete Memory
                                                        </Button>
                                                    </div>
                                                </div>
                                            </AccordionContent>
                                        </AccordionItem>
                                    );
                                })}
                            </Accordion>
                        )}
                    </ScrollArea>
                </CardContent>
            </Card>
        </div>
    );
}
