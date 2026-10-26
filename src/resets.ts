import { createHash, randomUUID } from "node:crypto";
import { Store } from "./db.js";
import type { Mailer, OutgoingMessage } from "./mailer.js";
import { renderEmailContent, renderIssueContent } from "./render.js";
import { renderXPost } from "./x-post.js";

const API = "https://codex-resets.com/api/v1/";
export const RESET_TEST_RECIPIENT = "yceachan@foxmail.com";

export interface ResetAnnouncement {
  id: string;
  reset_type: "regular" | "banked";
  announced_at: string;
  text: string;
  source: { type: "x_post" | "observed"; author?: string; url?: string };
}

export interface ResetEvent extends ResetAnnouncement {
  kind: "scheduled" | "executed";
  scheduled_for?: string | null;
}

interface ResetStatus {
  scheduled: ResetEvent | null;
  generatedAt: string;
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid Codex Resets API object");
  return value as Record<string, unknown>;
}

function timestamp(value: unknown): string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T/.test(value) || !Number.isFinite(Date.parse(value))) {
    throw new Error("Invalid Codex Resets API timestamp");
  }
  return value;
}

function parseAnnouncement(value: unknown, kind: ResetEvent["kind"]): ResetEvent {
  const row = object(value);
  const source = object(row.source);
  if (typeof row.id !== "string" || !row.id || typeof row.text !== "string"
    || (row.reset_type !== "regular" && row.reset_type !== "banked")
    || (source.type !== "x_post" && source.type !== "observed")) {
    throw new Error("Invalid Codex Resets API announcement");
  }
  let url: string | undefined;
  if (source.url !== undefined) {
    if (typeof source.url !== "string" || !["http:", "https:"].includes(new URL(source.url).protocol)) {
      throw new Error("Invalid Codex Resets API source URL");
    }
    url = source.url;
  } else if (source.type === "x_post") {
    throw new Error("Missing Codex Resets API source URL");
  }
  if (source.author !== undefined && (typeof source.author !== "string" || !/^[a-z0-9_]{1,15}$/i.test(source.author))) {
    throw new Error("Invalid Codex Resets API author");
  }
  const event: ResetEvent = {
    id: row.id, text: row.text, reset_type: row.reset_type,
    announced_at: timestamp(row.announced_at), source: {
      type: source.type, url,
      ...(typeof source.author === "string" ? { author: source.author } : {}),
    }, kind,
  };
  if (kind === "scheduled") {
    if (row.status !== "scheduled") throw new Error("Invalid Codex Resets scheduled status");
    event.scheduled_for = row.scheduled_for === null ? null : timestamp(row.scheduled_for);
  }
  return event;
}

async function getJson(url: string, fetchImpl: typeof fetch): Promise<unknown> {
  const response = await fetchImpl(url, {
    headers: { Accept: "application/json", "User-Agent": "ai-morning-post/codex-resets" },
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) throw new Error(`Codex Resets API HTTP ${response.status}`);
  return response.json();
}

export async function fetchResetStatus(fetchImpl: typeof fetch = fetch): Promise<ResetStatus> {
  const response = object(await getJson(`${API}status`, fetchImpl));
  const data = object(response.data);
  const meta = object(response.meta);
  if (meta.api_version !== "v1") throw new Error("Unsupported Codex Resets API version");
  return {
    scheduled: data.scheduled_reset === null ? null : parseAnnouncement(data.scheduled_reset, "scheduled"),
    generatedAt: timestamp(meta.generated_at),
  };
}

function eventKey(event: ResetEvent): string {
  return `${event.kind}:${event.id}:${event.kind === "scheduled" ? event.scheduled_for ?? "unspecified" : ""}`;
}

export class ResetStore {
  constructor(private readonly store: Store) {
    store.db.exec(`
      CREATE TABLE IF NOT EXISTS reset_state (
        id INTEGER PRIMARY KEY CHECK (id = 1), last_checked_at TEXT
      );
      INSERT OR IGNORE INTO reset_state (id) VALUES (1);
      CREATE TABLE IF NOT EXISTS reset_events (
        event_key TEXT PRIMARY KEY, payload TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS reset_deliveries (
        event_key TEXT NOT NULL REFERENCES reset_events(event_key),
        subscriber_id INTEGER NOT NULL REFERENCES subscribers(id),
        status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sent', 'failed')),
        provider_id TEXT, error TEXT, sent_at TEXT,
        PRIMARY KEY (event_key, subscriber_id)
      );
    `);
  }

  checkpoint(): string | null {
    return (this.store.db.prepare("SELECT last_checked_at FROM reset_state WHERE id = 1").get() as { last_checked_at: string | null }).last_checked_at;
  }

  hasEvent(event: ResetEvent): boolean {
    return this.store.db.prepare("SELECT 1 FROM reset_events WHERE event_key = ?").get(eventKey(event)) !== undefined;
  }

  record(events: ResetEvent[], checkedAt: string): number {
    const db = this.store.db;
    let added = 0;
    db.exec("BEGIN IMMEDIATE");
    try {
      const insert = db.prepare("INSERT OR IGNORE INTO reset_events (event_key, payload) VALUES (?, ?)");
      for (const event of events) {
        const key = eventKey(event);
        if (Number(insert.run(key, JSON.stringify(event)).changes) === 0) continue;
        added += 1;
        db.prepare(`INSERT INTO reset_deliveries (event_key, subscriber_id)
          SELECT ?, id FROM subscribers WHERE active = 1`).run(key);
      }
      db.prepare("UPDATE reset_state SET last_checked_at = ? WHERE id = 1").run(checkedAt);
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
    return added;
  }

  pending(): { key: string; subscriberId: number; email: string; event: ResetEvent }[] {
    const rows = this.store.db.prepare(`
      SELECT d.event_key, d.subscriber_id, s.email, e.payload FROM reset_deliveries d
      JOIN reset_events e ON e.event_key = d.event_key
      JOIN subscribers s ON s.id = d.subscriber_id AND s.active = 1
      WHERE d.status IN ('pending', 'failed')
        AND json_extract(e.payload, '$.kind') = 'scheduled'
      ORDER BY e.rowid, s.email
    `).all() as { event_key: string; subscriber_id: number; email: string; payload: string }[];
    return rows.map((row) => ({ key: row.event_key, subscriberId: row.subscriber_id, email: row.email, event: JSON.parse(row.payload) as ResetEvent }));
  }

  sent(key: string, subscriberId: number, providerId: string): void {
    this.store.db.prepare(`UPDATE reset_deliveries SET status = 'sent', provider_id = ?, error = NULL, sent_at = ?
      WHERE event_key = ? AND subscriber_id = ?`).run(providerId, new Date().toISOString(), key, subscriberId);
  }

  failed(key: string, subscriberId: number, error: unknown): void {
    this.store.db.prepare(`UPDATE reset_deliveries SET status = 'failed', error = ?
      WHERE event_key = ? AND subscriber_id = ?`).run(String(error).slice(0, 4000), key, subscriberId);
  }
}

export async function discoverResetEvents(ledger: ResetStore, options: { fetchImpl?: typeof fetch; dryRun?: boolean } = {}) {
  const fetchImpl = options.fetchImpl ?? fetch;
  const status = await fetchResetStatus(fetchImpl);
  const checkpoint = ledger.checkpoint();
  const events = status.scheduled ? [status.scheduled] : [];
  if (options.dryRun) {
    const unique = new Map(events.map((event) => [eventKey(event), event]));
    return { initialized: checkpoint !== null, discovered: [...unique.values()].filter((event) => !ledger.hasEvent(event)).length };
  }
  const discovered = ledger.record(events, status.generatedAt);
  return { initialized: checkpoint !== null, discovered };
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]!);
}

