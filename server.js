/**
 * EL TABLÓN FOOD CENTER - PUSH BRIDGE 24/7
 * Render + Firebase Firestore + OneSignal
 *
 * SOLO NOTIFICACIONES.
 * No toca dashboard, diseño, horarios, ranking ni asistencia.
 */

require("dotenv").config();

const express = require("express");
const cors = require("cors");
const fetch = require("node-fetch");
const admin = require("firebase-admin");

const app = express();
app.use(cors());
app.use(express.json({ limit: "1mb" }));

const PORT = process.env.PORT || 3000;

const ONE_SIGNAL_APP_ID = process.env.ONE_SIGNAL_APP_ID || process.env.ONESIGNAL_APP_ID;
const ONE_SIGNAL_REST_API_KEY = process.env.ONE_SIGNAL_REST_API_KEY || process.env.ONESIGNAL_API_KEY;

const FIREBASE_PROJECT_ID = process.env.FIREBASE_PROJECT_ID;
const FIREBASE_CLIENT_EMAIL = process.env.FIREBASE_CLIENT_EMAIL;
const FIREBASE_PRIVATE_KEY = (process.env.FIREBASE_PRIVATE_KEY || "").replace(/\\n/g, "\n");

const COLLECTIONS_TO_LISTEN = [
  "alertas_sistema",
  "alertas",
  "asistencia",
  "notificacionesCola",
];

let db = null;
const processedIds = new Set();

function safeLog(...args) {
  console.log(new Date().toLocaleString("es-PE"), "|", ...args);
}

function requiredEnvReady() {
  return Boolean(
    ONE_SIGNAL_APP_ID &&
    ONE_SIGNAL_REST_API_KEY &&
    FIREBASE_PROJECT_ID &&
    FIREBASE_CLIENT_EMAIL &&
    FIREBASE_PRIVATE_KEY
  );
}

function initFirebase() {
  if (admin.apps.length) {
    db = admin.firestore();
    return db;
  }

  if (!requiredEnvReady()) {
    safeLog("⚠️ Faltan variables de entorno. Revisa Render Environment.");
    return null;
  }

  admin.initializeApp({
    credential: admin.credential.cert({
      projectId: FIREBASE_PROJECT_ID,
      clientEmail: FIREBASE_CLIENT_EMAIL,
      privateKey: FIREBASE_PRIVATE_KEY,
    }),
  });

  db = admin.firestore();
  safeLog("✅ Firebase Admin conectado:", FIREBASE_PROJECT_ID);
  return db;
}

function normalizeText(value = "") {
  return String(value || "").trim();
}

function getFirstAvailableNumber(source = {}, keys = []) {
  for (const key of keys) {
    const value = Number(source[key]);
    if (Number.isFinite(value) && value > 0) return value;
  }
  return 0;
}

