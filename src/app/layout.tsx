import type { Metadata } from "next";
import { Inter } from "next/font/google";
import Link from "next/link";
import "./globals.css";
import { ThemeToggle } from "@/components/theme-toggle";
import { MobileNav } from "@/components/mobile-nav";
import { getVersionLabel } from "@/lib/version";

const inter = Inter({ subsets: ["latin"] });

export const metadata: Metadata = {
  title: "Dispatch",
  description: "Kanban for AI agent work",
  icons: {
    icon: [
      { url: "/images/favicon-16.png", sizes="16x16", type="image/png" },
      { url: "/images/favicon-32.png", sizes="32x32", type="image/png" },
    ],
    apple: "/images/apple-touch-icon.png",
  },
};

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
        <script dangerouslySetInnerHTML={{ __html: `
          (function() {
            var theme = localStorage.getItem('dispatch-theme');
            if (theme === 'dark' || (!theme && window.matchMedia('(prefers-color-scheme: dark)').matches)) {
              document.documentElement.classList.add('dark');
            }
          })();
        `}} />
      </head>
      <body className={`${inter.className} bg-background text-foreground`}>
        <div className="min-h-screen flex flex-col bg-background">
          <header className="border-b bg-card">
            <div className="mx-auto w-full max-w-screen-2xl px-4 sm:px-6 lg:px-8 flex items-center gap-6 py-4">
              <Link href="/" className="flex items-center gap-3 shrink-0">
                <svg
                  xmlns="http://www.w3.org/2000/svg"
                  width={28}
                  height={28}
                  viewBox="0 0 28 28"
                  fill="none"
                  className="shrink-0"
                  aria-label="Dispatch"
                >
                  <rect width="28" height="28" rx="6" fill="hsl(var(--primary))" />
                  <path d="M8 14L12 18L20 10" stroke="white" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
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
              </nav>

              {/* Mobile menu button */}
              <MobileNav />

              <span className="text-xs text-muted-foreground/60 shrink-0">{getVersionLabel()}</span>
              <div className="ml-auto shrink-0">
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
