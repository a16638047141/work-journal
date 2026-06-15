#!/usr/bin/env node

import fs from "node:fs/promises";
import path from "node:path";
import vm from "node:vm";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const htmlPath = path.join(repoRoot, "daily-work-journal.html");
const outputDir = path.join(repoRoot, "dist");
const GIST_DATA_FILE = "work-journal.json";
const GIST_HISTORY_FILE = "work-journal-send-history.json";

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

async function main() {
  const timeZone = process.env.TIME_ZONE || "Asia/Shanghai";
  const reportDate = normalizeDateKey(process.env.REPORT_DATE) || todayInTimeZone(timeZone);
  const dryRun = isTruthy(process.env.DRY_RUN);
  const triggerSource = normalizeTriggerSource(process.env.TRIGGER_SOURCE || process.env.GITHUB_EVENT_NAME);
  const scheduleDecision = getScheduledSendDecision({ triggerSource, timeZone });
  if (!scheduleDecision.shouldRun) {
    console.log(scheduleDecision.reason);
    return;
  }

  const state = normalizeState(await loadJournalState());
  const runtime = await loadJournalRuntime(state);

  runtime.state.selectedDate = reportDate;
  runtime.state.reportDate = reportDate;
  runtime.state.expenseView = "week";

  const bounds = runtime.getWorkWeekBounds(runtime.parseDateKey(reportDate));
  const userName = runtime.normalizeUserName(runtime.state.userName);
  const reportRange = `${runtime.formatDateCn(bounds.startKey)} 至 ${runtime.formatDateCn(bounds.endKey)}`;
  const filename = cleanAttachmentName(`${bounds.startKey}至${bounds.endKey}-周报.xlsx`);
  const blob = runtime.buildXlsxBlob(reportDate);
  const attachment = Buffer.from(await blob.arrayBuffer());
  const sendContext = {
    triggerSource,
    timeZone,
    reportDate,
    reportRange,
    weekStartKey: bounds.startKey,
    weekEndKey: bounds.endKey,
    userName,
    filename,
    scheduleKey: scheduleDecision.scheduleKey,
  };

  await fs.mkdir(outputDir, { recursive: true });
  await fs.writeFile(path.join(outputDir, filename), attachment);
  await fs.writeFile(
    path.join(outputDir, "weekly-report-summary.json"),
    JSON.stringify({ ...sendContext, dryRun }, null, 2),
  );

  console.log(`Generated ${filename}`);
  console.log(`Report date: ${reportDate}`);
  console.log(`Report range: ${reportRange}`);
  console.log(`Trigger source: ${triggerSource}`);

  if (dryRun) {
    console.log("DRY_RUN is enabled; email was not sent.");
    return;
  }

  if (await shouldSkipForFridayManualSend(sendContext)) {
    console.log("Skipped: this week already has a Friday manual send record.");
    return;
  }

  if (await shouldSkipAlreadySent(sendContext)) {
    console.log("Skipped: this scheduled send was already completed.");
    return;
  }

  const info = await sendEmail({ attachment, filename, reportRange, userName });
  await recordSendHistory({ ...sendContext, messageId: info.messageId || "" });
}

async function loadJournalState() {
  if (process.env.WORK_JOURNAL_STATE_JSON) {
    return JSON.parse(process.env.WORK_JOURNAL_STATE_JSON);
  }

  const gist = await fetchJournalGist();
  const file = gist.files?.[GIST_DATA_FILE]
    || Object.values(gist.files || {}).find((item) => {
      const filename = item.filename || "";
      return /\.json$/i.test(filename) && filename !== GIST_HISTORY_FILE;
    });

  if (!file?.content) {
    throw new Error(`Gist does not contain ${GIST_DATA_FILE}.`);
  }

  return JSON.parse(file.content);
}