function buildNotificationPayload(source = {}, collectionName = "") {
  const trabajador = normalizeText(
    source.trabajador ||
    source.nombre ||
    source.workerName ||
    source.worker ||
    source.colaborador ||
    source.empleado ||
    ""
  );

  const tipo = normalizeText(source.tipo || source.evento || source.type || source.accion || collectionName);
  const sede = normalizeText(source.sede || source.sucursal || source.local || "");
  const mensaje = normalizeText(source.mensaje || source.message || source.descripcion || source.detalle || "");
  const estado = normalizeText(source.estado || source.status || "");

  const text = `${tipo} ${mensaje} ${estado}`.toLowerCase();

  const tardanzaMinutos = getFirstAvailableNumber(source, [
    "tardanza",
    "minutosTardanza",
    "tardanzaMin",
    "minutos_tardanza",
    "lateMinutes",
    "minutesLate",
  ]);

  const breakMinutos = getFirstAvailableNumber(source, [
    "breakMinutos",
    "minutosBreak",
    "duracionBreak",
    "breakDuration",
    "break_minutes",
    "minutesBreak",
  ]);

  const breakExceso = getFirstAvailableNumber(source, [
    "breakExceso",
    "excesoBreak",
    "minutosExcesoBreak",
    "breakExceededMinutes",
    "excessBreakMinutes",
  ]);

  const ingresoAnticipado = getFirstAvailableNumber(source, [
    "minutosAnticipado",
    "anticipadoMinutos",
    "minutosAntes",
    "earlyMinutes",
    "minutesEarly",
  ]);

  const isEntrada = text.includes("entrada") || text.includes("ingreso");
  const isSalida = text.includes("salida");
  const isBreak = text.includes("break");
  const isBreakStart = isBreak && (text.includes("inicio") || text.includes("inicia"));
  const isBreakEnd = isBreak && (text.includes("termino") || text.includes("término") || text.includes("fin") || text.includes("retorno"));
  const isLate = text.includes("tard") || tardanzaMinutos > 8;
  const isEarly = text.includes("anticip") || text.includes("antes") || ingresoAnticipado > 0;
  const isGps = text.includes("gps") || text.includes("rango") || text.includes("fuera");

  const name = trabajador || "Trabajador";
  const place = sede ? ` · ${sede}` : "";

  let title = "🔔 EL TABLÓN - Alerta operativa";
  let body = mensaje || "Nueva actualización operativa registrada.";

  if (isLate) {
    const minutesText = tardanzaMinutos ? `${tardanzaMinutos} min` : "fuera de tolerancia";
    title = "⚠️ Tardanza registrada";
    body = `${name}${place} ingresó tarde: ${minutesText}.`;
  } else if (isEarly) {
    const minutesText = ingresoAnticipado ? `${ingresoAnticipado} min antes` : "antes de su horario";
    title = "⏱️ Ingreso anticipado";
    body = `${name}${place} marcó ingreso ${minutesText}.`;
  } else if (isBreak && (breakExceso > 0 || breakMinutos > 60 || text.includes("exced"))) {
    const exceso = breakExceso || Math.max(0, breakMinutos - 60);
    const total = breakMinutos ? ` · total ${breakMinutos} min` : "";
    title = "☕ Break excedido";
    body = `${name}${place} sobrepasó su break${exceso ? ` por ${exceso} min` : ""}${total}.`;
  } else if (isBreakStart) {
    title = "☕ Inicio de break";
    body = `${name}${place} inició su break.`;
  } else if (isBreakEnd) {
    title = "✅ Retorno de break";
    body = `${name}${place} terminó su break.`;
  } else if (isEntrada) {
    title = "✅ Ingreso registrado";
    body = `${name}${place} marcó ingreso.`;
  } else if (isSalida) {
    title = "🏁 Salida registrada";
    body = `${name}${place} marcó salida.`;
  } else if (isGps) {
    title = "📍 Alerta GPS";
    body = `${name}${place} requiere validación de ubicación.`;
  } else if (trabajador) {
    title = "🔔 Movimiento operativo";
    body = `${name}${place}${tipo ? ` · ${tipo}` : ""}${mensaje ? `: ${mensaje}` : ""}`;
  }

  return {
    title,
    body,
    data: {
      collectionName,
      trabajador,
      tipo,
      sede,
      tardanzaMinutos,
      breakMinutos,
      breakExceso,
      ingresoAnticipado,
      createdAt: new Date().toISOString(),
    },
  };
}

async function getAdminPlayerIds() {
  if (!db) return [];

  const playerIds = new Set();

  const readCollection = async (collectionName) => {
    try {
      const snap = await db.collection(collectionName).get();

      snap.forEach((doc) => {
        const data = doc.data() || {};

        if (data.playerId) playerIds.add(String(data.playerId));
        if (Array.isArray(data.playerIds)) {
          data.playerIds.forEach((id) => id && playerIds.add(String(id)));
        }
        if (data.external_id) playerIds.add(String(data.external_id));
      });
    } catch (error) {
      safeLog(`⚠️ No se pudo leer ${collectionName}:`, error.message);
    }
  };

  await readCollection("admins_push");
  await readCollection("push_admins");
  await readCollection("notificaciones_admin");

  return Array.from(playerIds).filter((id) => id && id.length >= 10);
}

