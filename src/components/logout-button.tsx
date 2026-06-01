"use client";

import { useRouter } from "next/navigation";
import { useState, useEffect } from "react";
import { signOut } from "next-auth/react";
import {
  clearBasicAuthCredentials,
  hasBasicAuthCredentials,
} from "@/lib/client-auth";

/**
 * Client-side logout button for both OIDC and Basic Auth modes.
 *
 * - OIDC mode: calls NextAuth signOut to clear session cookie
 * - Basic Auth mode: clears stored credentials from sessionStorage
 */
export function LogoutButton({ className }: { className?: string }) {
  const router = useRouter();
  const [loading, setLoading] = useState(false);
  const [hasCredentials, setHasCredentials] = useState(false);

  useEffect(() => {
    setHasCredentials(hasBasicAuthCredentials());
  }, []);

  const handleLogout = async () => {
    setLoading(true);
    try {
      if (hasCredentials) {
        clearBasicAuthCredentials();
      } else {
        await signOut({ redirect: false });
      }
      router.push("/login");
      router.refresh();
    } catch {
      // If logout fails, clear credentials anyway and redirect
      clearBasicAuthCredentials();
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
