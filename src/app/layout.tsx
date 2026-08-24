import type { Metadata } from "next";
import { Inter } from "next/font/google";
import Link from "next/link";
import "./globals.css";
import { ThemeToggle } from "@/components/theme-toggle";
import { MobileNav } from "@/components/mobile-nav";
import { AuthControls } from "@/components/auth-controls";
import { GitHubLink } from "@/components/github-link";
import { getVersionLabel } from "@/lib/version";

const inter = Inter({ subsets: ["latin"] });

export const metadata: Metadata = {
  title: "Dispatch",
  description: "Kanban for AI agent work",
  icons: {
    icon: [
      { url: "/images/favicon-16.png", sizes: "16x16", type: "image/png" },
      { url: "/images/favicon-32.png", sizes: "32x32", type: "image/png" },
    ],
    apple: "/images/apple-touch-icon.png",
  },
};

// The CSP sets `script-src 'self' 'nonce-<per-request>'` (see
// src/middleware.ts). The nonce is stamped onto the App Router's inline RSC
// flight scripts at *render* time, so a page prerendered at build time ships
// with flight scripts that carry no nonce and are blocked by its own CSP —
// hydration fails and the page renders as inert static HTML (this is why
// the grooming page "will not load", dispatch#841). Forcing dynamic
// rendering makes every page render per request, so every page's flight
// scripts carry the nonce for that request.
export const dynamic = "force-dynamic";

export default function RootLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <link rel="icon" href="/images/favicon-16.png" sizes="16x16" type="image/png" />
        <link rel="icon" href="/images/favicon-32.png" sizes="32x32" type="image/png" />
        <link rel="apple-touch-icon" href="/images/apple-touch-icon.png" />
        <meta name="theme-color" content="#000000" />
        {/*
          Theme initialiser, loaded from a static file rather than inline: the
          CSP sets `script-src 'self'` with no 'unsafe-inline' (tightened in
          #829), so an inline script here is blocked and dark mode never
          applies (dispatch#841). A classic <head> script is render-blocking,
          so it still runs before first paint. See public/theme-init.js.
          Synchronous on purpose: async/defer would let the page paint before
          the theme is known (dispatch#841).
        */}
        {/* eslint-disable-next-line @next/next/no-sync-scripts -- render-blocking by design: the theme class must be applied before first paint (dispatch#841); see public/theme-init.js */}
        <script src="/theme-init.js" />
      </head>
      <body className={`${inter.className} bg-background text-foreground`}>
        <div className="min-h-screen flex flex-col bg-background">
          <header className="border-b bg-card">
            <div className="mx-auto w-full max-w-screen-2xl px-4 sm:px-6 lg:px-8 flex items-center gap-6 py-4">
              <Link href="/" className="flex items-center gap-3 shrink-0">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src="/images/logo.png"
                  alt="Dispatch"
                  width={28}
                  height={28}
                  className="shrink-0"
                  aria-label="Dispatch"
                />
                <span className="font-bold text-lg">Dispatch</span>
              </Link>

              {/* Desktop navigation */}
              <nav className="hidden sm:flex gap-4 text-sm">
                <Link href="/" className="text-muted-foreground hover:text-foreground">
                  Overview
                </Link>
                <Link href="/board" className="text-muted-foreground hover:text-foreground">
                  Board
                </Link>
                <Link href="/projects" className="text-muted-foreground hover:text-foreground">
                  Projects
                </Link>
                <Link href="/agents" className="text-muted-foreground hover:text-foreground">
                  Agents
                </Link>
                <Link href="/automation" className="text-muted-foreground hover:text-foreground">
                  Automation
                </Link>
                <Link href="/groomer" className="text-muted-foreground hover:text-foreground">
                  Groomer
                </Link>
              </nav>

              {/* Mobile menu button */}
              <MobileNav />

              <span className="text-xs text-muted-foreground/60 shrink-0">{getVersionLabel()}</span>
              <div className="ml-auto shrink-0 flex items-center gap-2">
                <AuthControls />
                <GitHubLink />
                <ThemeToggle />
              </div>
            </div>
          </header>
          <main className="flex-1 mx-auto w-full max-w-screen-2xl px-4 sm:px-6 lg:px-8 py-6">{children}</main>
        </div>
      </body>
    </html>
  );
}