async function fetchJournalGist() {
  const gistId = requiredEnv("WORK_JOURNAL_GIST_ID");
  const gistToken = requiredEnv("WORK_JOURNAL_GIST_TOKEN");
  const response = await fetch(`https://api.github.com/gists/${gistId}`, {
    headers: {
      Authorization: `Bearer ${gistToken}`,
      Accept: "application/vnd.github+json",
      "User-Agent": "work-journal-auto-email",
      "X-GitHub-Api-Version": "2022-11-28",
    },
  });

  if (!response.ok) {
    throw new Error(`Failed to read Gist ${gistId}: HTTP ${response.status}`);
  }

  return response.json();
}

async function loadSendHistory() {
  const gist = await fetchJournalGist();
  const file = gist.files?.[GIST_HISTORY_FILE];
  if (!file?.content) {
    return { version: 1, entries: [] };
  }

  const parsed = JSON.parse(file.content);
  return {
    version: 1,
    ...parsed,
    entries: Array.isArray(parsed.entries) ? parsed.entries : [],
  };
}

async function shouldSkipForFridayManualSend(context) {
  if (!isAutomatedTrigger(context.triggerSource)) {
    return false;
  }

  const history = await loadSendHistory();
  return history.entries.some((entry) => {
    const source = normalizeTriggerSource(entry.trigger_source || entry.source);
    const sentDate = normalizeDateKey(entry.sent_date || entry.sentDate);
    return isManualTrigger(source)
      && isFriday(sentDate)
      && entry.week_start === context.weekStartKey
      && entry.week_end === context.weekEndKey;
  });
}

async function shouldSkipAlreadySent(context) {
  if (!isAutomatedTrigger(context.triggerSource) || !context.scheduleKey) {
    return false;
  }

  const history = await loadSendHistory();
  return history.entries.some((entry) => {
    return entry.schedule_key === context.scheduleKey
      && entry.week_start === context.weekStartKey
      && entry.week_end === context.weekEndKey;
  });
}

async function recordSendHistory(context) {
  const gistId = requiredEnv("WORK_JOURNAL_GIST_ID");
  const gistToken = requiredEnv("WORK_JOURNAL_GIST_TOKEN");
  const history = await loadSendHistory();
  const sentDate = todayInTimeZone(context.timeZone);
  const entry = {
    sent_at: new Date().toISOString(),
    sent_date: sentDate,
    sent_weekday: weekdayName(sentDate),
    trigger_source: context.triggerSource,
    report_date: context.reportDate,
    week_start: context.weekStartKey,
    week_end: context.weekEndKey,
    schedule_key: context.scheduleKey || "",
    filename: context.filename,
    to: process.env.MAIL_TO || "",
    cc: process.env.MAIL_CC || "",
    message_id: context.messageId || "",
  };
  const nextHistory = {
    version: 1,
    updated_at: entry.sent_at,
    entries: [entry, ...history.entries].slice(0, 120),
  };

  const response = await fetch(`https://api.github.com/gists/${gistId}`, {
    method: "PATCH",
    headers: {
      Authorization: `Bearer ${gistToken}`,
      Accept: "application/vnd.github+json",
      "Content-Type": "application/json",
      "User-Agent": "work-journal-auto-email",
      "X-GitHub-Api-Version": "2022-11-28",
    },
    body: JSON.stringify({
      files: {
        [GIST_HISTORY_FILE]: {
          content: JSON.stringify(nextHistory, null, 2),
        },
      },
    }),
  });

  if (!response.ok) {
    throw new Error(`Failed to update send history: HTTP ${response.status}`);
  }

  console.log(`Recorded send history: ${entry.trigger_source} ${entry.week_start}..${entry.week_end}`);
}

