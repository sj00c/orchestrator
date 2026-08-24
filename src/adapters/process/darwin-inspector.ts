import type { ProcessIdentity, ProcessInspector } from "../../ports/process-inspector.ts";

const PS = "/bin/ps";

/** Darwin process adapter backed by `ps`; all invocations use an argv vector. */
export class DarwinProcessInspector implements ProcessInspector {
  async inspect(pid: number): Promise<ProcessIdentity | null> {
    if (!isPid(pid)) return null;
    const child = Bun.spawn([PS, "-p", String(pid), "-o", "pid=", "-o", "pgid=", "-o", "lstart=", "-o", "comm="], {
      stdout: "pipe",
      stderr: "ignore",
      env: { ...process.env, LC_ALL: "C", LANG: "C" },
    });
    const [exitCode, stdout] = await Promise.all([child.exited, read(child.stdout)]);
    if (exitCode !== 0) return null;
    const identity = parsePs(stdout);
    return identity?.pid === pid ? identity : null;
  }

  async matches(expected: ProcessIdentity): Promise<boolean> {
    if (!validIdentity(expected)) return false;
    const actual = await this.inspect(expected.pid);
    return actual !== null
      && actual.pid === expected.pid
      && actual.pgid === expected.pgid
      && secondTimestamp(actual.startedAt) === secondTimestamp(expected.startedAt)
      && (expected.executable === undefined || actual.executable === expected.executable);
  }

  async signal(expected: ProcessIdentity, signal: NodeJS.Signals): Promise<void> {
    if (!validIdentity(expected)) throw new RangeError("Invalid process identity");
    // A non-leader's pgid can contain unrelated peers. Refuse it rather than
    // falling back to a PID-only signal target.
    if (expected.pgid !== expected.pid) throw new RangeError("Refusing to signal a process group not led by the expected process");
    if (!await this.matches(expected)) throw new Error("Process identity no longer matches");
    process.kill(-expected.pgid, signal);
  }
}

async function read(stream: ReadableStream<Uint8Array>): Promise<string> {
  return new TextDecoder().decode(await new Response(stream).arrayBuffer());
}
function parsePs(output: string): ProcessIdentity | null {
  const line = output.trim();
  // `lstart` has no zone, so parse its documented C-locale shape ourselves
  // rather than accepting Date's permissive, implementation-defined grammar.
  const match = /^(\d+)\s+(\d+)\s+([A-Z][a-z]{2})\s+([A-Z][a-z]{2})\s+(\d{1,2})\s+(\d{2}):(\d{2}):(\d{2})\s+(\d{4})\s+(.+)$/.exec(line);
  if (!match || match.length !== 11) return null;
  const [, pidText, pgidText, weekday, monthName, dayText, hourText, minuteText, secondText, yearText, executableText] = match;
  if (typeof pidText !== "string" || typeof pgidText !== "string" || typeof weekday !== "string" || typeof monthName !== "string"
    || typeof dayText !== "string" || typeof hourText !== "string" || typeof minuteText !== "string" || typeof secondText !== "string"
    || typeof yearText !== "string" || typeof executableText !== "string") return null;
  const pid = Number(pidText);
  const pgid = Number(pgidText);
  const startedAt = parseLstart(weekday, monthName, dayText, hourText, minuteText, secondText, yearText);
  const executable = executableText.trim();
  return isPid(pid) && isPid(pgid) && startedAt !== null && validExecutable(executable)
    ? { pid, pgid, startedAt, executable }
    : null;
}
function secondTimestamp(value: string): string | null {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value)) return null;
  const timestamp = new Date(value);
  if (!Number.isFinite(timestamp.getTime())) return null;
  const normalized = timestamp.toISOString();
  const canonical = value.includes(".") ? value : `${value.slice(0, -1)}.000Z`;
  return normalized === canonical ? new Date(Math.floor(timestamp.getTime() / 1000) * 1000).toISOString() : null;
}
function isPid(value: number): boolean { return Number.isSafeInteger(value) && value > 0; }
function validIdentity(value: ProcessIdentity): boolean {
  return isPid(value.pid)
    && isPid(value.pgid)
    && secondTimestamp(value.startedAt) !== null
    && (value.executable === undefined || validExecutable(value.executable));
}
function parseLstart(weekday: string, monthName: string, dayText: string, hourText: string, minuteText: string, secondText: string, yearText: string): string | null {
  const month = MONTHS.indexOf(monthName);
  const day = Number(dayText);
  const hour = Number(hourText);
  const minute = Number(minuteText);
  const second = Number(secondText);
  const year = Number(yearText);
  if (month < 0 || !Number.isSafeInteger(year) || year < 1970 || year > 9999 || day < 1 || hour > 23 || minute > 59 || second > 59) return null;
  const date = new Date(year, month, day, hour, minute, second, 0);
  if (date.getFullYear() !== year || date.getMonth() !== month || date.getDate() !== day || date.getHours() !== hour || date.getMinutes() !== minute || date.getSeconds() !== second || WEEKDAYS[date.getDay()] !== weekday) return null;
  return date.toISOString();
}
function validExecutable(value: string): boolean {
  return value.startsWith("/") && !/[\0\r\n]/.test(value);
}
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
