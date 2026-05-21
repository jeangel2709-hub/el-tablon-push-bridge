import "dotenv/config";
import express from "express";
import cors from "cors";
import fetch from "node-fetch";
import admin from "firebase-admin";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const app = express();
app.use(cors());
app.use(express.json());
const PORT = process.env.PORT || 3001;

if (!admin.apps.length) {
  const serviceAccountPath = path.join(__dirname, "service-account.json");
  const serviceAccount = JSON.parse(fs.readFileSync(serviceAccountPath, "utf8"));
  admin.initializeApp({ credential: admin.credential.cert(serviceAccount), projectId: serviceAccount.project_id });
  console.log("✅ Firebase Admin conectado:", serviceAccount.project_id);
}

const db = admin.firestore();
const ONESIGNAL_APP_ID = process.env.ONESIGNAL_APP_ID;
const ONESIGNAL_API_KEY = process.env.ONESIGNAL_REST_API_KEY;
const SUBSCRIPTIONS = [];
// IDs fijos desactivados para evitar invalid_player_ids.

const DEFAULT_CONFIG = {
  enabled: true,
  queueEnabled: true,
  logsEnabled: true,
  antiSpam: true,
  antiSpamMinutes: 3,
  quietHoursEnabled: false,
  quietStart: "23:00",
  quietEnd: "06:00",
  workerReminderMinutes: 10,
  missingExitMinutes: 20,
  recipients: { trabajador: true, admin: true, supervisor: true, sede: true },
  sedes: { Cayma: true, Mariscal: true },
  types: {
    trabajador10MinAntes: true,
    tardanza: true,
    salidaNoMarcada: true,
    supervisorSede: true,
    descansoVacaciones: true,
    aprobacionPendiente: true,
    fueraRangoGps: true,
    cambioTurno: true,
    disciplinario: true,
  },
  priorities: {
    trabajador10MinAntes: "media",
    tardanza: "alta",
    salidaNoMarcada: "alta",
    supervisorSede: "media",
    descansoVacaciones: "alta",
    aprobacionPendiente: "alta",
    fueraRangoGps: "critica",
    cambioTurno: "media",
    disciplinario: "critica",
  },
};

