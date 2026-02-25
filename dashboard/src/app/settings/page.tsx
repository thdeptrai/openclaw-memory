"use client";

import { Card, CardContent, CardHeader, CardTitle, CardDescription, CardFooter } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Key, Save, RotateCcw, Lock, Info } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { toast } from "sonner";
import useSWR from "swr";
import { fetcher, API_URL } from "@/lib/api";
import { useState, useEffect, useMemo } from "react";

// Group metadata: icon, subtitle, column layout hint
const GROUP_META: Record<string, { icon: string; subtitle: string; columns?: 1 | 2 }> = {
    'AI Models': { icon: '🧠', subtitle: 'MiniMax LLM — primary inference provider', columns: 2 },
    'Embeddings': { icon: '🧬', subtitle: 'Ollama — local vector embedding generation', columns: 2 },
    'Processing': { icon: '⚙️', subtitle: 'Fact extraction, deduplication, and batch pipeline', columns: 2 },
    'Memory': { icon: '💾', subtitle: 'Vector search and relevance tuning', columns: 2 },
    'Scheduler': { icon: '⏰', subtitle: 'Background maintenance tasks', columns: 2 },
    'Prompts': { icon: '📝', subtitle: 'System prompts for LLM-powered pipelines', columns: 1 },
};

// Ordered group names for consistent rendering
const GROUP_ORDER = ['AI Models', 'Embeddings', 'Processing', 'Memory', 'Scheduler', 'Prompts'];

function formatUnit(value: number | string, unit?: string): string {
    if (!unit || unit !== 'ms') return String(value);
    const ms = Number(value);
    if (ms >= 3600000) return `${(ms / 3600000).toFixed(1)}h`;
    if (ms >= 60000) return `${(ms / 60000).toFixed(0)}m`;
    if (ms >= 1000) return `${(ms / 1000).toFixed(0)}s`;
    return `${ms}ms`;
}

