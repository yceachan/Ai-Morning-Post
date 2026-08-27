import { createHash } from "node:crypto";
import nodemailer from "nodemailer";
import { assertEmailConfig } from "./config.js";
import type { EmailConfig, IssueRecord, SendResult } from "./types.js";
import { Store } from "./db.js";

export interface OutgoingMessage {
  to: string;
  subject: string;
  html: string;
  text: string;
  messageId: string;
}

export interface Mailer {
  send(message: OutgoingMessage): Promise<{ messageId?: string }>;
}

export interface SmtpTransportLike {
  sendMail(message: OutgoingMessage & { from: string; headers: Record<string, string> }): Promise<{ messageId?: string }>;
  close?: () => void;
}

export class SmtpMailer implements Mailer {
  private readonly transport: SmtpTransportLike;
  private readonly from: string;

  constructor(config: EmailConfig, transport?: SmtpTransportLike) {
    assertEmailConfig(config);
    this.from = formatFrom(config.from, config.fromName);
    this.transport = transport ?? nodemailer.createTransport({
      host: config.host,
      port: config.port,
      secure: config.secure,
      auth: { user: config.username, pass: config.password },
    }) as unknown as SmtpTransportLike;
  }

  async send(message: OutgoingMessage): Promise<{ messageId?: string }> {
    return this.transport.sendMail({
      ...message,
      from: this.from,
      headers: {
        "X-AI-Morning-Post-Issue": message.messageId,
      },
    });
  }

  close(): void {
    this.transport.close?.();
  }
}

function formatFrom(address: string, name: string): string {
  const safeName = name.replace(/[\r\n]/g, " ").trim();
  return safeName ? `"${safeName.replace(/"/g, "'")}" <${address}>` : address;
}

function stableMessageId(issue: IssueRecord, subscriberEmail: string): string {
  // Deterministic IDs allow a retry to be recognized by a mail client and make
  // logs easier to correlate. The DB unique(issue, subscriber) row remains the
  // authoritative duplicate-send guard.
  const subscriberHash = createHash("sha256").update(subscriberEmail).digest("hex").slice(0, 16);
  const safeGuid = issue.guid.replace(/[^a-z0-9]+/gi, "-").replace(/^-|-$/g, "").slice(0, 100);
  return `amp-${issue.id}-${safeGuid}-${subscriberHash}@ai-morning-post.local`;
}

function subjectFor(issue: IssueRecord, prefix: string): string {
  const cleanPrefix = prefix.trim();
  return cleanPrefix ? `[${cleanPrefix}] ${issue.title}` : issue.title;
}

export async function sendIssue(
  store: Store,
  issue: IssueRecord,
  mailer: Mailer,
  subjectPrefix: string,
  options: { includeAllActiveSubscribers?: boolean } = {},
): Promise<SendResult> {
  const subscribers = store.listSubscribers();
  const existingDeliveries = new Map(
    subscribers.map((subscriber) => [subscriber.id, store.getDelivery(issue.id, subscriber.id)]),
  );
  const hasExistingDeliveries = [...existingDeliveries.values()].some((delivery) => delivery !== null);
  const targets = options.includeAllActiveSubscribers || !hasExistingDeliveries
    ? subscribers
    : subscribers.filter((subscriber) => existingDeliveries.get(subscriber.id) !== null);
  let sent = 0;
  let failed = 0;
  let attempted = 0;
  for (const subscriber of targets) {
    const delivery = store.ensureDelivery(issue.id, subscriber.id);
    if (delivery.status === "sent") continue;
    attempted += 1;
    if (delivery.status === "failed") store.resetDeliveryForRetry(delivery.id);
    const outgoing: OutgoingMessage = {
      to: subscriber.email,
      subject: subjectFor(issue, subjectPrefix),
      html: issue.renderedHtml,
      text: issue.renderedText,
      messageId: stableMessageId(issue, subscriber.email),
    };
    try {
      const result = await mailer.send(outgoing);
      store.markDeliverySent(delivery.id, result.messageId ?? outgoing.messageId);
      sent += 1;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      store.markDeliveryFailed(delivery.id, message);
      failed += 1;
    }
  }
  return { issueId: issue.id, attempted, sent, failed };
}

export function createSmtpMailer(config: EmailConfig): SmtpMailer {
  return new SmtpMailer(config);
}