const sentMemory = new Map();
function mergeConfig(remote = {}) {
  return { ...DEFAULT_CONFIG, ...remote, recipients: { ...DEFAULT_CONFIG.recipients, ...(remote.recipients || {}) }, sedes: { ...DEFAULT_CONFIG.sedes, ...(remote.sedes || {}) }, types: { ...DEFAULT_CONFIG.types, ...(remote.types || {}) }, priorities: { ...DEFAULT_CONFIG.priorities, ...(remote.priorities || {}) } };
}
async function getConfig() {
  const ref = db.collection("configuracion").doc("notificaciones");
  const snap = await ref.get();
  if (!snap.exists) { await ref.set(DEFAULT_CONFIG, { merge: true }); return DEFAULT_CONFIG; }
  return mergeConfig(snap.data());
}
function inQuietHours(config) {
  if (!config.quietHoursEnabled) return false;
  const now = new Date();
  const current = `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
  const start = config.quietStart || "23:00";
  const end = config.quietEnd || "06:00";
  if (start < end) return current >= start && current <= end;
  return current >= start || current <= end;
}
function keyOf(parts) { return parts.filter(Boolean).join("|").toLowerCase(); }
function canSend(key, config) {
  if (!config.antiSpam) return true;
  const last = sentMemory.get(key);
  const now = Date.now();
  const ms = Number(config.antiSpamMinutes || 3) * 60 * 1000;
  if (last && now - last < ms) return false;
  sentMemory.set(key, now);
  return true;
}
function allowedByConfig(type, config, sede = "") {
  if (!config.enabled) return false;
  if (inQuietHours(config)) return false;
  if (config.types?.[type] === false) return false;
  if (sede && config.sedes && config.sedes[sede] === false) return false;
  return true;
}
async function logHistory(payload, result) {
  const config = await getConfig();
  if (!config.logsEnabled) return;
  await db.collection("notificacionesHistorial").add({ ...payload, resultId: result?.id || null, createdAt: new Date().toISOString() });
}

function normalizePushId(id = "") {
  return String(id || "").trim();
}

function isValidPushId(id = "") {
  return /^[0-9a-fA-F-]{32,}$/.test(normalizePushId(id));
}

function uniqueValidPushIds(ids = []) {
  return [...new Set((ids || []).map(normalizePushId).filter(isValidPushId))];
}

function extractPushIds(item = {}) {
  const ids = [];

  [
    item.playerId,
    item.player_id,
    item.oneSignalPlayerId,
    item.onesignalPlayerId,
    item.pushPlayerId,
    item.onesignalSubscriptionId,
    item.oneSignalSubscriptionId,
    item.subscriptionId,
    item.pushId,
    item.pushSubscriptionId,
  ].forEach((id) => id && ids.push(id));

  if (Array.isArray(item.playerIds)) ids.push(...item.playerIds);
  if (Array.isArray(item.pushIds)) ids.push(...item.pushIds);
  if (Array.isArray(item.subscriptionIds)) ids.push(...item.subscriptionIds);

  return uniqueValidPushIds(ids);
}

let ADMIN_PUSH_CACHE = { ids: [], expiresAt: 0 };

async function getAdminPushIds() {
  const now = Date.now();

  if (ADMIN_PUSH_CACHE.expiresAt > now && ADMIN_PUSH_CACHE.ids.length) {
    return ADMIN_PUSH_CACHE.ids;
  }

  const ids = new Set();

  for (const name of ["admins_push", "usuarios_admin", "admins", "push_tokens"]) {
    try {
      const snap = await db.collection(name).get();

      snap.docs.forEach((docSnap) => {
        const item = docSnap.data() || {};
        const roleText = String(item.rol || item.role || item.tipo || item.tipoUsuario || "").toLowerCase();

        const isAdmin =
          name === "admins_push" ||
          name === "usuarios_admin" ||
          name === "admins" ||
          item.admin === true ||
          item.esAdmin === true ||
          item.esJefe === true ||
          roleText.includes("admin") ||
          roleText.includes("jefe");

        if (!isAdmin) return;

        extractPushIds(item).forEach((id) => ids.add(id));
      });
    } catch (error) {
      console.log(`⚠️ No se pudo leer ${name}:`, error.message);
    }
  }

  const result = [...ids];

  ADMIN_PUSH_CACHE = {
    ids: result,
    expiresAt: Date.now() + 30 * 60 * 1000,
  };

  return result;
}

async function getTargetPushIds(target = "admin", data = {}) {
  if (target !== "trabajador") return getAdminPushIds();

  const ids = new Set();
  extractPushIds(data).forEach((id) => ids.add(id));

  const dni = String(data.dni || data.documento || "").replace(/\D/g, "");
  const name = String(data.trabajador || data.nombre || data.workerName || "").trim();
  const slug = name
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\s+/g, "-");

  for (const docId of [dni, slug, data.id, data.workerId, data.trabajadorId].filter(Boolean)) {
    try {
      const snap = await db.collection("push_tokens").doc(String(docId)).get();
      if (snap.exists) extractPushIds(snap.data() || {}).forEach((id) => ids.add(id));
    } catch {}
  }

  return [...ids];
}

async function cleanInvalidPushIds(invalidIds = []) {
  const ids = uniqueValidPushIds(invalidIds);
  if (!ids.length) return;

  for (const name of ["admins_push", "push_tokens", "trabajadores", "usuarios_admin", "admins"]) {
    try {
      const snap = await db.collection(name).get();

      await Promise.allSettled(
        snap.docs.map(async (docSnap) => {
          const item = docSnap.data() || {};
          const current = extractPushIds(item);
          const hasInvalid = current.some((id) => ids.includes(id));
          if (!hasInvalid) return;

          const next = current.filter((id) => !ids.includes(id));

          await docSnap.ref.set(
            {
              playerIds: next,
              playerId: next[0] || "",
              invalidPlayerIds: admin.firestore.FieldValue.arrayUnion(...ids),
              pushActivo: next.length > 0,
              pushStatus: next.length ? "validado" : "sin_player_id_valido",
              pushUpdatedAt: new Date().toISOString(),
            },
            { merge: true }
          );
        })
      );
    } catch (error) {
      console.log(`⚠️ No se pudo limpiar IDs en ${name}:`, error.message);
    }
  }
}


async function sendPush({ title, message, type = "aprobacionPendiente", source = "bridge", target = "admin", sede = "", data = {}, url = "https://el-tablon-2ad52.web.app/admin", subscriptionIds = [] }) {
  const config = await getConfig();

  if (!allowedByConfig(type, config, sede)) {
    console.log(`⏸️ Omitido por configuración: ${type}`);
    return { skipped: true, reason: "disabled_by_config" };
  }

  const antiKey = keyOf([source, type, data.id, data.trabajador, target, message]);

  if (!canSend(antiKey, config)) {
    console.log(`🛡️ Omitido por anti-spam: ${type}`);
    return { skipped: true, reason: "anti_spam" };
  }

  const targetIds =
    Array.isArray(subscriptionIds) && subscriptionIds.length > 0
      ? subscriptionIds
      : await getTargetPushIds(target, data);

  const validIds = uniqueValidPushIds(targetIds);

  if (!validIds.length) {
    console.log(`⚠️ Push omitido: sin playerId válido para ${target}`);
    return { skipped: true, reason: "no_valid_player_ids" };
  }

  const response = await fetch("https://onesignal.com/api/v1/notifications", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Basic ${ONESIGNAL_API_KEY}`,
    },
    body: JSON.stringify({
      app_id: ONESIGNAL_APP_ID,
      target_channel: "push",
      include_subscription_ids: validIds,
      headings: { en: title, es: title },
      contents: { en: message, es: message },
      url,
      data: { ...data, type, source, target, sede },
      priority: 10,
    }),
  });

  const result = await response.json();

  if (result?.errors?.invalid_player_ids?.length) {
    await cleanInvalidPushIds(result.errors.invalid_player_ids);
  }

  console.log("✅ Push procesado:", result);

  await logHistory(
    { title, message, type, source, target, sede, priority: config.priorities?.[type] || "media" },
    result
  );

  return result;
}
app.get("/", (req, res) => res.json({ ok: true, service: "EL TABLÓN Push Bridge activo" }));
app.get("/health", (req, res) => res.json({ ok: true, time: new Date().toISOString() }));
app.get("/test-push", async (req, res) => res.json({ ok: true, result: await sendPush({ title: "🚀 Push EL TABLÓN ACTIVO", message: "Notificaciones tipo WhatsApp funcionando correctamente.", type: "aprobacionPendiente", source: "test" }) }));
function getType(item = {}) {
  const text = [item.type, item.tipo, item.estado, item.status, item.motivo, item.reason, item.horario, item.tipoAprobacion].filter(Boolean).join(" ").toLowerCase();
  const dist = Number(item.distanciaMetros || item.distanceMeters || item.distancia || item.gpsDistance || 0);
  if (text.includes("10") || text.includes("recordatorio")) return "trabajador10MinAntes";
  if (text.includes("vacaciones") || text.includes("descanso")) return "descansoVacaciones";
  if (text.includes("fuera") || text.includes("rango") || text.includes("gps") || dist > 0) return "fueraRangoGps";
  if (text.includes("tardanza") || text.includes("tarde")) return "tardanza";
  if (text.includes("salida") && text.includes("no")) return "salidaNoMarcada";
  if (text.includes("cambio")) return "cambioTurno";
  if (text.includes("disciplina") || text.includes("incidencia")) return "disciplinario";
  return "aprobacionPendiente";
}
function buildPush(item = {}, id = "") {
  const type = getType(item);
  const trabajador = item.trabajador || item.nombre || item.workerName || "Trabajador";
  const sede = item.sede || item.sucursal || "";
  const tipo = item.tipo || "Marcación";
  const dist = item.distanciaMetros || item.distanceMeters || item.distancia || item.gpsDistance || "-";
  if (type === "trabajador10MinAntes") return { type, target: "trabajador", title: "⏰ EL TABLÓN · Tu turno inicia pronto", message: `${trabajador}, tu ingreso inicia en 10 minutos.`, sede };
  if (type === "fueraRangoGps") return { type, target: "admin", title: "📍 EL TABLÓN · Fuera de rango GPS", message: `${trabajador} intentó ${tipo} en ${sede}. Distancia: ${dist} m.`, sede };
  if (type === "descansoVacaciones") return { type, target: "admin", title: "📅 EL TABLÓN · Descanso/Vacaciones", message: `${trabajador} solicitó ${tipo} en día especial · ${sede}.`, sede };
  if (type === "tardanza") return { type, target: "admin", title: "⚠️ EL TABLÓN · Tardanza detectada", message: `${trabajador} registra tardanza en ${sede}.`, sede };
  if (type === "salidaNoMarcada") return { type, target: "admin", title: "🚪 EL TABLÓN · Salida no marcada", message: `${trabajador} no registra salida en ${sede}.`, sede };
  if (type === "cambioTurno") return { type, target: "admin", title: "🔄 EL TABLÓN · Cambio de turno", message: `${trabajador} tiene solicitud de cambio de turno.`, sede };
  if (type === "disciplinario") return { type, target: "admin", title: "🚨 EL TABLÓN · Incidencia disciplinaria", message: `${trabajador}: ${item.mensaje || "incidencia registrada"}.`, sede };
  return { type, target: "admin", title: "✅ EL TABLÓN · Aprobación pendiente", message: `${trabajador} solicitó ${tipo} en ${sede}.`, sede };
}
function isPendingApproval(item = {}) {
  const estado = String(item.estado || item.status || "").toLowerCase();
  const decision = String(item.aprobacionAdmin || item.approvalStatus || item.estadoAprobacion || "").toLowerCase();
  if (["aprobado", "rechazado", "resuelto"].includes(decision)) return false;
  return item.aprobacionPendiente === true || item.requiereAprobacion === true || item.requiresApproval === true || estado.includes("pendiente") || estado.includes("fuera") || estado.includes("rango") || ["fueraRangoGps", "descansoVacaciones", "tardanza", "salidaNoMarcada", "cambioTurno", "disciplinario"].includes(getType(item));
}
function listenCollection(name, mode = "generic") {
  db.collection(name).onSnapshot((snapshot) => snapshot.docChanges().forEach(async (change) => {
    if (change.type !== "added" && change.type !== "modified") return;
    const ref = change.doc.ref;
    const item = change.doc.data();
    if (!item) return;
    if (item.pushSent === true || item.pushAprobacionSent === true) return;
    if (mode === "approval" && !isPendingApproval(item)) return;
    const payload = buildPush(item, change.doc.id);
    const result = await sendPush({ ...payload, source: name, data: { id: change.doc.id, trabajador: item.trabajador || item.nombre || "Trabajador" } });
    await detectarSalidaAnticipada(name, item, change.doc.id);
    if (!result?.skipped && !result?.errors) {
      await ref.set({ pushSent: true, pushAprobacionSent: true, pushSentAt: new Date().toISOString() }, { merge: true });
    }
  }));
  console.log(`🔔 Escuchando colección ${name}...`);
}
function listenQueue() {
  db.collection("notificacionesCola").onSnapshot((snapshot) => snapshot.docChanges().forEach(async (change) => {
    if (change.type !== "added" && change.type !== "modified") return;
    const ref = change.doc.ref;
    const item = change.doc.data();
    if (!item || item.status === "sent" || item.status === "cancelled") return;
    const result = await sendPush({ title: item.title || "EL TABLÓN", message: item.message || "Notificación pendiente", type: item.type || "aprobacionPendiente", source: "notificacionesCola", target: item.target || "admin", data: { id: change.doc.id } });
    if (!result?.skipped && !result?.errors) {
      await ref.set({ status: "sent", sentAt: new Date().toISOString(), resultId: result?.id || null }, { merge: true });
    }
  }));
  console.log("📬 Escuchando cola de eventos notificacionesCola...");
}

