"use client";

import { useState, useEffect } from "react";
import Link from "next/link";
import { ThemeToggle } from "./theme-toggle";
import { getVersionLabel } from "@/lib/version";

const navLinks = [
  { href: "/", label: "Overview" },
  { href: "/board", label: "Board" },
  { href: "/projects", label: "Projects" },
  { href: "/agents", label: "Agents" },
  { href: "/automation", label: "Automation" },
];

export function MobileNav() {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!open) return;
    function onHashChange() {
      setOpen(false);
    }
    window.addEventListener("hashchange", onHashChange);
    return () => window.removeEventListener("hashchange", onHashChange);
  }, [open]);

  function close() {
    setOpen(false);
  }

  return (
    <div className="sm:hidden">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-label="Toggle navigation menu"
        aria-expanded={open}
        className="flex items-center gap-1 text-muted-foreground hover:text-foreground cursor-pointer"
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
      </button>
      <nav
        className={`${
          open ? "block" : "hidden"
        } border-t py-3 px-4 flex flex-col gap-2 text-sm bg-card`}
      >
        {navLinks.map((link) => (
          <Link
            key={link.href}
            href={link.href}
            onClick={close}
            className="text-muted-foreground hover:text-foreground py-1"
          >
            {link.label}
          </Link>
        ))}
        <div className="pt-2 flex items-center justify-between border-t mt-1">
          <span className="text-xs text-muted-foreground/60">{getVersionLabel()}</span>
          <ThemeToggle />
        </div>
      </nav>
    </div>
  );
}
