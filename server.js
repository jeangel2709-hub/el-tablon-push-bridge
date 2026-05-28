const express = require("express");
const admin = require("firebase-admin");
const fetch = require("node-fetch");

const app = express();
app.use(express.json({ limit: "1mb" }));

const PORT = process.env.PORT || 3001;
const ONE_SIGNAL_APP_ID = process.env.ONE_SIGNAL_APP_ID || process.env.ONESIGNAL_APP_ID || "";
const ONE_SIGNAL_REST_API_KEY = process.env.ONE_SIGNAL_REST_API_KEY || process.env.ONESIGNAL_REST_API_KEY || "";
const FIREBASE_PROJECT_ID = process.env.FIREBASE_PROJECT_ID || "";
const FIREBASE_CLIENT_EMAIL = process.env.FIREBASE_CLIENT_EMAIL || "";
let FIREBASE_PRIVATE_KEY = process.env.FIREBASE_PRIVATE_KEY || "";

if (FIREBASE_PRIVATE_KEY.includes("\\n")) FIREBASE_PRIVATE_KEY = FIREBASE_PRIVATE_KEY.replace(/\\n/g, "\n");

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert({
      projectId: FIREBASE_PROJECT_ID,
      clientEmail: FIREBASE_CLIENT_EMAIL,
      privateKey: FIREBASE_PRIVATE_KEY,
    }),
  });
}

const db = admin.firestore();

const TZ = "America/Lima";
const POLL_MS = Number(process.env.POLL_MS || 60000);
const CACHE_MS = Number(process.env.CACHE_MS || 900000);
const TOLERANCIA_MIN = Number(process.env.MINUTOS_TOLERANCIA || 8);
const BREAK_MAX_MIN = Number(process.env.BREAK_MAX_MINUTOS || 60);
const REMINDER_MIN = Number(process.env.REMINDER_MINUTOS || 10);

const memory = {
  admins: { ts: 0, rows: [] },
  workers: { ts: 0, rows: [] },
  devices: { ts: 0, rows: [] },
  processed: new Set(),
  lastAttendanceCheckMs: Date.now() - 10 * 60000,
  lastBreakSweepMs: 0,
  lastReminderMinuteKey: "",
};

function log(...args) {
  console.log(new Date().toLocaleString("es-PE", { timeZone: TZ }), "|", ...args);
}

function todayKey(date = new Date()) {
  return date.toLocaleDateString("en-CA", { timeZone: TZ });
}

