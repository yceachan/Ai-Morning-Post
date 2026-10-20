import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { runCli } from "../src/cli.js";
import { loadConfig } from "../src/config.js";
import { Store } from "../src/db.js";
import type { OutgoingMessage } from "../src/mailer.js";
import { discoverResetEvents, renderResetMessage, ResetStore, sendResetNotifications, type ResetEvent } from "../src/resets.js";

const checkpoint = "2026-10-20T01:00:00.000Z";
const executed: ResetEvent = {
  id: "old", kind: "executed", reset_type: "regular", announced_at: "2026-10-19T00:00:00.000Z",
  text: "Reset complete <script>alert(1)</script>", source: { type: "x_post", url: "https://x.com/thsottiaux/status/old" },
};
const scheduled: ResetEvent & { status: "scheduled" } = {
  ...executed, id: "new", kind: "scheduled", status: "scheduled",
  announced_at: "2026-10-20T00:30:00.000Z", scheduled_for: "2026-10-21T00:00:00.000Z", text: "Reset tomorrow",
};

function api(options: { latest?: ResetEvent | null; planned?: unknown; history?: ResetEvent[]; generatedAt?: string; watch?: unknown } = {}): typeof fetch {
  return async (input) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith("/status")) return Response.json({
      data: { latest_reset: options.latest === undefined ? executed : options.latest, scheduled_reset: options.planned ?? null, active_watch: options.watch ?? null },
      meta: { api_version: "v1", generated_at: options.generatedAt ?? checkpoint },
    });
    assert.ok(url.pathname.endsWith("/resets"));
    assert.equal(url.searchParams.get("from"), checkpoint);
    return Response.json({ data: options.history ?? [], pagination: { has_more: false, next_cursor: null } });
  };
}

test("initial baseline skips executed history and probability forecasts, but sends an existing plan", async () => {
  const store = new Store(":memory:");
  store.upsertSubscriber("weekday@example.com", 0);
  store.upsertSubscriber("inactive@example.com");
  store.removeSubscriber("inactive@example.com");
  const ledger = new ResetStore(store);
  try {
    await discoverResetEvents(ledger, { fetchImpl: api({ watch: { level: "strong" } }) });
    assert.equal(ledger.pending().length, 0);
    assert.equal(ledger.checkpoint(), checkpoint);
    await discoverResetEvents(ledger, { fetchImpl: api({ planned: scheduled }) });
    assert.deepEqual(ledger.pending().map((row) => row.email), ["weekday@example.com"], "reset messages ignore newsletter weekday masks");
  } finally { store.close(); }
});

test("scheduled announcements, revised times and execution have separate durable deduplication keys", async () => {
  const directory = mkdtempSync(join(tmpdir(), "amp-reset-test-"));
  const dbPath = join(directory, "db.sqlite");
  let store = new Store(dbPath);
  store.upsertSubscriber("person@example.com");
  let ledger = new ResetStore(store);
  const sent: OutgoingMessage[] = [];
  const mailer = { async send(message: OutgoingMessage) { sent.push(message); return {}; } };
  try {
    await discoverResetEvents(ledger, { fetchImpl: api() });
    await discoverResetEvents(ledger, { fetchImpl: api({ planned: scheduled }) });
    await sendResetNotifications(ledger, mailer);
    store.close();
    store = new Store(dbPath);
    ledger = new ResetStore(store);
    await discoverResetEvents(ledger, { fetchImpl: api({ planned: scheduled }) });
    assert.equal(ledger.pending().length, 0);
    assert.equal((await discoverResetEvents(ledger, { fetchImpl: api({ planned: scheduled }), dryRun: true })).discovered, 0);
    const revised = { ...scheduled, scheduled_for: "2026-10-22T00:00:00Z" };
    await discoverResetEvents(ledger, { fetchImpl: api({ planned: revised }) });
    await sendResetNotifications(ledger, mailer);
    const complete: ResetEvent = { ...executed, id: scheduled.id, announced_at: scheduled.announced_at };
    await discoverResetEvents(ledger, { fetchImpl: api({ latest: complete, history: [complete] }) });
    await sendResetNotifications(ledger, mailer);
    assert.equal(sent.length, 3);
    assert.equal(new Set(sent.map((message) => message.messageId)).size, 3);
  } finally { store.close(); rmSync(directory, { recursive: true, force: true }); }
});

