"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useState } from "react";

const DEFAULT_CALLBACK_URL = "/board";

function safeCallbackUrl(raw: string | null): string {
  if (!raw || raw.trim() === "") return DEFAULT_CALLBACK_URL;
  if (raw.startsWith("//") || /^https?:\/\//i.test(raw)) return DEFAULT_CALLBACK_URL;
  if (raw.startsWith("/")) return raw;
  return DEFAULT_CALLBACK_URL;
}

export default function LoginPage() {
  return (
    <Suspense>
      <LoginContent />
    </Suspense>
  );
}

function LoginContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const callbackUrl = safeCallbackUrl(searchParams.get("callbackUrl"));

  useEffect(() => {
    // Check if already logged in
    fetch("/api/auth/session")
      .then((res) => res.json())
      .then((data) => {
        if (data?.user) {
          router.replace(callbackUrl);
        }
      })
      .catch(() => {});
  }, [callbackUrl, router]);

  const handleSignIn = () => {
    setLoading(true);
    setError(null);
    window.location.href = `/api/login?callbackUrl=${encodeURIComponent(callbackUrl)}`;
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-50">
      <div className="max-w-md w-full space-y-8 p-10">
        <div className="text-center">
          <h2 className="mt-6 text-3xl font-bold tracking-tight text-gray-900">
            Sign in to Dispatch
          </h2>
          <p className="mt-2 text-sm text-gray-600">
            Use your organization account to continue
          </p>
        </div>

        {error && (
          <div className="bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded text-sm">
            {error}
          </div>
        )}

        <button
          onClick={handleSignIn}
          disabled={loading}
          className="w-full flex justify-center py-3 px-4 rounded-md text-white font-medium bg-blue-600 hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2 disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {loading ? "Signing in..." : "Sign in with SSO"}
        </button>
      </div>
    </div>
  );
}
