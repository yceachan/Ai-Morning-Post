#!/usr/bin/env node
import { fileURLToPath } from "node:url";
import { assertEmailConfig, loadConfig } from "./config.js";
import { Store } from "./db.js";
import { createSmtpMailer, sendIssue, sendTestIssue, type Mailer } from "./mailer.js";
import { renderIssueContent } from "./render.js";
import { fetchAndStore } from "./rss.js";
import { deliveryDayBit, formatDeliveryDays, parseDeliveryDays } from "./schedule.js";
import type { IssueRecord } from "./types.js";

interface ParsedArguments {
  positionals: string[];
  options: Record<string, string | boolean>;
}

export interface CliDependencies {
  fetchImpl?: typeof fetch;
  mailer?: Mailer;
  stdout?: (message: string) => void;
  stderr?: (message: string) => void;
  now?: () => Date;
}

function parseArguments(args: string[]): ParsedArguments {
  const positionals: string[] = [];
  const options: Record<string, string | boolean> = {};
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (!arg.startsWith("--")) {
      positionals.push(arg);
      continue;
    }
    const valueStart = arg.indexOf("=");
    if (valueStart >= 0) {
      options[arg.slice(2, valueStart)] = arg.slice(valueStart + 1);
      continue;
    }
    const key = arg.slice(2);
    const next = args[index + 1];
    if (next && !next.startsWith("--")) {
      options[key] = next;
      index += 1;
    } else {
      options[key] = true;
    }
  }
  return { positionals, options };
}

function optionString(options: Record<string, string | boolean>, key: string): string | undefined {
  const value = options[key];
  return typeof value === "string" ? value : undefined;
}

function help(): string {
  return `AI Morning Post\n\nUsage:\n  amp subscriber add <email> [--days everyday|work|weekend|7b'11111_00]\n  amp subscriber schedule <email> <days>\n  amp subscriber list [--all]\n  amp subscriber remove <email>\n  amp fetch\n  amp preview [--text]\n  amp rerender\n  amp smtp verify\n  amp send-test <email> [--dry-run]\n  amp run [--dry-run]\n\nGlobal options:\n  --config <path>  Config TOML path (default: config.toml)\n  --db <path>      Override database path\n`;
}

function outputLine(write: (message: string) => void, message: string): void {
  write(`${message}\n`);
}

async function makeMailer(config: ReturnType<typeof loadConfig>, dependencies: CliDependencies): Promise<Mailer> {
  if (dependencies.mailer) return dependencies.mailer;
  assertEmailConfig(config.email);
  return createSmtpMailer(config.email);
}

function issueDate(issue: { publishedAt: string | null; fetchedAt: string }): number {
  const value = Date.parse(issue.publishedAt ?? issue.fetchedAt);
  return Number.isNaN(value) ? 0 : value;
}

function renderStoredIssue(issue: IssueRecord, mode: "full" | "compact", baseUrl: string) {
  return renderIssueContent(issue.contentHtml, {
    title: issue.title,
    link: issue.link,
    publishedAt: issue.publishedAt,
    mode,
    baseUrl,
  });
}