test("missed reset history is paginated before advancing the checkpoint", async () => {
  const store = new Store(":memory:");
  const ledger = new ResetStore(store);
  store.upsertSubscriber("person@example.com");
  try {
    await discoverResetEvents(ledger, { fetchImpl: api() });
    const first = { ...executed, id: "first", announced_at: "2026-10-20T02:00:00Z" };
    const second = { ...first, id: "second", reset_type: "banked" as const };
    const requests: URL[] = [];
    await discoverResetEvents(ledger, { fetchImpl: async (input, init) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith("/status")) return api({ latest: second, generatedAt: "2026-10-20T03:00:00Z" })(input, init);
      requests.push(url);
      return Response.json(url.searchParams.has("cursor")
        ? { data: [second], pagination: { has_more: false, next_cursor: null } }
        : { data: [first], pagination: { has_more: true, next_cursor: "page2" } });
    } });
    assert.equal(requests.length, 2);
    assert.equal(requests[1].searchParams.get("cursor"), "page2");
    assert.equal(ledger.pending().length, 2);
    assert.equal(ledger.checkpoint(), "2026-10-20T03:00:00Z");
  } finally { store.close(); }
});

test("partial API failure leaves discovery state intact; invalid announcements fail explicitly", async () => {
  const store = new Store(":memory:");
  const ledger = new ResetStore(store);
  try {
    await discoverResetEvents(ledger, { fetchImpl: api() });
    await assert.rejects(discoverResetEvents(ledger, { fetchImpl: async (input, init) => {
      if (String(input).endsWith("/status")) return api({ planned: scheduled, generatedAt: "2026-10-20T03:00:00Z" })(input, init);
      return new Response(null, { status: 503 });
    } }), /HTTP 503/);
    assert.equal(ledger.checkpoint(), checkpoint);
    assert.equal(ledger.pending().length, 0);
    await assert.rejects(discoverResetEvents(ledger, { fetchImpl: api({ planned: { ...scheduled, scheduled_for: "broken" } }) }), /timestamp/);
    await assert.rejects(discoverResetEvents(ledger, { fetchImpl: api({ planned: { ...scheduled, source: { type: "x_post", url: "javascript:alert(1)" } } }) }), /source URL/);
  } finally { store.close(); }
});

test("dry-run preserves baseline and pending deliveries", async () => {
  const store = new Store(":memory:");
  const ledger = new ResetStore(store);
  try {
    await discoverResetEvents(ledger, { fetchImpl: api({ planned: scheduled }), dryRun: true });
    assert.equal(ledger.checkpoint(), null);
    assert.equal(ledger.pending().length, 0);
    assert.equal((store.db.prepare("SELECT count(*) AS n FROM reset_events").get() as { n: number }).n, 0);
  } finally { store.close(); }
});

test("failed SMTP recipients retry independently with stable Message-IDs", async () => {
  const store = new Store(":memory:");
  store.upsertSubscriber("good@example.com");
  store.upsertSubscriber("retry@example.com");
  const ledger = new ResetStore(store);
  try {
    await discoverResetEvents(ledger, { fetchImpl: api({ planned: scheduled }) });
    let retryMessageId = "";
    assert.deepEqual(await sendResetNotifications(ledger, { async send(message) {
      if (message.to === "retry@example.com") { retryMessageId = message.messageId; throw new Error("SMTP unavailable"); }
      return {};
    } }), { sent: 1, failed: 1 });
    assert.deepEqual(await sendResetNotifications(ledger, { async send(message) {
      assert.equal(message.to, "retry@example.com");
      assert.equal(message.messageId, retryMessageId);
      return {};
    } }), { sent: 1, failed: 0 });
    assert.equal(ledger.pending().length, 0);
  } finally { store.close(); }
});

test("email renders escaped source text, UTC+8 schedule, banked type and attribution", () => {
  const message = renderResetMessage({ ...scheduled, text: executed.text, reset_type: "banked" }, "person@example.com");
  assert.match(message.html, /&lt;script&gt;/);
  assert.doesNotMatch(message.html, /<script>/);
  assert.match(message.text, /2026\/10\/21 08:00（UTC\+8）/);
  assert.match(message.text, /banked/);
  assert.match(message.html, /href="https:\/\/codex-resets.com"/);
});

