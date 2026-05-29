const express = require("express");
const admin = require("firebase-admin");
const fetch = require("node-fetch");

const app = express();
app.use(express.json({ limit: "1mb" }));

// CORS seguro para que Firebase Hosting pueda llamar al bridge Render.
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

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

function getPlayerIds(x = {}) {
  return [...new Set([
    x.playerId,
    x.oneSignalPlayerId,
    x.onesignalPlayerId,
    x.subscriptionId,
    x.idOneSignal,
    ...(Array.isArray(x.playerIds) ? x.playerIds : []),
    ...(Array.isArray(x.subscriptionIds) ? x.subscriptionIds : []),
  ].filter(Boolean).map(v => String(v).trim()))].filter(v => v.length > 10);
}

function isAdminRecord(x = {}) {
  const role = norm(x.rol || x.role || x.tipo || "");
  return x.admin === true || x.esAdmin === true || x.esJefe === true || role.includes("admin") || role.includes("jefe") || role.includes("supervisor");
}

function isActive(x = {}) {
  return x.activo !== false && x.pushActivo !== false && x.disabled !== true;
}

// SOLO estas notificaciones están permitidas para no saturar Firebase/OneSignal.
const ALLOWED_PUSH_TYPES = new Set([
  "tardanza",
  "break_excedido",
  "salida_anticipada",
  "fuera_rango",
  "falta_marcacion",
  "recordatorio_ingreso",
  "test_admin",
  "test_worker",
]);