export async function runCli(args: string[] = process.argv.slice(2), dependencies: CliDependencies = {}): Promise<number> {
  const { positionals, options } = parseArguments(args);
  const write = dependencies.stdout ?? ((message: string) => process.stdout.write(message));
  if (positionals.length === 0 || positionals[0] === "help" || options.help) {
    outputLine(write, help());
    return 0;
  }

  const configPath = optionString(options, "config") ?? process.env.AMP_CONFIG ?? "config.toml";
  const config = loadConfig(configPath);
  if (optionString(options, "mode")) {
    const mode = optionString(options, "mode");
    if (mode !== "full" && mode !== "compact") throw new Error("--mode must be full or compact");
    config.email.mode = mode;
  }
  if (optionString(options, "db")) config.database.path = optionString(options, "db") as string;
  const store = new Store(config.database.path);
  let mailer: Mailer | undefined;
  try {
    const command = positionals[0];
    if (command === "subscriber") {
      const action = positionals[1];
      const email = positionals[2];
      if (action === "add" && email) {
        const daysValue = optionString(options, "days");
        if (options.days === true) throw new Error("--days requires a value");
        const subscriber = store.upsertSubscriber(email, daysValue === undefined ? undefined : parseDeliveryDays(daysValue));
        outputLine(write, `Added ${subscriber.email} (${formatDeliveryDays(subscriber.deliveryDays)})`);
        return 0;
      }
      if (action === "schedule" && email && positionals[3]) {
        const subscriber = store.setSubscriberDeliveryDays(email, parseDeliveryDays(positionals[3]));
        outputLine(write, `Scheduled ${subscriber.email}: ${formatDeliveryDays(subscriber.deliveryDays)}`);
        return 0;
      }
      if (action === "remove" && email) {
        outputLine(write, store.removeSubscriber(email) ? `Removed ${email.trim().toLowerCase()}` : `Not found: ${email}`);
        return 0;
      }
      if (action === "list") {
        const subscribers = store.listSubscribers(options.all === true);
        for (const subscriber of subscribers) {
          outputLine(write, `${subscriber.active ? "active" : "inactive"}\t${subscriber.email}\t${formatDeliveryDays(subscriber.deliveryDays)}`);
        }
        return 0;
      }
      throw new Error("Usage: amp subscriber add|schedule|list|remove ...");
    }

    if (command === "fetch") {
      const result = await fetchAndStore(config.feed, store, config.email.mode, { fetchImpl: dependencies.fetchImpl });
      outputLine(write, result.status === "not-modified"
        ? "RSS not modified"
        : `Fetched ${result.fetched} issue(s), inserted ${result.inserted} new issue(s)`);
      return 0;
    }

    if (command === "preview") {
      let issue = store.getLatestIssue();
      if (!issue) {
        await fetchAndStore(config.feed, store, config.email.mode, { fetchImpl: dependencies.fetchImpl });
        issue = store.getLatestIssue();
      }
      if (!issue) throw new Error("No issue available");
      const rendered = renderStoredIssue(issue, config.email.mode, config.feed.url);
      outputLine(write, options.text === true ? rendered.text : rendered.html);
      return 0;
    }

    if (command === "rerender") {
      const count = store.rerenderAllIssues((issue) => renderStoredIssue(issue, config.email.mode, config.feed.url));
      outputLine(write, `Re-rendered ${count} issue(s); subscriber and delivery records unchanged`);
      return 0;
    }

    if (command === "smtp" && positionals[1] === "verify") {
      mailer = await makeMailer(config, dependencies);
      if (!mailer.verify) throw new Error("Configured mailer does not support SMTP verification");
      await mailer.verify();
      outputLine(write, "SMTP connection and authentication verified");
      return 0;
    }

    if (command === "send-test") {
      const recipient = positionals[1];
      if (!recipient) throw new Error("Usage: amp send-test <email> [--dry-run]");
      const issue = store.getLatestIssue();
      if (!issue) throw new Error("No issue available; run `amp fetch` first");
      const rendered = renderStoredIssue(issue, config.email.mode, config.feed.url);
      if (options["dry-run"] === true) {
        outputLine(write, `Dry-run: would send freshly rendered test issue to ${recipient}`);
        return 0;
      }
      mailer = await makeMailer(config, dependencies);
      await sendTestIssue(issue, rendered, recipient, mailer, config.email.subjectPrefix);
      outputLine(write, `Sent freshly rendered test issue to ${recipient}; delivery records unchanged`);
      return 0;
    }

    if (command === "run") {
      const result = await fetchAndStore(config.feed, store, config.email.mode, { fetchImpl: dependencies.fetchImpl });
      let issues = result.inserted > 0 ? store.getIssuesByIds(result.issueIds) : [];
      if (result.firstFetch && issues.length > 0) {
        const latest = store.getLatestIssue();
        issues = latest ? [latest] : [];
      }
      const newlyDiscoveredIssueIds = new Set(issues.map((issue) => issue.id));
      // A process can die after creating a pending row or a provider can
      // transiently fail. Retry those rows even when the RSS is unchanged.
      const retryIssues = store.getIssuesWithRetryableDeliveries();
      const byId = new Map(issues.map((issue) => [issue.id, issue]));
      for (const issue of retryIssues) byId.set(issue.id, issue);
      issues = [...byId.values()].sort((left, right) => issueDate(left) - issueDate(right));
      const currentDayBit = deliveryDayBit(dependencies.now?.() ?? new Date());
      if (options["dry-run"] === true) {
        outputLine(write, `Dry-run: would process ${issues.length} issue(s); ${store.listSubscribersForDeliveryDay(currentDayBit).length} recipient(s) eligible today`);
        return 0;
      }
      if (issues.length === 0) {
        outputLine(write, result.status === "not-modified" ? "No new issue or retryable delivery" : "No new issue");
        return 0;
      }
      // Persist the target recipient snapshot before SMTP configuration or
      // connection. If credentials are temporarily absent, the next run can
      // safely recover these pending deliveries even when the RSS is 304.
      for (const issue of issues) {
        if (newlyDiscoveredIssueIds.has(issue.id)) store.queueIssueForEligibleSubscribers(issue.id, currentDayBit);
      }
      const sendableIssues = issues.filter((issue) => store.hasRetryableDeliveryForIssue(issue.id));
      if (sendableIssues.length === 0) {
        outputLine(write, `No eligible recipient or retryable delivery for ${issues.length} issue(s)`);
        return 0;
      }
      mailer = await makeMailer(config, dependencies);
      let sent = 0;
      let failed = 0;
      for (const issue of sendableIssues) {
        const sendResult = await sendIssue(store, issue, mailer, config.email.subjectPrefix, { onlyExistingDeliveries: true });
        sent += sendResult.sent;
        failed += sendResult.failed;
      }
      outputLine(write, `Processed ${sendableIssues.length} issue(s): ${sent} sent, ${failed} failed`);
      return failed > 0 ? 1 : 0;
    }

    throw new Error(`Unknown command: ${command}`);
  } finally {
    const close = (mailer as Mailer & { close?: () => void } | undefined)?.close;
    close?.call(mailer);
    store.close();
  }
}

export async function main(): Promise<void> {
  try {
    process.exitCode = await runCli();
  } catch (error) {
    const message = formatError(error);
    process.stderr.write(`Error: ${message}\n`);
    process.exitCode = 1;
  }
}

function formatError(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const parts = [error.message];
  let cause: unknown = (error as Error & { cause?: unknown }).cause;
  let depth = 0;
  while (cause && depth < 3) {
    if (cause instanceof Error) {
      const code = (cause as Error & { code?: unknown }).code;
      const detail = `${typeof code === "string" ? `${code}: ` : ""}${cause.message}`;
      if (!parts.includes(detail)) parts.push(detail);
      cause = (cause as Error & { cause?: unknown }).cause;
    } else {
      const detail = String(cause);
      if (!parts.includes(detail)) parts.push(detail);
      break;
    }
    depth += 1;
  }
  return parts.join("; caused by ");
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  void main();
}
