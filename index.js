// server.js
import express from "express";
import axios from "axios";
import { logMessage } from "./logger.js";
import dotenv from "dotenv";
dotenv.config();

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;
const BP_TEMPLATE_ID = Number(process.env.BP_TEMPLATE_ID || 1);

// ===================== helpers =====================

// Только базовая валидация домена и завершающий слэш
function normalizeWebhookBase(urlStr) {
  const u = new URL(urlStr);
  if (!/bitrix24\./i.test(u.hostname)) {
    throw new Error("Webhook must be a Bitrix24 domain");
  }
  if (!u.pathname.endsWith("/")) u.pathname += "/";
  return u.toString();
}
function webhookHost(urlStr) {
  try {
    return new URL(urlStr).hostname;
  } catch {
    return "unknown-host";
  }
}

// ---------- Работа с датой (строго по календарю, без TZ) ----------
function parseDateParts(s) {
  if (!s) return null;

  // YYYY-MM-DD
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (m) return { year: +m[1], month: +m[2], day: +m[3] };

  // DD.MM.YYYY[ HH:mm:ss]
  m = s.match(/^(\d{2})\.(\d{2})\.(\d{4})(?:\s+\d{2}:\d{2}:\d{2})?$/);
  if (m) return { year: +m[3], month: +m[2], day: +m[1] };

  // Фолбэк — возьмём календарные части из Date
  const d = new Date(s);
  if (!Number.isNaN(d.getTime())) {
    return { year: d.getFullYear(), month: d.getMonth() + 1, day: d.getDate() };
  }
  return null;
}
function fmtYMD({ year, month, day }) {
  const mm = String(month).padStart(2, "0");
  const dd = String(day).padStart(2, "0");
  return `${year}-${mm}-${dd}`;
}

