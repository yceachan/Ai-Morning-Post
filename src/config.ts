import { existsSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { parse as parseToml } from "smol-toml";
import type { AppConfig, EmailConfig, NewsletterMode } from "./types.js";

const DEFAULT_FEED_URL = "https://daily.juya.uk/rss.xml";
const DEFAULT_DB_PATH = "data/ai-morning-post.sqlite";
const DEFAULT_USER_AGENT = "ai-morning-post/0.1 (+https://daily.juya.uk/rss.xml)";

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function stringValue(value: unknown, fallback: string): string {
  return typeof value === "string" ? value : fallback;
}

function numberValue(value: unknown, fallback: number): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value))) return Number(value);
  return fallback;
}

function booleanValue(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

/**
 * Resolve an exact `$NAME` or `${NAME}` value from the process environment.
 * Keeping substitution exact avoids surprising expansion in URLs, subjects,
 * or article text. Missing variables become an empty string so read-only
 * commands (fetch/preview) can run without SMTP credentials; send commands
 * validate the fields before use.
 */
export function resolveEnvironment(value: string, env: NodeJS.ProcessEnv = process.env): string {
  const match = /^(?:\$([A-Z_][A-Z0-9_]*)|\$\{([A-Z_][A-Z0-9_]*)\})$/.exec(value);
  if (!match) return value;
  const name = match[1] ?? match[2];
  return env[name] ?? "";
}

function resolveStrings(value: unknown, env: NodeJS.ProcessEnv): unknown {
  if (typeof value === "string") return resolveEnvironment(value, env);
  if (Array.isArray(value)) return value.map((entry) => resolveStrings(entry, env));
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, entry]) => [key, resolveStrings(entry, env)]));
  }
  return value;
}

function pathFromConfig(value: string, configPath: string): string {
  return isAbsolute(value) ? value : resolve(dirname(configPath), value);
}

export function loadConfig(configPath = process.env.AMP_CONFIG ?? "config.toml", env: NodeJS.ProcessEnv = process.env): AppConfig {
  const absoluteConfigPath = resolve(configPath);
  let raw: Record<string, unknown> = {};
  if (existsSync(absoluteConfigPath)) {
    let parsed: unknown;
    try {
      parsed = parseToml(readFileSync(absoluteConfigPath, "utf8"));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new ConfigError(`Unable to parse ${absoluteConfigPath}: ${message}`);
    }
    raw = asRecord(resolveStrings(parsed, env));
  }

  const feed = asRecord(raw.feed);
  const database = asRecord(raw.database);
  // `[email]` is the documented name; `[smtp]` is accepted as a convenient
  // alias for people migrating from a generic SMTP config.
  const email = asRecord(raw.email ?? raw.smtp);
  const modeValue = stringValue(email.mode, "full").toLowerCase() as NewsletterMode;
  if (modeValue !== "full" && modeValue !== "compact") {
    throw new ConfigError(`email.mode must be \"full\" or \"compact\", got ${modeValue}`);
  }

  const configuredDbPath = stringValue(database.path, DEFAULT_DB_PATH);
  const username = stringValue(email.username, "");
  const from = stringValue(email.from ?? email.from_address, username);
  const emailConfig: EmailConfig = {
    host: stringValue(email.host, "smtp.qq.com"),
    port: numberValue(email.port, 465),
    secure: booleanValue(email.secure, true),
    username: username || undefined,
    password: stringValue(email.password, "") || undefined,
    from: from || undefined,
    fromName: stringValue(email.from_name ?? email.fromName, "AI Morning Post"),
    subjectPrefix: stringValue(email.subject_prefix ?? email.subjectPrefix, "AI Morning Post"),
    mode: modeValue,
  };

  const configuredTimeout = numberValue(feed.timeout_ms ?? feed.timeoutMs, 20_000);
  return {
    feed: {
      url: stringValue(feed.url, DEFAULT_FEED_URL),
      userAgent: stringValue(feed.user_agent ?? feed.userAgent, DEFAULT_USER_AGENT),
      timeoutMs: configuredTimeout > 0 ? configuredTimeout : 20_000,
    },
    database: {
      path: pathFromConfig(configuredDbPath, absoluteConfigPath),
    },
    email: emailConfig,
  };
}

export function assertEmailConfig(email: EmailConfig): asserts email is EmailConfig & { username: string; password: string; from: string } {
  const missing: string[] = [];
  if (!email.username) missing.push("email.username");
  if (!email.password) missing.push("email.password");
  if (!email.from) missing.push("email.from");
  if (!email.host) missing.push("email.host");
  if (missing.length > 0) {
    throw new ConfigError(`Missing SMTP configuration: ${missing.join(", ")}. Set the referenced environment variables in config.toml.`);
  }
}
