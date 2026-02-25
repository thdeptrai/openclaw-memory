"use client";

import { useState, useMemo, useCallback, useRef, useEffect } from "react";
import useSWR from "swr";
import { fetcher } from "@/lib/api";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Search, Network, Users, Maximize2, Minimize2, RotateCcw, Sparkles } from "lucide-react";
import dynamic from "next/dynamic";

// Dynamic import to avoid SSR issues with canvas
const ForceGraph2D = dynamic(() => import("react-force-graph-2d"), { ssr: false });

// Entity type → color mapping
const TYPE_COLORS: Record<string, string> = {
    person: "#f472b6",     // pink
    technology: "#60a5fa", // blue
    project: "#34d399",    // green
    organization: "#fbbf24", // amber
    concept: "#a78bfa",    // purple
    tool: "#fb923c",       // orange
    language: "#2dd4bf",   // teal
    framework: "#818cf8",  // indigo
    unknown: "#94a3b8",    // slate
};

const getColor = (type: string) => TYPE_COLORS[type?.toLowerCase()] || TYPE_COLORS.unknown;

interface Entity {
    id: string;
    name: string;
    entity_type: string;
    agent_id: string;
    description: string;
    mention_count: number;
    last_seen: string;
}

interface Relationship {
    id: string;
    source_entity_id: string;
    target_entity_id: string;
    relation_type: string;
    description: string;
    strength: number;
}

interface GraphData {
    entities: Entity[];
    relationships: Relationship[];
}