function normalizeText(value = "") {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim();
}

function toMinutes(value) {
  if (!value) return null;
  const match = String(value).match(/(\d{1,2}):(\d{2})/);
  if (!match) return null;
  return Number(match[1]) * 60 + Number(match[2]);
}

function getTodayKey() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
}

function getWorkerSubscriptionIds(worker = {}) {
  const raw =
    worker.onesignalSubscriptionId ||
    worker.oneSignalSubscriptionId ||
    worker.subscriptionId ||
    worker.playerId ||
    worker.player_id ||
    worker.pushId ||
    worker.pushSubscriptionId ||
    worker.subscriptionIds ||
    worker.playerIds ||
    worker.subscriptions ||
    worker.dispositivos ||
    worker.devices ||
    [];

  const list = Array.isArray(raw) ? raw : [raw];

  return list
    .map((item) => {
      if (!item) return null;
      if (typeof item === "string") return item;
      return (
        item.onesignalSubscriptionId ||
        item.oneSignalSubscriptionId ||
        item.subscriptionId ||
        item.playerId ||
        item.player_id ||
        item.pushId ||
        null
      );
    })
    .filter(Boolean);
}

async function sendPushToSubscriptions({
  title,
  message,
  subscriptionIds = [],
  type = "trabajador10MinAntes",
  source = "recordatorioAutomatico",
  target = "trabajador",
  sede = "",
  data = {},
  url = "https://el-tablon-2ad52.web.app/movil",
}) {
  const config = await getConfig();

  if (!allowedByConfig(type, config, sede)) {
    console.log(`⏸️ Recordatorio omitido por configuración: ${type}`);
    return { skipped: true };
  }

  const validSubscriptions = [...new Set(subscriptionIds.filter(Boolean))];

  if (!validSubscriptions.length) {
    console.log(`⚠️ Trabajador sin suscripción OneSignal válida: ${data.trabajador || "Sin nombre"}`);
    return { skipped: true, reason: "no_worker_subscription" };
  }

  const antiKey = keyOf([source, type, data.trabajador, data.fecha, data.horarioIngreso, target]);

  if (!canSend(antiKey, config)) {
    console.log(`🛡️ Recordatorio omitido por anti-spam: ${data.trabajador || ""}`);
    return { skipped: true };
  }

  const response = await fetch("https://onesignal.com/api/v1/notifications", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Basic ${ONESIGNAL_API_KEY}`,
    },
    body: JSON.stringify({
      app_id: ONESIGNAL_APP_ID,
      target_channel: "push",
      include_subscription_ids: validSubscriptions,
      headings: { en: title, es: title },
      contents: { en: message, es: message },
      url,
      data: { ...data, type, source, target, sede },
      ios_badgeType: "Increase",
      ios_badgeCount: 1,
      priority: 10,
    }),
  });

  const result = await response.json();
  console.log("✅ Push trabajador 10 min enviado:", result);

  await logHistory(
    {
      title,
      message,
      type,
      source,
      target,
      sede,
      priority: config.priorities?.[type] || "media",
      trabajador: data.trabajador || "",
    },
    result
  );

  return result;
}

async function getDailyScheduleOverride(workerName, dateKey) {
  if (!workerName || !dateKey) return null;

  const directId = `${workerName}_${dateKey}`;
  const directSnap = await db.collection("horarios_dia").doc(directId).get();

  if (directSnap.exists) return directSnap.data();

  const querySnap = await db
    .collection("horarios_dia")
    .where("fecha", "==", dateKey)
    .where("trabajador", "==", workerName)
    .limit(1)
    .get();

  if (!querySnap.empty) return querySnap.docs[0].data();

  return null;
}

function getIngresoFromSchedule(scheduleLike = {}) {
  if (!scheduleLike) return null;

  if (scheduleLike.descanso === true) return null;

  const horario =
    scheduleLike.horario ||
    scheduleLike.turno ||
    scheduleLike.jornada ||
    scheduleLike.horarioHoy ||
    "";

  if (typeof horario === "object") {
    return horario.ingreso || horario.inicio || null;
  }

  const text = String(horario || "");
  if (!text || normalizeText(text).includes("descanso")) return null;

  const start = text.split("-")[0]?.trim();
  return start || null;
}

async function getWorkerIngresoToday(worker = {}, dateKey) {
  const workerName = worker.nombre || worker.trabajador || worker.workerName || "";

  const override = await getDailyScheduleOverride(workerName, dateKey);
  const overrideIngreso = getIngresoFromSchedule(override);
  if (overrideIngreso) return { ingreso: overrideIngreso, source: "horarios_dia" };

  const directHorario =
    worker.horarioHoy ||
    worker.horarioActual ||
    worker.horario ||
    worker.turno ||
    worker.jornada ||
    null;

  const directIngreso = getIngresoFromSchedule({ horario: directHorario });
  if (directIngreso) return { ingreso: directIngreso, source: "trabajadores" };

  return { ingreso: null, source: "sin_horario" };
}

async function alreadyMarkedIngreso(worker = {}, dateKey) {
  const workerName = worker.nombre || worker.trabajador || worker.workerName || "";
  if (!workerName || !dateKey) return false;

  const collections = ["asistencia", "asistencias"];

  for (const collectionName of collections) {
    const snap = await db
      .collection(collectionName)
      .where("fecha", "==", dateKey)
      .where("trabajador", "==", workerName)
      .limit(10)
      .get();

    if (
      snap.docs.some((docSnap) => {
        const item = docSnap.data() || {};
        const typeText = normalizeText(
          item.tipo || item.tipoMarcacion || item.marcacion || item.accion || item.evento || item.estado
        );
        return typeText.includes("ingreso") || Boolean(item.entrada) || Boolean(item.horaEntrada);
      })
    ) {
      return true;
    }
  }

  return false;
}


let REMINDER_QUOTA_SLEEP_UNTIL = 0;
let REMINDER_LAST_RUN_AT = 0;
const REMINDER_SAFE_INTERVAL_MS = Number(process.env.REMINDER_SAFE_INTERVAL_MS || 10 * 60 * 1000);
const REMINDER_QUOTA_SLEEP_MS = Number(process.env.REMINDER_QUOTA_SLEEP_MS || 30 * 60 * 1000);

async function verificarRecordatoriosIngreso10Min() {
  try {
    const nowMs = Date.now();

    if (REMINDER_QUOTA_SLEEP_UNTIL > nowMs) {
      console.log("⏸️ Recordatorio 10 min pausado por cuota Firebase.");
      return;
    }

    if (REMINDER_LAST_RUN_AT && nowMs - REMINDER_LAST_RUN_AT < REMINDER_SAFE_INTERVAL_MS) {
      return;
    }

    REMINDER_LAST_RUN_AT = nowMs;

    const config = await getConfig();

    if (!allowedByConfig("trabajador10MinAntes", config)) return;
    if (config.recipients?.trabajador === false) return;

    const reminderMinutes = Number(config.workerReminderMinutes || 10);
    const now = new Date();
    const currentMinutes = now.getHours() * 60 + now.getMinutes();
    const dateKey = getTodayKey();

    const trabajadoresSnap = await db
      .collection("trabajadores")
      .where("activo", "!=", false)
      .limit(60)
      .get();

    for (const docSnap of trabajadoresSnap.docs) {
      const worker = { id: docSnap.id, ...docSnap.data() };
      const workerName = worker.nombre || worker.trabajador || worker.workerName;

      if (!workerName) continue;
      if (worker.activo === false || worker.estado === "inactivo") continue;

      const sede = worker.sede || worker.sucursal || "";

      if (sede && config.sedes && config.sedes[sede] === false) continue;

      const { ingreso, source } = await getWorkerIngresoToday(worker, dateKey);
      const ingresoMinutes = toMinutes(ingreso);

      if (ingresoMinutes === null) continue;

      const diff = ingresoMinutes - currentMinutes;

      if (diff < reminderMinutes || diff > reminderMinutes) continue;

      const marked = await alreadyMarkedIngreso(worker, dateKey);
      if (marked) {
        console.log(`✅ Sin recordatorio: ${workerName} ya marcó ingreso.`);
        continue;
      }

      const subscriptionIds = getWorkerSubscriptionIds(worker);

      const title = "🚀 EL TABLÓN — Tu turno inicia pronto";
      const message = `${workerName}, tu horario inicia a las ${ingreso}. Recuerda marcar tu asistencia a tiempo.`;

      const result = await sendPushToSubscriptions({
        title,
        message,
        subscriptionIds,
        type: "trabajador10MinAntes",
        source: "recordatorio10MinAutomatico",
        target: "trabajador",
        sede,
        data: {
          trabajador: workerName,
          trabajadorId: worker.id,
          fecha: dateKey,
          horarioIngreso: ingreso,
          minutosAntes: reminderMinutes,
          horarioSource: source,
        },
        url: "https://el-tablon-2ad52.web.app/movil",
      });

      if (!result?.skipped) {
        await db.collection("notificacionesHistorial").add({
          type: "trabajador10MinAntes",
          target: "trabajador",
          trabajador: workerName,
          trabajadorId: worker.id,
          sede,
          fecha: dateKey,
          horarioIngreso: ingreso,
          message,
          source: "recordatorio10MinAutomatico",
          createdAt: new Date().toISOString(),
          resultId: result?.id || null,
        });
      }
    }
  } catch (error) {
    const message = String(error?.message || error || "");

    if (message.includes("RESOURCE_EXHAUSTED") || message.includes("Quota exceeded")) {
      REMINDER_QUOTA_SLEEP_UNTIL = Date.now() + REMINDER_QUOTA_SLEEP_MS;
      console.log("⏸️ Recordatorio 10 min pausado 30 min por cuota Firebase.");
      return;
    }

    console.log("❌ Error en recordatorio automático 10 min:", error.message);
  }
}



function parseTimeToMinutes(value = "") {
  if (!value) return null;
  const match = String(value).match(/(\d{1,2}):(\d{2})/);
  if (!match) return null;
  return Number(match[1]) * 60 + Number(match[2]);
}

function parseHorarioSalida(horario = "") {
  if (!horario) return null;

  if (typeof horario === "object") {
    return horario.salida || horario.fin || null;
  }

  const text = String(horario);
  if (!text.includes("-")) return null;

  return text.split("-")[1]?.trim() || null;
}

async function detectarSalidaAnticipada(collectionName, item = {}, docId = "") {
  try {
    const trabajador =
      item.trabajador ||
      item.nombre ||
      item.workerName ||
      "";

    if (!trabajador) return;

    const tipoTexto = normalizeText(
      item.tipo ||
      item.tipoMarcacion ||
      item.estado ||
      item.evento ||
      item.accion ||
      ""
    );

    const esSalida =
      tipoTexto.includes("salida") ||
      Boolean(item.salida) ||
      Boolean(item.horaSalida);

    if (!esSalida) return;

    const fecha = item.fecha || getTodayKey();

    const trabajadoresSnap = await db
      .collection("trabajadores")
      .where("nombre", "==", trabajador)
      .limit(1)
      .get();

    if (trabajadoresSnap.empty) return;

    const worker = trabajadoresSnap.docs[0].data();

    let salidaProgramada = null;

    const override = await getDailyScheduleOverride(trabajador, fecha);

    if (override) {
      salidaProgramada = parseHorarioSalida(
        override.horario ||
          override.turno ||
          override.jornada ||
          override
      );
    }

    if (!salidaProgramada) {
      salidaProgramada = parseHorarioSalida(
        worker.horarioHoy ||
          worker.horarioActual ||
          worker.horario ||
          worker.turno ||
          worker.jornada ||
          ""
      );
    }

    if (!salidaProgramada) return;

    const salidaReal =
      item.horaSalida ||
      item.salida ||
      item.hora ||
      item.horaMarcacion ||
      null;

    if (!salidaReal) return;

    let salidaProgramadaMin = parseTimeToMinutes(salidaProgramada);
    let salidaRealMin = parseTimeToMinutes(salidaReal);

    if (salidaProgramadaMin === null || salidaRealMin === null) return;

    // Soporte para turnos nocturnos: si la salida es madrugada, se lleva al día siguiente.
    if (salidaProgramadaMin < 720) salidaProgramadaMin += 1440;
    if (salidaRealMin < 720) salidaRealMin += 1440;

    const tolerancia = 15;

    if (salidaRealMin >= salidaProgramadaMin - tolerancia) return;

    await sendPush({
      title: "🚨 EL TABLÓN · Salida anticipada",
      message:
        `${trabajador} registró salida antes del horario establecido. ` +
        `Horario: ${salidaProgramada}. Salida real: ${salidaReal}.`,
      type: "disciplinario",
      source: "salidaAnticipada",
      target: "admin",
      sede: item.sede || worker.sede || "",
      data: {
        id: docId,
        trabajador,
        salidaProgramada,
        salidaReal,
        fecha,
      },
      url: "https://el-tablon-2ad52.web.app/admin",
    });

    console.log(`🚨 Salida anticipada detectada: ${trabajador}`);
  } catch (error) {
    console.log("❌ Error salida anticipada:", error.message);
  }
}

app.listen(PORT, () => {
  console.log("====================================");
  console.log("🚀 PUSH EL TABLÓN ACTIVO — ETAPA 2A");
  console.log(`🌐 API Push lista en puerto ${PORT}`);
  console.log("🛡️ Anti-spam / horario silencioso / logs / cola activos");
  console.log("====================================");
  listenCollection("alertas_sistema", "generic");
  listenCollection("alertas", "generic");
  listenCollection("asistencia", "approval");
  listenCollection("asistencias", "approval");
  listenQueue();
  setInterval(verificarRecordatoriosIngreso10Min, REMINDER_SAFE_INTERVAL_MS);
  console.log("⏰ Recordatorios automáticos 10 min antes activos — modo seguro anti-cuota");
});
