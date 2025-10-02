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

// "Имя [243822]" -> 243822
function extractUserId(s) {
  if (typeof s !== "string") return null;
  const m = s.match(/\[(\d+)\]/);
  return m ? Number(m[1]) : null;
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

  // Фолбэк — попытаемся распарсить и взять календарные части
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

  // ISO-like, берём первые 10 символов YYYY-MM-DD
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

// Приводим любой формат EXCLUSIONS к массиву однотипных элементов
// Поддерживаем:
//   "YYYY-MM-DD"
//   { DATE: "YYYY-MM-DD" }
//   { DATE_FROM: "YYYY-MM-DD", DATE_TO: "YYYY-MM-DD" }
//   Массивы этих вариантов; "[]", "", null, {} -> []
function normalizeExclusions(raw) {
  if (raw == null) return [];
  let arr = [];

  if (Array.isArray(raw)) {
    arr = raw;
  } else if (typeof raw === "string") {
    const s = raw.trim();
    if (!s || s === "[]") return [];
    try {
      const parsed = JSON.parse(s);
      if (Array.isArray(parsed)) arr = parsed;
      else if (parsed && typeof parsed === "object") arr = [parsed];
      else return [];
    } catch {
      // Не JSON — игнорируем
      return [];
    }
  } else if (typeof raw === "object") {
    arr = [raw];
  } else {
    return [];
  }

  const norm = [];
  for (const e of arr) {
    if (typeof e === "string") {
      const ymd = toYmd(e);
      if (ymd) norm.push({ type: "single", date: ymd });
      continue;
    }
    if (e && typeof e === "object") {
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
    }
  }
  return norm;
}

// Рабочий день = дата НЕ входит в EXCLUSIONS
function isWorkingDayByExclusions(schedule, ymd) {
  const raw = schedule?.CALENDAR?.EXCLUSIONS;
  const excl = normalizeExclusions(raw);
  if (!excl.length) return true; // нет исключений => все даты рабочие

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
    PARAMETERS: { smena: Number(scheduleId == 6 ? 1 : 2) }, // передаём ID графика (6 или 4)
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
 *  scheduleId1=Сергей%20Интегратор%20[243822]
 *  scheduleId2=Game%20Changer%20[150300]
 *  date=03.10.2025%2000:00:00   (или YYYY-MM-DD)
 *  bpTemplateId=45              (опционально, иначе из .env)
 *
 * Логика:
 *  - извлекаем uid1/uid2 из scheduleId1/2 (для логов)
 *  - проверяем графики 6, затем 4
 *  - рабочий день: дата НЕ в CALENDAR.EXCLUSIONS
 *  - на первом «рабочем» графике запускаем БП на лиде; параметр smena = ID графика
 */
app.all("/qg_shifts_webhook/shift-check", async (req, res) => {
  try {
    const {
      b24WebhookUrl,
      leadId,
      scheduleId1, // "Имя [ID]" (ID сотрудника, для логов)
      scheduleId2, // "Имя [ID]"
      date,
      bpTemplateId,
    } = req.query || {};

    if (!b24WebhookUrl || !leadId || !scheduleId1 || !scheduleId2 || !date) {
      return res.status(400).json({
        error:
          "Required query params: b24WebhookUrl, leadId, scheduleId1, scheduleId2, date",
      });
    }

    const host = webhookHost(String(b24WebhookUrl));
    const userId1 = extractUserId(String(scheduleId1));
    const userId2 = extractUserId(String(scheduleId2));

    const dateParts = parseDateParts(String(date));
    if (!dateParts) {
      return res.status(400).json({
        error: "Invalid date format. Use YYYY-MM-DD or DD.MM.YYYY[ HH:mm:ss]",
      });
    }
    const ymd = fmtYMD(dateParts);

    logMessage(
      "info",
      "shift-check",
      `Request received: host=${host}, leadId=${leadId}, s1=${scheduleId1} -> uid1=${userId1}, s2=${scheduleId2} -> uid2=${userId2}, date=${ymd}`
    );

    const webhookBase = normalizeWebhookBase(String(b24WebhookUrl));
    const tplId = bpTemplateId ? Number(bpTemplateId) : BP_TEMPLATE_ID;
    const documentId = buildDocumentIdForLead(leadId);

    // Требование: проверяем ровно графики ID 6 и 4 — по порядку
    const schedulesToCheck = [6, 4];

    for (const sid of schedulesToCheck) {
      const schedule = await getSchedule(webhookBase, sid);
      const working = isWorkingDayByExclusions(schedule, ymd);
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
          `Bizproc started: workflowId=${workflowId}, scheduleId=${sid}, leadId=${leadId}, users=[${userId1},${userId2}], date=${ymd}`
        );

        return res.json({
          ok: true,
          workingScheduleId: sid,
          workflowId,
          documentId,
          users: [userId1, userId2],
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
      users: [userId1, userId2],
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
