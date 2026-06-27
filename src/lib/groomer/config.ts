export interface HostedGroomerConfig {
  enabled: boolean;
  dryRun: boolean;
  llmBaseUrl: string | null;
  apiKey: string | null;
  model: string;
  timeoutMs: number;
  maxContextBytes: number;
  repoContextEnabled: boolean;
  maxContextFiles: number;
  maxSearches: number;
  maxFileBytes: number;
  commentCooldownHours: number;
  groomerToken: string | null;
}

const parseBool = (value: string | undefined, defaultValue = false): boolean => {
  if (value === undefined) return defaultValue;
  if (!value) return false;
  return value.toLowerCase() === "true" || value === "1";
};

const parseIntEnv = (value: string | undefined, defaultValue: number, min = 1): number => {
  if (!value) return defaultValue;
  const parsed = parseInt(value, 10);
  return Number.isFinite(parsed) && parsed >= min ? parsed : defaultValue;
};

export function getHostedGroomerConfig(): HostedGroomerConfig {
  const enabled = parseBool(process.env.DISPATCH_HOSTED_GROOMER_ENABLED);

  if (!enabled) {
    return {
      enabled: false,
      dryRun: true,
      llmBaseUrl: null,
      apiKey: null,
      model: "gpt-4o-mini",
      timeoutMs: 60000,
      maxContextBytes: 8192,
      repoContextEnabled: false,
      maxContextFiles: 5,
      maxSearches: 3,
      maxFileBytes: 4096,
      commentCooldownHours: 24,
      groomerToken: null,
    };
  }

  const baseUrl = process.env.DISPATCH_LLM_BASE_URL?.trim() || null;
  const apiKey = process.env.DISPATCH_LLM_API_KEY?.trim() || null;

  if (!baseUrl) {
    throw new Error("DISPATCH_HOSTED_GROOMER_ENABLED requires DISPATCH_LLM_BASE_URL");
  }
  if (!apiKey) {
    throw new Error("DISPATCH_HOSTED_GROOMER_ENABLED requires DISPATCH_LLM_API_KEY");
  }

  return {
    enabled: true,
    dryRun: parseBool(process.env.DISPATCH_GROOMER_DRY_RUN, true),
    llmBaseUrl: baseUrl,
    apiKey,
    model: process.env.DISPATCH_GROOMER_MODEL?.trim() || "gpt-4o-mini",
    timeoutMs: process.env.DISPATCH_GROOMER_TIMEOUT_MS ? parseInt(process.env.DISPATCH_GROOMER_TIMEOUT_MS, 10) : 60000,
    maxContextBytes: process.env.DISPATCH_GROOMER_MAX_CONTEXT_BYTES ? parseInt(process.env.DISPATCH_GROOMER_MAX_CONTEXT_BYTES, 10) : 8192,
    repoContextEnabled: parseBool(process.env.DISPATCH_GROOMER_REPO_CONTEXT_ENABLED, false),
    maxContextFiles: parseIntEnv(process.env.DISPATCH_GROOMER_MAX_CONTEXT_FILES, 5),
    maxSearches: parseIntEnv(process.env.DISPATCH_GROOMER_MAX_SEARCHES, 3),
    maxFileBytes: parseIntEnv(process.env.DISPATCH_GROOMER_MAX_FILE_BYTES, 4096),
    commentCooldownHours: parseIntEnv(process.env.DISPATCH_GROOMER_COMMENT_COOLDOWN_HOURS, 24),
    groomerToken: process.env.DISPATCH_GROOMER_TOKEN?.trim() || null,
  };
}
