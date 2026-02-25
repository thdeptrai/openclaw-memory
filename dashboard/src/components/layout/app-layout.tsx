import { Sidebar } from "./sidebar";

export function AppLayout({ children }: { children: React.ReactNode }) {
    return (
        <div className="flex min-h-screen">
            <Sidebar />
            <main className="flex-1 ml-64 bg-background">
                {children}
            </main>
        </div>
    );
}
