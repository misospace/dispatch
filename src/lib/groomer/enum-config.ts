/**
 * Generic enum configuration for schema-driven groomer validation.
 *
 * Each entry describes one enum field: its canonical values, optional aliases,
 * and (for dynamic sources like lane config) a lazy resolver.
 *
 * Adding a new enum field = appending to the GROOMER_ENUM_CONFIGS registry.
 * No changes needed to the validator itself.
 */

/**
 * Configuration for a single enum field in groomer output.
 */
export interface EnumConfig<T extends string = string> {
  /** Dot-notation path, e.g. "lane.id", "confidence", "actionability" */
  field: string;

  /** Canonical allowed values (static). Mutually exclusive with resolveValidValues. */
  validValues?: readonly T[];

  /** Lazy resolver for canonical values (dynamic, e.g. lane config from env). */
  resolveValidValues?: () => readonly T[];

  /** Legacy → canonical alias map. May be static or a lazy getter. */
  aliases?: Record<string, T> | (() => Record<string, T>);
}

/**
 * Resolved enum config: all values materialized for a single validation run.
 */
export interface ResolvedEnumConfig<T extends string = string> {
  field: string;
  validValues: readonly T[];
  aliases: Record<string, T>;
}

/**
 * A structured record of an alias resolution event.
 * Not an error — purely informational for observability.
 */
export interface ResolutionEvent {
  /** Dot-notation field path, e.g. "lane.id" */
  field: string;
  /** The raw value returned by the LLM */
  rawValue: string;
  /** The canonical value after alias resolution */
  resolvedValue: string;
  /** How this resolution happened */
  source: "alias" | "invariant";
}

/**
 * Materialize a config into a resolved form (validValues + aliases).
 */
export function resolveEnumConfig<T extends string>(
  config: EnumConfig<T>,
): ResolvedEnumConfig<T> {
  const validValues =
    config.resolveValidValues?.() ?? config.validValues ?? [];

  let aliases: Record<string, T>;
  if (typeof config.aliases === "function") {
    aliases = config.aliases();
  } else {
    aliases = config.aliases ?? {};
  }

  return {
    field: config.field,
    validValues,
    aliases,
  };
}