function isAllowedPushType(type = "") {
  return ALLOWED_PUSH_TYPES.has(String(type || "").trim());
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

function visiblePayload({ title, message, ids, data }) {
  return {
    app_id: ONE_SIGNAL_APP_ID,
    include_player_ids: ids,
    headings: { es: title, en: title },
    contents: { es: message, en: message },
    subtitle: { es: message, en: message },
    web_push_topic: String(data?.type || "el_tablon_alerta"),
    android_group: "el_tablon_alertas",
    android_accent_color: "FF0EA5E9",
    priority: 10,
    ttl: 86400,
    data: {
      ...data,
      title,
      body: message,
      message,
      trabajador: data?.trabajador || "",
    },
  };
}

async function getCol(name) {
  try {
    const snap = await db.collection(name).get();
    return snap.docs.map(d => ({ id: d.id, ...d.data(), __collection: name }));
  } catch (e) {
    log(`No se pudo leer ${name}:`, e.code || e.message);
    return [];
  }
}

async function adminsCached(force = false) {
  if (!force && Date.now() - memory.admins.ts < CACHE_MS && memory.admins.rows.length) return memory.admins.rows;

  const rows = [];
  // admins_push suele tener PC; push_devices/push_tokens puede tener móvil.
  for (const c of ["admins_push", "push_admins", "usuarios_roles", "push_devices", "push_tokens"]) {
    rows.push(...await getCol(c));
  }

  const onlyAdmins = rows.filter(r => isActive(r) && (isAdminRecord(r) || r.__collection === "admins_push" || r.__collection === "push_admins"));
  memory.admins = { ts: Date.now(), rows: onlyAdmins };
  return onlyAdmins;
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
  const rows = await adminsCached();
  const ids = rows.flatMap(getPlayerIds);
  const unique = [...new Set(ids)];
  log(`Destinos admin activos detectados: ${unique.length}`);
  return unique;
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
  const direct = getPlayerIds(worker);
  if (direct.length) return direct;

  const dni = getDni(worker);
  const name = norm(getName(worker));
  const devices = await devicesCached();

  return devices.filter(d => isActive(d) && ((dni && getDni(d) === dni) || (name && norm(getName(d)) === name))).flatMap(getPlayerIds);
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

  const payload = visiblePayload({ title, message, ids, data });

  const res = await fetch("https://onesignal.com/api/v1/notifications", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Basic ${ONE_SIGNAL_REST_API_KEY}` },
    body: JSON.stringify(payload),
  });

  const json = await res.json().catch(() => ({}));
  log(`push enviado PC_MOVIL_NOMBRE (${ids.length} destinos):`, title, message, json);
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
  const limaNow = new Date(now.toLocaleString("en-US", { timeZone: TZ }));
  const nowMin = limaNow.getHours() * 60 + limaNow.getMinutes();
  const dayKeys = ["dom", "lun", "mar", "mie", "jue", "vie", "sab"];
  const dayKey = dayKeys[limaNow.getDay()];
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

    log("tick OK: PC+MOVIL+NOMBRE visible");
  } catch (e) {
    log("tick error:", e.code || e.message);
  }
}

app.get("/", (_, res) => res.json({
  ok: true,
  service: "EL TABLÓN PUSH PC MOVIL NOMBRE",
  mode: "polling_60s_pc_movil_nombre_visible",
}));

app.get("/health", (_, res) => res.json({ ok: true, ts: new Date().toISOString(), processed: memory.processed.size }));

app.post("/test-push-admin", async (_, res) => {
  const ids = await adminIds();
  const result = await sendOneSignal({
    title: "✅ Prueba push admin",
    message: "Wilberth Pacheco Delgadillo: prueba visible en PC y móvil.",
    playerIds: ids,
    data: { type: "test_admin", trabajador: "Wilberth Pacheco Delgadillo" },
  });
  res.json({ ok: true, ids: ids.length, result });
});


// ===============================
// ENDPOINTS DIRECTOS FIREBASE/FRONTEND
// ===============================
// Permiten que el Dashboard o Movil.jsx llamen al bridge directamente.
// Así Render despierta y quedan logs visibles cuando se genera una alerta.

app.post("/send-admin", async (req, res) => {
  try {
    const body = req.body || {};
    const type = String(body.type || body.tipo || "").trim();

    if (!isAllowedPushType(type)) {
      return res.status(400).json({ ok: false, error: "tipo_no_permitido", type });
    }

    const ids = await adminIds();

    const result = await sendOneSignal({
      title: body.title || body.titulo || "Alerta El Tablón",
      message: body.message || body.mensaje || "Nueva alerta del sistema.",
      playerIds: ids,
      data: {
        type,
        trabajador: body.trabajador || body.worker || "",
        dni: body.dni || "",
        origen: body.origen || "send_admin",
      },
    });

    await markProcessed(`direct_admin_${type}_${Date.now()}`, {
      type,
      trabajador: body.trabajador || body.worker || "",
      dni: body.dni || "",
      direct: true,
    });

    res.json({ ok: true, destinatarios: ids.length, result });
  } catch (error) {
    log("Error /send-admin:", error.code || error.message);
    res.status(500).json({ ok: false, error: error.message || "send_admin_error" });
  }
});

app.post("/send-worker", async (req, res) => {
  try {
    const body = req.body || {};
    const type = String(body.type || body.tipo || "").trim();

    if (!isAllowedPushType(type)) {
      return res.status(400).json({ ok: false, error: "tipo_no_permitido", type });
    }

    const worker = await resolveWorker({
      trabajador: body.trabajador || body.worker || body.nombre || "",
      dni: body.dni || "",
      workerId: body.workerId || body.uid || "",
    });

    const ids = await workerIds(worker);

    const result = await sendOneSignal({
      title: body.title || body.titulo || "El Tablón",
      message: body.message || body.mensaje || "Tienes una notificación pendiente.",
      playerIds: ids,
      data: {
        type,
        trabajador: getName(worker),
        dni: getDni(worker),
        origen: body.origen || "send_worker",
      },
    });

    await markProcessed(`direct_worker_${type}_${getDni(worker) || getName(worker)}_${Date.now()}`, {
      type,
      trabajador: getName(worker),
      dni: getDni(worker),
      direct: true,
    });

    res.json({ ok: true, trabajador: getName(worker), destinatarios: ids.length, result });
  } catch (error) {
    log("Error /send-worker:", error.code || error.message);
    res.status(500).json({ ok: false, error: error.message || "send_worker_error" });
  }
});

app.post("/send-alert", async (req, res) => {
  try {
    const body = req.body || {};
    const type = String(body.type || body.tipo || "").trim();
    const target = String(body.target || body.destino || "admin").trim().toLowerCase();

    if (!isAllowedPushType(type)) {
      return res.status(400).json({ ok: false, error: "tipo_no_permitido", type });
    }

    const results = [];

    if (target === "admin" || target === "both" || target === "ambos") {
      const ids = await adminIds();
      const result = await sendOneSignal({
        title: body.adminTitle || body.title || body.titulo || "Alerta El Tablón",
        message: body.adminMessage || body.message || body.mensaje || "Nueva alerta del sistema.",
        playerIds: ids,
        data: { type, trabajador: body.trabajador || body.worker || "", dni: body.dni || "", target: "admin" },
      });
      results.push({ target: "admin", ids: ids.length, result });
    }

    if (target === "worker" || target === "trabajador" || target === "both" || target === "ambos") {
      const worker = await resolveWorker({
        trabajador: body.trabajador || body.worker || body.nombre || "",
        dni: body.dni || "",
        workerId: body.workerId || body.uid || "",
      });
      const ids = await workerIds(worker);
      const result = await sendOneSignal({
        title: body.workerTitle || body.title || body.titulo || "El Tablón",
        message: body.workerMessage || body.message || body.mensaje || "Tienes una notificación pendiente.",
        playerIds: ids,
        data: { type, trabajador: getName(worker), dni: getDni(worker), target: "worker" },
      });
      results.push({ target: "worker", trabajador: getName(worker), ids: ids.length, result });
    }

    res.json({ ok: true, type, target, results });
  } catch (error) {
    log("Error /send-alert:", error.code || error.message);
    res.status(500).json({ ok: false, error: error.message || "send_alert_error" });
  }
});

app.post("/test-push-worker", async (req, res) => {
  try {
    const body = req.body || {};
    const worker = await resolveWorker({
      trabajador: body.trabajador || "Elisa Choque Pacsi",
      dni: body.dni || "48084163",
      workerId: body.workerId || "",
    });

    const ids = await workerIds(worker);

    const result = await sendOneSignal({
      title: "✅ Prueba push trabajador",
      message: `${getName(worker)}: prueba visible en celular.`,
      playerIds: ids,
      data: { type: "test_worker", trabajador: getName(worker), dni: getDni(worker) },
    });

    res.json({ ok: true, trabajador: getName(worker), ids: ids.length, result });
  } catch (error) {
    log("Error /test-push-worker:", error.code || error.message);
    res.status(500).json({ ok: false, error: error.message || "test_worker_error" });
  }
});

app.post("/tick-now", async (_, res) => {
  try {
    await tick();
    res.json({ ok: true, message: "tick ejecutado" });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message || "tick_error" });
  }
});


app.listen(PORT, () => {
  log(`EL TABLÓN PUSH PC MOVIL NOMBRE activo en puerto ${PORT}`);
  log("Modo: polling 60s, PC+móvil, body real con nombre del colaborador.");
});

setTimeout(tick, 5000);
setInterval(tick, POLL_MS);