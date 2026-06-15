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

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

async function main() {
  const timeZone = process.env.TIME_ZONE || "Asia/Shanghai";
  const reportDate = normalizeDateKey(process.env.REPORT_DATE) || todayInTimeZone(timeZone);
  const dryRun = isTruthy(process.env.DRY_RUN);
  const state = normalizeState(await loadJournalState());
  const runtime = await loadJournalRuntime(state);

  runtime.state.selectedDate = reportDate;
  runtime.state.reportDate = reportDate;
  runtime.state.expenseView = "week";

  const bounds = runtime.getWorkWeekBounds(runtime.parseDateKey(reportDate));
  const userName = runtime.normalizeUserName(runtime.state.userName);
  const reportRange = `${runtime.formatDateCn(bounds.startKey)} 至 ${runtime.formatDateCn(bounds.endKey)}`;
  const filename = cleanAttachmentName(`${userName}-${bounds.startKey}至${bounds.endKey}-周报.xlsx`);
  const blob = runtime.buildXlsxBlob(reportDate);
  const attachment = Buffer.from(await blob.arrayBuffer());

  await fs.mkdir(outputDir, { recursive: true });
  await fs.writeFile(path.join(outputDir, filename), attachment);
  await fs.writeFile(
    path.join(outputDir, "weekly-report-summary.json"),
    JSON.stringify({ reportDate, reportRange, userName, filename, dryRun }, null, 2),
  );

  console.log(`Generated ${filename}`);
  console.log(`Report date: ${reportDate}`);
  console.log(`Report range: ${reportRange}`);

  if (dryRun) {
    console.log("DRY_RUN is enabled; email was not sent.");
    return;
  }

  await sendEmail({ attachment, filename, reportRange, userName });
}

async function loadJournalState() {
  if (process.env.WORK_JOURNAL_STATE_JSON) {
    return JSON.parse(process.env.WORK_JOURNAL_STATE_JSON);
  }

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

  const gist = await response.json();
  const file = gist.files?.["work-journal.json"]
    || Object.values(gist.files || {}).find((item) => /\.json$/i.test(item.filename || ""));

  if (!file?.content) {
    throw new Error("Gist does not contain work-journal.json.");
  }

  return JSON.parse(file.content);
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
  const subject = process.env.MAIL_SUBJECT || `${userName} ${reportRange} 工作周报`;
  const text = process.env.MAIL_TEXT || [
    "您好，",
    "",
    `附件为${userName}${reportRange}工作周报，请查收。`,
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
