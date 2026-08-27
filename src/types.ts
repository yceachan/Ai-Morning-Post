export type NewsletterMode = "full" | "compact";

export interface FeedConfig {
  url: string;
  userAgent: string;
  timeoutMs: number;
}

export interface DatabaseConfig {
  path: string;
}

export interface EmailConfig {
  host: string;
  port: number;
  secure: boolean;
  username?: string;
  password?: string;
  from?: string;
  fromName: string;
  subjectPrefix: string;
  mode: NewsletterMode;
}

export interface AppConfig {
  feed: FeedConfig;
  database: DatabaseConfig;
  email: EmailConfig;
}

export interface IssueRecord {
  id: number;
  guid: string;
  title: string;
  link: string;
  publishedAt: string | null;
  contentHtml: string;
  contentText: string;
  renderedHtml: string;
  renderedText: string;
  fetchedAt: string;
}

export interface SubscriberRecord {
  id: number;
  email: string;
  active: boolean;
  createdAt: string;
  updatedAt: string;
}

export type DeliveryStatus = "pending" | "sent" | "failed";

export interface DeliveryRecord {
  id: number;
  issueId: number;
  subscriberId: number;
  status: DeliveryStatus;
  providerId: string | null;
  error: string | null;
  sentAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface FeedStateRecord {
  id: number;
  etag: string | null;
  lastModified: string | null;
  lastCheckedAt: string | null;
  lastSuccessAt: string | null;
}

export interface ParsedFeedIssue {
  guid: string;
  title: string;
  link: string;
  publishedAt: string | null;
  contentHtml: string;
  contentText: string;
}

export interface FetchResult {
  status: "not-modified" | "updated";
  fetched: number;
  inserted: number;
  issueIds: number[];
  firstFetch: boolean;
}

export interface SendResult {
  issueId: number;
  attempted: number;
  sent: number;
  failed: number;
}
