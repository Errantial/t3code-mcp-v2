import test from "node:test";
import assert from "node:assert/strict";
import {
  MAX_MESSAGE_CHARS_ENV,
  MESSAGE_DEFAULTS,
  envMaxChars,
  resolveMaxChars,
  sliceMessage,
} from "../dist/message.js";
import { messageRow } from "../dist/format.js";
import { registerPhase1 } from "../dist/tools/phase1.js";
import { registerPhase2 } from "../dist/tools/phase2.js";
import { registerPhase3 } from "../dist/tools/phase3.js";

const now = "2026-10-30T12:00:00.000Z";
const message = (id, text, role = "assistant") => ({
  id,
  role,
  text,
  turnId: "r1",
  createdAt: now,
  updatedAt: now,
});
const value = (result) => JSON.parse(result.content[0].text);
const extra = () => ({ signal: new AbortController().signal });
const longText = (n) =>
  Array.from({ length: n }, (_, i) => String.fromCharCode(97 + (i % 26))).join("");

function withEnv(value, fn) {
  const previous = process.env[MAX_MESSAGE_CHARS_ENV];
  process.env[MAX_MESSAGE_CHARS_ENV] = value;
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      if (previous === undefined) delete process.env[MAX_MESSAGE_CHARS_ENV];
      else process.env[MAX_MESSAGE_CHARS_ENV] = previous;
    });
}

function fakeClient({ messages = [], pages = {} } = {}) {
  const thread = {
    id: "t",
    projectId: "p",
    title: "fixture",
    createdAt: now,
    updatedAt: now,
    runtimeMode: "approval-required",
    interactionMode: "default",
    session: { threadId: "t", status: "idle" },
    latestTurn: { turnId: "r1", state: "completed" },
    pendingRequests: [],
    activities: [],
    messages,
    runs: [{ id: "r1", status: "completed" }],
  };
  const snapshot = (list, page) => ({
    snapshotSequence: 1,
    thread: { ...thread, messages: list },
    page,
  });
  return {
    shell: async () => ({
      snapshotSequence: 1,
      projects: [{ id: "p", title: "p", workspaceRoot: "/tmp" }],
      threads: [],
      updatedAt: now,
    }),
    detail: async () => thread,
    thread: async (_threadId, opts = {}) => {
      if (opts.beforeCursor) {
        const page = pages[opts.beforeCursor];
        assert.ok(page, `unexpected cursor ${opts.beforeCursor}`);
        return snapshot(page.messages, {
          hasMore: false,
          beforeCursor: null,
        });
      }
      return snapshot(pages.first?.messages ?? messages, {
        hasMore: Boolean(pages.first?.hasMore),
        beforeCursor: pages.first?.beforeCursor ?? null,
      });
    },
    dispatch: async () => ({ sequence: 1 }),
  };
}

function handlers(client) {
  const map = new Map();
  const server = {
    registerTool(name, _definition, handler) {
      map.set(name, handler);
    },
  };
  for (const register of [registerPhase1, registerPhase2, registerPhase3])
    register(server, () => client);
  return map;
}

test("sliceMessage returns the whole message when it fits", () => {
  const m = message("m1", "hello world");
  const slice = sliceMessage(m, { maxChars: 100 });
  assert.deepEqual(slice, {
    messageId: "m1",
    role: "assistant",
    at: now,
    totalChars: 11,
    offset: 0,
    text: "hello world",
    nextOffset: null,
    truncated: false,
  });
});

test("sliceMessage slices by offset and caps without an ellipsis", () => {
  const text = longText(500);
  const m = message("m1", text);
  const first = sliceMessage(m, { maxChars: 120 });
  assert.equal(first.text, text.slice(0, 120));
  assert.equal(first.text.length, 120);
  assert.equal(first.offset, 0);
  assert.equal(first.totalChars, 500);
  assert.equal(first.nextOffset, 120);
  assert.equal(first.truncated, true);

  const second = sliceMessage(m, {
    offset: first.nextOffset,
    maxChars: 120,
  });
  assert.equal(second.text, text.slice(120, 240));
  assert.equal(second.offset, 120);
  assert.equal(second.nextOffset, 240);

  const last = sliceMessage(m, { offset: 480, maxChars: 120 });
  assert.equal(last.text, text.slice(480));
  assert.equal(last.nextOffset, null);
  assert.equal(last.truncated, false);
});

