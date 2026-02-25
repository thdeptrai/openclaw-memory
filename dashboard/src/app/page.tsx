"use client";

import { MessageSquare, Brain, Bot, HeartPulse } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Input } from "@/components/ui/input";
import { useMemoloStream } from "@/components/providers/stream-provider";
import { formatDistanceToNow } from "date-fns";
import useSWR from "swr";
import { fetcher } from "@/lib/api";

export default function Dashboard() {
  const { stats, activities, status, clearActivities } = useMemoloStream();
  const { data: agentsRes } = useSWR<{ success: boolean, data: any[] }>("/api/memory/agents", fetcher, { refreshInterval: 10000 });
  const { data: memoriesRes } = useSWR<{ success: boolean, data: any[] }>("/api/memory/exchanges?limit=10", fetcher, { refreshInterval: 10000 });

  const agents = agentsRes?.data || [];
  const memories = memoriesRes?.data || [];
  return (
    <div className="p-8 space-y-8">
      <div>
        <h2 className="text-3xl font-bold tracking-tight">Dashboard</h2>
        <p className="text-muted-foreground">
          System overview — real-time updates via SSE
        </p>
      </div>

      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
        {/* Stats Cards */}
        <Card className="hover:shadow-lg hover:-translate-y-1 transition-all">
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground uppercase">
              Total Exchanges
            </CardTitle>
            <div className="p-2 bg-blue-500/10 rounded-xl">
              <MessageSquare className="h-5 w-5 text-blue-500" />
            </div>
          </CardHeader>
          <CardContent>
            <div className="text-3xl font-bold font-mono">{stats?.totalExchanges || "-"}</div>
            <p className="text-xs text-muted-foreground mt-1">
              User ↔ Agent conversations stored
            </p>
          </CardContent>
        </Card>

        <Card className="hover:shadow-lg hover:-translate-y-1 transition-all">
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground uppercase">
              Active Memories
            </CardTitle>
            <div className="p-2 bg-purple-500/10 rounded-xl">
              <Brain className="h-5 w-5 text-purple-500" />
            </div>
          </CardHeader>
          <CardContent>
            <div className="text-3xl font-bold font-mono">{stats?.activeMemories || "-"}</div>
            <p className="text-xs text-muted-foreground mt-1">
              Facts, decisions & preferences extracted
            </p>
          </CardContent>
        </Card>

        <Card className="hover:shadow-lg hover:-translate-y-1 transition-all">
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground uppercase">
              Registered Agents
            </CardTitle>
            <div className="p-2 bg-orange-500/10 rounded-xl">
              <Bot className="h-5 w-5 text-orange-500" />
            </div>
          </CardHeader>
          <CardContent>
            <div className="text-3xl font-bold font-mono">{stats?.registeredAgents || "-"}</div>
            <p className="text-xs text-muted-foreground mt-1">
              AI agents connected to Memolo
            </p>
          </CardContent>
        </Card>

        <Card className="hover:shadow-lg hover:-translate-y-1 transition-all border-green-500/20">
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground uppercase">
              System Health
            </CardTitle>
            <div className={`p-2 rounded-xl bg-${status.health === 'ok' ? 'green' : 'red'}-500/10`}>
              <HeartPulse className={`h-5 w-5 text-${status.health === 'ok' ? 'green' : 'red'}-500`} />
            </div>
          </CardHeader>
          <CardContent>
            <div className={`text-3xl font-bold text-${status.health === 'ok' ? 'green' : 'red'}-500`}>
              {status.health === 'checking' ? '...' : status.health === 'ok' ? 'OK' : 'ERR'}
            </div>
            <p className="text-xs text-muted-foreground mt-1">
              PostgreSQL · Qdrant · MiniMax · Ollama
            </p>
          </CardContent>
        </Card>
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        <Card className="col-span-2">
          <CardHeader className="flex flex-row items-center justify-between">
            <div className="flex items-center gap-2">
              <CardTitle>⚡ Activity Feed</CardTitle>
              <Badge variant="destructive" className="animate-pulse text-[9px] uppercase tracking-wider relative">
                LIVE
              </Badge>
            </div>
            <div className="space-x-2">
              <button onClick={clearActivities} className="text-xs text-muted-foreground hover:text-foreground">Clear</button>
            </div>
          </CardHeader>
          <CardContent>
            <ScrollArea className="h-[250px] w-full rounded-md border p-4">
              {activities.length === 0 ? (
                <div className="text-sm text-muted-foreground flex items-center justify-center h-full">
                  <span className="mr-2">⚡</span> Waiting for activity...
                </div>
              ) : (
                <div className="space-y-4">
                  {activities.map((item) => (
                    <div key={item.id} className="flex items-start gap-4">
                      <span className="text-xl shrink-0">{item.icon}</span>
                      <div className="flex-1 space-y-1">
                        <p className="text-sm font-medium leading-none">{item.title}</p>
                        <p className="text-xs text-muted-foreground">{item.description}</p>
                      </div>
                      <div className="flex flex-col items-end gap-1 shrink-0">
                        <span className="text-[10px] text-muted-foreground">
                          {formatDistanceToNow(item.timestamp, { addSuffix: true })}
                        </span>
                        {item.source && (
                          <Badge variant="secondary" className="text-[9px] uppercase tracking-wider">{item.source}</Badge>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </ScrollArea>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <span>🤖</span> Agents <span className="text-sm text-muted-foreground font-normal">({agents.length})</span>
            </CardTitle>
          </CardHeader>
          <CardContent>
            <ScrollArea className="h-[250px]">
              {agents.length === 0 ? (
                <div className="text-sm text-muted-foreground flex items-center justify-center h-full">
                  No agents found.
                </div>
              ) : (
                <div className="space-y-4 pr-4">
                  {agents.map((agent: any) => (
                    <div key={agent.id} className="flex flex-col gap-1 border-b pb-2">
                      <div className="flex items-center justify-between">
                        <span className="font-semibold">{agent.name || agent.id}</span>
                        <span className="text-xs text-muted-foreground">{agent.id}</span>
                      </div>
                      <div className="flex gap-2 text-xs text-muted-foreground">
                        <span title="Conversations">💬 {agent.conversation_count || agent.conversations || 0}</span>
                        <span title="Exchanges">📝 {agent.exchange_count || agent.exchanges || 0}</span>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </ScrollArea>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between">
            <CardTitle className="flex items-center gap-2"><span>💾</span> Recent Memories</CardTitle>
            <Input type="search" placeholder="Search memories..." className="w-[180px] h-8 text-xs" />
          </CardHeader>
          <CardContent>
            <ScrollArea className="h-[250px]">
              {memories.length === 0 ? (
                <div className="text-sm text-muted-foreground flex items-center justify-center h-full">
                  No recent memories...
                </div>
              ) : (
                <div className="space-y-3 pr-4">
                  {memories.map((mem: any) => (
                    <div key={mem.id} className="text-sm border rounded-md p-3 bg-muted/20">
                      <div className="flex items-center justify-between mb-1">
                        <Badge variant="outline" className={`text-[10px] ${mem.type === 'fact' ? 'text-green-500' : 'text-purple-500'}`}>
                          {mem.type ? mem.type.toUpperCase() : 'EXCHANGE'}
                        </Badge>
                        <span className="text-xs text-muted-foreground">{formatDistanceToNow(new Date(mem.created_at || mem.createdAt), { addSuffix: true })}</span>
                      </div>
                      <p className="line-clamp-2 text-muted-foreground">
                        {mem.content || mem.user_message || '...'}
                      </p>
                    </div>
                  ))}
                </div>
              )}
            </ScrollArea>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