async function sendOneSignalNotification({ title, body, data }) {
  const playerIds = await getAdminPlayerIds();

  const payload = {
    app_id: ONE_SIGNAL_APP_ID,
    headings: { es: title, en: title },
    contents: { es: body, en: body },
    data: data || {},
  };

  if (playerIds.length) {
    payload.include_player_ids = playerIds;
  } else {
    // Fallback: envía a usuarios suscritos si no hay Player IDs registrados.
    payload.included_segments = ["Subscribed Users"];
  }

  const response = await fetch("https://onesignal.com/api/v1/notifications", {
    method: "POST",
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      Authorization: `Basic ${ONE_SIGNAL_REST_API_KEY}`,
    },
    body: JSON.stringify(payload),
  });

  const result = await response.json().catch(() => ({}));

  if (!response.ok) {
    throw new Error(`OneSignal error ${response.status}: ${JSON.stringify(result)}`);
  }

  return result;
}

async function processNotificationDoc(collectionName, docSnapshot) {
  const data = docSnapshot.data() || {};
  const id = `${collectionName}/${docSnapshot.id}`;

  if (processedIds.has(id)) return;
  processedIds.add(id);

  if (data.pushProcesado === true || data.pushSent === true || data.notificacionEnviada === true) {
    return;
  }

  if (data.silencioso === true || data.noPush === true) {
    return;
  }

  const payload = buildNotificationPayload(data, collectionName);

  try {
    const result = await sendOneSignalNotification(payload);

    await docSnapshot.ref.set(
      {
        pushProcesado: true,
        pushSent: true,
        notificacionEnviada: true,
        pushProcesadoAt: new Date().toISOString(),
        oneSignalResult: result,
      },
      { merge: true }
    );

    safeLog("✅ Push procesado:", { id, external_id: result.external_id || null });
  } catch (error) {
    safeLog("❌ Error procesando push:", id, error.message);

    await docSnapshot.ref.set(
      {
        pushError: error.message,
        pushErrorAt: new Date().toISOString(),
      },
      { merge: true }
    );
  }
}

function listenCollection(collectionName) {
  if (!db) return;

  safeLog(`🔔 Escuchando colección ${collectionName}...`);

  db.collection(collectionName)
    .orderBy("createdAt", "desc")
    .limit(25)
    .onSnapshot(
      (snapshot) => {
        snapshot.docChanges().forEach((change) => {
          if (change.type === "added" || change.type === "modified") {
            processNotificationDoc(collectionName, change.doc);
          }
        });
      },
      (error) => {
        safeLog(`❌ Listener ${collectionName}:`, error.message);
      }
    );
}


/* =========================================================
   NOTIFICACIONES A TRABAJADORES - SOLO PUSH
   Reglas:
   1) Recordatorio 10 min antes de ingreso.
   2) Alerta al pasar 8 min de tolerancia.
   3) Alerta cuando break supera 1 hora.
   4) Alerta cuando marca salida antes de hora.
========================================================= */

const WORKER_ALERT_INTERVAL_MS = Number(process.env.WORKER_ALERT_INTERVAL_MS || 60000);
const ENTRY_REMINDER_MINUTES = Number(process.env.ENTRY_REMINDER_MINUTES || 10);
const LATE_TOLERANCE_MINUTES = Number(process.env.LATE_TOLERANCE_MINUTES || 8);
const BREAK_LIMIT_MINUTES = Number(process.env.BREAK_LIMIT_MINUTES || 60);

let workerAlertTimer = null;
const workerAlertMemory = new Set();

function parseTimeToMinutes(value = "") {
  const match = String(value || "").match(/(\d{1,2}):(\d{2})/);
  if (!match) return null;
  const hh = Number(match[1]);
  const mm = Number(match[2]);
  if (!Number.isFinite(hh) || !Number.isFinite(mm)) return null;
  return hh * 60 + mm;
}

function minutesToDate(baseDate, minutes) {
  const date = new Date(baseDate);
  date.setHours(Math.floor(minutes / 60), minutes % 60, 0, 0);
  return date;
}

function normalizeDayKey(date = new Date()) {
  const days = ["domingo", "lunes", "martes", "miércoles", "jueves", "viernes", "sábado"];
  return days[date.getDay()];
}

function getScheduleForToday(worker = {}, date = new Date()) {
  const dayKey = normalizeDayKey(date);
  const candidates = [
    worker?.horarios?.[dayKey],
    worker?.horario?.[dayKey],
    worker?.schedule?.[dayKey],
    worker?.turnos?.[dayKey],
    worker?.[dayKey],
    worker?.horarioHoy,
    worker?.turnoHoy,
  ];

  return candidates.find((item) => item && String(item).trim()) || "";
}

