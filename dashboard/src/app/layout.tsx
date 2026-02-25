import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

import { ThemeProvider } from "@/components/theme-provider";
import { AppLayout } from "@/components/layout/app-layout";
import { StreamProvider } from "@/components/providers/stream-provider";
import { Toaster } from "@/components/ui/sonner";

export const metadata: Metadata = {
  title: "Memolo Dashboard",
  description: "Memolo — Shared Memory Dashboard for AI Agents",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body
        className={`${geistSans.variable} ${geistMono.variable} antialiased`}
      >
        <ThemeProvider
          attribute="class"
          defaultTheme="dark"
          enableSystem
          disableTransitionOnChange
        >
          <StreamProvider>
            <AppLayout>{children}</AppLayout>
            <Toaster position="bottom-right" />
          </StreamProvider>
        </ThemeProvider>
      </body>
    </html>
  );
}