test("sliceMessage pages to exactly the original text", () => {
  const text = longText(1234);
  const m = message("m1", text);
  let offset = 0;
  let rebuilt = "";
  for (let guard = 0; guard < 100; guard++) {
    const slice = sliceMessage(m, { offset, maxChars: 100 });
    rebuilt += slice.text;
    if (slice.nextOffset === null) break;
    assert.ok(slice.nextOffset > offset, "nextOffset must advance");
    offset = slice.nextOffset;
  }
  assert.equal(rebuilt, text);
});

test("sliceMessage handles empty, exact-fit and past-the-end offsets", () => {
  const empty = sliceMessage(message("m0", ""), { maxChars: 10 });
  assert.equal(empty.totalChars, 0);
  assert.equal(empty.text, "");
  assert.equal(empty.nextOffset, null);
  assert.equal(empty.truncated, false);

  const exact = sliceMessage(message("m1", longText(50)), { maxChars: 50 });
  assert.equal(exact.text.length, 50);
  assert.equal(exact.nextOffset, null);
  assert.equal(exact.truncated, false);

  const past = sliceMessage(message("m1", "abc"), { offset: 99 });
  assert.equal(past.offset, 3);
  assert.equal(past.text, "");
  assert.equal(past.nextOffset, null);
  assert.equal(past.truncated, false);

  const negative = sliceMessage(message("m1", "abc"), { offset: -5 });
  assert.equal(negative.offset, 0);
  assert.equal(negative.text, "abc");
});

test("messageRow always exposes messageId, totalChars and truncated", () => {
  const short = messageRow(message("m1", "short"));
  assert.equal(short.messageId, "m1");
  assert.equal(short.totalChars, 5);
  assert.equal(short.truncated, false);
  assert.equal(short.text, "short");

  const long = messageRow(message("m2", longText(5000)));
  assert.equal(long.messageId, "m2");
  assert.equal(long.totalChars, 5000);
  assert.equal(long.truncated, true);
  assert.equal(long.text.length, MESSAGE_DEFAULTS.threadRow + 1); // + the ellipsis
  assert.equal(long.text.slice(0, -1), longText(5000).slice(0, 4000));

  const capped = messageRow(message("m3", longText(5000)), 10);
  assert.equal(capped.text, `${longText(5000).slice(0, 10)}…`);
  assert.equal(capped.truncated, true);
  assert.equal(capped.totalChars, 5000);
});

test(`${MAX_MESSAGE_CHARS_ENV} overrides defaults; explicit args still win`, async () => {
  await withEnv("25", () => {
    assert.equal(envMaxChars(), 25);
    // get_thread default cap now 25
    const row = messageRow(message("m1", longText(100)));
    assert.equal(row.text.length, 26);
    assert.equal(row.totalChars, 100);
    // explicit cap beats the env
    assert.equal(messageRow(message("m1", longText(100)), 5).text.length, 6);
    // get_message default cap now 25
    assert.equal(sliceMessage(message("m1", longText(100))).text.length, 25);
    assert.equal(
      sliceMessage(message("m1", longText(100)), { maxChars: 7 }).text.length,
      7,
    );
  });
});

test("invalid or blank env values fall back to built-in defaults", async () => {
  for (const raw of ["", "0", "-3", "abc", "1.5"]) {
    await withEnv(raw, () => {
      assert.equal(envMaxChars(), undefined, `raw=${JSON.stringify(raw)}`);
      assert.equal(
        resolveMaxChars(MESSAGE_DEFAULTS.threadRow),
        MESSAGE_DEFAULTS.threadRow,
      );
    });
  }
  delete process.env[MAX_MESSAGE_CHARS_ENV];
  assert.equal(envMaxChars(), undefined);
});

test("resolveMaxChars clamps to the 100000 ceiling", () => {
  assert.equal(resolveMaxChars(MESSAGE_DEFAULTS.getMessage, 500_000), 100_000);
});

