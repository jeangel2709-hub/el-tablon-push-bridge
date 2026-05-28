const express = require("express");
const admin = require("firebase-admin");
const fetch = require("node-fetch");

const app = express();
app.use(express.json({ limit: "1mb" }));

const PORT = process.env.PORT || 3001;
const TZ = "America/Lima";
const POLL_MS = Number(process.env.POLL_MS || 60000);
const CACHE_MS = Number(process.env.CACHE_MS || 900000);
const TOLERANCIA_MIN = Number(process.env.MINUTOS_TOLERANCIA || 8);
const BREAK_MAX_MIN = Number(process.env.BREAK_MAX_MINUTOS || 60);
const REMINDER_MIN = Number(process.env.REMINDER_MINUTOS || 10);

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

const memory = {
  admins: { ts: 0, rows: [] },
  workers: { ts: 0, rows: [] },
  devices: { ts: 0, rows: [] },
  processed: new Set(),
  lastBreakSweepMs: 0,
  lastReminderMinuteKey: "",
};

function log(...args) {
  console.log(new Date().toLocaleString("es-PE", { timeZone: TZ }), "|", ...args);
}

function todayKey(date = new Date()) {
  return date.toLocaleDateString("en-CA", { timeZone: TZ });
}

function norm(v = "") {
  return String(v || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().trim();
}

function getName(x = {}) {
  return x.trabajador || x.nombre || x.workerName || x.nombreTrabajador || x.colaborador || x.empleado || "Trabajador";
}

function getDni(x = {}) {
  return String(x.dni || x.documento || x.trabajadorDni || x.workerDni || "").replace(/\D/g, "");
}

function playerIds(x = {}) {
  return [...new Set([
    x.playerId, x.oneSignalPlayerId, x.onesignalPlayerId, x.subscriptionId,
    ...(Array.isArray(x.playerIds) ? x.playerIds : []),
    ...(Array.isArray(x.subscriptionIds) ? x.subscriptionIds : []),
  ].filter(Boolean).map(v => String(v).trim()))].filter(v => v.length > 10);
}

function toDate(v) {
  if (!v) return null;
  if (typeof v.toDate === "function") return v.toDate();
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

function createdDate(r = {}) {
  return toDate(r.createdAt) || toDate(r.fechaHora) || toDate(r.fechaIso) || toDate(r.fechaMarcacion) || toDate(r.fecha) || new Date();
}

function recordDateKey(r = {}) {
  return r.fechaOperativa || r.fechaIso || r.workDate || todayKey(createdDate(r));
}

function isToday(r = {}) {
  return recordDateKey(r) === todayKey();
}

function parseTimeMin(v) {
  if (!v) return null;
  const s = String(v).toLowerCase().replace(/\s+/g, "").replace("a.m.", "am").replace("p.m.", "pm").replace("a.m", "am").replace("p.m", "pm");
  const m = s.match(/(\d{1,2}):(\d{2})/);
  if (!m) return null;
  let h = Number(m[1]);
  const min = Number(m[2]);
  if (s.includes("pm") && h < 12) h += 12;
  if (s.includes("am") && h === 12) h = 0;
  return h * 60 + min;
}

function scheduleOf(r = {}, w = {}) {
  return r.horario || r.horarioTexto || r.turno || r.jornada || w.horario || w.horarioTexto || w.turno || w.jornada || "";
}

function scheduleStart(schedule = "") {
  if (!String(schedule).includes("-")) return null;
  return parseTimeMin(String(schedule).split("-")[0]);
}

function scheduleEnd(schedule = "") {
  if (!String(schedule).includes("-")) return null;
  return parseTimeMin(String(schedule).split("-")[1]);
}

function markMin(r = {}) {
  return parseTimeMin(r.hora || r.horaTexto || r.horaMarcacion || r.time || r.createdAt);
}

function isEntry(r = {}) {
  const t = norm(r.tipo || r.tipoMarcacion || r.accion || r.estado || "");
  return t.includes("entrada") || t.includes("ingreso") || String(r.id || "").toLowerCase().includes("entrada");
}

function lateMinutes(r = {}, w = {}) {
  const saved = Number(r.tardanza ?? r.tardanzaMin ?? r.minutosTardanza ?? r.lateMinutes ?? 0);
  if (Number.isFinite(saved) && saved > 0) return saved;

  const start = scheduleStart(scheduleOf(r, w));
  const mark = markMin(r);
  if (start == null || mark == null) return 0;

  let diff = mark - start;
  if (diff < -720) diff += 1440;
  return diff > 0 ? diff : 0;
}

async function getCol(name) {
  try {
    const snap = await db.collection(name).get();
    return snap.docs.map(d => ({ id: d.id, ...d.data() }));
  } catch (e) {
    log(`No se pudo leer ${name}:`, e.code || e.message);
    return [];
  }
}

async function adminsCached(force = false) {
  if (!force && Date.now() - memory.admins.ts < CACHE_MS && memory.admins.rows.length) return memory.admins.rows;
  const rows = [];
  for (const c of ["admins_push", "push_admins", "usuarios_roles"]) rows.push(...await getCol(c));
  memory.admins = { ts: Date.now(), rows };
  return rows;
}

async function workersCached(force = false) {
  if (!force && Date.now() - memory.workers.ts < CACHE_MS && memory.workers.rows.length) return memory.workers.rows;
  const rows = await getCol("trabajadores");
  memory.workers = { ts: Date.now(), rows };
  return rows;
}

async function devicesCached(force = false) {
  if (!force && Date.now() - memory.devices.ts < CACHE_MS && memory.devices.rows.length) return memory.devices.rows;
  const rows = [];
  for (const c of ["push_devices", "push_tokens"]) rows.push(...await getCol(c));
  memory.devices = { ts: Date.now(), rows };
  return rows;
}

async function adminIds() {
  return (await adminsCached()).flatMap(playerIds);
}

async function resolveWorker(r = {}) {
  const workers = await workersCached();
  const dni = getDni(r);
  const direct = getName(r);
  const wid = String(r.trabajadorId || r.workerId || r.uid || "").trim();

  const found = workers.find(w => {
    if (dni && getDni(w) && dni === getDni(w)) return true;
    if (wid && [w.id, w.uid, w.trabajadorId, w.workerId].filter(Boolean).map(String).includes(wid)) return true;
    if (direct !== "Trabajador" && norm(getName(w)) === norm(direct)) return true;
    return false;
  });

  return { ...(found || {}), ...r, trabajador: getName(found || r), dni: dni || getDni(found || {}) };
}

async function workerIds(worker = {}) {
  const direct = playerIds(worker);
  if (direct.length) return direct;

  const dni = getDni(worker);
  const name = norm(getName(worker));
  const devices = await devicesCached();

  return devices.filter(d => (dni && getDni(d) === dni) || (name && norm(getName(d)) === name)).flatMap(playerIds);
}

async function sendOneSignal({ title, message, playerIds, data = {} }) {
  const ids = [...new Set((playerIds || []).filter(Boolean).map(String))];
  if (!ONE_SIGNAL_APP_ID || !ONE_SIGNAL_REST_API_KEY) return log("OneSignal no configurado.");
  if (!ids.length) return log("Sin playerId destino:", title, message);

  const payload = {
    app_id: ONE_SIGNAL_APP_ID,
    include_player_ids: ids,
    headings: { es: title, en: title },
    contents: { es: message, en: message },
    data,
  };

  const res = await fetch("https://onesignal.com/api/v1/notifications", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Basic ${ONE_SIGNAL_REST_API_KEY}` },
    body: JSON.stringify(payload),
  });

  const json = await res.json().catch(() => ({}));
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
  } catch (e) {
    log("No se pudo leer push_sent_log:", e.code || e.message);
  }
  return false;
}

async function markProcessed(key, payload = {}) {
  memory.processed.add(key);
  try {
    await db.collection("push_sent_log").doc(key).set({
      ...payload, key, sentAt: admin.firestore.FieldValue.serverTimestamp(), dateKey: todayKey()
    }, { merge: true });
  } catch (e) {
    log("No se pudo escribir push_sent_log:", e.code || e.message);
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

async function processRecord(record = {}, docId = "") {
  if (!isToday(record)) return;

  const worker = await resolveWorker({ id: docId, ...record });
  const name = getName(worker);
  const dni = getDni(worker);
  const dateKey = todayKey();
  const admins = await adminIds();

  const late = lateMinutes(record, worker);
  if (isEntry({ id: docId, ...record }) && late > TOLERANCIA_MIN) {
    const over = late - TOLERANCIA_MIN;
    log(`Tardanza detectada: ${name} | ${over} min sobre tolerancia`);

    await sendOnce(`tardanza_${dni || name}_${dateKey}`, {
      title: "⚠️ Tardanza detectada",
      message: `${name} llegó tarde: ${over} min sobre tolerancia.`,
      playerIds: admins,
      data: { type: "tardanza", trabajador: name, dni, dateKey, minutosTardanza: late, sobreTolerancia: over },
    });
  }

  const gpsOk = record.gpsValidado ?? record.gpsValido ?? record.gpsOk;
  if (record.fueraRango === true || record.outOfRange === true || gpsOk === false) {
    await sendOnce(`gps_${dni || name}_${dateKey}_${docId}`, {
      title: "📍 Fuera de rango GPS",
      message: `${name} intentó marcar fuera del rango autorizado.`,
      playerIds: admins,
      data: { type: "fuera_rango", trabajador: name, dni, dateKey },
    });
  }

  const tipo = norm(record.tipo || record.tipoMarcacion || record.accion || record.estado || "");
  if (tipo.includes("salida")) {
    const end = scheduleEnd(scheduleOf(record, worker));
    const mark = markMin(record);
    if (end != null && mark != null && mark < end) {
      await sendOnce(`salida_anticipada_${dni || name}_${dateKey}`, {
        title: "🚨 Salida anticipada",
        message: `${name} salió antes de hora: ${end - mark} min antes.`,
        playerIds: admins,
        data: { type: "salida_anticipada", trabajador: name, dni, dateKey },
      });
    }
  }
}

async function readAttendanceToday() {
  try {
    const snap = await db.collection("asistencia").where("fechaOperativa", "==", todayKey()).limit(120).get();
    return snap.docs.map(d => ({ id: d.id, ...d.data() }));
  } catch (e) {
    log("No se pudo leer por fechaOperativa, intento fechaIso:", e.code || e.message);
  }

  try {
    const snap = await db.collection("asistencia").where("fechaIso", "==", todayKey()).limit(120).get();
    return snap.docs.map(d => ({ id: d.id, ...d.data() }));
  } catch (e) {
    log("No se pudo leer por fechaIso, fallback limit:", e.code || e.message);
  }

  try {
    const snap = await db.collection("asistencia").limit(120).get();
    return snap.docs.map(d => ({ id: d.id, ...d.data() })).filter(isToday);
  } catch (e) {
    log("No se pudo leer asistencia:", e.code || e.message);
    return [];
  }
}

async function pollAttendanceToday() {
  const rows = await readAttendanceToday();
  for (const row of rows) await processRecord(row, row.id);
}

async function sweepBreaksExceeded() {
  if (Date.now() - memory.lastBreakSweepMs < 8 * 60000) return;
  memory.lastBreakSweepMs = Date.now();

  const rows = await readAttendanceToday();
  const byWorker = new Map();

  for (const row of rows) {
    const worker = await resolveWorker(row).catch(() => row);
    const key = getDni(worker) || getName(worker);
    if (!byWorker.has(key)) byWorker.set(key, []);
    byWorker.get(key).push({ ...row, worker });
  }

  const admins = await adminIds();
  const dateKey = todayKey();

  for (const [key, marks] of byWorker.entries()) {
    const sorted = marks.sort((a, b) => createdDate(a) - createdDate(b));
    const last = sorted[sorted.length - 1];
    const tipo = norm(last.tipo || last.tipoMarcacion || "");
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

  const workers = await workersCached();
  const nowMin = now.getHours() * 60 + now.getMinutes();
  const dayKeys = ["dom", "lun", "mar", "mie", "jue", "vie", "sab"];
  const dayKey = dayKeys[now.getDay()];
  const dateKey = todayKey(now);

  for (const w of workers) {
    if (w.rol === "admin" || w.activo === false) continue;
    const schedule = w[dayKey] || w.horario || (w.horarios && w.horarios[dayKey]) || "";
    const start = scheduleStart(schedule);
    if (start == null) continue;
    if (start - nowMin !== REMINDER_MIN) continue;

    const name = getName(w);
    const dni = getDni(w);
    const ids = await workerIds(w);

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
    await adminsCached();
    await workersCached();
    await devicesCached();

    await pollAttendanceToday();
    await sweepBreaksExceeded();
    await sweepEntryReminders();

    log("tick OK: fechaOperativa/fechaIso + tardanza real");
  } catch (e) {
    log("tick error:", e.code || e.message);
  }
}

app.get("/", (_, res) => res.json({
  ok: true,
  service: "EL TABLÓN PUSH TARDANZA REAL FECHA/HORA",
  mode: "polling_60s_today_fechaOperativa_fechaIso",
}));

app.get("/health", (_, res) => res.json({ ok: true, ts: new Date().toISOString(), processed: memory.processed.size }));

app.post("/test-push-admin", async (_, res) => {
  const ids = await adminIds();
  const result = await sendOneSignal({
    title: "✅ Prueba push admin",
    message: "EL TABLÓN push con fecha/hora real activo.",
    playerIds: ids,
    data: { type: "test_admin" },
  });
  res.json({ ok: true, ids: ids.length, result });
});

app.listen(PORT, () => {
  log(`EL TABLÓN PUSH TARDANZA REAL FECHA/HORA activo en puerto ${PORT}`);
  log("Modo: polling 60s, sin onSnapshot, solo día actual, fechaOperativa/fechaIso.");
});

setTimeout(tick, 5000);
setInterval(tick, POLL_MS);