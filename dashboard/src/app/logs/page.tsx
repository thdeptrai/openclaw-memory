"use client";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Terminal } from "lucide-react";
import { useMemoloStream, LogLevel } from "@/components/providers/stream-provider";
import { useState } from "react";
import { format } from "date-fns";

export default function Logs() {
    const { logs, clearLogs } = useMemoloStream();
    const [filter, setFilter] = useState<string>("all");

    const filteredLogs = logs.filter(log => filter === "all" || log.level === filter);

    const getBadgeVariant = (level: LogLevel) => {
        switch (level) {
            case "error": return "destructive";
            case "warn": return "secondary"; // Will add custom amber class inline
            case "info": return "secondary"; // Will add custom blue class inline
            default: return "outline";
        }
    };

    const getBadgeClass = (level: LogLevel) => {
        switch (level) {
            case "warn": return "bg-amber-500/10 text-amber-500 hover:bg-amber-500/20";
            case "info": return "bg-blue-500/10 text-blue-500 hover:bg-blue-500/20";
            case "error": return "";
            default: return "";
        }
    };
    return (
        <div className="p-8 space-y-6 max-w-[1400px] mx-auto h-[100vh] flex flex-col">
            <div>
                <h2 className="text-3xl font-bold tracking-tight">Server Logs</h2>
                <p className="text-muted-foreground">
                    Real-time server logs with source tags
                </p>
            </div>

            <Card className="flex-1 flex flex-col min-h-0">
                <CardHeader className="flex flex-row items-center justify-between py-4 border-b">
                    <CardTitle className="flex items-center gap-2">
                        <Terminal className="h-5 w-5" /> Full Logs
                    </CardTitle>
                    <div className="flex items-center gap-4">
                        <Button variant="outline" size="sm" onClick={clearLogs}>Clear</Button>
                        <Tabs value={filter} onValueChange={setFilter} className="w-[300px]">
                            <TabsList className="grid w-full grid-cols-4 h-9">
                                <TabsTrigger value="all" className="text-xs">All</TabsTrigger>
                                <TabsTrigger value="info" className="text-xs">Info</TabsTrigger>
                                <TabsTrigger value="warn" className="text-xs">Warn</TabsTrigger>
                                <TabsTrigger value="error" className="text-xs">Error</TabsTrigger>
                            </TabsList>
                        </Tabs>
                    </div>
                </CardHeader>
                <CardContent className="flex-1 p-0 overflow-hidden bg-muted/20">
                    <ScrollArea className="h-full p-4 font-mono text-sm max-h-[80vh]">
                        {logs.length === 0 ? (
                            <div className="flex items-center justify-center h-full text-muted-foreground my-10">
                                Connecting to log stream... Waiting for logs.
                            </div>
                        ) : filteredLogs.length === 0 ? (
                            <div className="flex items-center justify-center h-full text-muted-foreground my-10">
                                No logs matching the current filter.
                            </div>
                        ) : (
                            <div className="space-y-1">
                                {filteredLogs.map((log, index) => (
                                    <div key={index} className="flex items-start gap-4 py-2 border-b border-border/40 hover:bg-muted/50 transition-colors px-2 rounded">
                                        <span className="text-xs text-muted-foreground shrink-0 w-[160px]">
                                            {format(new Date(log.timestamp), "yyyy-MM-dd HH:mm:ss.SSS")}
                                        </span>
                                        <Badge variant={getBadgeVariant(log.level)} className={`shrink-0 w-[60px] justify-center ${getBadgeClass(log.level)} uppercase`}>
                                            {log.level}
                                        </Badge>
                                        <Badge variant="outline" className="shrink-0 w-[80px] justify-center truncate">
                                            {log.source || "SYSTEM"}
                                        </Badge>
                                        <span className={`text-foreground flex-1 break-all ${log.level === 'error' ? 'text-red-400' : ''}`}>
                                            {log.message}
                                        </span>
                                    </div>
                                ))}
                            </div>
                        )}
                    </ScrollArea>
                </CardContent>
            </Card>
        </div>
    );
}