test("get_thread honours maxChars per message", async () => {
  const client = fakeClient({ messages: [message("m1", longText(9000))] });
  const tools = handlers(client);
  const def = value(await tools.get("get_thread")({ threadId: "t" }));
  assert.equal(def.messages[0].messageId, "m1");
  assert.equal(def.messages[0].totalChars, 9000);
  assert.equal(def.messages[0].truncated, true);
  assert.equal(def.messages[0].text.length, MESSAGE_DEFAULTS.threadRow + 1);

  const wide = value(
    await tools.get("get_thread")({ threadId: "t", maxChars: 9000 }),
  );
  assert.equal(wide.messages[0].truncated, false);
  assert.equal(wide.messages[0].text, longText(9000));
});

test("get_message returns slices and a terminating nextOffset chain", async () => {
  const text = longText(25_000);
  const client = fakeClient({ messages: [message("m1", text)] });
  const tools = handlers(client);

  const first = value(
    await tools.get("get_message")({ threadId: "t", messageId: "m1" }),
  );
  assert.equal(first.messageId, "m1");
  assert.equal(first.role, "assistant");
  assert.equal(first.at, now);
  assert.equal(first.totalChars, 25_000);
  assert.equal(first.offset, 0);
  assert.equal(first.text.length, MESSAGE_DEFAULTS.getMessage);
  assert.equal(first.nextOffset, MESSAGE_DEFAULTS.getMessage);
  assert.equal(first.truncated, true);

  const second = value(
    await tools.get("get_message")({
      threadId: "t",
      messageId: "m1",
      offset: first.nextOffset,
    }),
  );
  assert.equal(second.offset, 20_000);
  assert.equal(second.text, text.slice(20_000));
  assert.equal(second.nextOffset, null);
  assert.equal(second.truncated, false);
  assert.equal(first.text + second.text, text);
});

test("get_message pages back when the message is outside the recent window", async () => {
  const client = fakeClient({
    pages: {
      first: {
        messages: [message("m-recent", "recent")],
        hasMore: true,
        beforeCursor: "c1",
      },
      c1: { messages: [message("m-old", longText(300))] },
    },
  });
  const tools = handlers(client);
  const slice = value(
    await tools.get("get_message")({
      threadId: "t",
      messageId: "m-old",
      maxChars: 100,
    }),
  );
  assert.equal(slice.messageId, "m-old");
  assert.equal(slice.totalChars, 300);
  assert.equal(slice.text, longText(300).slice(0, 100));
  assert.equal(slice.nextOffset, 100);
});

test("get_message reports an unknown id instead of guessing", async () => {
  const client = fakeClient({ messages: [message("m1", "short")] });
  const tools = handlers(client);
  const result = await tools.get("get_message")({
    threadId: "t",
    messageId: "nope",
  });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /No message nope/);
});

test("wait_for_turn caps the reply and honours maxChars", async () => {
  const text = longText(9000);
  const client = fakeClient({
    messages: [message("m-long", text)],
  });
  const tools = handlers(client);

  const def = value(
    await tools.get("wait_for_turn")({ threadId: "t", runId: "r1" }, extra()),
  );
  assert.equal(def.outcome, "completed");
  assert.equal(def.reply.messageId, "m-long");
  assert.equal(def.reply.totalChars, 9000);
  assert.equal(def.reply.truncated, true);
  assert.equal(def.reply.text.length, MESSAGE_DEFAULTS.waitReply + 1);

  const wide = value(
    await tools.get("wait_for_turn")(
      { threadId: "t", runId: "r1", maxChars: 9000 },
      extra(),
    ),
  );
  assert.equal(wide.reply.truncated, false);
  assert.equal(wide.reply.text, text);
});

test("wait_for_turn reply default follows the env override", async () => {
  await withEnv("40", async () => {
    const client = fakeClient({ messages: [message("m-long", longText(500))] });
    const tools = handlers(client);
    const result = value(
      await tools.get("wait_for_turn")({ threadId: "t", runId: "r1" }, extra()),
    );
    assert.equal(result.reply.text.length, 41);
    assert.equal(result.reply.totalChars, 500);
  });
});
