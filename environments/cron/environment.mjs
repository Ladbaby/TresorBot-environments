// Schedule input: a cron expression as an input adapter.
//
// The instructive part is the cursor. Sun does not know what a schedule means, so
// this input keeps its own notion of "the last minute I fired for" in the cursor
// store and decides for itself what to do after downtime. That is the shape every
// polling input uses: read where you were, look at where you are, emit what is
// genuinely new.
//
// Catch-up policy is at most one event, not one per missed minute. Firing a week
// of missed mornings at once would queue a week of work behind a single prompt,
// which is never what an operator meant by "run at 9".

import { asDate, matches, parseSchedule, validateTimeZone, zonedParts } from "./schedule.mjs";

const CURSOR_KEY = "last_fired_minute";
// How far back a start looks for a missed schedule. Bounded on purpose: a Sun that
// was off for a month should not scan a month of minutes on every boot, and one
// missed run is the whole point of catching up.
const CATCH_UP_WINDOW_MINUTES = 36 * 60;

export default function createInput({ mode } = {}) {
  if (mode === "describe") {
    // Describe mode must be cheap and side-effect free: it runs on every catalogue
    // scan, not once per instance, so it reports nothing and just hands back the
    // factory.
    return { createInstance };
  }
  return { createInstance };
}

function createInstance(ctx) {
  const { log, emit, cursor } = ctx;
  let settings = { ...ctx.settings };
  let timer = null;
  let stopped = false;
  let schedule = null;
  let timeZone = "";

  function compile() {
    schedule = parseSchedule(settings.schedule);
    timeZone = String(settings.timezone ?? "").trim();
    const problem = validateTimeZone(timeZone);
    if (problem) throw new Error(problem);
  }

  // The current wall-clock minute in the configured zone, as a sortable string.
  // Zero-padded so string order is time order, which is what the cursor needs.
  const minuteKey = (date) => {
    const p = zonedParts(date, timeZone);
    const pad = (n) => String(n).padStart(2, "0");
    return `${p.year}${pad(p.month)}${pad(p.day)}${pad(p.hour)}${pad(p.minute)}`;
  };

  /** Fires one event for one wall-clock minute. */
  async function fire(minute) {
    const text = String(settings.text ?? "").trim();
    if (!text) {
      log("schedule matched but no prompt is configured", "error");
      return;
    }
    // The cursor advances BEFORE the event is emitted. Emitting can fail, and the
    // process can die mid-call; recording first means a crash loses one tick
    // rather than re-firing the same tick on every restart forever.
    await cursor.set(CURSOR_KEY, minute);
    await emit({
      // The minute is the identity, so the same scheduled minute can only ever
      // produce one event even if a restart lands between emitting and recording.
      version: "ingress.v1",
      event_id: `${ctx.instance}:${minute}`,
      kind: "schedule",
      content: { text },
      origin: { channel: "schedule", author: schedule.expression },
    });
    log(`fired for ${minute}`);
  }

  /**
   * Finds the most recent scheduled minute strictly between `last` and now.
   *
   * Scans backwards so the answer is the newest miss: running the most recent
   * missed schedule is what an operator means by catching up, and firing the
   * oldest instead would be a week stale.
   */
  function mostRecentMiss(now, last) {
    const probe = new Date(now.getTime());
    probe.setSeconds(0, 0);
    for (let step = 0; step < CATCH_UP_WINDOW_MINUTES; step++) {
      const key = minuteKey(probe);
      if (last && key <= last) return "";
      if (matches(schedule, asDate(zonedParts(probe, timeZone)))) return key;
      probe.setTime(probe.getTime() - 60000);
    }
    return "";
  }

  async function tick(fromStart) {
    timer = null;
    if (stopped) return;
    try {
      const now = new Date();
      const current = minuteKey(now);
      const last = await cursor.get(CURSOR_KEY);
      // One event per minute however often the timer fires: a slow tick or a
      // restart must not double-fire.
      if (current !== last) {
        if (matches(schedule, asDate(zonedParts(now, timeZone)))) {
          await fire(current);
        } else if (fromStart) {
          // Only a start considers catch-up. A running instance that slept past a
          // schedule has been alive and simply missed it, which is a different
          // situation from having been down.
          if (settings.catch_up === false) {
            log("a scheduled time passed while Sun was stopped; catch_up is off so it is skipped");
          } else {
            const missed = mostRecentMiss(now, last);
            if (missed) await fire(missed);
          }
        }
      }
    } catch (cause) {
      // A throw here must not stop the timer, or one bad tick would end the
      // schedule until the next restart.
      log(`tick failed: ${cause.message ?? cause}`, "error");
    } finally {
      // Align to the next minute boundary rather than polling every second: a
      // schedule's resolution is a minute, so waking up twenty times a minute
      // would be work that cannot change the answer.
      if (!stopped) timer = setTimeout(() => tick(false), 60000 - (Date.now() % 60000) + 50);
    }
  }

  return {
    async start() {
      compile();
      const last = await cursor.get(CURSOR_KEY);
      log(`scheduled ${schedule.expression}${timeZone ? ` in ${timeZone}` : ""}${last ? `, last fired ${last}` : ""}`);
      // The first tick runs immediately, so a Sun that restarts at 09:00:30 still
      // catches its 09:00 schedule instead of waiting a day for the next match.
      timer = setTimeout(() => tick(true), 0);
    },

    async reconfigure(next) {
      const previous = schedule?.expression;
      settings = { ...settings, ...(next ?? {}) };
      compile();
      log(`schedule changed from ${previous ?? "none"} to ${schedule.expression}`);
    },

    async deliver({ delivery_key, outcome }) {
      // A schedule has no upstream to answer to, so the reply is recorded in the
      // log and nothing else. Reporting "delivered" is still right: the
      // alternative is a growing pile of undeliverable replies, and the owner reads
      // results in the dashboard anyway.
      log(`result for ${delivery_key}: ${outcome.state}${outcome.summary ? ` — ${outcome.summary}` : ""}`);
      return { delivered: true };
    },

    /**
     * The tools this environment offers to the bot.
     *
     * Declared here rather than in the manifest so a tool can describe the
     * instance's *current* settings: a schema that cannot mention the real
     * schedule is less useful than one that can.
     */
    async listTools() {
      return [
        {
          name: "describe_schedule",
          description: "Show this schedule's expression, time zone, prompt and whether it is currently armed.",
          parameters: { type: "object", properties: {}, additionalProperties: false },
        },
        {
          name: "next_run",
          description: "Report the next time this schedule will fire, in UTC.",
          parameters: {
            type: "object",
            properties: {
              count: {
                type: "integer",
                description: "How many upcoming times to list. Defaults to 1.",
              },
            },
            additionalProperties: false,
          },
        },
        {
          name: "run_now",
          description: "Trigger this schedule immediately, in addition to its normal times. Use when the owner asks for the brief now.",
          parameters: {
            type: "object",
            properties: {
              reason: { type: "string", maxLength: 200, description: "Why it is being run early." },
            },
            required: ["reason"],
            additionalProperties: false,
          },
        },
      ];
    },

    async callTool({ name, arguments: args = {} }) {
      switch (name) {
        case "describe_schedule":
          return {
            expression: schedule?.expression ?? null,
            timezone: timeZone || "local",
            prompt: settings.text ?? "",
            catch_up: settings.catch_up !== false,
            armed: !stopped && schedule !== null,
            last_fired: (await cursor.get(CURSOR_KEY)) || null,
          };
        case "next_run": {
          const count = Math.min(Math.max(Number(args?.count ?? 1) || 1, 1), 5);
          const upcoming = [];
          let from = Date.now();
          // Bounded scan: a schedule that never matches must answer rather than
          // search forever. Two years of minutes covers any real expression.
          for (let i = 0; i < 2 * 366 * 24 * 60 && upcoming.length < count; i++) {
            from += 60000 - (from % 60000);
            // matches() reads a normalised wall-clock date, so the time zone is
            // applied first — the same conversion the scheduled tick uses.
            if (matches(schedule, asDate(zonedParts(new Date(from), timeZone)))) {
              upcoming.push(new Date(from).toISOString());
              from += 60000;
            }
          }
          return { next: upcoming };
        }
        case "run_now":
          if (stopped) throw new Error("this environment is stopped");
          // The same path a scheduled tick takes, so a manual run is
          // indistinguishable downstream from a timed one.
          await tick(false, `manual: ${String(args?.reason ?? "").slice(0, 200)}`);
          return { triggered: true, at: new Date().toISOString() };
        default:
          throw new Error(`unknown tool ${name}`);
      }
    },

    async stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
      timer = null;
    },
  };
}
