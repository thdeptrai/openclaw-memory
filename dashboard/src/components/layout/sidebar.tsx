"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Brain } from "lucide-react";

import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { ThemeToggle } from "@/components/theme-toggle";
import { Badge } from "@/components/ui/badge";
import { navigation } from "./navigation";
import { useMemoloStream } from "@/components/providers/stream-provider";

export function Sidebar() {
    const pathname = usePathname();
    const { status, stats, logs } = useMemoloStream();

    const counts: Record<string, number | string> = {
        "nav-conv-count": stats?.totalConversations || 0,
        "nav-agent-count": stats?.registeredAgents || 0,
        "nav-memory-count": stats?.activeMemories || 0,
        "nav-log-count": logs.length || 0,
    };

    return (
        <aside className="fixed inset-y-0 left-0 z-50 flex w-64 flex-col border-r bg-background/60 backdrop-blur-xl">
            <div className="flex h-16 items-center gap-2 border-b px-6">
                <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-gradient-to-br from-indigo-500 via-purple-500 to-pink-500 shadow-md">
                    <Brain className="h-5 w-5 text-white" />
                </div>
                <div className="flex flex-col">
                    <span className="font-bold tracking-tight bg-gradient-to-br from-indigo-500 via-purple-500 to-pink-500 text-transparent bg-clip-text leading-tight">
                        Memolo
                    </span>
                    <span className="text-[10px] text-muted-foreground leading-none">
                        Memory System v2.0
                    </span>
                </div>
            </div>

            <nav className="flex-1 space-y-1 p-4">
                {navigation.map((item) => {
                    const isActive = pathname === item.href;
                    return (
                        <Button
                            key={item.name}
                            variant={isActive ? "secondary" : "ghost"}
                            className={cn(
                                "w-full justify-start relative",
                                isActive && "bg-primary/10 text-primary font-semibold"
                            )}
                            asChild
                        >
                            <Link href={item.href}>
                                {isActive && (
                                    <span className="absolute left-0 top-1/2 -translate-y-1/2 w-1 h-6 bg-primary rounded-r-md" />
                                )}
                                <item.icon className={cn("mr-3 h-4 w-4", isActive ? "opacity-100" : "opacity-70")} />
                                {item.name}
                                {item.badgeId && (
                                    <Badge
                                        variant="secondary"
                                        className="ml-auto flex h-5 w-5 items-center justify-center rounded-full p-0 text-[10px]"
                                    >
                                        {counts[item.badgeId]}
                                    </Badge>
                                )}
                            </Link>
                        </Button>
                    );
                })}
            </nav>

            <div className="border-t p-4 flex flex-col gap-4">
                <div className="flex items-center justify-between">
                    <span className="text-sm text-muted-foreground">Theme</span>
                    <ThemeToggle />
                </div>
                <div className="flex flex-col gap-2 text-xs text-muted-foreground">
                    <div className="flex items-center gap-2">
                        <span className="relative flex h-2 w-2">
                            {status.health === "ok" && <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-green-400 opacity-75"></span>}
                            <span className={cn("relative inline-flex rounded-full h-2 w-2", status.health === "ok" ? "bg-green-500 shadow-[0_0_8px_rgba(34,197,94,0.6)]" : status.health === "checking" ? "bg-yellow-500" : "bg-red-500")}></span>
                        </span>
                        System Health: {status.health.toUpperCase()}
                    </div>
                    <div className="flex items-center gap-2">
                        <span className="relative flex h-2 w-2">
                            {status.sse === "connected" && <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-green-400 opacity-75"></span>}
                            <span className={cn("relative inline-flex rounded-full h-2 w-2", status.sse === "connected" ? "bg-green-500 shadow-[0_0_8px_rgba(34,197,94,0.6)]" : status.sse === "connecting" ? "bg-yellow-500" : "bg-red-500")}></span>
                        </span>
                        SSE: {status.sse.charAt(0).toUpperCase() + status.sse.slice(1)}
                    </div>
                </div>
            </div>
        </aside>
    );
}