export default function Settings() {
    const { data: configRes, mutate } = useSWR<{ success: boolean, data: Record<string, any> }>("/api/config", fetcher);
    const { data: agentsRes } = useSWR<{ success: boolean, data: any[] }>("/api/memory/agents", fetcher);
    const [formData, setFormData] = useState<Record<string, any>>({});
    const [isSaving, setIsSaving] = useState(false);

    const configData = configRes?.data || {};
    const agentCount = agentsRes?.data?.length || 0;

    useEffect(() => {
        if (configRes?.data) {
            const initialForm: Record<string, any> = {};
            Object.entries(configRes.data).forEach(([k, v]: [string, any]) => {
                initialForm[k] = v.value;
            });
            setFormData(initialForm);
        }
    }, [configRes]);

    const changedKeys = useMemo(() => {
        const keys: string[] = [];
        Object.entries(formData).forEach(([k, v]) => {
            const orig = configData[k]?.value;
            if (orig !== v && !(v === '' && configData[k]?.sensitive)) {
                keys.push(k);
            }
        });
        return keys;
    }, [formData, configData]);

    const handleSave = async () => {
        setIsSaving(true);
        try {
            const changes: Record<string, any> = {};
            changedKeys.forEach(k => { changes[k] = formData[k]; });

            if (Object.keys(changes).length === 0) {
                toast("No changes to save.");
                setIsSaving(false);
                return;
            }

            const res = await fetch(`${API_URL}/api/config`, {
                method: "PUT",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ settings: changes })
            });
            const data = await res.json();

            if (data.success) {
                toast.success(`${Object.keys(changes).length} setting(s) saved successfully.`);
                mutate();
            } else {
                toast.error("Failed to save: " + (data.errors?.join(", ") || "Unknown error"));
            }
        } catch (e: any) {
            toast.error("Error saving: " + e.message);
        } finally {
            setIsSaving(false);
        }
    };

    const handleResetAll = async () => {
        if (!confirm("Are you sure you want to reset all settings to defaults? This cannot be undone.")) return;
        try {
            const res = await fetch(`${API_URL}/api/config/reset`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ all: true })
            });
            if (res.ok) {
                toast.success("All settings reset to defaults.");
                mutate();
            }
        } catch (e: any) {
            toast.error("Error resetting: " + e.message);
        }
    };

    // Group settings in defined order
    const groupedConfig = useMemo(() => {
        const groups: Record<string, any[]> = {};
        Object.entries(configData).forEach(([key, meta]: [string, any]) => {
            const group = meta.group || 'General';
            if (!groups[group]) groups[group] = [];
            groups[group].push({ key, ...meta });
        });
        return groups;
    }, [configData]);

    const orderedGroups = GROUP_ORDER.filter(g => groupedConfig[g]?.length > 0);

    const renderSettingInput = (item: any) => {
        const isChanged = changedKeys.includes(item.key);

        if (item.type === 'readonly') {
            return (
                <div className="flex items-center gap-2">
                    <div className="px-3 py-1.5 rounded-md bg-muted text-sm font-mono text-muted-foreground border">
                        {item.value}
                    </div>
                    <Lock className="h-3.5 w-3.5 text-muted-foreground/50" />
                </div>
            );
        }

        if (item.type === 'boolean') {
            return (
                <div className="flex items-center gap-3">
                    <span className="text-xs text-muted-foreground">
                        {formData[item.key] ? 'Enabled' : 'Disabled'}
                    </span>
                    <Switch
                        checked={formData[item.key] || false}
                        onCheckedChange={(c) => setFormData(p => ({ ...p, [item.key]: c }))}
                    />
                </div>
            );
        }

        if (item.type === 'textarea') {
            return (
                <Textarea
                    className={`font-mono text-xs min-h-[120px] resize-y transition-colors ${isChanged ? 'border-amber-500/50 bg-amber-500/5' : ''}`}
                    value={formData[item.key] !== undefined ? formData[item.key] : ''}
                    onChange={(e) => setFormData(p => ({ ...p, [item.key]: e.target.value }))}
                />
            );
        }

        if (item.type === 'number') {
            return (
                <div className="flex items-center gap-2">
                    <Input
                        type="number"
                        min={item.min}
                        max={item.max}
                        step={item.step}
                        className={`w-[130px] font-mono transition-colors ${isChanged ? 'border-amber-500/50 bg-amber-500/5' : ''}`}
                        value={formData[item.key] !== undefined ? formData[item.key] : ''}
                        onChange={(e) => setFormData(p => ({ ...p, [item.key]: parseFloat(e.target.value) }))}
                    />
                    {item.unit && (
                        <span className="text-xs text-muted-foreground whitespace-nowrap">
                            {formatUnit(formData[item.key], item.unit)}
                        </span>
                    )}
                </div>
            );
        }

        // string (default)
        return (
            <Input
                type={item.sensitive ? "password" : "text"}
                className={`font-mono text-sm transition-colors ${isChanged ? 'border-amber-500/50 bg-amber-500/5' : ''}`}
                value={formData[item.key] !== undefined ? formData[item.key] : ''}
                placeholder={item.sensitive ? "••••••••" : ""}
                onChange={(e) => setFormData(p => ({ ...p, [item.key]: e.target.value }))}
            />
        );
    };

    const renderSettingItem = (item: any, isFullWidth: boolean) => {
        if (isFullWidth) {
            // Full-width layout for textarea items
            return (
                <div key={item.key} className="space-y-2 py-4 border-b last:border-0 border-border/50">
                    <div className="flex items-center gap-2">
                        {item.icon && <span className="text-sm">{item.icon}</span>}
                        <label className="text-sm font-semibold">{item.label}</label>
                        <TooltipProvider delayDuration={200}>
                            <Tooltip>
                                <TooltipTrigger asChild>
                                    <Info className="h-3.5 w-3.5 text-muted-foreground/50 cursor-help" />
                                </TooltipTrigger>
                                <TooltipContent side="top" className="max-w-[300px]">
                                    <p className="text-xs">{item.description}</p>
                                </TooltipContent>
                            </Tooltip>
                        </TooltipProvider>
                    </div>
                    <p className="text-xs text-muted-foreground mb-2">{item.description}</p>
                    {renderSettingInput(item)}
                </div>
            );
        }

        // Grid layout for non-textarea items
        return (
            <div key={item.key} className="flex flex-col gap-2 p-3 rounded-lg bg-card/50 border border-border/30 hover:border-border/60 transition-colors">
                <div className="flex items-start justify-between gap-2">
                    <div className="flex items-center gap-2 min-w-0">
                        {item.icon && <span className="text-sm flex-shrink-0">{item.icon}</span>}
                        <label className="text-sm font-semibold truncate">{item.label}</label>
                    </div>
                    <TooltipProvider delayDuration={200}>
                        <Tooltip>
                            <TooltipTrigger asChild>
                                <Info className="h-3.5 w-3.5 text-muted-foreground/40 cursor-help flex-shrink-0 mt-0.5" />
                            </TooltipTrigger>
                            <TooltipContent side="top" className="max-w-[300px]">
                                <p className="text-xs">{item.description}</p>
                            </TooltipContent>
                        </Tooltip>
                    </TooltipProvider>
                </div>
                <p className="text-[11px] text-muted-foreground leading-tight">{item.description}</p>
                <div className="mt-auto pt-1">
                    {renderSettingInput(item)}
                </div>
            </div>
        );
    };

    return (
        <div className="p-8 space-y-8 max-w-5xl mx-auto">
            {/* Header — sticky so Save is always accessible */}
            <div className="flex items-end justify-between sticky top-0 z-20 bg-background/80 backdrop-blur-md py-4 -mt-4 border-b border-border/40">
                <div>
                    <h2 className="text-3xl font-bold tracking-tight">Settings</h2>
                    <p className="text-muted-foreground mt-1">
                        Runtime configuration — changes take effect immediately
                    </p>
                </div>
                <div className="flex gap-3">
                    <Button variant="outline" onClick={handleResetAll} size="sm">
                        <RotateCcw className="h-4 w-4 mr-1.5" />
                        Reset All
                    </Button>
                    <Button onClick={handleSave} disabled={isSaving || changedKeys.length === 0} size="sm"
                        className="bg-primary hover:bg-primary/90">
                        <Save className="h-4 w-4 mr-1.5" />
                        {isSaving ? "Saving..." : changedKeys.length > 0 ? `Save ${changedKeys.length} Change${changedKeys.length > 1 ? 's' : ''}` : "Save Changes"}
                    </Button>
                </div>
            </div>

            {/* API Keys Section */}
            <div className="space-y-4">
                <div className="flex items-center gap-3 pb-2 border-b">
                    <Key className="h-5 w-5 text-primary" />
                    <div>
                        <h3 className="text-lg font-semibold">Authentication</h3>
                        <p className="text-xs text-muted-foreground">API keys for agents connecting to this server</p>
                    </div>
                </div>

                <div className="grid gap-4 md:grid-cols-2">
                    <Card className="border-border/40">
                        <CardHeader className="pb-2">
                            <CardTitle className="flex items-center justify-between text-base">
                                <div className="flex items-center gap-2"><span>👑</span> Master Key</div>
                                <Badge variant="outline" className="text-[10px] bg-green-500/10 text-green-500 border-green-500/20">Active</Badge>
                            </CardTitle>
                            <CardDescription className="text-xs">MEMOLO_MASTER_KEY environment variable</CardDescription>
                        </CardHeader>
                        <CardContent className="text-xs text-muted-foreground pb-3">
                            Full admin access to all endpoints and configurations.
                        </CardContent>
                        <CardFooter className="bg-muted/30 p-3 border-t text-xs text-muted-foreground">
                            <Lock className="h-3 w-3 mr-1.5" /> Set via environment variable — cannot be changed at runtime.
                        </CardFooter>
                    </Card>

                    <Card className="border-border/40">
                        <CardHeader className="pb-2">
                            <CardTitle className="flex items-center justify-between text-base">
                                <div className="flex items-center gap-2"><span>🤖</span> Agent Keys</div>
                                <Badge variant="secondary" className="text-[10px]">{agentCount} registered</Badge>
                            </CardTitle>
                            <CardDescription className="text-xs">Per-agent keys generated on registration</CardDescription>
                        </CardHeader>
                        <CardContent className="text-xs text-muted-foreground pb-3">
                            Manage individual agent access in the Agents tab.
                        </CardContent>
                    </Card>
                </div>
            </div>

            {/* Dynamic Settings Groups */}
            {Object.keys(groupedConfig).length === 0 ? (
                <Card>
                    <CardContent className="flex items-center justify-center p-12 text-muted-foreground">
                        <div className="text-center space-y-2">
                            <div className="text-2xl animate-spin-slow">⚙️</div>
                            <span className="text-sm">Loading configuration...</span>
                        </div>
                    </CardContent>
                </Card>
            ) : (
                orderedGroups.map(group => {
                    const items = groupedConfig[group];
                    const meta = GROUP_META[group] || { icon: '⚙️', subtitle: '' };
                    const columns = meta.columns || 1;
                    const textareaItems = items.filter((i: any) => i.type === 'textarea');
                    const gridItems = items.filter((i: any) => i.type !== 'textarea');

                    return (
                        <Card key={group} className="border-border/40 overflow-hidden">
                            <CardHeader className="pb-4 bg-muted/20 border-b border-border/30">
                                <div className="flex items-center gap-3">
                                    <span className="text-xl">{meta.icon}</span>
                                    <div>
                                        <CardTitle className="text-lg">{group}</CardTitle>
                                        <CardDescription className="text-xs mt-0.5">{meta.subtitle}</CardDescription>
                                    </div>
                                </div>
                            </CardHeader>
                            <CardContent className="pt-5 pb-4">
                                {/* Grid items */}
                                {gridItems.length > 0 && (
                                    <div className={`grid gap-3 ${columns === 2 ? 'md:grid-cols-2' : ''}`}>
                                        {gridItems.map((item: any) => renderSettingItem(item, false))}
                                    </div>
                                )}
                                {/* Full-width textarea items */}
                                {textareaItems.length > 0 && (
                                    <div className={gridItems.length > 0 ? 'mt-4 pt-4 border-t border-border/30' : ''}>
                                        {textareaItems.map((item: any) => renderSettingItem(item, true))}
                                    </div>
                                )}
                            </CardContent>
                        </Card>
                    );
                })
            )}
        </div>
    );
}