function parseScheduleWindow(scheduleValue = "", baseDate = new Date()) {
  const text = String(scheduleValue || "").trim();
  const lower = text.toLowerCase();
  if (!text || text === "-" || lower.includes("descanso") || lower.includes("vacaciones")) return null;

  const match = text.match(/(\d{1,2}:\d{2})\s*[-–]\s*(\d{1,2}:\d{2})/);
  if (!match) return null;

  const startMinutes = parseTimeToMinutes(match[1]);
  const endMinutes = parseTimeToMinutes(match[2]);
  if (startMinutes == null || endMinutes == null) return null;

  const start = minutesToDate(baseDate, startMinutes);
  const end = minutesToDate(baseDate, endMinutes);
  if (endMinutes <= startMinutes) end.setDate(end.getDate() + 1);

  return {
    start,
    end,
    label: `${match[1]}-${match[2]}`,
    crossesMidnight: endMinutes <= startMinutes,
  };
}

function getRecordDateTime(record = {}) {
  const rawDate = record.fecha || record.date || record.createdAt || record.created_at || record.timestamp;
  let date = null;

  if (rawDate?.toDate) date = rawDate.toDate();
  else if (rawDate instanceof Date) date = rawDate;
  else if (typeof rawDate === "string" || typeof rawDate === "number") date = new Date(rawDate);

  if (!date || Number.isNaN(date.getTime())) date = new Date();

  const minutes = parseTimeToMinutes(record.hora || record.time || "");
  if (minutes != null) {
    date.setHours(Math.floor(minutes / 60), minutes % 60, 0, 0);
  }

  return date;
}

function normalizeMarkType(value = "") {
  return String(value || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
}

function isEntradaMark(record = {}) {
  const t = normalizeMarkType(record.tipo || record.type || record.accion || "");
  return t.includes("entrada") || t.includes("ingreso");
}

function isSalidaMark(record = {}) {
  const t = normalizeMarkType(record.tipo || record.type || record.accion || "");
  return t.includes("salida");
}

function isBreakStartMark(record = {}) {
  const t = normalizeMarkType(record.tipo || record.type || record.accion || "");
  return t.includes("break") && (t.includes("inicio") || t.includes("inicia"));
}

function isBreakEndMark(record = {}) {
  const t = normalizeMarkType(record.tipo || record.type || record.accion || "");
  return t.includes("break") && (t.includes("termino") || t.includes("fin") || t.includes("retorno"));
}

function getWorkerName(worker = {}) {
  return worker.nombre || worker.trabajador || worker.name || worker.workerName || worker.id || "Trabajador";
}

function getWorkerSede(worker = {}) {
  return worker.sede || worker.sucursal || worker.local || "";
}

async function getWorkerPushTargets(worker = {}) {
  const ids = new Set();

  const directFields = [
    worker.playerId,
    worker.oneSignalPlayerId,
    worker.onesignalPlayerId,
    worker.pushPlayerId,
    worker.subscriptionId,
    worker.onesignalId,
  ];

  directFields.forEach((id) => id && ids.add(String(id)));

  if (Array.isArray(worker.playerIds)) {
    worker.playerIds.forEach((id) => id && ids.add(String(id)));
  }

  if (Array.isArray(worker.pushIds)) {
    worker.pushIds.forEach((id) => id && ids.add(String(id)));
  }

  return Array.from(ids).filter((id) => id && id.length >= 10);
}

async function sendWorkerPush(worker = {}, title = "", body = "", data = {}) {
  const include_player_ids = await getWorkerPushTargets(worker);

  if (!include_player_ids.length) {
    safeLog("⚠️ Trabajador sin playerId para push:", getWorkerName(worker));
    return null;
  }

  const payload = {
    app_id: ONE_SIGNAL_APP_ID,
    include_player_ids,
    headings: { es: title, en: title },
    contents: { es: body, en: body },
    data: {
      target: "worker",
      trabajador: getWorkerName(worker),
      sede: getWorkerSede(worker),
      ...data,
    },
  };

  const response = await fetch("https://onesignal.com/api/v1/notifications", {
    method: "POST",
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      Authorization: `Basic ${ONE_SIGNAL_REST_API_KEY}`,
    },
    body: JSON.stringify(payload),
  });

  const result = await response.json().catch(() => ({}));

  if (!response.ok) {
    throw new Error(`OneSignal worker error ${response.status}: ${JSON.stringify(result)}`);
  }

  safeLog("✅ Push trabajador:", getWorkerName(worker), title);
  return result;
}

