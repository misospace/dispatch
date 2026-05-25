/**
 * Client-side auth helper for Dispatch browser UI.
 *
 * When DISPATCH_AUTH_MODE="basic", all fetch calls to Dispatch API routes
 * must include an `Authorization: Basic ...` header with the operator's
 * credentials.
 *
 * This module provides a hook that reads credentials from sessionStorage
 * (set by a login prompt) and attaches them to every outgoing request.
 */

import { useState, useEffect, useCallback } from "react";

const AUTH_SESSION_KEY = "dispatch-auth-credentials";

/**
 * Encode username:password as Base64 for the Basic Auth header.
 */
function encodeBasicAuth(username: string, password: string): string {
  return btoa(`${username}:${password}`);
}

/**
 * Store Basic Auth credentials in sessionStorage.
 */
export function storeBasicAuthCredentials(username: string, password: string): void {
  const encoded = encodeBasicAuth(username, password);
  sessionStorage.setItem(AUTH_SESSION_KEY, encoded);
}

/**
 * Clear stored Basic Auth credentials from sessionStorage.
 */
export function clearBasicAuthCredentials(): void {
  sessionStorage.removeItem(AUTH_SESSION_KEY);
}

/**
 * Retrieve stored Basic Auth credentials.
 */
export function getStoredBasicAuthCredentials(): string | null {
  return sessionStorage.getItem(AUTH_SESSION_KEY);
}

/**
 * Check if Basic Auth credentials are stored.
 */
export function hasBasicAuthCredentials(): boolean {
  return sessionStorage.getItem(AUTH_SESSION_KEY) !== null;
}

/**
 * Hook that returns the current Basic Auth header value (if any).
 * Watches for storage events so tabs stay in sync.
 */
export function useBasicAuthHeader(): string | null {
  const [header, setHeader] = useState<string | null>(null);

  const refresh = useCallback(() => {
    const stored = sessionStorage.getItem(AUTH_SESSION_KEY);
    setHeader(stored ? `Basic ${stored}` : null);
  }, []);

  useEffect(() => {
    refresh();

    // Listen for credential changes from other tabs
    const handler = (e: StorageEvent) => {
      if (e.key === AUTH_SESSION_KEY) refresh();
    };
    window.addEventListener("storage", handler);
    return () => window.removeEventListener("storage", handler);
  }, [refresh]);

  return header;
}

/**
 * Wrap fetch to automatically attach Basic Auth credentials when stored.
 */
export async function authedFetch(url: string, options: RequestInit = {}): Promise<Response> {
  const stored = sessionStorage.getItem(AUTH_SESSION_KEY);
  const headers: Record<string, string> = {
    ...(options.headers as Record<string, string> || {}),
  };
  if (stored && !headers.Authorization) {
    headers.Authorization = `Basic ${stored}`;
  }
  return fetch(url, { ...options, headers });
}
