// @ts-nocheck
export {};

const fs = require("fs");
const path = require("path");
const os = require("os");
const toml = require("smol-toml");
const { isPlainObject } = require("./featurePatches");

const CODEX_HOME = process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
const CODEX_AUTOMATIONS_DIR = path.join(CODEX_HOME, "automations");
const AUTOMATION_BACKEND_REQUIRED_ERROR =
  "自动化定时调度需要 Codex Desktop/App 后端在线；Web 只作为控制面，不能本地创建或接管调度。";

function stringOrNull(value) {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function timestampMsOrNull(value) {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value > 0 && value < 10_000_000_000 ? value * 1000 : value;
  }
  if (value instanceof Date) {
    const time = value.getTime();
    return Number.isFinite(time) ? time : null;
  }
  if (typeof value === "string" && value.trim()) {
    const numeric = Number(value);
    if (Number.isFinite(numeric)) return timestampMsOrNull(numeric);
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function stringArray(value) {
  return Array.isArray(value) ? value.filter((item) => typeof item === "string" && item.length > 0) : [];
}

function parseRruleParts(rrule) {
  const raw = String(rrule || "").trim().replace(/^RRULE:/i, "");
  const parts = {};
  for (const segment of raw.split(";")) {
    const eq = segment.indexOf("=");
    if (eq <= 0) continue;
    const key = segment.slice(0, eq).trim().toUpperCase();
    const value = segment.slice(eq + 1).trim();
    if (key) parts[key] = value;
  }
  return parts;
}

function parseRruleNumberList(value, min, max) {
  const values = String(value || "")
    .split(",")
    .map((item) => Number(item.trim()))
    .filter((item) => Number.isInteger(item) && item >= min && item <= max);
  return [...new Set(values)].sort((a, b) => a - b);
}

function parsePositiveInteger(value, fallback) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : fallback;
}

function rruleWeekdayIndex(day) {
  return { SU: 0, MO: 1, TU: 2, WE: 3, TH: 4, FR: 5, SA: 6 }[String(day || "").slice(0, 2).toUpperCase()];
}

function parseRruleWeekdays(value) {
  if (!value) return null;
  const days = String(value)
    .split(",")
    .map(rruleWeekdayIndex)
    .filter((day) => Number.isInteger(day));
  return days.length > 0 ? new Set(days) : null;
}

function localDayStart(date) {
  const next = new Date(date);
  next.setHours(0, 0, 0, 0);
  return next;
}

function nextDailyOrWeeklyRunAt(parts, nowMs) {
  const now = new Date(nowMs);
  const hours = parseRruleNumberList(parts.BYHOUR, 0, 23);
  const minutes = parseRruleNumberList(parts.BYMINUTE, 0, 59);
  const seconds = parseRruleNumberList(parts.BYSECOND, 0, 59);
  const weekdays = parts.FREQ === "WEEKLY" ? parseRruleWeekdays(parts.BYDAY) : null;
  const candidateHours = hours.length > 0 ? hours : [now.getHours()];
  const candidateMinutes = minutes.length > 0 ? minutes : [0];
  const candidateSeconds = seconds.length > 0 ? seconds : [0];

  for (let dayOffset = 0; dayOffset <= 370; dayOffset += 1) {
    const day = localDayStart(now);
    day.setDate(day.getDate() + dayOffset);
    if (weekdays && !weekdays.has(day.getDay())) continue;
    for (const hour of candidateHours) {
      for (const minute of candidateMinutes) {
        for (const second of candidateSeconds) {
          const candidate = new Date(day);
          candidate.setHours(hour, minute, second, 0);
          const time = candidate.getTime();
          if (time > nowMs) return time;
        }
      }
    }
  }
  return null;
}

function nextHourlyRunAt(parts, nowMs) {
  const interval = parsePositiveInteger(parts.INTERVAL, 1);
  const minutes = parseRruleNumberList(parts.BYMINUTE, 0, 59);
  const seconds = parseRruleNumberList(parts.BYSECOND, 0, 59);
  const candidateMinutes = minutes.length > 0 ? minutes : [0];
  const candidateSeconds = seconds.length > 0 ? seconds : [0];
  const start = new Date(nowMs);
  start.setMinutes(0, 0, 0);

  for (let hourOffset = 0; hourOffset <= 24 * 14; hourOffset += 1) {
    const hourBase = new Date(start);
    hourBase.setHours(hourBase.getHours() + hourOffset);
    const absoluteHour = Math.floor(hourBase.getTime() / (60 * 60 * 1000));
    if (absoluteHour % interval !== 0) continue;
    for (const minute of candidateMinutes) {
      for (const second of candidateSeconds) {
        const candidate = new Date(hourBase);
        candidate.setMinutes(minute, second, 0);
        const time = candidate.getTime();
        if (time > nowMs) return time;
      }
    }
  }
  return null;
}

function computeNextRunAt(rrule, status) {
  if (status === "PAUSED") return null;
  const parts = parseRruleParts(rrule);
  switch (parts.FREQ) {
    case "DAILY":
    case "WEEKLY":
      return nextDailyOrWeeklyRunAt(parts, Date.now());
    case "HOURLY":
      return nextHourlyRunAt(parts, Date.now());
    case "MINUTELY": {
      const interval = parsePositiveInteger(parts.INTERVAL, 1);
      return Date.now() + interval * 60 * 1000;
    }
    default:
      return null;
  }
}

function normalizeAutomationStatus(value) {
  return value === "PAUSED" ? "PAUSED" : "ACTIVE";
}

function automationTomlFiles() {
  let entries = [];
  try {
    entries = fs.readdirSync(CODEX_AUTOMATIONS_DIR, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(CODEX_AUTOMATIONS_DIR, entry.name, "automation.toml"))
    .filter((filePath) => {
      try {
        return fs.statSync(filePath).isFile();
      } catch {
        return false;
      }
    })
    .sort();
}

function automationFromToml(filePath) {
  let parsed;
  let stats = null;
  try {
    stats = fs.statSync(filePath);
    parsed = toml.parse(fs.readFileSync(filePath, "utf8"));
  } catch (error) {
    console.warn(`[gateway] failed to read automation: ${filePath}`, error);
    return null;
  }
  if (!isPlainObject(parsed)) return null;
  const kind = parsed.kind === "heartbeat" ? "heartbeat" : parsed.kind === "cron" ? "cron" : null;
  if (!kind) return null;

  const id = stringOrNull(parsed.id) || path.basename(path.dirname(filePath));
  const status = normalizeAutomationStatus(parsed.status);
  const createdAt = timestampMsOrNull(parsed.created_at ?? parsed.createdAt) ?? stats.mtimeMs;
  const updatedAt = timestampMsOrNull(parsed.updated_at ?? parsed.updatedAt) ?? stats.mtimeMs;
  const rrule = stringOrNull(parsed.rrule) || "";
  const base = {
    id,
    kind,
    name: stringOrNull(parsed.name) || id,
    prompt: stringOrNull(parsed.prompt) || "",
    status,
    rrule,
    nextRunAt: timestampMsOrNull(parsed.next_run_at ?? parsed.nextRunAt) ?? computeNextRunAt(rrule, status),
    lastRunAt: timestampMsOrNull(parsed.last_run_at ?? parsed.lastRunAt),
    createdAt,
    updatedAt,
  };
  if (kind === "heartbeat") {
    return {
      ...base,
      targetThreadId: stringOrNull(parsed.target_thread_id ?? parsed.targetThreadId),
      model: null,
      reasoningEffort: null,
    };
  }
  return {
    ...base,
    cwds: stringArray(parsed.cwds),
    executionEnvironment: parsed.execution_environment === "local" || parsed.executionEnvironment === "local" ? "local" : "worktree",
    localEnvironmentConfigPath:
      stringOrNull(parsed.local_environment_config_path ?? parsed.localEnvironmentConfigPath) || null,
    model: stringOrNull(parsed.model),
    reasoningEffort: stringOrNull(parsed.reasoning_effort ?? parsed.reasoningEffort),
  };
}

function listAutomations() {
  return {
    items: automationTomlFiles().map(automationFromToml).filter(Boolean),
    webControlOnly: true,
    schedulerBackend: "codex-desktop-app",
  };
}

function backendRequiredError() {
  return new Error(AUTOMATION_BACKEND_REQUIRED_ERROR);
}

function createAutomationIpcHandlers() {
  return {
    listAutomations,
    backendRequiredError,
  };
}

module.exports = {
  AUTOMATION_BACKEND_REQUIRED_ERROR,
  createAutomationIpcHandlers,
  listAutomations,
};
