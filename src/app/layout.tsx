import type { Metadata } from "next";
import { Inter } from "next/font/google";
import Link from "next/link";
import "./globals.css";
import { ThemeToggle } from "@/components/theme-toggle";
import { getVersionLabel } from "@/lib/version";

const inter = Inter({ subsets: ["latin"] });

export const metadata: Metadata = {
  title: "Dispatch",
  description: "Kanban for AI agent work",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
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
              <Link href="/" className="font-bold text-lg shrink-0">
                Dispatch
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

function MobileNav() {
  return (
    <>
      <input type="checkbox" id="mobile-nav-toggle" className="peer hidden" />
      <label
        htmlFor="mobile-nav-toggle"
        role="button"
        className="sm:hidden flex items-center gap-1 text-muted-foreground hover:text-foreground cursor-pointer"
        aria-label="Toggle navigation menu"
      >
        <svg
          xmlns="http://www.w3.org/2000/svg"
          width="20"
          height="20"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <line x1="4" x2="20" y1="12" y2="12" />
          <line x1="4" x2="20" y1="6" y2="6" />
          <line x1="4" x2="20" y1="18" y2="18" />
        </svg>
      </label>
      <nav className="sm:hidden hidden peer-checked:block border-t py-3 px-4 flex flex-col gap-2 text-sm bg-card">
        <Link href="/" className="text-muted-foreground hover:text-foreground py-1">
          Overview
        </Link>
        <Link href="/board" className="text-muted-foreground hover:text-foreground py-1">
          Board
        </Link>
        <Link href="/projects" className="text-muted-foreground hover:text-foreground py-1">
          Projects
        </Link>
        <Link href="/agents" className="text-muted-foreground hover:text-foreground py-1">
          Agents
        </Link>
        <Link href="/automation" className="text-muted-foreground hover:text-foreground py-1">
          Automation
        </Link>
      </nav>
    </>
  );
}
