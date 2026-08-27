import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type {
  DeliveryRecord,
  DeliveryStatus,
  FeedStateRecord,
  IssueRecord,
  ParsedFeedIssue,
  SubscriberRecord,
} from "./types.js";

type SqlRow = Record<string, unknown>;

function nowIso(): string {
  return new Date().toISOString();
}

function asNumber(value: unknown): number {
  return typeof value === "bigint" ? Number(value) : Number(value);
}

function asNullableString(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value);
}

function ensureParentDirectory(path: string): void {
  if (path === ":memory:") return;
  mkdirSync(dirname(path), { recursive: true });
}

export interface InsertIssueResult {
  id: number;
  isNew: boolean;
}

export class Store {
  readonly db: DatabaseSync;

  constructor(path: string) {
    ensureParentDirectory(path);
    this.db = new DatabaseSync(path);
    this.db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
    this.migrate();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS subscribers (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        email TEXT NOT NULL UNIQUE COLLATE NOCASE,
        active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS issues (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        guid TEXT NOT NULL UNIQUE,
        title TEXT NOT NULL,
        link TEXT NOT NULL DEFAULT '',
        published_at TEXT,
        content_html TEXT NOT NULL DEFAULT '',
        content_text TEXT NOT NULL DEFAULT '',
        rendered_html TEXT NOT NULL DEFAULT '',
        rendered_text TEXT NOT NULL DEFAULT '',
        fetched_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS deliveries (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        issue_id INTEGER NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
        subscriber_id INTEGER NOT NULL REFERENCES subscribers(id) ON DELETE CASCADE,
        status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sent', 'failed')),
        provider_id TEXT,
        error TEXT,
        sent_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(issue_id, subscriber_id)
      );

      CREATE TABLE IF NOT EXISTS feed_state (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        etag TEXT,
        last_modified TEXT,
        last_checked_at TEXT,
        last_success_at TEXT
      );

      INSERT OR IGNORE INTO feed_state (id) VALUES (1);
      CREATE INDEX IF NOT EXISTS idx_issues_published_at ON issues(published_at);
      CREATE INDEX IF NOT EXISTS idx_deliveries_issue_status ON deliveries(issue_id, status);
    `);
  }

  close(): void {
    this.db.close();
  }

  getFeedState(): FeedStateRecord {
    const row = this.db.prepare("SELECT * FROM feed_state WHERE id = 1").get() as SqlRow;
    return {
      id: 1,
      etag: asNullableString(row.etag),
      lastModified: asNullableString(row.last_modified),
      lastCheckedAt: asNullableString(row.last_checked_at),
      lastSuccessAt: asNullableString(row.last_success_at),
    };
  }

  updateFeedState(values: Partial<Omit<FeedStateRecord, "id">>): void {
    const current = this.getFeedState();
    this.db.prepare(`
      UPDATE feed_state
      SET etag = ?, last_modified = ?, last_checked_at = ?, last_success_at = ?
      WHERE id = 1
    `).run(
      values.etag === undefined ? current.etag : values.etag,
      values.lastModified === undefined ? current.lastModified : values.lastModified,
      values.lastCheckedAt === undefined ? current.lastCheckedAt : values.lastCheckedAt,
      values.lastSuccessAt === undefined ? current.lastSuccessAt : values.lastSuccessAt,
    );
  }

  countIssues(): number {
    const row = this.db.prepare("SELECT COUNT(*) AS count FROM issues").get() as SqlRow;
    return asNumber(row.count);
  }

  insertIssue(issue: ParsedFeedIssue, renderedHtml: string, renderedText: string): InsertIssueResult {
    const existing = this.db.prepare("SELECT id FROM issues WHERE guid = ?").get(issue.guid) as SqlRow | undefined;
    if (existing) return { id: asNumber(existing.id), isNew: false };

    const result = this.db.prepare(`
      INSERT INTO issues (guid, title, link, published_at, content_html, content_text, rendered_html, rendered_text, fetched_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      issue.guid,
      issue.title,
      issue.link,
      issue.publishedAt,
      issue.contentHtml,
      issue.contentText,
      renderedHtml,
      renderedText,
      nowIso(),
    ) as { lastInsertRowid: number | bigint };
    return { id: asNumber(result.lastInsertRowid), isNew: true };
  }

  getIssueById(id: number): IssueRecord | null {
    const row = this.db.prepare("SELECT * FROM issues WHERE id = ?").get(id) as SqlRow | undefined;
    return row ? this.mapIssue(row) : null;
  }

  getIssueByGuid(guid: string): IssueRecord | null {
    const row = this.db.prepare("SELECT * FROM issues WHERE guid = ?").get(guid) as SqlRow | undefined;
    return row ? this.mapIssue(row) : null;
  }

  getLatestIssue(): IssueRecord | null {
    const row = this.db.prepare(`
      SELECT * FROM issues
      ORDER BY COALESCE(published_at, fetched_at) DESC, id DESC
      LIMIT 1
    `).get() as SqlRow | undefined;
    return row ? this.mapIssue(row) : null;
  }

  getIssuesByIds(ids: number[]): IssueRecord[] {
    return ids.map((id) => this.getIssueById(id)).filter((issue): issue is IssueRecord => issue !== null);
  }

  /** Issues with a pending/failed recipient row that should be retried. */
  getIssuesWithRetryableDeliveries(): IssueRecord[] {
    const rows = this.db.prepare(`
      SELECT DISTINCT i.*
      FROM issues i
      INNER JOIN deliveries d ON d.issue_id = i.id
      INNER JOIN subscribers s ON s.id = d.subscriber_id AND s.active = 1
      WHERE d.status IN ('pending', 'failed')
      ORDER BY COALESCE(i.published_at, i.fetched_at) ASC, i.id ASC
    `).all() as SqlRow[];
    return rows.map((row) => this.mapIssue(row));
  }

  private mapIssue(row: SqlRow): IssueRecord {
    return {
      id: asNumber(row.id),
      guid: String(row.guid),
      title: String(row.title),
      link: String(row.link ?? ""),
      publishedAt: asNullableString(row.published_at),
      contentHtml: String(row.content_html ?? ""),
      contentText: String(row.content_text ?? ""),
      renderedHtml: String(row.rendered_html ?? ""),
      renderedText: String(row.rendered_text ?? ""),
      fetchedAt: String(row.fetched_at),
    };
  }

  upsertSubscriber(email: string): SubscriberRecord {
    const normalized = normalizeEmail(email);
    const timestamp = nowIso();
    this.db.prepare(`
      INSERT INTO subscribers (email, active, created_at, updated_at)
      VALUES (?, 1, ?, ?)
      ON CONFLICT(email) DO UPDATE SET active = 1, updated_at = excluded.updated_at
    `).run(normalized, timestamp, timestamp);
    return this.getSubscriber(normalized) as SubscriberRecord;
  }

  removeSubscriber(email: string): boolean {
    const normalized = normalizeEmail(email);
    const result = this.db.prepare("UPDATE subscribers SET active = 0, updated_at = ? WHERE email = ?").run(nowIso(), normalized) as { changes: number | bigint };
    return asNumber(result.changes) > 0;
  }

  getSubscriber(email: string): SubscriberRecord | null {
    const normalized = normalizeEmail(email);
    const row = this.db.prepare("SELECT * FROM subscribers WHERE email = ?").get(normalized) as SqlRow | undefined;
    return row ? this.mapSubscriber(row) : null;
  }

  listSubscribers(includeInactive = false): SubscriberRecord[] {
    const query = includeInactive
      ? "SELECT * FROM subscribers ORDER BY email"
      : "SELECT * FROM subscribers WHERE active = 1 ORDER BY email";
    const rows = this.db.prepare(query).all() as SqlRow[];
    return rows.map((row) => this.mapSubscriber(row));
  }

  private mapSubscriber(row: SqlRow): SubscriberRecord {
    return {
      id: asNumber(row.id),
      email: String(row.email),
      active: Number(row.active) === 1,
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
    };
  }

  ensureDelivery(issueId: number, subscriberId: number): DeliveryRecord {
    const timestamp = nowIso();
    this.db.prepare(`
      INSERT OR IGNORE INTO deliveries (issue_id, subscriber_id, status, created_at, updated_at)
      VALUES (?, ?, 'pending', ?, ?)
    `).run(issueId, subscriberId, timestamp, timestamp);
    const row = this.db.prepare("SELECT * FROM deliveries WHERE issue_id = ? AND subscriber_id = ?").get(issueId, subscriberId) as SqlRow;
    return this.mapDelivery(row);
  }

  getDelivery(issueId: number, subscriberId: number): DeliveryRecord | null {
    const row = this.db.prepare(
      "SELECT * FROM deliveries WHERE issue_id = ? AND subscriber_id = ?",
    ).get(issueId, subscriberId) as SqlRow | undefined;
    return row ? this.mapDelivery(row) : null;
  }

  resetDeliveryForRetry(id: number): void {
    this.db.prepare("UPDATE deliveries SET status = 'pending', error = NULL, updated_at = ? WHERE id = ? AND status = 'failed'").run(nowIso(), id);
  }

  markDeliverySent(id: number, providerId: string | null): void {
    const timestamp = nowIso();
    this.db.prepare(`
      UPDATE deliveries
      SET status = 'sent', provider_id = ?, error = NULL, sent_at = ?, updated_at = ?
      WHERE id = ?
    `).run(providerId, timestamp, timestamp, id);
  }

  markDeliveryFailed(id: number, error: string): void {
    this.db.prepare("UPDATE deliveries SET status = 'failed', error = ?, updated_at = ? WHERE id = ?").run(error.slice(0, 4_000), nowIso(), id);
  }

  private mapDelivery(row: SqlRow): DeliveryRecord {
    return {
      id: asNumber(row.id),
      issueId: asNumber(row.issue_id),
      subscriberId: asNumber(row.subscriber_id),
      status: String(row.status) as DeliveryStatus,
      providerId: asNullableString(row.provider_id),
      error: asNullableString(row.error),
      sentAt: asNullableString(row.sent_at),
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
    };
  }
}

export function normalizeEmail(email: string): string {
  const normalized = email.trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized)) {
    throw new Error(`Invalid email address: ${email}`);
  }
  return normalized;
}
