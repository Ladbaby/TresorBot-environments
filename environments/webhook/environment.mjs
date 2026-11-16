// Webhook input: an HTTP request as an event.
//
// Two things are worth copying from this file if you write your own.
//
// 1. Verify the signature over the RAW bytes. Sun forwards the body base64-encoded
//    precisely so this is possible; parsing to JSON and re-serialising would
//    produce different bytes and every signature would fail.
//
// 2. Answer the caller before the work is done. The adapter's job is to admit the
//    event; Sun's is to queue and run it. Returning after admission is what keeps
//    an upstream's request from blocking for the length of a bot turn.

import { createHmac, timingSafeEqual } from "node:crypto";

export default function createInput({ mode } = {}) {
  if (mode === "describe") return { createInstance };
  return { createInstance };
}

function createInstance(ctx) {
  const { log, emit } = ctx;
  let settings = { ...ctx.settings };

  /** Verifies the HMAC signature, when one is configured. */
  function verify({ headers, body }) {
    const secret = String(settings.secret ?? "").trim();
    if (!secret) return ""; // No secret configured: the caller is trusting the URL credential alone.
    const headerName = String(settings.signature_header ?? "X-Hub-Signature-256").toLowerCase();
    // Header lookup is case-insensitive because an upstream sends whatever casing
    // it likes; Sun forwards the canonical form.
    let presented = "";
    for (const [key, value] of Object.entries(headers ?? {})) {
      if (key.toLowerCase() !== headerName) continue;
      presented = Array.isArray(value) ? String(value[0] ?? "") : String(value ?? "");
      break;
    }
    if (!presented) return `missing ${headerName} header`;
    const expected = "sha256=" + createHmac("sha256", secret).update(body).digest("hex");
    // Constant-time comparison: a byte-by-byte compare leaks how much of a guessed
    // signature was right, which is enough to forge one incrementally.
    const a = Buffer.from(expected);
    const b = Buffer.from(presented.trim().toLowerCase());
    if (a.length !== b.length || !timingSafeEqual(a, b)) return "signature does not match";
    return "";
  }

  /** Renders the prompt from the payload, falling back to the raw JSON. */
  function render(payload, raw) {
    const template = String(settings.prompt ?? "").trim();
    if (!template) return raw.trim();
    return template
      .replaceAll("{body}", raw.trim())
      .replaceAll("{event}", String(payload.event ?? payload.type ?? ""))
      .replaceAll("{action}", String(payload.action ?? ""));
  }

  return {
    // A webhook input has nothing to start: it is driven entirely by requests. But
    // start() must exist, because Sun calls it, and returning normally is what
    // marks the instance healthy.
    async start() {
      log("ready to receive webhooks");
    },

    async reconfigure(next) {
      settings = { ...settings, ...(next ?? {}) };
      log("settings updated");
    },

    async handleWebhook({ method, headers, body }) {
      if (method !== "POST") return { handled: false, status: 405, code: "method_not_allowed" };

      const problem = verify({ headers, body });
      if (problem) return { handled: false, status: 401, code: "bad_signature" };

      const raw = body.toString("utf8");
      let payload = {};
      try {
        payload = raw.trim() ? JSON.parse(raw) : {};
      } catch {
        // Not every webhook is JSON. A plain-text body is still a perfectly good
        // event, so it becomes the message rather than an error.
        payload = {};
      }

      const accepted = settings.kinds;
      if (Array.isArray(accepted) && accepted.length) {
        const kind = String(payload.action ?? payload.event ?? payload.type ?? "");
        if (!accepted.includes(kind)) {
          // Answering 202 rather than 400 matters: the upstream did nothing wrong,
          // and a rejection would make it retry forever.
          log(`ignoring ${kind || "unlabelled"} payload; kinds is ${accepted.join(", ")}`);
          return { handled: true, status: 202 };
        }
      }

      // The identity comes from the upstream when it offers one. A re-delivery of
      // the same payload is then recognised as a duplicate, which is exactly what a
      // webhook sender retrying after a timeout expects.
      const eventID = String(
        headers["x-github-delivery"] ??
          headers["x-request-id"] ??
          payload.id ??
          `${ctx.instance}:${Date.now()}:${Math.random().toString(36).slice(2, 10)}`,
      );

      await emit({
        version: "ingress.v1",
        event_id: eventID,
        kind: String(payload.action ?? payload.event ?? "webhook"),
        content: { text: render(payload, raw) },
        // reply_to is carried through to delivery, so a reply can find its way back
        // to whatever the payload names — a pull request, a ticket, a channel.
        reply_to: {
          channel: "webhook",
          reference: eventID,
          conversation: String(payload.reply_to ?? payload.channel ?? ""),
        },
      });
      return { handled: true, status: 202 };
    },

    async deliver({ delivery_key, outcome }) {
      // Nothing to call back: the upstream got its 202 long ago. The result is
      // logged so an operator can correlate it with the request.
      log(`result for ${delivery_key}: ${outcome.state}${outcome.summary ? ` — ${outcome.summary}` : ""}`);
      return { delivered: true };
    },

    async stop() {},
  };
}
