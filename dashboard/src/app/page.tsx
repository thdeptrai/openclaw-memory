"use client";

import { MessageSquare, Brain, Bot, HeartPulse, Zap, Database, Wifi, WifiOff, ArrowRight } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Separator } from "@/components/ui/separator";
import { Tooltip, TooltipContent, TooltipTrigger, TooltipProvider } from "@/components/ui/tooltip";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useMemoloStream } from "@/components/providers/stream-provider";
import { formatDistanceToNow } from "date-fns";
import useSWR from "swr";
import { fetcher } from "@/lib/api";
import Link from "next/link";

export default function Dashboard() {
  const { stats, activities, status, clearActivities } = useMemoloStream();
  const { data: agentsRes } = useSWR<{ success: boolean; data: any[] }>("/api/memory/agents", fetcher, { refreshInterval: 10000 });
  const { data: exchangesRes } = useSWR<{ success: boolean; data: any[] }>("/api/memory/exchanges?limit=6", fetcher, { refreshInterval: 10000 });
  const { data: memoriesRes } = useSWR<{ success: boolean; data: any[] }>("/api/memory/memories?limit=6", fetcher, { refreshInterval: 10000 });
  const { data: healthRes } = useSWR<{ status: string; checks: Record<string, string> }>("/api/health", fetcher, { refreshInterval: 15000 });

  const agents = agentsRes?.data || [];
  const exchanges = exchangesRes?.data || [];
  const memories = memoriesRes?.data || [];
  const checks = healthRes?.checks || {};

  return (
    <TooltipProvider>
      <div className="p-8 space-y-8 max-w-5xl mx-auto">
        {/* Header — same style as Settings/Memories */}
        <div className="flex items-end justify-between">
          <div>
            <h2 className="text-3xl font-bold tracking-tight">Dashboard</h2>
            <p className="text-muted-foreground">System overview — real-time updates via SSE</p>
          </div>
          <div className="flex items-center gap-2 text-xs">
            {status.sse === "connected" ? (
              <span className="flex items-center gap-1.5 text-green-500">
                <Wifi className="h-3.5 w-3.5" /> Connected
              </span>
            ) : (
              <span className="flex items-center gap-1.5 text-red-500">
                <WifiOff className="h-3.5 w-3.5" /> {status.sse}
              </span>
            )}
          </div>
        </div>

        {/* Stats + Health — 4 stat cards + health card */}
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
          <Card>
            <CardHeader className="flex flex-row items-center justify-between pb-2">
              <CardDescription className="text-xs uppercase tracking-wide">Exchanges</CardDescription>
              <MessageSquare className="h-4 w-4 text-blue-500" />
            </CardHeader>
            <CardContent>
              <p className="text-2xl font-bold font-mono">{stats?.totalExchanges ?? exchanges.length}</p>
              <p className="text-[11px] text-muted-foreground mt-1">
                {stats?.totalConversations ?? 0} conversations
              </p>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="flex flex-row items-center justify-between pb-2">
              <CardDescription className="text-xs uppercase tracking-wide">Memories</CardDescription>
              <Brain className="h-4 w-4 text-purple-500" />
            </CardHeader>
            <CardContent>
              <p className="text-2xl font-bold font-mono">{stats?.activeMemories ?? memories.length}</p>
              <p className="text-[11px] text-muted-foreground mt-1">
                {stats?.supersededMemories ?? 0} superseded
              </p>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="flex flex-row items-center justify-between pb-2">
              <CardDescription className="text-xs uppercase tracking-wide">Agents</CardDescription>
              <Bot className="h-4 w-4 text-orange-500" />
            </CardHeader>
            <CardContent>
              <p className="text-2xl font-bold font-mono">{stats?.registeredAgents ?? agents.length}</p>
              <p className="text-[11px] text-muted-foreground mt-1">
                {agents.length > 0 ? agents.map((a: any) => a.name || a.id).join(", ") : "No agents"}
              </p>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="flex flex-row items-center justify-between pb-2">
              <CardDescription className="text-xs uppercase tracking-wide">Health</CardDescription>
              <HeartPulse className={`h-4 w-4 ${status.health === "ok" ? "text-green-500" : "text-red-500"}`} />
            </CardHeader>
            <CardContent>
              <div className="flex flex-col gap-1.5">
                <ServiceDot name="PostgreSQL" status={checks.postgres} />
                <ServiceDot name="Qdrant" status={checks.qdrant} />
                <ServiceDot name="Ollama" status={checks.ollama} />
              </div>
            </CardContent>
          </Card>
        </div>

        {/* Activity Feed — full width */}
        <Card>
          <CardHeader className="flex flex-row items-center justify-between">
            <div className="flex items-center gap-2">
              <Zap className="h-4 w-4 text-amber-500" />
              <CardTitle className="text-base">Activity Feed</CardTitle>
              <Badge variant="destructive" className="h-4 px-1.5 text-[9px] animate-pulse">LIVE</Badge>
            </div>
            <Button variant="ghost" size="sm" className="text-xs h-7" onClick={clearActivities}>Clear</Button>
          </CardHeader>
          <Separator />
          <CardContent className="p-0">
            <ScrollArea className="h-[280px]">
              {activities.length === 0 ? (
                <div className="text-sm text-muted-foreground flex items-center justify-center h-full py-16">
                  Waiting for activity...
                </div>
              ) : (
                <div className="divide-y">
                  {activities.map((item) => (
                    <div key={item.id} className="flex items-start gap-3 px-6 py-3 hover:bg-muted/50 transition-colors">
                      <span className="text-base mt-0.5 shrink-0">{item.icon}</span>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2">
                          <span className="text-sm font-medium">{item.title}</span>
                          <Badge variant="secondary" className="text-[9px] px-1.5 h-4">{item.source}</Badge>
                        </div>
                        <p className="text-xs text-muted-foreground truncate mt-0.5">{item.description}</p>
                      </div>
                      <span className="text-[10px] text-muted-foreground shrink-0 whitespace-nowrap">
                        {formatDistanceToNow(item.timestamp, { addSuffix: true })}
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </ScrollArea>
          </CardContent>
        </Card>

        {/* Agents + Recent Exchanges — side by side */}
        <div className="grid gap-4 lg:grid-cols-2">
          {/* Agents */}
          <Card>
            <CardHeader className="flex flex-row items-center justify-between">
              <div className="flex items-center gap-2">
                <Bot className="h-4 w-4 text-muted-foreground" />
                <CardTitle className="text-base">Agents</CardTitle>
                <span className="text-xs text-muted-foreground">({agents.length})</span>
              </div>
              <Button variant="ghost" size="sm" className="text-xs h-7" asChild>
                <Link href="/agents">View all <ArrowRight className="h-3 w-3 ml-1" /></Link>
              </Button>
            </CardHeader>
            <Separator />
            <CardContent className="p-0">
              <ScrollArea className="h-[240px]">
                {agents.length === 0 ? (
                  <div className="text-sm text-muted-foreground flex items-center justify-center h-full py-12">
                    No agents registered
                  </div>
                ) : (
                  <div className="divide-y">
                    {agents.map((agent: any) => (
                      <div key={agent.id} className="flex items-center gap-3 px-6 py-3 hover:bg-muted/50 transition-colors">
                        <Avatar className="h-8 w-8">
                          <AvatarFallback className="bg-gradient-to-br from-indigo-500 to-purple-600 text-white text-xs font-bold">
                            {(agent.name || agent.id).charAt(0).toUpperCase()}
                          </AvatarFallback>
                        </Avatar>
                        <div className="flex-1 min-w-0">
                          <p className="text-sm font-medium truncate">{agent.name || agent.id}</p>
                          <p className="text-[11px] text-muted-foreground">{agent.id}</p>
                        </div>
                        <div className="flex items-center gap-3 text-xs text-muted-foreground">
                          <Tooltip>
                            <TooltipTrigger className="flex items-center gap-1">
                              <MessageSquare className="h-3 w-3" /> {agent.conversation_count || 0}
                            </TooltipTrigger>
                            <TooltipContent>Conversations</TooltipContent>
                          </Tooltip>
                          <Tooltip>
                            <TooltipTrigger className="flex items-center gap-1">
                              <Database className="h-3 w-3" /> {agent.exchange_count || 0}
                            </TooltipTrigger>
                            <TooltipContent>Exchanges</TooltipContent>
                          </Tooltip>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </ScrollArea>
            </CardContent>
          </Card>

          {/* Recent Exchanges */}
          <Card>
            <CardHeader className="flex flex-row items-center justify-between">
              <div className="flex items-center gap-2">
                <MessageSquare className="h-4 w-4 text-muted-foreground" />
                <CardTitle className="text-base">Recent Exchanges</CardTitle>
              </div>
              <Button variant="ghost" size="sm" className="text-xs h-7" asChild>
                <Link href="/conversations">View all <ArrowRight className="h-3 w-3 ml-1" /></Link>
              </Button>
            </CardHeader>
            <Separator />
            <CardContent className="p-0">
              <ScrollArea className="h-[240px]">
                {exchanges.length === 0 ? (
                  <div className="text-sm text-muted-foreground flex items-center justify-center h-full py-12">
                    No exchanges yet
                  </div>
                ) : (
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead className="w-[40px]">#</TableHead>
                        <TableHead>Message</TableHead>
                        <TableHead className="text-right w-[90px]">Time</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {exchanges.map((ex: any) => (
                        <TableRow key={ex.id}>
                          <TableCell className="font-mono text-xs text-muted-foreground">
                            {ex.sequence_num || "—"}
                          </TableCell>
                          <TableCell>
                            <p className="text-sm truncate max-w-[300px]">{ex.user_message || "..."}</p>
                            <p className="text-xs text-muted-foreground truncate max-w-[300px]">
                              → {ex.agent_response?.substring(0, 80) || "..."}
                            </p>
                          </TableCell>
                          <TableCell className="text-right text-[11px] text-muted-foreground whitespace-nowrap">
                            {ex.created_at ? formatDistanceToNow(new Date(ex.created_at), { addSuffix: true }) : ""}
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                )}
              </ScrollArea>
            </CardContent>
          </Card>
        </div>

        {/* Recent Memories — full width */}
        <Card>
          <CardHeader className="flex flex-row items-center justify-between">
            <div className="flex items-center gap-2">
              <Brain className="h-4 w-4 text-muted-foreground" />
              <CardTitle className="text-base">Recent Memories</CardTitle>
            </div>
            <Button variant="ghost" size="sm" className="text-xs h-7" asChild>
              <Link href="/memories">View all <ArrowRight className="h-3 w-3 ml-1" /></Link>
            </Button>
          </CardHeader>
          <Separator />
          <CardContent className="p-0">
            <ScrollArea className="h-[240px]">
              {memories.length === 0 ? (
                <div className="text-sm text-muted-foreground flex items-center justify-center h-full py-12">
                  No memories extracted yet
                </div>
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead className="w-[80px]">Type</TableHead>
                      <TableHead className="w-[80px]">Category</TableHead>
                      <TableHead>Content</TableHead>
                      <TableHead className="w-[80px]">Agent</TableHead>
                      <TableHead className="text-right w-[90px]">Time</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {memories.map((mem: any) => (
                      <TableRow key={mem.id}>
                        <TableCell>
                          <Badge
                            variant="outline"
                            className={`text-[9px] ${mem.type === "fact"
                              ? "text-emerald-500 border-emerald-500/30"
                              : mem.type === "decision"
                                ? "text-blue-500 border-blue-500/30"
                                : mem.type === "preference"
                                  ? "text-amber-500 border-amber-500/30"
                                  : "text-muted-foreground"
                              }`}
                          >
                            {mem.type?.toUpperCase() || "MEMORY"}
                          </Badge>
                        </TableCell>
                        <TableCell>
                          <Badge
                            variant="outline"
                            className={`text-[9px] ${(mem.memory_type || 'knowledge') === 'profile' ? 'text-pink-500 border-pink-500/30' :
                                (mem.memory_type || 'knowledge') === 'event' ? 'text-cyan-500 border-cyan-500/30' :
                                  (mem.memory_type || 'knowledge') === 'behavior' ? 'text-amber-500 border-amber-500/30' :
                                    'text-emerald-500 border-emerald-500/30'
                              }`}
                          >
                            {(mem.memory_type || 'knowledge').toUpperCase()}
                          </Badge>
                        </TableCell>
                        <TableCell>
                          <p className="text-sm line-clamp-1">{mem.content || "..."}</p>
                          {mem.topic && mem.topic !== "general" && (
                            <span className="text-[10px] text-muted-foreground">📁 {mem.topic}</span>
                          )}
                        </TableCell>
                        <TableCell className="text-xs text-muted-foreground">
                          {mem.source_agent_id || "—"}
                        </TableCell>
                        <TableCell className="text-right text-[11px] text-muted-foreground whitespace-nowrap">
                          {mem.created_at ? formatDistanceToNow(new Date(mem.created_at), { addSuffix: true }) : ""}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </ScrollArea>
          </CardContent>
        </Card>
      </div>
    </TooltipProvider>
  );
}

/* ---------- Sub-components ---------- */

function ServiceDot({ name, status }: { name: string; status?: string }) {
  const isOk = status === "ok";
  return (
    <div className="flex items-center gap-1.5">
      <span className={`h-1.5 w-1.5 rounded-full ${isOk ? "bg-green-500" : "bg-red-500"}`} />
      <span className={`text-xs ${isOk ? "text-muted-foreground" : "text-red-500"}`}>{name}</span>
      {!isOk && status && <span className="text-[10px] text-red-400">({status})</span>}
    </div>
  );
}
