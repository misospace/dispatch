// Internal shared helper, do not re-export from barrel
const GITHUB_API = "https://api.github.com";

interface CachedToken {
  token: string;
  expiresAt: number;
}

let installationTokenCache: CachedToken | null = null;
let useGitHubApp = false;
let appNotConfigured = false;
let inFlightTokenFetch: Promise<void> | null = null;

function base64urlEncodeArrayBuffer(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return Buffer.from(binary, "binary").toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64urlEncode(data: string): string {
  return Buffer.from(data).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function pemToArrayBuffer(pem: string): ArrayBuffer {
  const lines = pem.split("\n").filter((line) => !line.startsWith("-----"));
  const base64 = lines.join("");
  const bytes = Buffer.from(base64, "base64");
  const copy = Buffer.alloc(bytes.length);
  copy.set(bytes);
  return copy.buffer as ArrayBuffer;
}

async function generateAppJwt(privateKey: string): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const header = base64urlEncode(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const payload = base64urlEncode(JSON.stringify({
    iat: now,
    exp: now + 600,
    iss: process.env.GITHUB_APP_ID,
  }));
  const signingInput = `${header}.${payload}`;

  const cryptoKey = await crypto.subtle.importKey(
    "pkcs8",
    pemToArrayBuffer(privateKey),
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"]
  );

  const signatureBuffer = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    cryptoKey,
    new TextEncoder().encode(signingInput)
  );
  const signature = base64urlEncodeArrayBuffer(signatureBuffer);

  return `${signingInput}.${signature}`;
}

async function getInstallationTokenWithExpiry(): Promise<CachedToken> {
  const appId = process.env.GITHUB_APP_ID;
  const installationId = process.env.GITHUB_APP_INSTALLATION_ID;
  let privateKey = process.env.GITHUB_APP_PRIVATE_KEY || "";

  if (!appId || !installationId || !privateKey) {
    throw new Error("GitHub App authentication is misconfigured — missing required env vars");
  }

  privateKey = privateKey.replace(/\\n/g, "\n");

  const jwt = await generateAppJwt(privateKey);

  const response = await fetch(
    `${GITHUB_API}/app/installations/${installationId}/access_tokens`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${jwt}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
      },
    }
  );

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Failed to get GitHub App installation token: ${response.status} ${text}`);
  }

  const data = (await response.json()) as { token: string; expires_at: string };

  const githubExpiresAt = Math.floor(Date.parse(data.expires_at) / 1000);
  const safeTtl = Math.min(3300, githubExpiresAt - Math.floor(Date.now() / 1000) - 60);

  return { token: data.token, expiresAt: Date.now() / 1000 + safeTtl };
}

function fetchAndCacheInstallationToken(): Promise<void> {
  if (!inFlightTokenFetch) {
    inFlightTokenFetch = getInstallationTokenWithExpiry()
      .then((cached) => {
        installationTokenCache = cached;
        useGitHubApp = true;
      })
      .finally(() => {
        inFlightTokenFetch = null;
      });
  }
  return inFlightTokenFetch;
}

async function ensureInit(): Promise<void> {
  if (useGitHubApp || appNotConfigured) return;

  const appId = process.env.GITHUB_APP_ID;
  const installationId = process.env.GITHUB_APP_INSTALLATION_ID;
  const privateKey = process.env.GITHUB_APP_PRIVATE_KEY;

  if (!appId || !installationId || !privateKey) {
    appNotConfigured = true;
    return;
  }

  try {
    await fetchAndCacheInstallationToken();
  } catch {
  }
}

async function refreshIfNeeded(): Promise<void> {
  if (!useGitHubApp || !installationTokenCache) return;

  if (installationTokenCache.expiresAt <= Date.now() / 1000 + 60) {
    await fetchAndCacheInstallationToken();
  }
}

export async function getGitHubToken(): Promise<string> {
  await ensureInit();
  await refreshIfNeeded();

  if (useGitHubApp && installationTokenCache) {
    return installationTokenCache.token;
  }

  const token = process.env.GITHUB_TOKEN;
  if (!token) {
    throw new Error("GITHUB_TOKEN environment variable is not set");
  }
  return token;
}

// Internal shared helper, do not re-export from barrel
export async function getHeadersAsync(): Promise<HeadersInit> {
  const token = await getGitHubToken();
  return {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
  };
}

export function __resetGitHubAppState(): void {
  installationTokenCache = null;
  useGitHubApp = false;
  appNotConfigured = false;
  inFlightTokenFetch = null;
}

function getNextLink(response: Response): string | null {
  const link = response.headers.get("Link");
  if (!link) return null;
  const match = link.match(/<([^>]+)>;\s*rel="next"/);
  return match?.[1] ?? null;
}

export async function fetchPaginated<T>(
  url: string,
  maxItems = Infinity,
  extractPageItems?: (data: unknown) => T[],
): Promise<T[]> {
  const all: T[] = [];
  let currentUrl: string | null = url;

  while (currentUrl && all.length < maxItems) {
    const response = await fetch(currentUrl, { headers: await getHeadersAsync() });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`GitHub API error: ${response.status} ${text}`);
    }

    const data = await response.json();
    const page = extractPageItems ? extractPageItems(data) : data;
    if (!Array.isArray(page)) {
      throw new Error(`GitHub API error: expected array response from ${currentUrl}`);
    }
    const remaining = maxItems - all.length;
    all.push(...page.slice(0, remaining));

    if (all.length >= maxItems) break;

    currentUrl = getNextLink(response);
  }

  return all;
}

export async function validateGitHubToken(): Promise<boolean> {
  try {
    const response = await fetch(`${GITHUB_API}/user`, {
      headers: await getHeadersAsync(),
    });
    return response.ok;
  } catch {
    return false;
  }
}

export { GITHUB_API };
