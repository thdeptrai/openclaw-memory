export const API_URL = typeof window !== 'undefined'
    ? (process.env.NEXT_PUBLIC_API_URL || "")
    : (process.env.NEXT_PUBLIC_INTERNAL_API_URL || "http://localhost:7437");

// SSE must connect directly to backend — Next.js rewrites buffer responses and break SSE streaming
export const SSE_URL = typeof window !== 'undefined'
    ? (process.env.NEXT_PUBLIC_SSE_URL || "http://localhost:7437")
    : "http://localhost:7437";

export async function fetcher<T>(url: string): Promise<T> {
    const res = await fetch(`${API_URL}${url}`);
    if (!res.ok) {
        const error = new Error("An error occurred while fetching the data.");
        // Attach extra info to the error object.
        const info = await res.json().catch(() => ({}));
        (error as any).info = info;
        (error as any).status = res.status;
        throw error;
    }
    return res.json();
}

export async function apiCall<T>(method: "GET" | "POST" | "PUT" | "DELETE", path: string, body?: any): Promise<T> {
    const opts: RequestInit = {
        method,
        headers: {
            "Content-Type": "application/json",
        },
    };
    if (body) {
        opts.body = JSON.stringify(body);
    }
    const res = await fetch(`${API_URL}${path}`, opts);
    return res.json();
}
