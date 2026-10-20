import PostalMime from "postal-mime";
import type { Env, NtfyMessage } from "./runtime-types.js";

// ---------------------------------------------------------------------------
// Outbound: publish -> email notification, via the Resend API.
// Active only when both RESEND_API_KEY and EMAIL_FROM are configured.
// Triggered by the X-Email / Email publish header (or the "email" JSON field),
// mirroring upstream ntfy's behavior.
// ---------------------------------------------------------------------------

export function emailNotifyConfigured(env: Env): boolean {
  return Boolean(env.RESEND_API_KEY && env.EMAIL_FROM);
}

const EMAIL_RE = /^[^\s@,]+@[^\s@,]+\.[^\s@,]+$/;

export async function sendEmailNotification(env: Env, msg: NtfyMessage, targetsRaw: string): Promise<void> {
  const targets = [...new Set(targetsRaw.split(",").map((s) => s.trim()).filter((s) => EMAIL_RE.test(s)))].slice(0, 5);
  if (!targets.length) return;
  const subject = msg.title?.trim() || `ntfy · ${msg.topic}`;
  const lines: string[] = [];
  if (msg.title) lines.push(msg.title, "");
  lines.push(msg.message || "");
  lines.push("", "---", `Topic: ${msg.topic}`);
  if (msg.priority && msg.priority !== 3) lines.push(`Priority: ${msg.priority}`);
  if (msg.tags?.length) lines.push(`Tags: ${msg.tags.join(", ")}`);
  if (msg.click) lines.push(`Click: ${msg.click}`);
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { authorization: `Bearer ${env.RESEND_API_KEY}`, "content-type": "application/json" },
    body: JSON.stringify({ from: env.EMAIL_FROM, to: targets, subject, text: lines.join("\n") }),
  });
  if (!res.ok) throw new Error(`resend_http_${res.status}`);
}

// ---------------------------------------------------------------------------
// Inbound: email -> publish (Cloudflare Email Routing -> worker email handler).
// The recipient local part is the topic: <topic>@<domain>, optionally with a
// shared secret suffix: <topic>+<secret>@<domain> (required when
// EMAIL_PUBLISH_SECRET is configured).
// ---------------------------------------------------------------------------

export interface ParsedInboundEmail {
  subject?: string;
  text: string;
}

export async function parseInboundEmail(raw: ReadableStream | ArrayBuffer): Promise<ParsedInboundEmail> {
  const parsed = await PostalMime.parse(raw as ArrayBuffer);
  let text = (parsed.text || "").trim();
  if (!text && parsed.html) {
    text = parsed.html
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<\/p>/gi, "\n\n")
      .replace(/<[^>]+>/g, " ")
      .replace(/&nbsp;/g, " ")
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/[ \t]{2,}/g, " ")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
  }
  return { subject: parsed.subject?.trim() || undefined, text };
}

export function splitTopicAndSecret(localPart: string): { topic: string; secret?: string } {
  const plus = localPart.indexOf("+");
  if (plus < 0) return { topic: localPart };
  return { topic: localPart.slice(0, plus), secret: localPart.slice(plus + 1) };
}