async function loadJournalRuntime(state) {
  const html = await fs.readFile(htmlPath, "utf8");
  const scriptMatch = html.match(/<script[^>]*>([\s\S]*?)<\/script>/i);
  if (!scriptMatch) {
    throw new Error("Cannot find app script in daily-work-journal.html.");
  }

  const exportedScript = scriptMatch[1].replace(/\s*\}\)\(\);\s*$/, `
      globalThis.__journalAutomation = {
        state,
        buildXlsxBlob,
        getWorkWeekBounds,
        parseDateKey,
        formatDateCn,
        normalizeUserName
      };
    })();
  `);

  if (exportedScript === scriptMatch[1]) {
    throw new Error("Cannot expose report generator from daily-work-journal.html.");
  }

  const context = {
    console,
    Blob,
    Buffer,
    ArrayBuffer,
    DataView,
    Uint8Array,
    TextEncoder,
    TextDecoder,
    Date,
    Intl,
    JSON,
    Math,
    Number,
    Object,
    RegExp,
    String,
    Map,
    Set,
    Promise,
    crypto: { randomUUID },
    navigator: { clipboard: { writeText: async () => {} } },
    document: {
      addEventListener: () => {},
      getElementById: () => null,
      querySelectorAll: () => [],
      createElement: () => ({}),
      body: { appendChild: () => {} },
    },
    localStorage: {
      getItem: (key) => (key === "daily-work-journal.v1" ? JSON.stringify(state) : null),
      setItem: () => {},
      removeItem: () => {},
    },
    fetch: async () => {
      throw new Error("Unexpected network call from journal runtime.");
    },
    setInterval: () => 0,
    clearInterval: () => {},
    setTimeout: () => 0,
    clearTimeout: () => {},
  };
  context.window = context;
  context.globalThis = context;

  vm.createContext(context);
  vm.runInContext(exportedScript, context, { filename: "daily-work-journal.html" });

  if (!context.__journalAutomation?.buildXlsxBlob) {
    throw new Error("Report generator was not loaded.");
  }

  return context.__journalAutomation;
}

async function sendEmail({ attachment, filename, reportRange, userName }) {
  const host = requiredEnv("SMTP_HOST");
  const port = Number(process.env.SMTP_PORT || 465);
  const user = requiredEnv("SMTP_USER");
  const pass = requiredEnv("SMTP_PASS");
  const to = requiredEnv("MAIL_TO");
  const from = process.env.MAIL_FROM || `${userName} <${user}>`;
  const cc = process.env.MAIL_CC || undefined;
  const secure = process.env.SMTP_SECURE
    ? isTruthy(process.env.SMTP_SECURE)
    : port === 465;
  const subject = process.env.MAIL_SUBJECT || `${reportRange} 工作周报`;
  const text = process.env.MAIL_TEXT || [
    "您好，",
    "",
    `附件为${reportRange}工作周报，请查收。`,
  ].join("\n");

  const { default: nodemailer } = await import("nodemailer");
  const transporter = nodemailer.createTransport({
    host,
    port,
    secure,
    auth: { user, pass },
  });

  await transporter.verify();
  const info = await transporter.sendMail({
    from,
    to,
    cc,
    subject,
    text,
    attachments: [{
      filename,
      content: attachment,
      contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    }],
  });

  console.log(`Email sent: ${info.messageId || "ok"}`);
  return info;
}

function normalizeState(value) {
  const state = value && typeof value === "object" ? value : {};
  return {
    selectedDate: "",
    reportDate: "",
    expenseView: "week",
    journals: {},
    expenses: [],
    template: "",
    generatedReport: "",
    reportFileName: "周报.xlsx",
    userName: "袁宏林",
    ...state,
    journals: state.journals && typeof state.journals === "object" ? state.journals : {},
    expenses: Array.isArray(state.expenses) ? state.expenses : [],
  };
}

function todayInTimeZone(timeZone) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function normalizeDateKey(value) {
  const raw = String(value || "").trim().replace(/\//g, "-");
  const match = raw.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (!match) return "";
  const [, year, month, day] = match;
  return `${year}-${month.padStart(2, "0")}-${day.padStart(2, "0")}`;
}

function cleanAttachmentName(name) {
  return String(name || "周报.xlsx")
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, "-")
    .replace(/\s+/g, " ")
    .trim();
}

