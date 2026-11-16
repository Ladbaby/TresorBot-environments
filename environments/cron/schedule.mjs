// A five-field cron schedule, parsed once and evaluated without dependencies.
//
// Node ships no cron parser and Sun installs nothing, so this is the whole
// implementation. It is intentionally small and strict: five fields, the usual
// *, ranges, steps and lists, and day-of-month/day-of-week combined the way cron
// has always combined them (either may match).

const FIELDS = [
  { name: "minute", min: 0, max: 59 },
  { name: "hour", min: 0, max: 23 },
  { name: "day of month", min: 1, max: 31 },
  { name: "month", min: 1, max: 12 },
  { name: "day of week", min: 0, max: 7 },
];

/**
 * Parses a schedule into per-field match sets.
 *
 * Throws with the offending field named, because "invalid schedule" alone leaves
 * an operator guessing across five comma-separated expressions.
 */
export function parseSchedule(expression) {
  const parts = String(expression ?? "")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (parts.length !== 5) {
    throw new Error(`schedule needs 5 fields (minute hour day month weekday), got ${parts.length}`);
  }
  const sets = parts.map((text, index) => parseField(text, FIELDS[index]));
  // Sunday as 7 is accepted as well as 0, so both conventions work.
  if (sets[4].has(7)) {
    sets[4].add(0);
    sets[4].delete(7);
  }
  return {
    expression: parts.join(" "),
    minute: sets[0],
    hour: sets[1],
    dayOfMonth: sets[2],
    month: sets[3],
    dayOfWeek: sets[4],
    // A restricted day field is what makes the two day fields an OR rather than
    // an AND, which is the historical behaviour every other cron has.
    domRestricted: parts[2] !== "*",
    dowRestricted: parts[4] !== "*",
  };
}

function parseField(text, { name, min, max }) {
  const out = new Set();
  for (const piece of text.split(",")) {
    if (!piece) throw new Error(`empty entry in ${name} field`);
    const [rangeText, stepText, extra] = piece.split("/");
    if (extra !== undefined) throw new Error(`invalid step in ${name} field: ${piece}`);
    let step = 1;
    if (stepText !== undefined) {
      step = Number(stepText);
      if (!Number.isInteger(step) || step < 1) throw new Error(`invalid step in ${name} field: ${piece}`);
    }
    let from;
    let to;
    if (rangeText === "*") {
      from = min;
      to = max;
    } else if (rangeText.includes("-")) {
      const [a, b] = rangeText.split("-");
      from = Number(a);
      to = Number(b);
    } else {
      from = Number(rangeText);
      // `5/15` means every 15 starting at 5, which is how cron reads it.
      to = stepText === undefined ? from : max;
    }
    if (!Number.isInteger(from) || !Number.isInteger(to) || from < min || to > max || from > to) {
      throw new Error(`${name} value out of range ${min}-${max} in ${piece}`);
    }
    for (let value = from; value <= to; value += step) out.add(value);
  }
  if (out.size === 0) throw new Error(`${name} field matches nothing`);
  return out;
}

/** Reports whether a schedule fires at the given wall-clock minute. */
export function matches(schedule, date) {
  if (!schedule.minute.has(date.getMinutes())) return false;
  if (!schedule.hour.has(date.getHours())) return false;
  if (!schedule.month.has(date.getMonth() + 1)) return false;
  const dom = schedule.dayOfMonth.has(date.getDate());
  const dow = schedule.dayOfWeek.has(date.getDay());
  if (schedule.domRestricted && schedule.dowRestricted) return dom || dow;
  return dom && dow;
}

/**
 * The wall-clock parts of a Date in a named time zone.
 *
 * Intl is used rather than a fixed offset because a schedule has to follow the
 * clock an operator means, and that clock moves twice a year. Formatting the
 * instant in the target zone is the only portable way to ask "what time is it
 * there".
 */
export function zonedParts(date, timeZone) {
  if (!timeZone) {
    return {
      year: date.getFullYear(),
      month: date.getMonth() + 1,
      day: date.getDate(),
      hour: date.getHours(),
      minute: date.getMinutes(),
      dayOfWeek: date.getDay(),
    };
  }
  const format = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    weekday: "short",
  });
  const parts = Object.fromEntries(format.formatToParts(date).map((part) => [part.type, part.value]));
  const weekdays = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  // `hour: "2-digit"` renders midnight as 24 in some ICU versions; normalising it
  // here keeps a 0-hour schedule from silently never firing.
  const hour = Number(parts.hour) % 24;
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour,
    minute: Number(parts.minute),
    dayOfWeek: weekdays[parts.weekday] ?? 0,
  };
}

/** Limits a time zone name to something Intl accepts, so an instance can be flagged rather than crash the host. */
export function validateTimeZone(timeZone) {
  if (!timeZone) return "";
  try {
    new Intl.DateTimeFormat("en-US", { timeZone }).format(new Date());
    return "";
  } catch {
    return `unknown time zone ${JSON.stringify(timeZone)}`;
  }
}

/** Normalises the wall-clock parts into the shape `matches` expects. */
export function asDate(parts) {
  const d = new Date(Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute));
  // Read the components back in UTC so `matches` sees the operator's clock rather
  // than the host's: a schedule is a wall-clock statement, not an instant.
  return {
    getMinutes: () => d.getUTCMinutes(),
    getHours: () => d.getUTCHours(),
    getMonth: () => d.getUTCMonth(),
    getDate: () => d.getUTCDate(),
    getDay: () => parts.dayOfWeek,
  };
}
