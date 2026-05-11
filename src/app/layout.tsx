import type { Metadata } from "next";
import { Inter } from "next/font/google";
import Link from "next/link";
import "./globals.css";

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
    <html lang="en">
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
            </div>
          </header>
          <main className="flex-1 container py-6">{children}</main>
        </div>
      </body>
    </html>
  );
}