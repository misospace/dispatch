"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

/**
 * Client-side logout button for OIDC authentication mode.
 *
 * In OIDC mode, clears the session via the API and redirects to login.
 * In Basic Auth mode, this is a no-op since browsers manage credentials.
 */
export function LogoutButton({
  onLogout,
  className,
}: {
  onLogout?: () => void;
  className?: string;
}) {
  const router = useRouter();
  const [loading, setLoading] = useState(false);

  const handleLogout = async () => {
    setLoading(true);
    try {
      await fetch("/api/auth/logout", { method: "POST" });
      router.push("/login");
      router.refresh();
      onLogout?.();
    } catch {
      // If logout API fails, clear session and redirect anyway
      router.push("/login");
      router.refresh();
    } finally {
      setLoading(false);
    }
  };

  return (
    <button
      onClick={handleLogout}
      disabled={loading}
      className={className}
    >
      {loading ? "Signing out..." : "Sign out"}
    </button>
  );
}