// ---------- Нормализация EXCLUSIONS ----------
function toYmd(s) {
  if (!s || typeof s !== "string") return null;

  // ISO-like YYYY-MM-DD(…)
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;

  // DD.MM.YYYY
  m = s.match(/^(\d{2})\.(\d{2})\.(\d{4})/);
  if (m) return `${m[3]}-${m[2]}-${m[1]}`;

  // Last resort
  const d = new Date(s);
  if (!Number.isNaN(d.getTime())) {
    const yyyy = d.getFullYear();
    const mm = String(d.getMonth() + 1).padStart(2, "0");
    const dd = String(d.getDate()).padStart(2, "0");
    return `${yyyy}-${mm}-${dd}`;
  }
  return null;
}
function safeParseJSON(s) {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}
// Приводим что угодно к массиву (вскрываем строковые JSON)
function normalizeToArray(raw) {
  if (raw == null) return [];
  if (Array.isArray(raw)) return raw;
  if (typeof raw === "string") {
    const t = raw.trim();
    if (!t) return [];
    if (/^[\[\{]/.test(t)) {
      const parsed = safeParseJSON(t);
      if (Array.isArray(parsed)) return parsed;
      if (parsed && typeof parsed === "object") return [parsed];
      return [];
    }
    return [t]; // строка-дата или строка-диапазон
  }
  if (typeof raw === "object") return [raw];
  return [];
}

// Выдаёт массив объектов:
// { type: "single", date: "YYYY-MM-DD" } или { type: "range", from: "YYYY-MM-DD", to: "YYYY-MM-DD" }
function normalizeExclusions(raw) {
  // helper’ы
  const queue = normalizeToArray(raw);
  const norm = [];

  // Специальный парсер карты: { "2025": { "10": { "3": "0", ... } } }
  const tryCalendarMap = (obj) => {
    let found = false;
    for (const y of Object.keys(obj || {})) {
      const ym = obj[y];
      if (ym && typeof ym === "object") {
        for (const m of Object.keys(ym)) {
          const md = ym[m];
          if (md && typeof md === "object") {
            for (const d of Object.keys(md)) {
              // значение обычно "0" -> выходной; ключи — числа-строки
              const yyyy = String(y).padStart(4, "0");
              const mm = String(m).padStart(2, "0");
              const dd = String(d).padStart(2, "0");
              norm.push({ type: "single", date: `${yyyy}-${mm}-${dd}` });
              found = true;
            }
          }
        }
      }
    }
    return found;
  };

  while (queue.length) {
    const e = queue.shift();

    // строка-JSON — раскрываем
    if (typeof e === "string" && /^[\[\{]/.test(e.trim())) {
      const parsed = safeParseJSON(e.trim());
      if (parsed != null) {
        const arr = normalizeToArray(parsed);
        queue.push(...arr);
        continue;
      }
    }

    // строка-диапазон "YYYY-MM-DD to YYYY-MM-DD" / "YYYY-MM-DD - YYYY-MM-DD"
    if (typeof e === "string") {
      const range = e.match(
        /^(\d{4}-\d{2}-\d{2})\s*(?:to|-|—)\s*(\d{4}-\d{2}-\d{2})$/i
      );
      if (range) {
        const from = toYmd(range[1]);
        const to = toYmd(range[2]);
        if (from && to) {
          norm.push({ type: "range", from, to });
          continue;
        }
      }
      const ymd = toYmd(e);
      if (ymd) {
        norm.push({ type: "single", date: ymd });
      }
      continue;
    }

    // объект
    if (e && typeof e === "object") {
      // 1) Прямо карта календаря {YYYY:{MM:{DD:"0"}}}
      if (tryCalendarMap(e)) continue;

      // 2) Вложенный массив исключений
      if (Array.isArray(e.EXCLUSIONS)) {
        queue.push(...e.EXCLUSIONS);
        continue;
      }

      // 3) Обычные формы объектов
      if (typeof e.DATE === "string") {
        const ymd = toYmd(e.DATE);
        if (ymd) norm.push({ type: "single", date: ymd });
        continue;
      }
      const from = toYmd(e.DATE_FROM);
      const to = toYmd(e.DATE_TO);
      if (from && to) {
        norm.push({ type: "range", from, to });
        continue;
      }

      // 4) Обойти вложенные поля (вдруг там строки/массивы/объекты)
      for (const v of Object.values(e)) {
        const arr = normalizeToArray(v);
        if (arr.length) queue.push(...arr);
      }
      continue;
    }
  }

  // Дедуп
  const seenSingles = new Set();
  const seenRanges = new Set();
  const dedup = [];
  for (const it of norm) {
    if (it.type === "single") {
      const key = `S|${it.date}`;
      if (!seenSingles.has(key)) {
        seenSingles.add(key);
        dedup.push(it);
      }
    } else if (it.type === "range") {
      const key = `R|${it.from}|${it.to}`;
      if (!seenRanges.has(key)) {
        seenRanges.add(key);
        dedup.push(it);
      }
    }
  }
  return dedup;
}

// Рабочий день = дата НЕ входит в EXCLUSIONS
function isWorkingDayByExclusions(schedule, ymd, debug = false, sid = null) {
  const raw = schedule?.CALENDAR?.EXCLUSIONS;
  const calendarId = schedule?.CALENDAR?.ID ?? schedule?.CALENDAR_ID ?? null;
  const excl = normalizeExclusions(raw);
  if (debug) {
    const sampleSingles = excl
      .filter((x) => x.type === "single")
      .slice(0, 5)
      .map((x) => x.date);
    const sampleRanges = excl
      .filter((x) => x.type === "range")
      .slice(0, 3)
      .map((x) => `${x.from}..${x.to}`);
    logMessage(
      "info",
      "shift-check",
      `Calendar debug: scheduleId=${
        sid ?? "?"
      }, calendarId=${calendarId}, exclSingles=${
        sampleSingles.length
      } [${sampleSingles.join(", ")}], exclRanges=${
        sampleRanges.length
      } [${sampleRanges.join(", ")}]`
    );
  }

  if (!excl.length) return true; // нет исключений => день рабочий

  const hit = excl.some((item) => {
    if (item.type === "single") return item.date === ymd;
    if (item.type === "range") return ymd >= item.from && ymd <= item.to;
    return false;
  });
  return !hit;
}

// ---------- REST ----------
async function getSchedule(webhookBase, scheduleId) {
  const url = `${webhookBase}timeman.schedule.get.json`;
  const { data } = await axios.post(
    url,
    { id: Number(scheduleId) },
    { timeout: 15000 }
  );
  if (!data || data.error) {
    throw new Error(
      `Bitrix error for schedule ${scheduleId}: ${
        data?.error_description || data?.error || "unknown"
      }`
    );
  }
  return data.result;
}
function buildDocumentIdForLead(leadId) {
  const idNum = Number(leadId);
  if (!Number.isFinite(idNum) || idNum <= 0) throw new Error("Invalid leadId");
  return ["crm", "CCrmDocumentLead", `LEAD_${idNum}`];
}
async function startWorkflow({
  webhookBase,
  scheduleId,
  bpTemplateId,
  documentId,
}) {
  const url = `${webhookBase}bizproc.workflow.start.json`;
  const payload = {
    TEMPLATE_ID: Number(bpTemplateId),
    DOCUMENT_ID: documentId,
    // передаём флаг смены: 1 для графика 6, 2 для графика 4 (как у тебя было)
    PARAMETERS: { smena: Number(scheduleId == 6 ? 1 : 2) },
  };
  const { data } = await axios.post(url, payload, { timeout: 15000 });
  if (!data || data.error) {
    throw new Error(
      `Bizproc start error: ${
        data?.error_description || data?.error || "unknown"
      }`
    );
  }
  return data.result; // workflow id
}

// ===================== middleware =====================
app.use((req, res, next) => {
  const started = Date.now();
  res.on("finish", () => {
    const ms = Date.now() - started;
    logMessage(
      "access",
      "http",
      `${req.method} ${req.originalUrl} -> ${res.statusCode} (${ms}ms) from ${req.ip}`
    );
  });
  next();
});

app.get("/health", (req, res) => res.status(200).send("OK"));

// ===================== handler =====================
/**
 * Параметры из QUERY-строки (GET/POST/…):
 *  b24WebhookUrl=https://portal.bitrix24.kz/rest/USER/TOKEN/
 *  leadId=398494
 *  date=03.10.2025%2000:00:00   (или YYYY-MM-DD)
 *  bpTemplateId=45              (опционально, иначе из .env)
 *  debug=1                      (опционально: вернуть доп. диагностику в логах)
 *
 * Логика:
 *  - проверяем графики 6, затем 4
 *  - рабочий день: дата НЕ в CALENDAR.EXCLUSIONS
 *  - на первом «рабочем» графике запускаем БП на лиде; параметр smena = 1 (для 6) или 2 (для 4)
 */
app.all("/qg_shifts_webhook/shift-check", async (req, res) => {
  try {
    const { b24WebhookUrl, leadId, date, bpTemplateId, debug } =
      req.query || {};

    if (!b24WebhookUrl || !leadId || !date) {
      return res
        .status(400)
        .json({ error: "Required query params: b24WebhookUrl, leadId, date" });
    }

    const host = webhookHost(String(b24WebhookUrl));
    const dateParts = parseDateParts(String(date));
    if (!dateParts) {
      return res.status(400).json({
        error: "Invalid date format. Use YYYY-MM-DD or DD.MM.YYYY[ HH:mm:ss]",
      });
    }
    const ymd = fmtYMD(dateParts);
    const dbg = String(debug || "") === "1";

    logMessage(
      "info",
      "shift-check",
      `Request received: host=${host}, leadId=${leadId}, date=${ymd}, debug=${dbg}`
    );

    const webhookBase = normalizeWebhookBase(String(b24WebhookUrl));
    const tplId = bpTemplateId ? Number(bpTemplateId) : BP_TEMPLATE_ID;
    const documentId = buildDocumentIdForLead(leadId);

    // Проверяем ровно графики ID 6 и 4 — по порядку
    const schedulesToCheck = [6, 4];

    for (const sid of schedulesToCheck) {
      const schedule = await getSchedule(webhookBase, sid);
      const working = isWorkingDayByExclusions(schedule, ymd, dbg, sid);
      logMessage(
        "info",
        "shift-check",
        `Schedule check: scheduleId=${sid}, date=${ymd}, working=${working}`
      );

      if (working) {
        const workflowId = await startWorkflow({
          webhookBase,
          scheduleId: sid,
          bpTemplateId: tplId,
          documentId,
        });
        logMessage(
          "info",
          "shift-check",
          `Bizproc started: workflowId=${workflowId}, scheduleId=${sid}, leadId=${leadId}, date=${ymd}`
        );
        return res.json({
          ok: true,
          workingScheduleId: sid,
          workflowId,
          documentId,
          date: ymd,
        });
      }
    }

    logMessage("info", "shift-check", `No working schedules for date=${ymd}`);
    return res.json({
      ok: true,
      workingScheduleId: null,
      message: "Выходной по обоим графикам (6 и 4)",
      documentId,
      date: ymd,
    });
  } catch (e) {
    logMessage("error", "shift-check", e);
    return res.status(500).json({ error: String(e.message || e) });
  }
});

app.listen(PORT, () => {
  logMessage("info", "startup", `Shift checker listening on :${PORT}`);
});