export default function KnowledgeGraph() {
    const [search, setSearch] = useState("");
    const [selectedEntity, setSelectedEntity] = useState<Entity | null>(null);
    const [isFullscreen, setIsFullscreen] = useState(false);
    const graphRef = useRef<any>(null);

    // Fetch agents for selector
    const { data: agentsRes } = useSWR<{ success: boolean; data: any[] }>("/api/memory/agents", fetcher);
    const agents = agentsRes?.data || [];
    const [selectedAgentId, setSelectedAgentId] = useState<string>("");

    // Auto-select first agent
    useEffect(() => {
        if (agents.length > 0 && !selectedAgentId) {
            setSelectedAgentId(agents[0].id);
        }
    }, [agents, selectedAgentId]);

    // Fetch graph data for selected agent
    const { data: graphRes, isLoading } = useSWR<{ success: boolean; data: GraphData }>(
        selectedAgentId ? `/api/graph/${selectedAgentId}?limit=300` : null,
        fetcher,
        { refreshInterval: 15000 }
    );
    const graphData = graphRes?.data;
    const entities = graphData?.entities || [];
    const relationships = graphData?.relationships || [];

    // Filter entities for list
    const filteredEntities = useMemo(() => {
        if (!search.trim()) return entities;
        const q = search.toLowerCase();
        return entities.filter(e =>
            e.name.toLowerCase().includes(q) ||
            e.entity_type.toLowerCase().includes(q) ||
            (e.description || "").toLowerCase().includes(q)
        );
    }, [entities, search]);

    // Entity types for badges
    const entityTypes = useMemo(() => {
        const types = new Map<string, number>();
        entities.forEach(e => {
            types.set(e.entity_type, (types.get(e.entity_type) || 0) + 1);
        });
        return Array.from(types.entries()).sort((a, b) => b[1] - a[1]);
    }, [entities]);

    // Build force-graph data
    const forceGraphData = useMemo(() => {
        if (!entities.length) return { nodes: [], links: [] };

        const entityIds = new Set(entities.map(e => e.id));
        const nodes = entities.map(e => ({
            id: e.id,
            name: e.name,
            type: e.entity_type,
            mentions: e.mention_count,
            color: getColor(e.entity_type),
            val: Math.max(2, Math.min(15, e.mention_count * 2)),
        }));

        const links = relationships
            .filter(r => entityIds.has(r.source_entity_id) && entityIds.has(r.target_entity_id))
            .map(r => ({
                source: r.source_entity_id,
                target: r.target_entity_id,
                label: r.relation_type,
                strength: r.strength,
            }));

        return { nodes, links };
    }, [entities, relationships]);

    // Handle node click
    const handleNodeClick = useCallback((node: any) => {
        const entity = entities.find(e => e.id === node.id);
        if (entity) setSelectedEntity(entity);
        // Zoom to node
        if (graphRef.current) {
            graphRef.current.centerAt(node.x, node.y, 500);
            graphRef.current.zoom(3, 500);
        }
    }, [entities]);

    // Reset zoom
    const handleResetZoom = useCallback(() => {
        if (graphRef.current) {
            graphRef.current.zoomToFit(400, 50);
        }
    }, []);

    // Node canvas render
    const paintNode = useCallback((node: any, ctx: CanvasRenderingContext2D, globalScale: number) => {
        const label = node.name;
        const fontSize = Math.max(10, 12 / globalScale);
        const radius = Math.max(4, node.val);
        const isSelected = selectedEntity?.id === node.id;

        // Glow effect for selected
        if (isSelected) {
            ctx.beginPath();
            ctx.arc(node.x, node.y, radius + 4, 0, 2 * Math.PI);
            ctx.fillStyle = `${node.color}40`;
            ctx.fill();
        }

        // Node circle
        ctx.beginPath();
        ctx.arc(node.x, node.y, radius, 0, 2 * Math.PI);
        ctx.fillStyle = node.color;
        ctx.fill();

        if (isSelected) {
            ctx.strokeStyle = "#fff";
            ctx.lineWidth = 2 / globalScale;
            ctx.stroke();
        }

        // Label
        if (globalScale > 0.8 || isSelected || node.mentions > 3) {
            ctx.font = `${isSelected ? "bold " : ""}${fontSize}px Inter, sans-serif`;
            ctx.textAlign = "center";
            ctx.textBaseline = "top";
            ctx.fillStyle = "#e2e8f0";
            ctx.fillText(label, node.x, node.y + radius + 2);
        }
    }, [selectedEntity]);

    // Link render
    const paintLink = useCallback((link: any, ctx: CanvasRenderingContext2D, globalScale: number) => {
        const start = link.source;
        const end = link.target;
        if (!start || !end || typeof start.x === 'undefined') return;

        ctx.beginPath();
        ctx.moveTo(start.x, start.y);
        ctx.lineTo(end.x, end.y);
        ctx.strokeStyle = "rgba(148, 163, 184, 0.15)";
        ctx.lineWidth = Math.max(0.5, link.strength * 2) / globalScale;
        ctx.stroke();

        // Label on zoom
        if (globalScale > 1.5 && link.label) {
            const midX = (start.x + end.x) / 2;
            const midY = (start.y + end.y) / 2;
            ctx.font = `${9 / globalScale}px Inter, sans-serif`;
            ctx.textAlign = "center";
            ctx.fillStyle = "rgba(148, 163, 184, 0.6)";
            ctx.fillText(link.label, midX, midY);
        }
    }, []);

    return (
        <div className="p-8 space-y-6 max-w-[1600px] mx-auto h-[calc(100vh-2rem)] flex flex-col">
            {/* Header */}
            <div className="flex items-end justify-between shrink-0">
                <div>
                    <h2 className="text-3xl font-bold tracking-tight flex items-center gap-2">
                        <Network className="h-8 w-8 text-purple-500" />
                        Knowledge Graph
                    </h2>
                    <p className="text-muted-foreground">
                        Entity relationships and connections extracted from conversations
                    </p>
                </div>
                <div className="flex items-center gap-3">
                    {/* Agent selector */}
                    <select
                        value={selectedAgentId}
                        onChange={e => setSelectedAgentId(e.target.value)}
                        className="h-9 rounded-md border border-input bg-background px-3 text-sm"
                    >
                        {agents.length === 0 && <option value="">No agents found</option>}
                        {agents.map((a: any) => (
                            <option key={a.id} value={a.id}>{a.name || a.id}</option>
                        ))}
                    </select>
                    <Badge variant="secondary" className="gap-1">
                        <Sparkles className="h-3 w-3" />
                        {entities.length} entities · {relationships.length} links
                    </Badge>
                </div>
            </div>

            {/* Type badges */}
            {entityTypes.length > 0 && (
                <div className="flex gap-2 flex-wrap shrink-0">
                    {entityTypes.map(([type, count]) => (
                        <Badge
                            key={type}
                            variant="outline"
                            className="gap-1.5 cursor-pointer hover:bg-accent transition-colors"
                            style={{ borderColor: getColor(type) + "60", color: getColor(type) }}
                            onClick={() => setSearch(type)}
                        >
                            <span className="w-2 h-2 rounded-full" style={{ background: getColor(type) }} />
                            {type} ({count})
                        </Badge>
                    ))}
                </div>
            )}

            {/* Main content */}
            <div className={`flex gap-4 flex-1 min-h-0 ${isFullscreen ? "fixed inset-0 z-50 bg-background p-4" : ""}`}>
                {/* Graph visualization */}
                <Card className={`flex-1 flex flex-col overflow-hidden ${isFullscreen ? "" : "min-w-0"}`}>
                    <CardHeader className="flex flex-row items-center justify-between py-3 px-4 border-b shrink-0">
                        <CardTitle className="text-sm flex items-center gap-2">
                            <Network className="h-4 w-4 text-purple-500" />
                            Graph View
                        </CardTitle>
                        <div className="flex items-center gap-1">
                            <Button variant="ghost" size="icon" className="h-7 w-7" onClick={handleResetZoom} title="Reset zoom">
                                <RotateCcw className="h-3.5 w-3.5" />
                            </Button>
                            <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => setIsFullscreen(f => !f)} title="Toggle fullscreen">
                                {isFullscreen ? <Minimize2 className="h-3.5 w-3.5" /> : <Maximize2 className="h-3.5 w-3.5" />}
                            </Button>
                        </div>
                    </CardHeader>
                    <CardContent className="flex-1 p-0 relative">
                        {isLoading ? (
                            <div className="flex items-center justify-center h-full text-muted-foreground">
                                Loading graph...
                            </div>
                        ) : forceGraphData.nodes.length === 0 ? (
                            <div className="flex flex-col items-center justify-center h-full text-muted-foreground gap-2">
                                <Network className="h-12 w-12 opacity-30" />
                                <p>No entities found for this agent</p>
                                <p className="text-xs">Knowledge Graph builds entities from conversations automatically</p>
                            </div>
                        ) : (
                            <ForceGraph2D
                                ref={graphRef}
                                graphData={forceGraphData}
                                nodeCanvasObject={paintNode}
                                linkCanvasObject={paintLink}
                                onNodeClick={handleNodeClick}
                                backgroundColor="transparent"
                                cooldownTicks={100}
                                nodeRelSize={5}
                                linkDirectionalParticles={0}
                                enableNodeDrag={true}
                                enableZoomInteraction={true}
                                enablePanInteraction={true}
                                warmupTicks={50}
                                onEngineStop={() => graphRef.current?.zoomToFit(400, 50)}
                            />
                        )}
                    </CardContent>
                </Card>

                {/* Entity list sidebar */}
                {!isFullscreen && (
                    <Card className="w-[340px] shrink-0 flex flex-col">
                        <CardHeader className="py-3 px-4 border-b shrink-0 space-y-3">
                            <CardTitle className="text-sm flex items-center gap-2">
                                <Users className="h-4 w-4" />
                                Entities ({filteredEntities.length})
                            </CardTitle>
                            <div className="relative">
                                <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
                                <Input
                                    placeholder="Search entities..."
                                    value={search}
                                    onChange={e => setSearch(e.target.value)}
                                    className="pl-8 h-8 text-xs"
                                />
                            </div>
                        </CardHeader>
                        <CardContent className="flex-1 p-0 overflow-hidden">
                            <ScrollArea className="h-full">
                                <div className="p-2 space-y-1">
                                    {filteredEntities.map(entity => (
                                        <button
                                            key={entity.id}
                                            onClick={() => {
                                                setSelectedEntity(entity);
                                                // Find and focus the node
                                                const node = forceGraphData.nodes.find(n => n.id === entity.id);
                                                if (node && graphRef.current) {
                                                    graphRef.current.centerAt((node as any).x, (node as any).y, 500);
                                                    graphRef.current.zoom(3, 500);
                                                }
                                            }}
                                            className={`w-full text-left rounded-md px-3 py-2.5 transition-all hover:bg-accent group ${selectedEntity?.id === entity.id
                                                    ? "bg-primary/10 border border-primary/20"
                                                    : "border border-transparent"
                                                }`}
                                        >
                                            <div className="flex items-center justify-between">
                                                <span className="font-medium text-sm truncate">{entity.name}</span>
                                                <Badge
                                                    variant="outline"
                                                    className="text-[10px] h-5 shrink-0 ml-2"
                                                    style={{ borderColor: getColor(entity.entity_type) + "60", color: getColor(entity.entity_type) }}
                                                >
                                                    {entity.entity_type}
                                                </Badge>
                                            </div>
                                            {entity.description && (
                                                <p className="text-xs text-muted-foreground mt-1 line-clamp-1">{entity.description}</p>
                                            )}
                                            <div className="flex items-center gap-3 mt-1 text-[10px] text-muted-foreground">
                                                <span>📊 {entity.mention_count} mentions</span>
                                            </div>
                                        </button>
                                    ))}
                                    {filteredEntities.length === 0 && (
                                        <div className="text-center text-muted-foreground text-xs py-8">
                                            {search ? "No matching entities" : "No entities yet"}
                                        </div>
                                    )}
                                </div>
                            </ScrollArea>
                        </CardContent>
                    </Card>
                )}
            </div>

            {/* Selected entity detail panel */}
            {selectedEntity && (
                <Card className="shrink-0 border-purple-500/20">
                    <CardContent className="py-3 px-4">
                        <div className="flex items-start justify-between">
                            <div className="flex items-center gap-3">
                                <div
                                    className="w-10 h-10 rounded-lg flex items-center justify-center text-white font-bold text-sm"
                                    style={{ background: getColor(selectedEntity.entity_type) }}
                                >
                                    {selectedEntity.name.substring(0, 2).toUpperCase()}
                                </div>
                                <div>
                                    <h3 className="font-semibold">{selectedEntity.name}</h3>
                                    <div className="flex items-center gap-2 mt-0.5">
                                        <Badge variant="outline" className="text-[10px]" style={{ color: getColor(selectedEntity.entity_type) }}>
                                            {selectedEntity.entity_type}
                                        </Badge>
                                        <span className="text-xs text-muted-foreground">📊 {selectedEntity.mention_count} mentions</span>
                                        <span className="text-xs text-muted-foreground">
                                            🔗 {relationships.filter(r =>
                                                r.source_entity_id === selectedEntity.id || r.target_entity_id === selectedEntity.id
                                            ).length} connections
                                        </span>
                                    </div>
                                </div>
                            </div>
                            <Button variant="ghost" size="sm" onClick={() => setSelectedEntity(null)} className="text-xs">
                                ✕
                            </Button>
                        </div>
                        {selectedEntity.description && (
                            <p className="text-sm text-muted-foreground mt-2 ml-[52px]">{selectedEntity.description}</p>
                        )}
                    </CardContent>
                </Card>
            )}
        </div>
    );
}
