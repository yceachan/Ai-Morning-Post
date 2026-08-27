import { strict as assert } from "node:assert";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { loadConfig } from "../src/config.js";
import { Store } from "../src/db.js";
import { sendIssue, type Mailer, type OutgoingMessage } from "../src/mailer.js";
import { renderIssueContent } from "../src/render.js";
import { fetchAndStore, parseFeed } from "../src/rss.js";
import { runCli } from "../src/cli.js";

const sampleXml = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:content="http://purl.org/rss/1.0/modules/content/">
  <channel><title>AI Morning Post</title>
    <item>
      <title><![CDATA[Issue Two]]></title>
      <link>https://daily.juya.uk/issues/two</link>
      <guid>issue-two</guid>
      <pubDate>Thu, 27 Aug 2026 01:00:00 GMT</pubDate>
      <content:encoded><![CDATA[<p>Hello <strong>world</strong>.</p><script>alert('x')</script><img src="/image.png" onerror="bad()" />]]></content:encoded>
    </item>
    <item>
      <title>Issue One</title><link>/issues/one</link><pubDate>Wed, 26 Aug 2026 01:00:00 GMT</pubDate>
      <description><![CDATA[<p>Fallback description</p>]]></description>
    </item>
  </channel>
</rss>`;

function tempPath(suffix: string): { directory: string; path: string } {
  const directory = mkdtempSync(join(tmpdir(), "ai-morning-post-test-"));
  return { directory, path: join(directory, suffix) };
}

test("config resolves exact environment references without persisting secrets", () => {
  const { directory, path } = tempPath("config.toml");
  writeFileSync(path, `