function displayTime(value: string): string {
  return `${new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Singapore", year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).format(new Date(value))}（UTC+8）`;
}

export function renderResetMessage(event: ResetEvent, to: string, test = false): OutgoingMessage {
  const title = "Codex 重置计划已公布";
  const type = event.reset_type === "banked" ? "备用重置额度（banked）" : "常规重置（regular）";
  const timing = `计划时间：${event.scheduled_for ? displayTime(event.scheduled_for) : "公告尚未给出具体时间"}`;
  const intro = test ? "测试邮件 · 以下为当前 API 数据快照。" : "检测到新的 Codex 重置公告。";
  const sourceUrl = event.source.url ?? "https://codex-resets.com";
  const input = {
    title, link: sourceUrl, publishedAt: event.announced_at,
    linkLabel: "查看公告来源", source: { name: "Codex Resets", url: "https://codex-resets.com" },
  };
  // Older persisted events retain the source URL but predate the author field.
  const handle = event.source.type === "x_post"
    ? event.source.author ?? new URL(sourceUrl).pathname.split("/")[1] : null;
  const post = handle ? renderXPost({
    name: handle === "thsottiaux" ? "Tibo" : handle,
    handle, verified: handle === "thsottiaux",
    ...(handle === "thsottiaux" ? { avatarUrl: "https://pbs.twimg.com/profile_images/2093807917833281537/2yBgpwVV_normal.jpg" } : {}),
    text: event.text, publishedAt: event.announced_at, url: sourceUrl,
  }) : null;
  const rendered = post ? renderEmailContent({
    html: `<p style="margin:0 0 16px">${intro}</p><p style="margin:0 0 24px">类型：${type}<br>${timing}</p>${post.html}`,
    text: `${intro}\n类型：${type}\n${timing}\n\n公告原文：\n${post.text}`,
  }, input) : renderIssueContent(
    `<p>${intro}</p><p>类型：${type}<br>${timing}</p><h3>公告原文</h3><p>${escapeHtml(event.text).replace(/\r\n|\r|\n/g, "<br>")}</p>`,
    input,
  );
  const hash = createHash("sha256").update(`${eventKey(event)}:${to}`).digest("hex");
  return {
    to, subject: `${test ? "[TEST] " : ""}[Codex Resets] ${title}`,
    ...rendered,
    messageId: `amp-reset-${hash}${test ? `-test-${randomUUID()}` : ""}@ai-morning-post.local`,
  };
}

export async function sendResetNotifications(ledger: ResetStore, mailer: Mailer): Promise<{ sent: number; failed: number }> {
  let sent = 0;
  let failed = 0;
  for (const target of ledger.pending()) {
    const outgoing = renderResetMessage(target.event, target.email);
    try {
      const result = await mailer.send(outgoing);
      ledger.sent(target.key, target.subscriberId, result.messageId ?? outgoing.messageId);
      sent += 1;
    } catch (error) {
      ledger.failed(target.key, target.subscriberId, error);
      failed += 1;
    }
  }
  return { sent, failed };
}