async function getWorkersForNotifications() {
  if (!db) return [];
  const collections = ["trabajadores", "workers", "colaboradores"];
  for (const name of collections) {
    try {
      const snap = await db.collection(name).get();
      if (!snap.empty) {
        return snap.docs.map((doc) => ({ id: doc.id, ...doc.data() }));
      }
    } catch (error) {
      safeLog(`⚠️ No se pudo leer ${name}:`, error.message);
    }
  }
  return [];
}

async function getWorkerAttendanceInWindow(workerName, start, end) {
  if (!db || !workerName) return [];

  try {
    const snap = await db.collection("asistencia").get();
    return snap.docs
      .map((doc) => ({ id: doc.id, ...doc.data() }))
      .filter((record) => String(record.trabajador || record.nombre || "") === String(workerName))
      .filter((record) => {
        const date = getRecordDateTime(record);
        return date >= start && date <= end;
      })
      .sort((a, b) => getRecordDateTime(a).getTime() - getRecordDateTime(b).getTime());
  } catch (error) {
    safeLog("⚠️ No se pudo leer asistencia para trabajador:", workerName, error.message);
    return [];
  }
}

function shouldSendOnce(key) {
  const today = new Date().toISOString().slice(0, 10);
  const fullKey = `${today}:${key}`;
  if (workerAlertMemory.has(fullKey)) return false;
  workerAlertMemory.add(fullKey);

  if (workerAlertMemory.size > 5000) {
    const recent = Array.from(workerAlertMemory).slice(-2500);
    workerAlertMemory.clear();
    recent.forEach((item) => workerAlertMemory.add(item));
  }

  return true;
}

async function processWorkerNotificationRules() {
  if (!db || !ONE_SIGNAL_APP_ID || !ONE_SIGNAL_REST_API_KEY) return;

  const now = new Date();
  const workers = await getWorkersForNotifications();

  for (const worker of workers) {
    try {
      const workerName = getWorkerName(worker);
      const sede = getWorkerSede(worker);
      const schedule = getScheduleForToday(worker, now);
      const window = parseScheduleWindow(schedule, now);
      if (!window) continue;

      const scanStart = new Date(window.start.getTime() - 30 * 60 * 1000);
      const scanEnd = new Date(window.end.getTime() + 90 * 60 * 1000);
      const records = await getWorkerAttendanceInWindow(workerName, scanStart, scanEnd);

      const entrada = records.find(isEntradaMark);
      const salida = records.find(isSalidaMark);
      const latestBreakStart = [...records].reverse().find(isBreakStartMark);
      const latestBreakEnd = [...records].reverse().find(isBreakEndMark);

      const reminderTime = new Date(window.start.getTime() - ENTRY_REMINDER_MINUTES * 60 * 1000);
      const lateLimit = new Date(window.start.getTime() + LATE_TOLERANCE_MINUTES * 60 * 1000);

      // 1. Recordatorio 10 minutos antes del ingreso.
      if (now >= reminderTime && now < window.start) {
        const key = `${worker.id || workerName}:entry-reminder:${window.label}`;
        if (shouldSendOnce(key)) {
          await sendWorkerPush(
            worker,
            "⏰ Recordatorio de ingreso",
            `${workerName}${sede ? ` · ${sede}` : ""}: tu turno inicia en ${ENTRY_REMINDER_MINUTES} min (${window.label}).`,
            { rule: "entry_reminder", schedule: window.label }
          );
        }
      }

      // 2. Alerta cuando pasan los 8 minutos de tolerancia.
      if (now >= lateLimit && !entrada) {
        const minutesLate = Math.max(0, Math.floor((now - window.start) / 60000));
        const key = `${worker.id || workerName}:late-alert:${window.label}`;
        if (shouldSendOnce(key)) {
          await sendWorkerPush(
            worker,
            "⚠️ Tolerancia superada",
            `${workerName}${sede ? ` · ${sede}` : ""}: han pasado ${minutesLate} min desde tu hora de ingreso.`,
            { rule: "late_alert", minutesLate, schedule: window.label }
          );
        }
      }

      // 3. Alerta cuando sobrepasan 1 hora de break.
      if (latestBreakStart) {
        const breakStartDate = getRecordDateTime(latestBreakStart);
        const breakEndDate = latestBreakEnd ? getRecordDateTime(latestBreakEnd) : null;
        const breakStillOpen = !breakEndDate || breakEndDate < breakStartDate;
        const breakMinutes = Math.floor((now - breakStartDate) / 60000);

        if (breakStillOpen && breakMinutes > BREAK_LIMIT_MINUTES) {
          const exceeded = breakMinutes - BREAK_LIMIT_MINUTES;
          const key = `${worker.id || workerName}:break-exceeded:${breakStartDate.toISOString().slice(0, 16)}`;
          if (shouldSendOnce(key)) {
            await sendWorkerPush(
              worker,
              "☕ Break excedido",
              `${workerName}${sede ? ` · ${sede}` : ""}: tu break supera 1 hora por ${exceeded} min.`,
              { rule: "break_exceeded", breakMinutes, exceeded, schedule: window.label }
            );
          }
        }
      }

      // 4. Alerta cuando marcan antes de su hora de salida.
      if (salida) {
        const salidaDate = getRecordDateTime(salida);
        if (salidaDate < window.end) {
          const earlyMinutes = Math.max(1, Math.ceil((window.end - salidaDate) / 60000));
          const key = `${worker.id || workerName}:early-exit:${salida.id || salidaDate.toISOString()}`;
          if (shouldSendOnce(key)) {
            await sendWorkerPush(
              worker,
              "⚠️ Salida antes de horario",
              `${workerName}${sede ? ` · ${sede}` : ""}: marcaste salida ${earlyMinutes} min antes de tu horario.`,
              { rule: "early_exit", earlyMinutes, schedule: window.label }
            );
          }
        }
      }
    } catch (error) {
      safeLog("❌ Regla push trabajador:", getWorkerName(worker), error.message);
    }
  }
}