function normalizeText(value = "") {
  return String(value || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().trim();
}

function getName(data = {}) {
  return data.trabajador || data.nombre || data.workerName || data.nombreTrabajador || data.colaborador || data.empleado || "Trabajador";
}

function getDni(data = {}) {
  return String(data.dni || data.documento || data.trabajadorDni || data.workerDni || "").replace(/\D/g, "");
}

function getPlayerIds(data = {}) {
  const values = [
    data.playerId,
    data.oneSignalPlayerId,
    data.onesignalPlayerId,
    data.subscriptionId,
    ...(Array.isArray(data.playerIds) ? data.playerIds : []),
    ...(Array.isArray(data.subscriptionIds) ? data.subscriptionIds : []),
  ];

  return [...new Set(values.filter(Boolean).map((id) => String(id).trim()))].filter((id) => id.length > 10);
}

function toDate(value) {
  if (!value) return null;
  if (typeof value.toDate === "function") return value.toDate();
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

function createdDate(record = {}) {
  return toDate(record.createdAt) || toDate(record.fechaHora) || toDate(record.fechaIso) || toDate(record.fechaMarcacion) || toDate(record.fecha) || new Date();
}

function parseTimeToMinutes(value) {
  if (!value) return null;
  const clean = String(value)
    .toLowerCase()
    .replace(/\s+/g, "")
    .replace("a.m.", "am")
    .replace("p.m.", "pm")
    .replace("a.m", "am")
    .replace("p.m", "pm");

  const match = clean.match(/(\d{1,2}):(\d{2})/);
  if (!match) return null;

  let h = Number(match[1]);
  const m = Number(match[2]);
  const isPm = clean.includes("pm");
  const isAm = clean.includes("am");

  if (isPm && h < 12) h += 12;
  if (isAm && h === 12) h = 0;

  return h * 60 + m;
}

function scheduleStartMinutes(schedule = "") {
  if (!schedule || !String(schedule).includes("-")) return null;
  return parseTimeToMinutes(String(schedule).split("-")[0]);
}

function scheduleEndMinutes(schedule = "") {
  if (!schedule || !String(schedule).includes("-")) return null;
  return parseTimeToMinutes(String(schedule).split("-")[1]);
}

function markTimeMinutes(record = {}) {
  return parseTimeToMinutes(record.hora || record.horaTexto || record.horaMarcacion || record.time || record.createdAt);
}

function isTodayRecord(record = {}) {
  const k = record.fechaIso || record.fechaOperativa || record.workDate || todayKey(createdDate(record));
  return k === todayKey();
}

function getRecordSchedule(record = {}, worker = {}) {
  return record.horario || record.horarioTexto || record.turno || record.jornada || worker.horario || worker.horarioTexto || worker.turno || worker.jornada || "";
}

// FIX PUNTUAL: tardanza calculada por horario real.
// Ya no depende solo de campos tardanza/minutosTardanza guardados en Firestore.
function calculateLateMinutes(record = {}, worker = {}) {
  const savedLate = Number(record.tardanza ?? record.tardanzaMin ?? record.minutosTardanza ?? record.lateMinutes ?? 0);
  if (Number.isFinite(savedLate) && savedLate > 0) return savedLate;

  const schedule = getRecordSchedule(record, worker);
  const start = scheduleStartMinutes(schedule);
  const marked = markTimeMinutes(record);

  if (start == null || marked == null) return 0;

  let diff = marked - start;
  if (diff < -720) diff += 1440; // soporte turno nocturno
  if (diff < 0) return 0;

  return diff;
}

async function safeGetCollection(collectionName) {
  try {
    const snap = await db.collection(collectionName).get();
    return snap.docs.map((doc) => ({ id: doc.id, ...doc.data() }));
  } catch (error) {
    log(`No se pudo leer ${collectionName}:`, error.code || error.message);
    return [];
  }
}

async function getAdminsCached(force = false) {
  if (!force && Date.now() - memory.admins.ts < CACHE_MS && memory.admins.rows.length) return memory.admins.rows;

  const rows = [];
  for (const col of ["admins_push", "push_admins", "usuarios_roles"]) rows.push(...await safeGetCollection(col));

  memory.admins = { ts: Date.now(), rows };
  return rows;
}

async function getWorkersCached(force = false) {
  if (!force && Date.now() - memory.workers.ts < CACHE_MS && memory.workers.rows.length) return memory.workers.rows;

  const rows = await safeGetCollection("trabajadores");
  memory.workers = { ts: Date.now(), rows };
  return rows;
}

async function getDevicesCached(force = false) {
  if (!force && Date.now() - memory.devices.ts < CACHE_MS && memory.devices.rows.length) return memory.devices.rows;

  const rows = [];
  for (const col of ["push_devices", "push_tokens"]) rows.push(...await safeGetCollection(col));

  memory.devices = { ts: Date.now(), rows };
  return rows;
}

async function getAdminPlayerIds() {
  const admins = await getAdminsCached();
  return admins.flatMap(getPlayerIds);
}

async function resolveWorker(record = {}) {
  const workers = await getWorkersCached();
  const dni = getDni(record);
  const directName = getName(record);
  const workerId = String(record.trabajadorId || record.workerId || record.uid || "").trim();

  const found = workers.find((worker) => {
    if (dni && getDni(worker) && dni === getDni(worker)) return true;
    if (workerId && [worker.id, worker.uid, worker.trabajadorId, worker.workerId].filter(Boolean).map(String).includes(workerId)) return true;
    if (directName !== "Trabajador" && normalizeText(getName(worker)) === normalizeText(directName)) return true;
    return false;
  });

  return { ...(found || {}), ...record, trabajador: getName(found || record), dni: dni || getDni(found || {}) };
}

async function getWorkerPlayerIds(worker = {}) {
  const direct = getPlayerIds(worker);
  if (direct.length) return direct;

  const dni = getDni(worker);
  const name = normalizeText(getName(worker));
  const devices = await getDevicesCached();

  const matches = devices.filter((device) => {
    if (dni && getDni(device) && dni === getDni(device)) return true;
    if (name && normalizeText(getName(device)) === name) return true;
    return false;
  });

  return matches.flatMap(getPlayerIds);
}

async function sendOneSignal({ title, message, playerIds, data = {} }) {
  const ids = [...new Set((playerIds || []).filter(Boolean).map(String))];

  if (!ONE_SIGNAL_APP_ID || !ONE_SIGNAL_REST_API_KEY) {
    log("OneSignal no configurado.");
    return null;
  }

  if (!ids.length) {
    log("Sin playerId destino:", title, message);
    return null;
  }

  const payload = {
    app_id: ONE_SIGNAL_APP_ID,
    include_player_ids: ids,
    headings: { es: title, en: title },
    contents: { es: message, en: message },
    data,
  };

  const response = await fetch("https://onesignal.com/api/v1/notifications", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Basic ${ONE_SIGNAL_REST_API_KEY}` },
    body: JSON.stringify(payload),
  });

  const json = await response.json().catch(() => ({}));
  log("push enviado include_player_ids:", title, message, json);
  return json;
}

async function wasProcessed(key) {
  if (memory.processed.has(key)) return true;

  try {
    const doc = await db.collection("push_sent_log").doc(key).get();
    if (doc.exists) {
      memory.processed.add(key);
      return true;
    }
  } catch (error) {
    log("No se pudo leer push_sent_log:", error.code || error.message);
  }

  return false;
}

async function markProcessed(key, payload = {}) {
  memory.processed.add(key);

  try {
    await db.collection("push_sent_log").doc(key).set({
      ...payload,
      key,
      sentAt: admin.firestore.FieldValue.serverTimestamp(),
      dateKey: todayKey(),
    }, { merge: true });
  } catch (error) {
    log("No se pudo escribir push_sent_log:", error.code || error.message);
  }
}

async function sendOnce(key, notification) {
  if (await wasProcessed(key)) return false;

  const result = await sendOneSignal(notification);
  await markProcessed(key, {
    type: notification.data?.type || "",
    trabajador: notification.data?.trabajador || "",
    dni: notification.data?.dni || "",
  });

  return Boolean(result);
}

async function processCriticalAttendance(record = {}, docId = "") {
  if (!isTodayRecord(record)) return;

  const worker = await resolveWorker({ id: docId, ...record });
  const name = getName(worker);
  const dni = getDni(worker);
  const dateKey = todayKey();
  const tipo = normalizeText(record.tipo || record.tipoMarcacion || record.accion || "");
  const admins = await getAdminPlayerIds();

  const late = calculateLateMinutes(record, worker);

  if ((tipo.includes("entrada") || tipo.includes("ingreso")) && late > TOLERANCIA_MIN) {
    const lateOverTolerance = late - TOLERANCIA_MIN;

    await sendOnce(`tardanza_${dni || name}_${dateKey}`, {
      title: "⚠️ Tardanza detectada",
      message: `${name} llegó tarde: ${lateOverTolerance} min sobre tolerancia.`,
      playerIds: admins,
      data: { type: "tardanza", trabajador: name, dni, dateKey, minutosTardanza: late, sobreTolerancia: lateOverTolerance },
    });
  }

  const gpsOk = record.gpsValidado ?? record.gpsValido ?? record.gpsOk;
  const outOfRange = record.fueraRango === true || record.outOfRange === true || gpsOk === false;

  if (outOfRange) {
    await sendOnce(`gps_${dni || name}_${dateKey}_${docId}`, {
      title: "📍 Fuera de rango GPS",
      message: `${name} intentó marcar fuera del rango autorizado.`,
      playerIds: admins,
      data: { type: "fuera_rango", trabajador: name, dni, dateKey },
    });
  }

  if (tipo.includes("salida")) {
    const expectedEnd = scheduleEndMinutes(getRecordSchedule(record, worker));
    const mark = markTimeMinutes(record);

    if (expectedEnd != null && mark != null && mark < expectedEnd) {
      const diff = expectedEnd - mark;

      await sendOnce(`salida_anticipada_${dni || name}_${dateKey}`, {
        title: "🚨 Salida anticipada",
        message: `${name} salió antes de hora: ${diff} min antes.`,
        playerIds: admins,
        data: { type: "salida_anticipada", trabajador: name, dni, dateKey },
      });
    }
  }
}

async function pollAttendanceIncremental() {
  const since = new Date(memory.lastAttendanceCheckMs);
  const now = Date.now();

  let rows = [];

  try {
    const snap = await db.collection("asistencia").where("createdAt", ">=", since.toISOString()).limit(80).get();
    rows = snap.docs.map((doc) => ({ id: doc.id, ...doc.data() }));
  } catch (error) {
    log("Polling incremental fallback:", error.code || error.message);

    try {
      const snap = await db.collection("asistencia").limit(80).get();
      rows = snap.docs.map((doc) => ({ id: doc.id, ...doc.data() })).filter(isTodayRecord);
    } catch (fallbackError) {
      log("No se pudo leer asistencia:", fallbackError.code || fallbackError.message);
      return;
    }
  }

  for (const row of rows) await processCriticalAttendance(row, row.id);

  memory.lastAttendanceCheckMs = now - 2 * 60000;
}

async function sweepBreaksExceeded() {
  const now = Date.now();
  if (now - memory.lastBreakSweepMs < 8 * 60000) return;
  memory.lastBreakSweepMs = now;

  let rows = [];

  try {
    const snap = await db.collection("asistencia").limit(120).get();
    rows = snap.docs.map((doc) => ({ id: doc.id, ...doc.data() })).filter(isTodayRecord);
  } catch (error) {
    log("No se pudo leer asistencia para break:", error.code || error.message);
    return;
  }

  const byWorker = new Map();

  for (const row of rows) {
    const worker = await resolveWorker(row).catch(() => row);
    const key = getDni(worker) || getName(worker);

    if (!byWorker.has(key)) byWorker.set(key, []);
    byWorker.get(key).push({ ...row, worker });
  }

  const admins = await getAdminPlayerIds();
  const dateKey = todayKey();

  for (const [key, marks] of byWorker.entries()) {
    const sorted = marks.sort((a, b) => createdDate(a) - createdDate(b));
    const last = sorted[sorted.length - 1];
    const tipo = normalizeText(last.tipo || last.tipoMarcacion || "");

    if (!tipo.includes("break") || tipo.includes("termino") || tipo.includes("fin")) continue;

    const minutes = Math.floor((Date.now() - createdDate(last).getTime()) / 60000);
    if (minutes <= BREAK_MAX_MIN) continue;

    const name = getName(last.worker || last);
    const dni = getDni(last.worker || last);

    await sendOnce(`break_excedido_${key}_${dateKey}`, {
      title: "☕ Break excedido",
      message: `${name} lleva ${minutes} min en break.`,
      playerIds: admins,
      data: { type: "break_excedido", trabajador: name, dni, dateKey },
    });
  }
}

async function sweepEntryReminders() {
  const now = new Date();
  const minuteKey = `${todayKey(now)}_${now.getHours()}_${now.getMinutes()}`;

  if (memory.lastReminderMinuteKey === minuteKey) return;
  memory.lastReminderMinuteKey = minuteKey;

  const workers = await getWorkersCached();
  const nowMin = now.getHours() * 60 + now.getMinutes();
  const dayKeys = ["dom", "lun", "mar", "mie", "jue", "vie", "sab"];
  const dayKey = dayKeys[now.getDay()];
  const dateKey = todayKey(now);

  for (const worker of workers) {
    if (worker.rol === "admin" || worker.activo === false) continue;

    const schedule = worker[dayKey] || worker.horario || (worker.horarios && worker.horarios[dayKey]) || "";
    const start = scheduleStartMinutes(schedule);

    if (start == null) continue;
    if (start - nowMin !== REMINDER_MIN) continue;

    const name = getName(worker);
    const dni = getDni(worker);
    const ids = await getWorkerPlayerIds(worker);

    await sendOnce(`reminder10_${dni || name}_${dateKey}`, {
      title: "⏰ Recordatorio de ingreso",
      message: `${name} debes marcar ingreso en 10 minutos.`,
      playerIds: ids,
      data: { type: "recordatorio_ingreso", trabajador: name, dni, dateKey },
    });
  }
}

async function tick() {
  try {
    await getAdminsCached();
    await getWorkersCached();
    await getDevicesCached();

    await pollAttendanceIncremental();
    await sweepBreaksExceeded();
    await sweepEntryReminders();

    log("tick ultra light OK + tardanza calculada");
  } catch (error) {
    log("tick error:", error.code || error.message);
  }
}

app.get("/", (_, res) => {
  res.json({ ok: true, service: "EL TABLÓN PUSH ULTRA LIGHT + TARDANZA CALCULADA", mode: "polling_60s_no_onSnapshot_today_only" });
});

app.get("/health", (_, res) => {
  res.json({ ok: true, ts: new Date().toISOString(), processed: memory.processed.size, lastAttendanceCheckMs: memory.lastAttendanceCheckMs });
});

app.post("/test-push-admin", async (_, res) => {
  const ids = await getAdminPlayerIds();

  const result = await sendOneSignal({
    title: "✅ Prueba push admin",
    message: "EL TABLÓN Ultra Light activo con tardanza calculada.",
    playerIds: ids,
    data: { type: "test_admin" },
  });

  res.json({ ok: true, ids: ids.length, result });
});

app.listen(PORT, () => {
  log(`EL TABLÓN PUSH ULTRA LIGHT + TARDANZA CALCULADA activo en puerto ${PORT}`);
  log("Modo: polling cada 60s, cache real, incremental, sin onSnapshot, solo día actual.");
});

setTimeout(tick, 5000);
setInterval(tick, POLL_MS);