function cliFixture() {
  const directory = mkdtempSync(join(tmpdir(), "amp-reset-cli-"));
  const path = join(directory, "config.toml");
  const dbPath = join(directory, "db.sqlite");
  writeFileSync(path, `[database]\npath = "db.sqlite"\n[resets]\nenabled = true\n`);
  return { directory, path, dbPath };
}

test("reset acceptance email is restricted to the test address and leaves delivery ledgers untouched", async () => {
  const { directory, path, dbPath } = cliFixture();
  const store = new Store(dbPath);
  store.upsertSubscriber("other@example.com");
  store.close();
  const messages: OutgoingMessage[] = [];
  const deps = { fetchImpl: api(), stdout() {}, mailer: { async send(message: OutgoingMessage) { messages.push(message); return {}; } } };
  try {
    assert.equal(await runCli(["--config", path, "resets", "send-test"], deps), 0);
    assert.deepEqual(messages.map((message) => message.to), ["yceachan@foxmail.com"]);
    assert.match(messages[0].subject, /^\[TEST\]/);
    const verify = new Store(dbPath);
    const ledger = new ResetStore(verify);
    assert.equal(ledger.checkpoint(), null);
    assert.equal(ledger.pending().length, 0);
    verify.close();
    await assert.rejects(runCli(["--config", path, "resets", "send-test", "other@example.com"], deps), /recipient is fixed/);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("pending reset deliveries retry even when API is unavailable", async () => {
  const { directory, path, dbPath } = cliFixture();
  const store = new Store(dbPath);
  store.upsertSubscriber("person@example.com");
  await discoverResetEvents(new ResetStore(store), { fetchImpl: api({ planned: scheduled }) });
  store.close();
  const sent: string[] = [];
  try {
    await assert.rejects(runCli(["--config", path, "resets", "run"], {
      fetchImpl: async () => new Response(null, { status: 429 }), stdout() {},
      mailer: { async send(message) { sent.push(message.to); return {}; } },
    }), /HTTP 429/);
    assert.deepEqual(sent, ["person@example.com"]);
    const verify = new Store(dbPath);
    assert.equal(new ResetStore(verify).pending().length, 0);
    verify.close();
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("poll continues newsletter processing after reset API failure", async () => {
  const { directory, path } = cliFixture();
  const requested: string[] = [];
  try {
    assert.equal(await runCli(["--config", path, "poll"], {
      fetchImpl: async (input) => {
        const url = String(input);
        requested.push(url);
        return url.includes("codex-resets.com") ? new Response(null, { status: 503 }) : new Response(null, { status: 304 });
      }, stdout() {}, stderr() {},
    }), 1);
    assert.equal(requested.length, 2);
    assert.match(requested[1], /rss.xml/);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("reset notifications default to disabled and reject malformed enable flags", () => {
  const { directory, path } = cliFixture();
  try {
    writeFileSync(path, "");
    assert.equal(loadConfig(path).resets.enabled, false);
    writeFileSync(path, '[resets]\nenabled = "true"\n');
    assert.throws(() => loadConfig(path), /boolean/);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("poll dry-run propagates the flag to both jobs without sending or advancing reset state", async () => {
  const { directory, path, dbPath } = cliFixture();
  const setup = new Store(dbPath);
  setup.upsertSubscriber("person@example.com");
  setup.close();
  const messages: OutgoingMessage[] = [];
  const output: string[] = [];
  try {
    assert.equal(await runCli(["--config", path, "poll", "--dry-run"], {
      fetchImpl: async (input, init) => String(input).includes("codex-resets.com")
        ? api({ planned: scheduled })(input, init) : new Response(null, { status: 304 }),
      stdout(message) { output.push(message); },
      mailer: { async send(message) { messages.push(message); return {}; } },
    }), 0);
    assert.equal(messages.length, 0);
    assert.match(output.join(""), /Codex resets dry-run/);
    assert.match(output.join(""), /Dry-run: would process/);
    const verify = new Store(dbPath);
    assert.equal(new ResetStore(verify).checkpoint(), null);
    verify.close();
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