function startWorkerNotificationRules() {
  if (workerAlertTimer) return;

  safeLog("📲 Reglas push trabajadores activas: recordatorio, tolerancia, break, salida anticipada.");

  processWorkerNotificationRules().catch((error) => {
    safeLog("❌ Worker notification initial run:", error.message);
  });

  workerAlertTimer = setInterval(() => {
    processWorkerNotificationRules().catch((error) => {
      safeLog("❌ Worker notification interval:", error.message);
    });
  }, WORKER_ALERT_INTERVAL_MS);
}


function startListeners() {
  const firestore = initFirebase();

  if (!firestore) {
    safeLog("❌ Firebase no inició. El servicio queda vivo para healthcheck, pero sin listeners.");
    return;
  }

  COLLECTIONS_TO_LISTEN.forEach(listenCollection);
  startWorkerNotificationRules();

  safeLog("🚀 PUSH EL TABLÓN ACTIVO — RENDER 24/7");
  safeLog("🌐 API Push lista en puerto", PORT);
  safeLog("🛡️ Anti-spam / cola / logs activos");
}

app.get("/", (_req, res) => {
  res.json({
    ok: true,
    service: "EL TABLÓN Push Bridge",
    mode: "Render 24/7",
    firebase: Boolean(db),
    time: new Date().toISOString(),
  });
});

app.get("/health", (_req, res) => {
  res.json({
    ok: true,
    status: "online",
    firebase: Boolean(db),
    oneSignal: Boolean(ONE_SIGNAL_APP_ID && ONE_SIGNAL_REST_API_KEY),
  });
});

app.post("/test-push", async (req, res) => {
  try {
    const payload = {
      title: req.body?.title || "✅ Push EL TABLÓN activo",
      body: req.body?.body || "Servicio Render 24/7 funcionando correctamente.",
      data: { test: true, createdAt: new Date().toISOString() },
    };

    const result = await sendOneSignalNotification(payload);
    res.json({ ok: true, result });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
});

app.listen(PORT, () => {
  safeLog(`✅ Servidor activo en puerto ${PORT}`);
  startListeners();
});
