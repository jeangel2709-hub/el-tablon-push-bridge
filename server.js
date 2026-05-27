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

const SPAM_CACHE = new Map();
const WORKER_CACHE = { ts: 0, rows: [] };
const ADMIN_CACHE = { ts: 0, rows: [] };

const TOLERANCIA_MIN = Number(process.env.MINUTOS_TOLERANCIA || 8);
const BREAK_MAX_MIN = Number(process.env.BREAK_MAX_MINUTOS || 60);
const REMINDER_MIN = Number(process.env.REMINDER_MINUTOS || 10);
const CACHE_MS = 10 * 60 * 1000;

function todayKey(date = new Date()) {
  return date.toLocaleDateString("en-CA", { timeZone: "America/Lima" });
}

function normalizeText(v = "") {
  return String(v || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().trim();
}

function getName(x = {}) {
  return x.trabajador || x.nombre || x.workerName || x.nombreTrabajador || x.colaborador || x.empleado || "Trabajador";
}

function getDni(x = {}) {
  return String(x.dni || x.documento || x.trabajadorDni || x.workerDni || "").replace(/\D/g, "");
}

function getSede(x = {}) {
  return x.sede || x.sucursal || x.local || "";
}

function getPlayerIds(x = {}) {
  const ids = [
    x.playerId,
    x.oneSignalPlayerId,
    x.onesignalPlayerId,
    x.subscriptionId,
    ...(Array.isArray(x.playerIds) ? x.playerIds : []),
    ...(Array.isArray(x.subscriptionIds) ? x.subscriptionIds : []),
  ].filter(Boolean).map(String);
  return [...new Set(ids)].filter((id) => id.length > 10);
}

function createdDate(x = {}) {
  const raw = x.createdAt || x.fechaHora || x.fechaIso || x.fechaMarcacion || x.fecha;
  if (!raw) return new Date();
  if (raw.toDate) return raw.toDate();
  const d = new Date(raw);
  return Number.isNaN(d.getTime()) ? new Date() : d;
}

function parseTimeToMinutes(text) {
  if (!text) return null;
  const s = String(text).toLowerCase().replace(/\s+/g, "");
  const m = s.match(/(\d{1,2}):(\d{2})/);
  if (!m) return null;
  let h = Number(m[1]);
  const min = Number(m[2]);
  const pm = s.includes("pm") || s.includes("p.m");
  const am = s.includes("am") || s.includes("a.m");
  if (pm && h < 12) h += 12;
  if (am && h === 12) h = 0;
  return h * 60 + min;
}

function scheduleEndMinutes(schedule = "") {
  if (!schedule || !String(schedule).includes("-")) return null;
  return parseTimeToMinutes(String(schedule).split("-")[1]);
}

function markTimeMinutes(record = {}) {
  return parseTimeToMinutes(record.hora || record.horaTexto || record.time || record.createdAt);
}

function isSpam(key, minutes = 1440) {
  const now = Date.now();
  const prev = SPAM_CACHE.get(key);
  if (prev && now - prev < minutes * 60 * 1000) return true;
  SPAM_CACHE.set(key, now);
  return false;
}

async function getWorkers() {
  if (Date.now() - WORKER_CACHE.ts < CACHE_MS && WORKER_CACHE.rows.length) return WORKER_CACHE.rows;
  const snap = await db.collection("trabajadores").get();
  WORKER_CACHE.rows = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
  WORKER_CACHE.ts = Date.now();
  return WORKER_CACHE.rows;
}

async function getAdmins() {
  if (Date.now() - ADMIN_CACHE.ts < CACHE_MS && ADMIN_CACHE.rows.length) return ADMIN_CACHE.rows;
  const cols = ["admins_push", "push_admins", "usuarios_roles"];
  const rows = [];
  for (const c of cols) {
    try {
      const snap = await db.collection(c).get();
      snap.docs.forEach((d) => rows.push({ id: d.id, ...d.data() }));
    } catch (e) {}
  }
  ADMIN_CACHE.rows = rows;
  ADMIN_CACHE.ts = Date.now();
  return rows;
}

async function resolveWorker(record = {}) {
  const directName = getName(record);
  const dni = getDni(record);
  const id = String(record.trabajadorId || record.workerId || record.uid || record.idWorker || "").trim();
  const workers = await getWorkers().catch(() => []);
  const match = workers.find((w) => {
    const wDni = getDni(w);
    if (dni && wDni && dni === wDni) return true;
    if (id && [w.id, w.uid, w.trabajadorId, w.workerId].filter(Boolean).map(String).includes(id)) return true;
    if (directName !== "Trabajador" && normalizeText(getName(w)) === normalizeText(directName)) return true;
    return false;
  });
  return {
    ...(match || {}),
    ...record,
    trabajador: getName(match || record),
    dni: dni || getDni(match || {}),
    sede: getSede(record) || getSede(match || {}),
  };
}

async function sendOneSignal({ title, message, playerIds, data = {} }) {
  const ids = [...new Set((playerIds || []).filter(Boolean))];
  if (!ONE_SIGNAL_APP_ID || !ONE_SIGNAL_REST_API_KEY) {
    console.log("OneSignal no configurado.");
    return null;
  }
  if (!ids.length) {
    console.log("Sin playerId destino:", title, message);
    return null;
  }

  const res = await fetch("https://onesignal.com/api/v1/notifications", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Basic ${ONE_SIGNAL_REST_API_KEY}`,
    },
    body: JSON.stringify({
      app_id: ONE_SIGNAL_APP_ID,
      include_player_ids: ids,
      headings: { es: title, en: title },
      contents: { es: message, en: message },
      data,
    }),
  });

  const json = await res.json().catch(() => ({}));
  console.log("push enviado:", title, message, json);
  return json;
}

async function adminPlayerIds() {
  const admins = await getAdmins().catch(() => []);
  return admins.flatMap(getPlayerIds);
}

async function workerPlayerIds(worker = {}) {
  const direct = getPlayerIds(worker);
  if (direct.length) return direct;
  const dni = getDni(worker);
  if (!dni) return [];
  const snap = await db.collection("push_devices").where("dni", "==", dni).limit(5).get().catch(() => null);
  if (!snap || snap.empty) return [];
  return snap.docs.flatMap((d) => getPlayerIds(d.data()));
}

async function handleCriticalAttendance(record = {}, docId = "") {
  const worker = await resolveWorker({ id: docId, ...record });
  const name = getName(worker);
  const dateKey = record.fechaIso || record.fechaOperativa || todayKey(createdDate(record));
  const tipoRaw = String(record.tipo || record.tipoMarcacion || record.accion || "").toLowerCase();
  const tipo = normalizeText(tipoRaw);
  const admins = await adminPlayerIds();

  const late = Number(record.tardanza || record.tardanzaMin || record.minutosTardanza || 0);
  if ((tipo.includes("entrada") || tipo.includes("ingreso")) && late > TOLERANCIA_MIN) {
    const key = `tardanza:${getDni(worker) || name}:${dateKey}`;
    if (!isSpam(key)) {
      await sendOneSignal({
        title: "⚠️ Tardanza detectada",
        message: `${name} llegó tarde: ${late} min sobre tolerancia.`,
        playerIds: admins,
        data: { type: "tardanza", trabajador: name, dni: getDni(worker), dateKey },
      });
    }
  }

  const gpsOk = record.gpsValidado ?? record.gpsValido ?? record.gpsOk;
  const fueraRango = record.fueraRango === true || record.outOfRange === true || gpsOk === false;
  if (fueraRango) {
    const key = `gps:${getDni(worker) || name}:${dateKey}:${tipo || "marca"}`;
    if (!isSpam(key)) {
      await sendOneSignal({
        title: "📍 Fuera de rango GPS",
        message: `${name} intentó marcar fuera del rango autorizado.`,
        playerIds: admins,
        data: { type: "fuera_rango", trabajador: name, dni: getDni(worker), dateKey },
      });
    }
  }

  if (tipo.includes("salida")) {
    const end = scheduleEndMinutes(record.horario || record.horarioTexto || "");
    const mark = markTimeMinutes(record);
    if (end != null && mark != null && mark < end) {
      const diff = end - mark;
      const key = `salida_anticipada:${getDni(worker) || name}:${dateKey}`;
      if (!isSpam(key)) {
        await sendOneSignal({
          title: "🚨 Salida anticipada",
          message: `${name} salió antes de hora: ${diff} min antes.`,
          playerIds: admins,
          data: { type: "salida_anticipada", trabajador: name, dni: getDni(worker), dateKey },
        });
      }
    }
  }
}

async function sweepBreaksExceeded() {
  const snap = await db.collection("asistencia").get().catch(() => null);
  if (!snap) return;
  const rows = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
  const byWorker = new Map();

  for (const r of rows) {
    const worker = await resolveWorker(r).catch(() => r);
    const key = getDni(worker) || getName(worker);
    if (!byWorker.has(key)) byWorker.set(key, []);
    byWorker.get(key).push({ ...r, worker });
  }

  const admins = await adminPlayerIds();

  for (const [key, marks] of byWorker.entries()) {
    const sorted = marks.sort((a, b) => createdDate(a) - createdDate(b));
    const last = sorted[sorted.length - 1];
    const tipo = normalizeText(last.tipo || last.tipoMarcacion || "");
    if (!tipo.includes("break") || tipo.includes("termino") || tipo.includes("fin")) continue;

    const minutes = Math.floor((Date.now() - createdDate(last).getTime()) / 60000);
    if (minutes <= BREAK_MAX_MIN) continue;

    const name = getName(last.worker || last);
    const dateKey = todayKey();
    const spamKey = `break_excedido:${key}:${dateKey}`;
    if (isSpam(spamKey)) continue;

    await sendOneSignal({
      title: "☕ Break excedido",
      message: `${name} lleva ${minutes} min en break.`,
      playerIds: admins,
      data: { type: "break_excedido", trabajador: name, dni: getDni(last.worker || last), dateKey },
    });
  }
}

async function sweepEntryReminders() {
  const workers = await getWorkers().catch(() => []);
  const now = new Date();
  const nowMin = now.getHours() * 60 + now.getMinutes();
  const dayKeys = ["dom", "lun", "mar", "mie", "jue", "vie", "sab"];
  const dayKey = dayKeys[now.getDay()];
  const dateKey = todayKey(now);

  for (const worker of workers) {
    if (worker.rol === "admin" || worker.activo === false) continue;
    const schedule = worker[dayKey] || worker.horario || (worker.horarios && worker.horarios[dayKey]) || "";
    const start = parseTimeToMinutes(String(schedule).split("-")[0]);
    if (start == null) continue;
    if (start - nowMin !== REMINDER_MIN) continue;

    const spamKey = `reminder10:${getDni(worker) || getName(worker)}:${dateKey}`;
    if (isSpam(spamKey)) continue;

    const ids = await workerPlayerIds(worker);
    await sendOneSignal({
      title: "⏰ Recordatorio de ingreso",
      message: `${getName(worker)} debes marcar ingreso en 10 minutos.`,
      playerIds: ids,
      data: { type: "recordatorio_ingreso", trabajador: getName(worker), dni: getDni(worker), dateKey },
    });
  }
}

function startListeners() {
  db.collection("asistencia").onSnapshot((snapshot) => {
    snapshot.docChanges().forEach((change) => {
      if (change.type !== "added" && change.type !== "modified") return;
      handleCriticalAttendance(change.doc.data(), change.doc.id).catch((e) => {
        console.log("error procesando asistencia crítica:", e.message);
      });
    });
  }, (error) => console.log("listener asistencia:", error.message));

  console.log("Listener crítico asistencia activo: tardanza, GPS, salida anticipada.");
}

app.get("/", (_, res) => res.json({ ok: true, service: "EL TABLON PUSH CRITICO LIMITADO" }));
app.get("/health", (_, res) => res.json({ ok: true, ts: new Date().toISOString() }));
app.post("/test-push-admin", async (req, res) => {
  const ids = await adminPlayerIds();
  const result = await sendOneSignal({
    title: "✅ Prueba push admin",
    message: "EL TABLÓN push crítico limitado activo.",
    playerIds: ids,
    data: { type: "test_admin" },
  });
  res.json({ ok: true, ids: ids.length, result });
});

startListeners();
setInterval(() => sweepBreaksExceeded().catch((e) => console.log("sweep break:", e.message)), 8 * 60 * 1000);
setInterval(() => sweepEntryReminders().catch((e) => console.log("sweep reminders:", e.message)), 60 * 1000);

app.listen(PORT, () => {
  console.log(`EL TABLÓN PUSH CRÍTICO LIMITADO activo en puerto ${PORT}`);
});