function requiredEnv(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function isTruthy(value) {
  return /^(1|true|yes|y)$/i.test(String(value || "").trim());
}

function getScheduledSendDecision({ triggerSource, timeZone }) {
  if (normalizeTriggerSource(triggerSource) !== "schedule") {
    return { shouldRun: true, scheduleKey: "" };
  }

  const weekday = normalizeScheduleWeekday(process.env.SCHEDULE_SEND_WEEKDAY || 6);
  const hour = normalizeNumber(process.env.SCHEDULE_SEND_HOUR, 8);
  const minute = normalizeNumber(process.env.SCHEDULE_SEND_MINUTE, 7);
  const windowMinutes = Math.max(1, normalizeNumber(process.env.SCHEDULE_SEND_WINDOW_MINUTES, 10));
  const now = dateTimeInTimeZone(timeZone);
  const targetMinuteOfDay = hour * 60 + minute;
  const currentMinuteOfDay = now.hour * 60 + now.minute;
  const offset = currentMinuteOfDay - targetMinuteOfDay;
  const targetLabel = `${now.dateKey} ${pad2(hour)}:${pad2(minute)}`;

  if (now.weekday !== weekday) {
    return {
      shouldRun: false,
      scheduleKey: "",
      reason: `Skipped: today weekday ${now.weekday} is not scheduled weekday ${weekday}.`,
    };
  }

  if (offset < 0 || offset > windowMinutes) {
    return {
      shouldRun: false,
      scheduleKey: "",
      reason: `Skipped: current time ${now.dateKey} ${pad2(now.hour)}:${pad2(now.minute)} is outside scheduled window ${targetLabel}+${windowMinutes}m.`,
    };
  }

  return {
    shouldRun: true,
    scheduleKey: `${targetLabel}+${windowMinutes}m`,
  };
}

function dateTimeInTimeZone(timeZone) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date());
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  const dateKey = `${values.year}-${values.month}-${values.day}`;
  return {
    dateKey,
    hour: Number(values.hour),
    minute: Number(values.minute),
    weekday: weekdayNumber(dateKey),
  };
}

function normalizeScheduleWeekday(value) {
  const raw = String(value || "").trim().toLowerCase();
  const names = {
    sunday: 0,
    sun: 0,
    monday: 1,
    mon: 1,
    tuesday: 2,
    tue: 2,
    wednesday: 3,
    wed: 3,
    thursday: 4,
    thu: 4,
    friday: 5,
    fri: 5,
    saturday: 6,
    sat: 6,
  };
  if (raw in names) return names[raw];
  const number = Number(raw);
  if (number === 7) return 0;
  if (Number.isInteger(number) && number >= 0 && number <= 6) return number;
  return 6;
}

function normalizeNumber(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function normalizeTriggerSource(value) {
  const normalized = String(value || "").trim().toLowerCase();
  if (["manual", "page", "web", "workflow_dispatch"].includes(normalized)) return "manual";
  if (["timer", "external", "cron"].includes(normalized)) return "timer";
  if (normalized === "schedule") return "schedule";
  return normalized || "manual";
}

function isManualTrigger(source) {
  return normalizeTriggerSource(source) === "manual";
}

function isAutomatedTrigger(source) {
  return ["schedule", "timer"].includes(normalizeTriggerSource(source));
}

function isFriday(dateKey) {
  return weekdayName(dateKey) === "Friday";
}

function weekdayName(dateKey) {
  const normalized = normalizeDateKey(dateKey);
  if (!normalized) return "";
  return ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"][
    weekdayNumber(normalized)
  ];
}

function weekdayNumber(dateKey) {
  const normalized = normalizeDateKey(dateKey);
  if (!normalized) return NaN;
  const [year, month, day] = normalized.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day)).getUTCDay();
}

function pad2(value) {
  return String(value).padStart(2, "0");
}
