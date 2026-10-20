import { test } from "node:test";
import assert from "node:assert/strict";
import { parseInboundEmail, sendEmailNotification, splitTopicAndSecret } from "../src/email.ts";

const MIME = [
  "From: Alice <alice@example.com>",
  "To: alerts+sekrit@t.huanjue.me",
  "Subject: =?UTF-8?B?5pyN5Yqh5Zmo5oql6K2m?=",
  "MIME-Version: 1.0",
  "Content-Type: multipart/alternative; boundary=XYZ",
  "",
  "--XYZ",
  "Content-Type: text/plain; charset=utf-8",
  "Content-Transfer-Encoding: base64",
  "",
  Buffer.from("CPU 使用率超过 90%\n请及时处理", "utf8").toString("base64"),
  "--XYZ",
  "Content-Type: text/html; charset=utf-8",
  "",
  "<p>CPU 使用率超过 90%</p>",
  "--XYZ--",
  "",
].join("\r\n");

test("inbound: parses encoded subject and base64 text part", async () => {
  const { subject, text } = await parseInboundEmail(new TextEncoder().encode(MIME).buffer as ArrayBuffer);
  assert.equal(subject, "服务器报警");
  assert.match(text, /CPU 使用率超过 90%/);
  assert.match(text, /请及时处理/);
});

test("inbound: html-only mail falls back to stripped html", async () => {
  const htmlOnly = ["From: a@b.c", "Subject: Hi", "Content-Type: text/html; charset=utf-8", "", "<p>Hello <b>world</b></p>"].join("\r\n");
  const { subject, text } = await parseInboundEmail(new TextEncoder().encode(htmlOnly).buffer as ArrayBuffer);
  assert.equal(subject, "Hi");
  assert.equal(text, "Hello world");
});

test("address split: topic+secret", () => {
  assert.deepEqual(splitTopicAndSecret("alerts+sekrit"), { topic: "alerts", secret: "sekrit" });
  assert.deepEqual(splitTopicAndSecret("alerts"), { topic: "alerts" });
});

test("outbound: posts to Resend with filtered/deduped targets", async () => {
  const calls: any[] = [];
  const origFetch = globalThis.fetch;
  globalThis.fetch = async (url: any, init: any) => {
    calls.push({ url, init });
    return new Response("{}", { status: 200 });
  };
  try {
    const env: any = { RESEND_API_KEY: "rk_test", EMAIL_FROM: "ntfy@huanjue.me" };
    const msg: any = { topic: "alerts", title: "磁盘满了", message: "/data 已用 99%", priority: 4, tags: ["warning"] };
    await sendEmailNotification(env, msg, "a@x.com, bad-address, a@x.com, b@y.org");
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, "https://api.resend.com/emails");
    const body = JSON.parse(calls[0].init.body);
    assert.deepEqual(body.to, ["a@x.com", "b@y.org"]);
    assert.equal(body.subject, "磁盘满了");
    assert.match(body.text, /已用 99%/);
    assert.match(body.text, /Topic: alerts/);
    assert.equal(calls[0].init.headers.authorization, "Bearer rk_test");
  } finally {
    globalThis.fetch = origFetch;
  }
});

test("outbound: no valid targets -> no request", async () => {
  let called = 0;
  const origFetch = globalThis.fetch;
  globalThis.fetch = async () => { called++; return new Response("{}", { status: 200 }); };
  try {
    await sendEmailNotification({ RESEND_API_KEY: "k", EMAIL_FROM: "f@x.c" } as any, { topic: "t", message: "m" } as any, "not-an-email");
    assert.equal(called, 0);
  } finally {
    globalThis.fetch = origFetch;
  }
});
