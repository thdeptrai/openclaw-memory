import {
    LayoutDashboard,
    MessageSquare,
    Bot,
    Database,
    ListOrdered,
    RefreshCw,
    Settings,
    Network,
} from "lucide-react";

export const navigation = [
    { name: "Dashboard", href: "/", icon: LayoutDashboard },
    { name: "Conversations", href: "/conversations", icon: MessageSquare, badgeId: "nav-conv-count" },
    { name: "Agents", href: "/agents", icon: Bot, badgeId: "nav-agent-count" },
    { name: "Memories", href: "/memories", icon: Database, badgeId: "nav-memory-count" },
    { name: "Knowledge Graph", href: "/graph", icon: Network },
    { name: "Live Logs", href: "/logs", icon: ListOrdered, badgeId: "nav-log-count" },
    { name: "Recall Test", href: "/recall", icon: RefreshCw },
    { name: "Settings", href: "/settings", icon: Settings },
];
