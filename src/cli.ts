#!/usr/bin/env node
import { fileURLToPath } from "node:url";
import { assertEmailConfig, loadConfig } from "./config.js";
import { Store } from "./db.js";
import { createSmtpMailer, sendIssue, type Mailer } from "./mailer.js";
import { fetchAndStore } from "./rss.js";

interface ParsedArguments {
  positionals: string[];
  options: Record<string, string | boolean>;
}

export interface CliDependencies {
  fetchImpl?: typeof fetch;
  mailer?: Mailer;
  stdout?: (message: string) => void;
  stderr?: (message: string) => void;
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
  return `AI Morning Post\n\nUsage:\n  amp subscriber add <email>\n  amp subscriber list [--all]\n  amp subscriber remove <email>\n  amp fetch\n  amp preview [--text]\n  amp send-latest [--dry-run]\n  amp run [--dry-run]\n\nGlobal options:\n  --config <path>  Config TOML path (default: config.toml)\n  --db <path>      Override database path\n`;
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
        const subscriber = store.upsertSubscriber(email);
        outputLine(write, `Added ${subscriber.email}`);
        return 0;
      }
      if (action === "remove" && email) {
        outputLine(write, store.removeSubscriber(email) ? `Removed ${email.trim().toLowerCase()}` : `Not found: ${email}`);
        return 0;
      }
      if (action === "list") {
        const subscribers = store.listSubscribers(options.all === true);
        for (const subscriber of subscribers) outputLine(write, `${subscriber.active ? "active" : "inactive"}\t${subscriber.email}`);
        return 0;
      }
      throw new Error("Usage: amp subscriber add|list|remove ...");
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
      outputLine(write, options.text === true ? issue.renderedText : issue.renderedHtml);
      return 0;
    }

    if (command === "send-latest") {
      await fetchAndStore(config.feed, store, config.email.mode, { fetchImpl: dependencies.fetchImpl });
      const issue = store.getLatestIssue();
      if (!issue) throw new Error("No issue available");
      if (options["dry-run"] === true) {
        outputLine(write, `Dry-run: would send latest issue to ${store.listSubscribers().length} recipient(s)`);
        return 0;
      }
      mailer = await makeMailer(config, dependencies);
      const result = await sendIssue(store, issue, mailer, config.email.subjectPrefix, {
        includeAllActiveSubscribers: true,
      });
      outputLine(write, `Sent latest issue: ${result.sent} sent, ${result.failed} failed, ${result.attempted} recipient(s)`);
      return result.failed > 0 ? 1 : 0;
    }

    if (command === "run") {
      const result = await fetchAndStore(config.feed, store, config.email.mode, { fetchImpl: dependencies.fetchImpl });
      let issues = result.inserted > 0 ? store.getIssuesByIds(result.issueIds) : [];
      if (result.firstFetch && issues.length > 0) {
        const latest = store.getLatestIssue();
        issues = latest ? [latest] : [];
      }
      // A process can die after creating a pending row or a provider can
      // transiently fail. Retry those rows even when the RSS is unchanged.
      const retryIssues = store.getIssuesWithRetryableDeliveries();
      const byId = new Map(issues.map((issue) => [issue.id, issue]));
      for (const issue of retryIssues) byId.set(issue.id, issue);
      issues = [...byId.values()].sort((left, right) => issueDate(left) - issueDate(right));
      if (options["dry-run"] === true) {
        outputLine(write, `Dry-run: would process ${issues.length} issue(s) for ${store.listSubscribers().length} recipient(s)`);
        return 0;
      }
      if (issues.length === 0) {
        outputLine(write, result.status === "not-modified" ? "No new issue or retryable delivery" : "No new issue");
        return 0;
      }
      mailer = await makeMailer(config, dependencies);
      let sent = 0;
      let failed = 0;
      for (const issue of issues) {
        const sendResult = await sendIssue(store, issue, mailer, config.email.subjectPrefix);
        sent += sendResult.sent;
        failed += sendResult.failed;
      }
      outputLine(write, `Processed ${issues.length} issue(s): ${sent} sent, ${failed} failed`);
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
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`Error: ${message}\n`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  void main();
}