[feed]
url = "https://example.test/rss.xml"
[database]
path = "newsletter.sqlite"
[email]
username = "$QQ_USER"
password = "${"$"}{QQ_PASSWORD}"
from = "$QQ_USER"
`);
  const config = loadConfig(path, { QQ_USER: "yceachan@qq.com", QQ_PASSWORD: "secret" });
  assert.equal(config.email.username, "yceachan@qq.com");
  assert.equal(config.email.password, "secret");
  assert.equal(config.database.path, join(directory, "newsletter.sqlite"));
  assert.equal(readFileSync(path, "utf8").includes("secret"), false);
  rmSync(directory, { recursive: true, force: true });
});

test("RSS parser handles content:encoded and renderer removes active content", () => {
  const issues = parseFeed(sampleXml, "https://daily.juya.uk/rss.xml");
  assert.equal(issues.length, 2);
  assert.equal(issues[0].guid, "issue-two");
  assert.match(issues[0].contentHtml, /Hello/);
  const rendered = renderIssueContent(issues[0].contentHtml, {
    title: issues[0].title,
    link: issues[0].link,
    publishedAt: issues[0].publishedAt,
    baseUrl: "https://daily.juya.uk/rss.xml",
  });
  assert.doesNotMatch(rendered.html, /<script/i);
  assert.doesNotMatch(rendered.html, /onerror/i);
  assert.match(rendered.html, /https:\/\/daily\.juya\.uk\/image\.png/);
  assert.match(rendered.text, /Hello world/);
});

test("fetch uses conditional headers and persists issues/feed state", async () => {
  const { directory } = tempPath("db.sqlite");
  const store = new Store(join(directory, "db.sqlite"));
  let requestCount = 0;
  let secondHeaders: Headers | undefined;
  const fetchImpl: typeof fetch = async (_url, init) => {
    requestCount += 1;
    if (requestCount === 2) {
      secondHeaders = init?.headers instanceof Headers ? init.headers : new Headers(init?.headers);
      return new Response(null, { status: 304 });
    }
    return new Response(sampleXml, { status: 200, headers: { etag: '"feed-v1"', "last-modified": "Thu, 27 Aug 2026 01:00:00 GMT" } });
  };
  const feed = { url: "https://daily.juya.uk/rss.xml", userAgent: "test", timeoutMs: 2_000 };
  const first = await fetchAndStore(feed, store, "full", { fetchImpl });
  assert.equal(first.inserted, 2);
  assert.equal(first.firstFetch, true);
  assert.equal(store.countIssues(), 2);
  const second = await fetchAndStore(feed, store, "full", { fetchImpl });
  assert.equal(second.status, "not-modified");
  assert.equal(second.inserted, 0);
  assert.equal(secondHeaders?.get("if-none-match"), '"feed-v1"');
  assert.equal(store.getFeedState().lastSuccessAt !== null, true);
  store.close();
  rmSync(directory, { recursive: true, force: true });
});

test("delivery rows prevent duplicate sends and retry failed sends", async () => {
  const { directory } = tempPath("db.sqlite");
  const store = new Store(join(directory, "db.sqlite"));
  const subscriber = store.upsertSubscriber("YCEACHAN@FOXMAIL.COM");
  const issueData = {
    guid: "delivery-issue",
    title: "Delivery issue",
    link: "https://example.test/issue",
    publishedAt: new Date().toISOString(),
    contentHtml: "<p>Body</p>",
    contentText: "Body",
  };
  const inserted = store.insertIssue(issueData, "<p>Body</p>", "Body");
  const issue = store.getIssueById(inserted.id);
  assert.ok(issue);
  const sentMessages: OutgoingMessage[] = [];
  const mailer: Mailer = {
    async send(message) {
      sentMessages.push(message);
      return { messageId: "provider-id" };
    },
  };
  const first = await sendIssue(store, issue, mailer, "AI Morning Post");
  assert.deepEqual(first, { issueId: issue.id, attempted: 1, sent: 1, failed: 0 });
  const second = await sendIssue(store, issue, mailer, "AI Morning Post");
  assert.deepEqual(second, { issueId: issue.id, attempted: 0, sent: 0, failed: 0 });
  assert.equal(sentMessages.length, 1);
  assert.equal(sentMessages[0].to, subscriber.email);
  assert.match(sentMessages[0].messageId, /^amp-/);
  store.close();
  rmSync(directory, { recursive: true, force: true });
});

test("a failed retry does not backfill an old issue to a newly added subscriber", async () => {
  const { directory } = tempPath("db.sqlite");
  const store = new Store(join(directory, "db.sqlite"));
  store.upsertSubscriber("first@example.com");
  const inserted = store.insertIssue({
    guid: "old-retry",
    title: "Old retry",
    link: "https://example.test/old",
    publishedAt: new Date().toISOString(),
    contentHtml: "<p>Body</p>",
    contentText: "Body",
  }, "<p>Body</p>", "Body");
  const issue = store.getIssueById(inserted.id);
  assert.ok(issue);

  await sendIssue(store, issue, { async send() { throw new Error("temporary"); } }, "AMP");
  store.upsertSubscriber("second@example.com");
  const retried: string[] = [];
  await sendIssue(store, issue, { async send(message) { retried.push(message.to); return {}; } }, "AMP");
  assert.deepEqual(retried, ["first@example.com"]);

  const explicit: string[] = [];
  await sendIssue(
    store,
    issue,
    { async send(message) { explicit.push(message.to); return {}; } },
    "AMP",
    { includeAllActiveSubscribers: true },
  );
  assert.deepEqual(explicit, ["second@example.com"]);
  store.close();
  rmSync(directory, { recursive: true, force: true });
});

test("run dry-run never creates a mailer or delivery rows", async () => {
  const { directory, path: configPath } = tempPath("config.toml");
  const dbPath = join(directory, "db.sqlite");
  writeFileSync(configPath, `[feed]\nurl = "https://daily.juya.uk/rss.xml"\n[database]\npath = "${dbPath.replaceAll("\\", "/")}\"\n`);
  const output: string[] = [];
  let mailerCalled = false;
  const result = await runCli(["--config", configPath, "run", "--dry-run"], {
    fetchImpl: async () => new Response(sampleXml, { status: 200 }),
    mailer: {
      async send() {
        mailerCalled = true;
        return {};
      },
    },
    stdout: (message) => output.push(message),
  });
  assert.equal(result, 0);
  assert.equal(mailerCalled, false);
  assert.match(output.join(""), /Dry-run/);
  const store = new Store(dbPath);
  const deliveryCount = Number((store.db.prepare("SELECT COUNT(*) AS count FROM deliveries").get() as { count: number }).count);
  assert.equal(deliveryCount, 0);
  store.close();
  rmSync(directory, { recursive: true, force: true });
});

test("run retries failed deliveries when RSS returns 304", async () => {
  const { directory, path: configPath } = tempPath("config.toml");
  const dbPath = join(directory, "db.sqlite");
  writeFileSync(configPath, `[feed]\nurl = "https://daily.juya.uk/rss.xml"\n[database]\npath = "${dbPath.replaceAll("\\", "/")}\"\n`);
  const store = new Store(dbPath);
  const subscriber = store.upsertSubscriber("yceachan@foxmail.com");
  const inserted = store.insertIssue({
    guid: "retry-issue",
    title: "Retry issue",
    link: "https://example.test/retry",
    publishedAt: new Date().toISOString(),
    contentHtml: "<p>Body</p>",
    contentText: "Body",
  }, "<p>Body</p>", "Body");
  const delivery = store.ensureDelivery(inserted.id, subscriber.id);
  store.markDeliveryFailed(delivery.id, "temporary");
  store.updateFeedState({ etag: '"same"' });
  store.close();

  const sent: OutgoingMessage[] = [];
  const result = await runCli(["--config", configPath, "run"], {
    fetchImpl: async () => new Response(null, { status: 304 }),
    mailer: { async send(message) { sent.push(message); return { messageId: "retry-ok" }; } },
  });
  assert.equal(result, 0);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].to, "yceachan@foxmail.com");
  rmSync(directory, { recursive: true, force: true });
});
