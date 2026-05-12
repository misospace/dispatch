import type { Metadata } from "next";
import { Inter } from "next/font/google";
import Link from "next/link";
import "./globals.css";
import { ThemeToggle } from "@/components/theme-toggle";

const inter = Inter({ subsets: ["latin"] });

export const metadata: Metadata = {
  title: "Mission Control",
  description: "OpenClaw Mission Control Dashboard",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: `
          (function() {
            var theme = localStorage.getItem('mission-control-theme');
            if (theme === 'dark' || (!theme && window.matchMedia('(prefers-color-scheme: dark)').matches)) {
              document.documentElement.classList.add('dark');
            }
          })();
        `}} />
      </head>
      <body className={inter.className}>
        <div className="min-h-screen flex flex-col">
          <header className="border-b">
            <div className="container flex items-center gap-6 py-4">
              <Link href="/" className="font-bold text-lg">
                Mission Control
              </Link>
              <nav className="flex gap-4 text-sm">
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
              <div className="ml-auto">
                <ThemeToggle />
              </div>
            </div>
          </header>
          <main className="flex-1 container py-6">{children}</main>
        </div>
      </body>
    </html>
  );
}