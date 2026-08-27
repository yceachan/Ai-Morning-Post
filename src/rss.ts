import { createHash } from "node:crypto";
import { XMLParser } from "fast-xml-parser";
import type { FeedConfig, FetchResult, ParsedFeedIssue } from "./types.js";
import { Store } from "./db.js";
import { renderIssueContent } from "./render.js";

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  trimValues: false,
  parseTagValue: false,
  processEntities: true,
});

type UnknownRecord = Record<string, unknown>;

function asRecord(value: unknown): UnknownRecord {
  return value !== null && typeof value === "object" ? (value as UnknownRecord) : {};
}

function first(value: unknown): unknown {
  return Array.isArray(value) ? value[0] : value;
}

function scalar(value: unknown): string {
  value = first(value);
  if (value === null || value === undefined) return "";
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return String(value).trim();
  const record = asRecord(value);
  // fast-xml-parser uses #text for mixed content and @_href for Atom links.
  return scalar(record["#text"] ?? record["__cdata"] ?? record["@_href"] ?? "");
}

function field(item: UnknownRecord, names: string[]): unknown {
  for (const name of names) {
    if (item[name] !== undefined) return first(item[name]);
  }
  return undefined;
}

function itemsFromDocument(document: UnknownRecord): UnknownRecord[] {
  const rss = asRecord(document.rss);
  const channel = asRecord(first(rss.channel));
  const rssItems = channel.item;
  if (rssItems !== undefined) return (Array.isArray(rssItems) ? rssItems : [rssItems]).map(asRecord);

  const atom = asRecord(document.feed);
  const atomEntries = atom.entry;
  if (atomEntries !== undefined) return (Array.isArray(atomEntries) ? atomEntries : [atomEntries]).map(asRecord);
  return [];
}

function parseDate(value: string): string | null {
  if (!value) return null;
  const timestamp = Date.parse(value);
  return Number.isNaN(timestamp) ? null : new Date(timestamp).toISOString();
}

function canonicalLink(value: unknown, baseUrl: string): string {
  const raw = scalar(value);
  if (!raw) return "";
  try {
    return new URL(raw, baseUrl).toString();
  } catch {
    return raw;
  }
}

function fallbackGuid(title: string, link: string, publishedAt: string | null): string {
  return `sha256:${createHash("sha256").update(`${title}\n${link}\n${publishedAt ?? ""}`).digest("hex")}`;
}

export function parseFeed(xml: string, baseUrl: string): ParsedFeedIssue[] {
  let document: UnknownRecord;
  try {
    document = asRecord(parser.parse(xml));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Unable to parse RSS XML: ${message}`);
  }

  const parsed: ParsedFeedIssue[] = [];
  for (const item of itemsFromDocument(document)) {
    const title = scalar(field(item, ["title"])) || "Untitled issue";
    const link = canonicalLink(field(item, ["link", "origLink"]), baseUrl);
    const publishedAt = parseDate(scalar(field(item, ["pubDate", "published", "updated", "date"])));
    const contentValue = field(item, ["content:encoded", "content", "description", "summary"]);
    const contentHtml = scalar(contentValue);
    const contentText = renderIssueContent(contentHtml, { title, link, publishedAt, mode: "full", baseUrl }).text;
    const guid = scalar(field(item, ["guid", "id"])) || fallbackGuid(title, link, publishedAt);
    parsed.push({ guid, title, link, publishedAt, contentHtml, contentText });
  }

  if (parsed.length === 0) throw new Error("RSS feed contained no items");
  return parsed;
}

export interface FetchDependencies {
  fetchImpl?: typeof fetch;
}

export async function fetchAndStore(
  config: FeedConfig,
  store: Store,
  mode: "full" | "compact" = "full",
  dependencies: FetchDependencies = {},
): Promise<FetchResult> {
  const state = store.getFeedState();
  const issueCountBefore = store.countIssues();
  const headers = new Headers({
    accept: "application/rss+xml, application/atom+xml, application/xml, text/xml;q=0.9, */*;q=0.1",
    "user-agent": config.userAgent,
  });
  if (state.etag) headers.set("if-none-match", state.etag);
  if (state.lastModified) headers.set("if-modified-since", state.lastModified);

  const fetchImpl = dependencies.fetchImpl ?? globalThis.fetch;
  if (!fetchImpl) throw new Error("This Node.js runtime does not provide fetch");
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.timeoutMs);
  try {
    const response = await fetchImpl(config.url, { headers, signal: controller.signal });
    const checkedAt = new Date().toISOString();
    if (response.status === 304) {
      store.updateFeedState({ lastCheckedAt: checkedAt });
      return {
        status: "not-modified",
        fetched: 0,
        inserted: 0,
        issueIds: [],
        firstFetch: issueCountBefore === 0,
      };
    }
    if (!response.ok) throw new Error(`RSS request failed with HTTP ${response.status}`);

    // Keep the AbortController active through response body consumption; a
    // server can return headers promptly and then stall the XML body.
    const xml = await response.text();
    const issues = parseFeed(xml, config.url);
    const issueIds: number[] = [];
    let inserted = 0;
    for (const issue of issues) {
      const rendered = renderIssueContent(issue.contentHtml, {
        title: issue.title,
        link: issue.link,
        publishedAt: issue.publishedAt,
        mode,
        baseUrl: config.url,
      });
      const result = store.insertIssue(issue, rendered.html, rendered.text);
      if (result.isNew) {
        issueIds.push(result.id);
        inserted += 1;
      }
    }
    store.updateFeedState({
      etag: response.headers.get("etag"),
      lastModified: response.headers.get("last-modified"),
      lastCheckedAt: checkedAt,
      lastSuccessAt: checkedAt,
    });
    return { status: "updated", fetched: issues.length, inserted, issueIds, firstFetch: issueCountBefore === 0 };
  } finally {
    clearTimeout(timeout);
  }
}
