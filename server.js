/**
 * EL TABLÓN FOOD CENTER - PUSH BRIDGE 24/7
 * Render + Firebase Firestore + OneSignal
 *
 * OPTIMIZACIÓN FIRESTORE QUOTA / ANTI-SPAM PRO
 * SOLO NOTIFICACIONES. No toca dashboard, diseño, horarios, ranking ni asistencia.
 */

require("dotenv").config();

const express = require("express");
const cors = require("cors");
const fetch = require("node-fetch");
const admin = require("firebase-admin");

const app = express();
app.use(cors());
app.use(express.json({ limit: "1mb" }));

const PORT = Number(process.env.PORT || 3001);

const ONE_SIGNAL_APP_ID =
  process.env.ONE_SIGNAL_APP_ID ||
  process.env.ONESIGNAL_APP_ID;

const ONE_SIGNAL_REST_API_KEY =
  process.env.ONE_SIGNAL_REST_API_KEY ||
  process.env.ONESIGNAL_API_KEY ||
  process.env.ONESIGNAL_REST_API_KEY;

const FIREBASE_PROJECT_ID = process.env.FIREBASE_PROJECT_ID;
const FIREBASE_CLIENT_EMAIL = process.env.FIREBASE_CLIENT_EMAIL;
const FIREBASE_PRIVATE_KEY = (process.env.FIREBASE_PRIVATE_KEY || "").replace(/\\n/g, "\n");

const APP_URL = process.env.APP_URL || "https://el-tablon-2ad52.web.app/admin";

const COLLECTIONS_TO_LISTEN = [
  "alertas_sistema",
  "alertas",
  "asistencia",
  "notificacionesCola",
];

const WORKERS_COLLECTIONS = ["trabajadores", "workers"];
const SCHEDULE_COLLECTIONS = ["horarios_semanales", "horarios", "horarios_dia", "daily_schedules"];
const ADMIN_PUSH_COLLECTIONS = ["admins_push", "usuarios_admin", "admins", "push_admins", "notificaciones_admin"];
const WORKER_PUSH_COLLECTIONS = ["push_tokens", "trabajadores", "workers"];

const DEFAULT_CONFIG = {
  enabled: true,
  queueEnabled: true,
  logsEnabled: true,
  antiSpam: true,
  antiSpamMinutes: 5,
  workerReminderMinutes: 10,
  toleranceMinutes: 8,
  breakLimitMinutes: 60,
  missingExitMinutes: 20,
  autoChecksEnabled: true,
  autoCheckIntervalMinutes: 8,
  cacheMinutes: 8,
  adminCacheMinutes: 30,
  workerPushCacheMinutes: 30,
  quotaBackoffMinutes: 12,
  maxDocsPerSnapshot: 45,
  recipients: { trabajador: true, admin: true, supervisor: true, sede: true },
  types: {
    trabajador10MinAntes: true,
    tardanza: true,
    breakExcedido: true,
    salidaAnticipada: true,
    salidaNoMarcada: true,
    faltaIngreso: true,
    fueraRangoGps: true,
    cambioTurno: true,
    aprobacionPendiente: true,
    disciplinario: true,
  },
  priorities: {
    trabajador10MinAntes: "media",
    tardanza: "alta",
    breakExcedido: "alta",
    salidaAnticipada: "alta",
    salidaNoMarcada: "alta",
    faltaIngreso: "alta",
    fueraRangoGps: "critica",
    cambioTurno: "media",
    aprobacionPendiente: "alta",
    disciplinario: "critica",
  },
};

let db = null;
let autoCheckTimer = null;
let autoCheckRunning = false;
let quotaBackoffUntil = 0;

const processedIds = new TTLSet(24 * 60 * 60 * 1000);
const sentMemory = new TTLMap(24 * 60 * 60 * 1000);

const cache = {
  config: { value: null, expiresAt: 0 },
  admins: { ids: [], expiresAt: 0 },
  workers: { value: [], expiresAt: 0 },
  schedules: { value: [], expiresAt: 0 },
  attendanceToday: { value: [], expiresAt: 0 },
  workerPush: new Map(),
};

function safeLog(...args) {
  console.log(new Date().toLocaleString("es-PE"), "|", ...args);
}

function normalizeText(value = "") {
  return String(value || "")
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
}

function pickFirstText(source = {}, keys = []) {
  for (const key of keys) {
    const value = source?.[key];
    if (value !== undefined && value !== null && String(value).trim()) return String(value).trim();
  }
  return "";
}

function numberFrom(source = {}, keys = []) {
  for (const key of keys) {
    const raw = source?.[key];
    const value = Number(raw);
    if (Number.isFinite(value)) return value;
  }
  return 0;
}

function nowMs() {
  return Date.now();
}

function minutesToMs(minutes = 1) {
  return Math.max(1, Number(minutes || 1)) * 60 * 1000;
}

function isQuotaError(error) {
  const text = String(error?.message || error || "").toLowerCase();
  return text.includes("resource_exhausted") || text.includes("quota") || text.includes("exceeded");
}

function markQuotaBackoff(config = DEFAULT_CONFIG) {
  quotaBackoffUntil = Date.now() + minutesToMs(config.quotaBackoffMinutes || DEFAULT_CONFIG.quotaBackoffMinutes);
  safeLog(`🟠 FIRESTORE QUOTA: pausa inteligente hasta ${new Date(quotaBackoffUntil).toLocaleTimeString("es-PE")}`);
}

function inQuotaBackoff() {
  return quotaBackoffUntil && Date.now() < quotaBackoffUntil;
}

class TTLSet {
  constructor(ttlMs) {
    this.ttlMs = ttlMs;
    this.map = new Map();
  }

  has(key) {
    this.cleanup();
    return this.map.has(key);
  }

  add(key) {
    this.cleanup();
    this.map.set(key, Date.now());
  }

  cleanup() {
    const limit = Date.now() - this.ttlMs;
    for (const [key, ts] of this.map.entries()) {
      if (ts < limit) this.map.delete(key);
    }
  }
}

class TTLMap {
  constructor(ttlMs) {
    this.ttlMs = ttlMs;
    this.map = new Map();
  }

  get(key) {
    this.cleanup();
    return this.map.get(key);
  }

  set(key, value) {
    this.cleanup();
    this.map.set(key, { value, ts: Date.now() });
  }

  hasFresh(key, ttlMs = this.ttlMs) {
    this.cleanup();
    const item = this.map.get(key);
    return item && Date.now() - item.ts < ttlMs;
  }

  cleanup() {
    const limit = Date.now() - this.ttlMs;
    for (const [key, item] of this.map.entries()) {
      if (!item || item.ts < limit) this.map.delete(key);
    }
  }
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

function mergeConfig(remote = {}) {
  return {
    ...DEFAULT_CONFIG,
    ...remote,
    recipients: { ...DEFAULT_CONFIG.recipients, ...(remote.recipients || {}) },
    types: { ...DEFAULT_CONFIG.types, ...(remote.types || {}) },
    priorities: { ...DEFAULT_CONFIG.priorities, ...(remote.priorities || {}) },
  };
}

async function getConfig(force = false) {
  const ttl = minutesToMs(5);
  if (!force && cache.config.value && cache.config.expiresAt > Date.now()) {
    return cache.config.value;
  }

  if (!db || inQuotaBackoff()) {
    return cache.config.value || DEFAULT_CONFIG;
  }

  try {
    const ref = db.collection("configuracion").doc("notificaciones");
    const snap = await ref.get();
    const cfg = snap.exists ? mergeConfig(snap.data() || {}) : DEFAULT_CONFIG;

    if (!snap.exists) {
      await ref.set(DEFAULT_CONFIG, { merge: true }).catch(() => null);
    }

    cache.config = { value: cfg, expiresAt: Date.now() + ttl };
    return cfg;
  } catch (error) {
    if (isQuotaError(error)) markQuotaBackoff(cache.config.value || DEFAULT_CONFIG);
    safeLog("⚠️ No se pudo leer configuración:", error.message);
    return cache.config.value || DEFAULT_CONFIG;
  }
}

function allowedByConfig(type, config, target = "admin") {
  if (!config.enabled) return false;
  if (config.types?.[type] === false) return false;
  if (target === "trabajador" && config.recipients?.trabajador === false) return false;
  if (target === "admin" && config.recipients?.admin === false) return false;
  return true;
}

function antiSpamKey(parts = []) {
  return parts.filter(Boolean).join("|").toLowerCase();
}

function canSend(key, config, specificMinutes = null) {
  if (!config.antiSpam) return true;
  const ttl = minutesToMs(specificMinutes || config.antiSpamMinutes || DEFAULT_CONFIG.antiSpamMinutes);
  if (sentMemory.hasFresh(key, ttl)) return false;
  sentMemory.set(key, true);
  return true;
}

function normalizePushId(id = "") {
  return String(id || "").trim();
}

function isValidPushId(id = "") {
  const value = normalizePushId(id);
  return /^[0-9a-fA-F-]{20,}$/.test(value) || /^webpush:/.test(value);
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
    item.external_id,
  ].forEach((id) => id && ids.push(id));

  if (Array.isArray(item.playerIds)) ids.push(...item.playerIds);
  if (Array.isArray(item.pushIds)) ids.push(...item.pushIds);
  if (Array.isArray(item.subscriptionIds)) ids.push(...item.subscriptionIds);

  return uniqueValidPushIds(ids);
}

async function getAdminPushIds(force = false) {
  const config = await getConfig();
  const ttl = minutesToMs(config.adminCacheMinutes || DEFAULT_CONFIG.adminCacheMinutes);

  if (!force && cache.admins.expiresAt > Date.now() && cache.admins.ids.length) {
    return cache.admins.ids;
  }

  if (!db || inQuotaBackoff()) return cache.admins.ids || [];

  const ids = new Set();

  for (const name of ADMIN_PUSH_COLLECTIONS) {
    try {
      const snap = await db.collection(name).limit(40).get();

      snap.docs.forEach((docSnap) => {
        const item = docSnap.data() || {};
        const roleText = normalizeText(`${item.rol || ""} ${item.role || ""} ${item.tipo || ""}`);

        const isAdmin =
          name.includes("admin") ||
          item.admin === true ||
          item.esAdmin === true ||
          item.esJefe === true ||
          roleText.includes("admin") ||
          roleText.includes("jefe");

        if (!isAdmin) return;

        extractPushIds(item).forEach((id) => ids.add(id));
      });
    } catch (error) {
      if (isQuotaError(error)) markQuotaBackoff(config);
      safeLog(`⚠️ No se pudo leer ${name}:`, error.message);
    }
  }

  const result = [...ids];
  cache.admins = { ids: result, expiresAt: Date.now() + ttl };

  return result;
}

function getWorkerIdentity(data = {}) {
  const name = pickFirstText(data, [
    "trabajador", "trabajadorNombre", "nombreTrabajador", "workerName", "worker_name",
    "worker", "colaborador", "colaboradorNombre", "empleado", "empleadoNombre",
    "nombre", "displayName", "name", "fullName", "usuario", "userName"
  ]);

  const dni = String(data.dni || data.documento || data.workerDni || data.trabajadorDni || "").replace(/\D/g, "");
  const id = String(data.id || data.workerId || data.trabajadorId || data.uid || "").trim();

  return { name, dni, id, slug: slugify(name) };
}

function slugify(value = "") {
  return normalizeText(value).replace(/\s+/g, "-");
}

async function getWorkerPushIds(data = {}, force = false) {
  const config = await getConfig();
  const ttl = minutesToMs(config.workerPushCacheMinutes || DEFAULT_CONFIG.workerPushCacheMinutes);
  const identity = getWorkerIdentity(data);
  const cacheKey = antiSpamKey([identity.dni, identity.slug, identity.id, "workerPush"]);

  if (!force && cache.workerPush.has(cacheKey)) {
    const item = cache.workerPush.get(cacheKey);
    if (item && item.expiresAt > Date.now()) return item.ids;
  }

  const ids = new Set();
  extractPushIds(data).forEach((id) => ids.add(id));

  if (!db || inQuotaBackoff()) return [...ids];

  const candidates = [identity.dni, identity.slug, identity.id].filter(Boolean);

  for (const collectionName of WORKER_PUSH_COLLECTIONS) {
    for (const docId of candidates) {
      try {
        const snap = await db.collection(collectionName).doc(String(docId)).get();
        if (snap.exists) extractPushIds(snap.data() || {}).forEach((id) => ids.add(id));
      } catch (error) {
        if (isQuotaError(error)) markQuotaBackoff(config);
      }
    }
  }

  const result = [...ids];
  cache.workerPush.set(cacheKey, { ids: result, expiresAt: Date.now() + ttl });

  return result;
}

async function cleanInvalidPushIds(invalidIds = []) {
  const ids = uniqueValidPushIds(invalidIds);
  if (!ids.length || !db || inQuotaBackoff()) return;

  const config = await getConfig();

  for (const name of ["admins_push", "push_tokens", "trabajadores", "usuarios_admin", "admins"]) {
    try {
      const snap = await db.collection(name).limit(60).get();

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
      if (isQuotaError(error)) markQuotaBackoff(config);
      safeLog(`⚠️ No se pudo limpiar IDs en ${name}:`, error.message);
    }
  }
}

function buildWhatsAppStyleOptions(data = {}, priority = "alta") {
  const isCritical = priority === "critica";
  return {
    priority: isCritical ? 10 : 8,
    android_channel_id: process.env.ONESIGNAL_ANDROID_CHANNEL_ID || process.env.ONE_SIGNAL_ANDROID_CHANNEL_ID || undefined,
    android_accent_color: process.env.PUSH_ACCENT_COLOR || "00D9FF",
    small_icon: process.env.PUSH_SMALL_ICON || "ic_stat_onesignal_default",
    large_icon: process.env.PUSH_LARGE_ICON || undefined,
    chrome_web_icon: process.env.PUSH_WEB_ICON || undefined,
    chrome_web_badge: process.env.PUSH_WEB_BADGE || undefined,
    android_sound: isCritical
      ? (process.env.ADMIN_PUSH_SOUND_CRITICAL || process.env.ADMIN_PUSH_SOUND || "alerta_admin")
      : (process.env.ADMIN_PUSH_SOUND || "alerta_admin"),
    ios_sound: isCritical
      ? (process.env.ADMIN_PUSH_SOUND_IOS_CRITICAL || process.env.ADMIN_PUSH_SOUND_IOS || "alerta_admin.wav")
      : (process.env.ADMIN_PUSH_SOUND_IOS || "alerta_admin.wav"),
    adm_sound: process.env.ADMIN_PUSH_SOUND || "alerta_admin",
    android_vibration_pattern: isCritical
      ? (process.env.ADMIN_VIBRATION_PATTERN_CRITICAL || "350,120,350,120,550")
      : (process.env.ADMIN_VIBRATION_PATTERN || "200,100,200,100,350"),
    ttl: Number(process.env.PUSH_TTL_SECONDS || 86400),
    data: {
      pushStyle: "whatsapp_full",
      priority,
      badge: "el_tablon",
      wakeScreen: true,
      persistent: true,
      ...data,
    },
  };
}

async function sendPush({
  title,
  message,
  type = "aprobacionPendiente",
  source = "bridge",
  target = "admin",
  sede = "",
  data = {},
  url = APP_URL,
  subscriptionIds = [],
  antiSpamMinutes = null,
}) {
  const config = await getConfig();

  if (!allowedByConfig(type, config, target)) {
    safeLog(`⏸️ Omitido por configuración: ${type}/${target}`);
    return { skipped: true, reason: "disabled_by_config" };
  }

  const key = antiSpamKey([
    source,
    type,
    target,
    data.id,
    data.asistenciaId,
    data.trabajador,
    data.dni,
    data.fecha,
    message,
  ]);

  if (!canSend(key, config, antiSpamMinutes)) {
    safeLog(`🛡️ Omitido por anti-spam: ${type} ${data.trabajador || ""}`);
    return { skipped: true, reason: "anti_spam" };
  }

  const targetIds =
    Array.isArray(subscriptionIds) && subscriptionIds.length > 0
      ? subscriptionIds
      : target === "trabajador"
        ? await getWorkerPushIds(data)
        : await getAdminPushIds();

  const validIds = uniqueValidPushIds(targetIds);

  if (!validIds.length) {
    safeLog(`⚠️ ${target === "trabajador" ? "Trabajador" : "Admin"} sin playerId para push:`, data.trabajador || data.nombre || "-");
    return { skipped: true, reason: "no_valid_player_ids" };
  }

  const priority = config.priorities?.[type] || "media";

  const body = {
    app_id: ONE_SIGNAL_APP_ID,
    target_channel: "push",
    include_subscription_ids: validIds,
    headings: { en: title, es: title },
    contents: { en: message, es: message },
    url,
    ...buildWhatsAppStyleOptions({ ...data, type, source, target, sede }, priority),
  };

  const response = await fetch("https://onesignal.com/api/v1/notifications", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Basic ${ONE_SIGNAL_REST_API_KEY}`,
    },
    body: JSON.stringify(body),
  });

  const result = await response.json().catch(() => ({}));

  if (result?.errors?.invalid_player_ids?.length) {
    cleanInvalidPushIds(result.errors.invalid_player_ids).catch(() => null);
  }

  if (!response.ok) {
    throw new Error(`OneSignal ${response.status}: ${JSON.stringify(result)}`);
  }

  safeLog(`✅ Push ${target}:`, data.trabajador || "", title, result?.id || "");

  logHistory(
    { title, message, type, source, target, sede, data, priority },
    result
  ).catch(() => null);

  return result;
}

async function logHistory(payload, result) {
  const config = await getConfig();
  if (!config.logsEnabled || !db || inQuotaBackoff()) return;

  try {
    await db.collection("notificacionesHistorial").add({
      ...payload,
      resultId: result?.id || null,
      createdAt: new Date().toISOString(),
      createdAtServer: admin.firestore.FieldValue.serverTimestamp(),
    });
  } catch (error) {
    if (isQuotaError(error)) markQuotaBackoff(config);
    safeLog("⚠️ Historial push omitido:", error.message);
  }
}

function resolveWorkerNameFromPayload(source = {}) {
  const direct = pickFirstText(source, [
    "trabajador", "trabajadorNombre", "nombreTrabajador", "workerName", "worker_name",
    "worker", "colaborador", "colaboradorNombre", "empleado", "empleadoNombre",
    "nombre", "displayName", "name", "fullName", "usuario", "userName"
  ]);

  if (direct) return direct;

  const nestedCandidates = [
    source.trabajadorData, source.workerData, source.colaboradorData,
    source.empleadoData, source.user, source.usuarioData, source.profile
  ];

  for (const item of nestedCandidates) {
    if (!item || typeof item !== "object") continue;
    const nested = pickFirstText(item, [
      "nombre", "trabajador", "trabajadorNombre", "name",
      "fullName", "displayName", "workerName"
    ]);
    if (nested) return nested;
  }

  return "";
}

function resolveSedeFromPayload(source = {}) {
  return pickFirstText(source, ["sede", "sucursal", "local", "tienda", "store", "branch"]);
}

function normalizeNotificationAction(source = {}, collectionName = "") {
  const tipo = pickFirstText(source, ["tipo", "evento", "type", "accion", "action", "estado", "status"]) || collectionName;
  const mensaje = pickFirstText(source, ["mensaje", "message", "descripcion", "detalle", "description", "motivo", "reason"]);
  return `${tipo} ${mensaje}`.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
}

function getType(item = {}) {
  const text = normalizeNotificationAction(item, "");
  const dist = Number(item.distanciaMetros || item.distanceMeters || item.distancia || item.gpsDistance || 0);
  const tardanza = numberFrom(item, ["tardanza", "minutosTardanza", "tardanzaMin", "lateMinutes"]);
  const breakMin = numberFrom(item, ["breakMinutos", "minutosBreak", "duracionBreak", "breakDuration"]);
  const earlyExit = numberFrom(item, ["minutosSalidaAnticipada", "salidaAnticipadaMinutos", "earlyExitMinutes"]);

  if (text.includes("recordatorio") || text.includes("10 minutos")) return "trabajador10MinAntes";
  if (text.includes("fuera") || text.includes("rango") || text.includes("gps") || dist > 0 && (item.aprobacionPendiente || item.requiereAprobacion)) return "fueraRangoGps";
  if (text.includes("tard") || tardanza > 8) return "tardanza";
  if (text.includes("break") && (text.includes("exced") || breakMin > 60)) return "breakExcedido";
  if (text.includes("salida anticipada") || earlyExit > 0) return "salidaAnticipada";
  if (text.includes("no marco ingreso") || text.includes("no marcó ingreso") || text.includes("falta ingreso")) return "faltaIngreso";
  if (text.includes("salida") && (text.includes("no marcada") || text.includes("no marco") || text.includes("sigue activo"))) return "salidaNoMarcada";
  if (text.includes("cambio")) return "cambioTurno";
  if (text.includes("disciplina") || text.includes("incidencia")) return "disciplinario";
  return "aprobacionPendiente";
}

function buildPush(item = {}, id = "", collectionName = "") {
  const type = getType(item);
  const trabajador = resolveWorkerNameFromPayload(item) || "Trabajador";
  const sede = resolveSedeFromPayload(item);
  const sedeText = sede ? ` · ${sede}` : "";
  const tipo = item.tipo || item.accion || "Marcación";
  const dist = item.distanciaMetros || item.distanceMeters || item.distancia || item.gpsDistance || "-";
  const tardanza = numberFrom(item, ["tardanza", "minutosTardanza", "tardanzaMin", "lateMinutes"]);
  const breakMin = numberFrom(item, ["breakMinutos", "minutosBreak", "duracionBreak", "breakDuration"]);
  const breakExceso = numberFrom(item, ["breakExceso", "excesoBreak", "minutosExcesoBreak", "excessBreakMinutes"]);
  const earlyExit = numberFrom(item, ["minutosSalidaAnticipada", "salidaAnticipadaMinutos", "earlyExitMinutes"]);
  const earlyEntry = numberFrom(item, ["minutosAnticipado", "anticipadoMinutos", "minutosAntes", "earlyMinutes"]);

  const data = {
    id,
    asistenciaId: item.asistenciaId || item.id || id,
    trabajador,
    dni: item.dni || item.documento || "",
    sede,
    collectionName,
    fecha: item.fecha || item.dateKey || new Date().toLocaleDateString("es-PE"),
    ...item,
  };

  if (type === "trabajador10MinAntes") {
    return {
      type, target: "trabajador", title: "⏰ EL TABLÓN · Tu turno inicia pronto",
      message: `${trabajador}, tu ingreso inicia en 10 minutos${sedeText}.`, sede, data
    };
  }

  if (type === "fueraRangoGps") {
    return {
      type, target: "admin", title: "📍 EL TABLÓN · Fuera de rango GPS",
      message: `${trabajador} intentó ${tipo}${sedeText}. Distancia: ${dist} m.`, sede, data
    };
  }

  if (type === "tardanza") {
    return {
      type, target: "admin", title: "⚠️ Tolerancia superada",
      message: `${trabajador} ingresó tarde${tardanza ? ` (${tardanza} min)` : ""}${sedeText}.`, sede, data
    };
  }

  if (type === "breakExcedido") {
    const exceso = breakExceso || Math.max(0, Number(breakMin || 0) - 60);
    return {
      type, target: "admin", title: "☕ Break excedido",
      message: `${trabajador} excedió break${exceso ? ` por ${exceso} min` : ""}${sedeText}.`, sede, data
    };
  }

  if (type === "salidaAnticipada") {
    return {
      type, target: "admin", title: "🚨 Salida anticipada",
      message: `${trabajador} marcó salida${earlyExit ? ` ${earlyExit} min antes` : " antes de horario"}${sedeText}.`, sede, data
    };
  }

  if (type === "faltaIngreso") {
    return {
      type, target: "admin", title: "⚠️ No marcó ingreso",
      message: `${trabajador} no registró ingreso${sedeText}.`, sede, data
    };
  }

  if (type === "salidaNoMarcada") {
    return {
      type, target: "admin", title: "🚨 Salida no marcada",
      message: `${trabajador} sigue activo fuera de horario${sedeText}.`, sede, data
    };
  }

  if (type === "cambioTurno") {
    return {
      type, target: "admin", title: "🔄 Cambio de turno",
      message: item.mensaje || `${trabajador}: cambio de turno registrado${sedeText}.`, sede, data
    };
  }

  const isEntrada = normalizeNotificationAction(item, collectionName).includes("entrada") || normalizeNotificationAction(item, collectionName).includes("ingreso");
  const isSalida = normalizeNotificationAction(item, collectionName).includes("salida");
  const isBreak = normalizeNotificationAction(item, collectionName).includes("break");

  if (isEntrada && earlyEntry > 0) {
    return {
      type: "aprobacionPendiente", target: "admin", title: "⏱️ Ingreso anticipado",
      message: `${trabajador} marcó ingreso ${earlyEntry} min antes${sedeText}.`, sede, data
    };
  }

  if (isEntrada) {
    return {
      type: "aprobacionPendiente", target: "admin", title: "✅ Ingreso registrado",
      message: `${trabajador} registró ingreso${sedeText}.`, sede, data
    };
  }

  if (isSalida) {
    return {
      type: "aprobacionPendiente", target: "admin", title: "🏁 Salida registrada",
      message: `${trabajador} registró salida${sedeText}.`, sede, data
    };
  }

  if (isBreak) {
    return {
      type: "aprobacionPendiente", target: "admin", title: "☕ Movimiento de break",
      message: `${trabajador}: ${item.mensaje || item.tipo || "break registrado"}${sedeText}.`, sede, data
    };
  }

  return {
    type, target: "admin", title: "🔔 Nueva alerta operativa",
    message: `${trabajador}: ${item.mensaje || item.tipo || "actividad registrada"}${sedeText}.`, sede, data
  };
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

  try {
    const built = buildPush(data, id, collectionName);

    const result = await sendPush({
      ...built,
      source: collectionName,
      data: built.data,
    });

    if (!result?.skipped && db && !collectionName.includes("asistencia")) {
      await docSnapshot.ref.set({
        pushProcesado: true,
        pushSent: true,
        pushSentAt: new Date().toISOString(),
        pushResultId: result?.id || null,
      }, { merge: true }).catch((error) => {
        if (isQuotaError(error)) markQuotaBackoff();
      });
    }

    // Push dual para trabajador en eventos que también le corresponden.
    if (["trabajador10MinAntes", "breakExcedido", "tardanza", "salidaAnticipada"].includes(built.type)) {
      await maybeSendWorkerMirror(built, data).catch(() => null);
    }

  } catch (error) {
    safeLog("❌ Error procesando push:", id, error.message);
  }
}

async function maybeSendWorkerMirror(built, originalData = {}) {
  const workerTypes = {
    trabajador10MinAntes: "⏰ Tu turno inicia pronto",
    tardanza: "⚠️ Tolerancia superada",
    breakExcedido: "☕ Break excedido",
    salidaAnticipada: "⏱️ Revisa tu salida",
  };

  if (!workerTypes[built.type]) return;

  let message = built.message;
  if (built.type === "tardanza") message = "Registraste ingreso fuera de tolerancia. Regulariza con tu encargado si corresponde.";
  if (built.type === "breakExcedido") message = "Tu tiempo de break superó 1 hora. Por favor regulariza tu marcación.";
  if (built.type === "salidaAnticipada") message = "Marcaste salida antes de tu horario programado. Por favor confirma con tu encargado.";

  await sendPush({
    title: workerTypes[built.type],
    message,
    type: built.type,
    source: "worker_mirror",
    target: "trabajador",
    sede: built.sede,
    data: { ...built.data, ...originalData },
    url: "https://el-tablon-2ad52.web.app/movil",
    antiSpamMinutes: 30,
  });
}

function listenCollection(collectionName) {
  if (!db) return null;

  safeLog(`🔔 Escuchando colección ${collectionName}...`);

  return db.collection(collectionName)
    .orderBy("createdAt", "desc")
    .limit(Number(process.env.LISTENER_LIMIT || DEFAULT_CONFIG.maxDocsPerSnapshot))
    .onSnapshot((snapshot) => {
      snapshot.docChanges().forEach((change) => {
        if (change.type !== "added" && change.type !== "modified") return;

        processNotificationDoc(collectionName, change.doc).catch((error) => {
          safeLog(`❌ Error listener ${collectionName}:`, error.message);
        });
      });
    }, (error) => {
      if (isQuotaError(error)) markQuotaBackoff();
      safeLog(`❌ Listener ${collectionName} detenido:`, error.message);
    });
}

function parseDateFromRecord(item = {}) {
  if (item.createdAt) {
    const d = new Date(item.createdAt);
    if (!Number.isNaN(d.getTime())) return d;
  }

  if (item.fechaHora) {
    const d = new Date(item.fechaHora);
    if (!Number.isNaN(d.getTime())) return d;
  }

  if (item.fecha) {
    const parts = String(item.fecha).split("/");
    if (parts.length === 3) {
      const d = new Date(`${parts[2]}-${String(parts[1]).padStart(2, "0")}-${String(parts[0]).padStart(2, "0")}T12:00:00`);
      if (!Number.isNaN(d.getTime())) return d;
    }

    const d = new Date(item.fecha);
    if (!Number.isNaN(d.getTime())) return d;
  }

  return null;
}

function todayPE() {
  return new Date().toLocaleDateString("es-PE");
}

function toDateKey(date = new Date()) {
  const d = new Date(date);
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function getDayKey(date = new Date()) {
  return ["dom", "lun", "mar", "mie", "jue", "vie", "sab"][date.getDay()];
}

function parseScheduleStart(value) {
  if (!value || String(value).includes("Descanso") || String(value).includes("Vacaciones")) return null;
  const [h, m] = String(value).split("-")[0]?.split(":").map(Number) || [];
  if (!Number.isFinite(h) || !Number.isFinite(m)) return null;
  return h * 60 + m;
}

function parseScheduleEnd(value) {
  if (!value || String(value).includes("Descanso") || String(value).includes("Vacaciones")) return null;
  const right = String(value).split("-")[1];
  if (!right) return null;
  const [h, m] = right.split(":").map(Number);
  if (!Number.isFinite(h) || !Number.isFinite(m)) return null;
  return h * 60 + m;
}

function nowMinutes() {
  const d = new Date();
  return d.getHours() * 60 + d.getMinutes();
}

function isWorkSchedule(value) {
  const text = normalizeText(value);
  return value && value !== "-" && !text.includes("descanso") && !text.includes("vacaciones");
}

async function getWorkersCached(force = false) {
  const config = await getConfig();
  const ttl = minutesToMs(config.cacheMinutes || DEFAULT_CONFIG.cacheMinutes);

  if (!force && cache.workers.expiresAt > Date.now()) return cache.workers.value;
  if (!db || inQuotaBackoff()) return cache.workers.value || [];

  const map = new Map();

  for (const name of WORKERS_COLLECTIONS) {
    try {
      const snap = await db.collection(name).limit(120).get();

      snap.docs.forEach((docSnap) => {
        const data = { id: docSnap.id, ...docSnap.data() };
        if (data.deleted === true || data.softDeleted === true || data.activo === false || data.rol === "admin") return;
        const identity = getWorkerIdentity(data);
        const key = identity.dni || identity.slug || docSnap.id;
        map.set(key, { ...data, trabajador: data.nombre || data.trabajador || data.workerName || identity.name });
      });
    } catch (error) {
      if (isQuotaError(error)) markQuotaBackoff(config);
      safeLog(`⚠️ No se pudo leer ${name}:`, error.message);
    }
  }

  const workers = [...map.values()];
  cache.workers = { value: workers, expiresAt: Date.now() + ttl };
  return workers;
}

async function getSchedulesCached(force = false) {
  const config = await getConfig();
  const ttl = minutesToMs(config.cacheMinutes || DEFAULT_CONFIG.cacheMinutes);

  if (!force && cache.schedules.expiresAt > Date.now()) return cache.schedules.value;
  if (!db || inQuotaBackoff()) return cache.schedules.value || [];

  const schedules = [];

  for (const name of SCHEDULE_COLLECTIONS) {
    try {
      const snap = await db.collection(name).limit(200).get();
      snap.docs.forEach((docSnap) => schedules.push({ id: docSnap.id, _collection: name, ...docSnap.data() }));
    } catch (error) {
      if (isQuotaError(error)) markQuotaBackoff(config);
      safeLog(`⚠️ No se pudo leer ${name}:`, error.message);
    }
  }

  cache.schedules = { value: schedules, expiresAt: Date.now() + ttl };
  return schedules;
}

async function getAttendanceTodayCached(force = false) {
  const config = await getConfig();
  const ttl = minutesToMs(3);

  if (!force && cache.attendanceToday.expiresAt > Date.now()) return cache.attendanceToday.value;
  if (!db || inQuotaBackoff()) return cache.attendanceToday.value || [];

  try {
    const snap = await db.collection("asistencia").orderBy("createdAt", "desc").limit(250).get();
    const today = todayPE();
    const dateKey = toDateKey(new Date());

    const records = snap.docs
      .map((docSnap) => ({ id: docSnap.id, ...docSnap.data() }))
      .filter((item) => {
        if (item.deleted || item.softDeleted) return false;
        if (String(item.fecha || "") === today || String(item.dateKey || "") === dateKey) return true;
        const d = parseDateFromRecord(item);
        return d && d.toLocaleDateString("es-PE") === today;
      });

    cache.attendanceToday = { value: records, expiresAt: Date.now() + ttl };
    return records;
  } catch (error) {
    if (isQuotaError(error)) markQuotaBackoff(config);
    safeLog("⚠️ No se pudo leer asistencia de hoy:", error.message);
    return cache.attendanceToday.value || [];
  }
}

function getScheduleForWorker(worker = {}, schedules = [], date = new Date()) {
  const name = worker.trabajador || worker.nombre || worker.workerName || "";
  const slug = slugify(name);
  const dni = String(worker.dni || worker.documento || "").replace(/\D/g, "");
  const dayKey = getDayKey(date);
  const dateKey = toDateKey(date);

  const candidates = schedules.filter((s) => {
    const sWorker = normalizeText(s.trabajador || s.nombre || s.workerName || "");
    const sSlug = slugify(s.trabajador || s.nombre || s.workerName || s.id || "");
    const sDni = String(s.dni || s.documento || "").replace(/\D/g, "");
    const id = String(s.id || "").toLowerCase();

    return (
      (slug && (sSlug === slug || id.includes(slug))) ||
      (dni && sDni === dni) ||
      (name && sWorker === normalizeText(name))
    );
  });

  const daily = candidates.find((s) => String(s.fecha || s.dateKey || "").includes(dateKey));
  if (daily) return daily.horario || daily.turno || daily[dayKey] || daily.horarios?.[dayKey] || "-";

  const weekly = candidates[0];
  if (!weekly) return "-";

  return weekly[dayKey] || weekly.horarios?.[dayKey] || weekly.dias?.[dayKey] || weekly.programacion?.[dayKey] || "-";
}

function hasAttendance(records = [], worker = {}, type = "Entrada") {
  const name = normalizeText(worker.trabajador || worker.nombre || worker.workerName || "");
  const dni = String(worker.dni || worker.documento || "").replace(/\D/g, "");

  return records.some((r) => {
    const rName = normalizeText(r.trabajador || r.nombre || r.workerName || "");
    const rDni = String(r.dni || r.documento || "").replace(/\D/g, "");
    const rType = normalizeText(r.tipo || r.accion || r.type || "");
    return (name && rName === name || dni && rDni === dni) && rType.includes(normalizeText(type));
  });
}

function getActiveBreakStart(records = [], worker = {}) {
  const name = normalizeText(worker.trabajador || worker.nombre || worker.workerName || "");
  const workerRecords = records
    .filter((r) => normalizeText(r.trabajador || r.nombre || r.workerName || "") === name)
    .sort((a, b) => (parseDateFromRecord(a)?.getTime() || 0) - (parseDateFromRecord(b)?.getTime() || 0));

  let start = null;

  for (const r of workerRecords) {
    const type = normalizeText(r.tipo || r.accion || r.type || "");
    if (type.includes("inicio") && type.includes("break")) start = parseDateFromRecord(r) || new Date();
    if ((type.includes("termino") || type.includes("término") || type.includes("fin")) && type.includes("break")) start = null;
  }

  return start;
}

async function createSystemAlertOnce(type, worker, payload = {}, cooldownMinutes = 240) {
  const config = await getConfig();
  const trabajador = worker.trabajador || worker.nombre || worker.workerName || payload.trabajador || "Trabajador";
  const key = antiSpamKey(["auto", type, trabajador, payload.fecha || toDateKey(new Date())]);

  if (!canSend(key, config, cooldownMinutes)) return { skipped: true, reason: "auto_cooldown" };

  const built = buildPush({
    ...payload,
    trabajador,
    nombre: trabajador,
    dni: worker.dni || worker.documento || payload.dni || "",
    sede: worker.sede || worker.sucursal || payload.sede || "",
    tipo: type,
  }, key, "auto");

  if (type === "faltaIngreso") {
    built.type = "faltaIngreso";
    built.title = "⚠️ No marcó ingreso";
    built.message = `${trabajador} no registró ingreso${built.sede ? ` · ${built.sede}` : ""}.`;
  }

  if (type === "salidaNoMarcada") {
    built.type = "salidaNoMarcada";
    built.title = "🚨 Salida no marcada";
    built.message = `${trabajador} sigue activo fuera de horario${built.sede ? ` · ${built.sede}` : ""}.`;
  }

  if (type === "breakExcedido") {
    built.type = "breakExcedido";
    built.title = "☕ Break excedido";
    built.message = `${trabajador} lleva ${payload.breakMinutos || ""} min en break${built.sede ? ` · ${built.sede}` : ""}.`;
  }

  if (type === "trabajador10MinAntes") {
    built.type = "trabajador10MinAntes";
    built.target = "trabajador";
    built.title = "⏰ EL TABLÓN · Tu turno inicia pronto";
    built.message = `${trabajador}, tu ingreso inicia en 10 minutos${built.sede ? ` · ${built.sede}` : ""}.`;
  }

  const result = await sendPush({
    ...built,
    source: "auto_checker",
    data: built.data,
    antiSpamMinutes: cooldownMinutes,
    url: built.target === "trabajador" ? "https://el-tablon-2ad52.web.app/movil" : APP_URL,
  });

  // Guarda alerta ligera solo si no hay backoff. Esto permite trazabilidad sin saturar.
  if (!result?.skipped && db && !inQuotaBackoff()) {
    db.collection("alertas_sistema").add({
      tipo: type,
      trabajador,
      sede: worker.sede || worker.sucursal || "",
      mensaje: built.message,
      origen: "auto_checker_quota_safe",
      autoGenerado: true,
      pushProcesado: true,
      pushSent: true,
      createdAt: new Date().toISOString(),
      createdAtServer: admin.firestore.FieldValue.serverTimestamp(),
    }).catch((error) => {
      if (isQuotaError(error)) markQuotaBackoff(config);
    });
  }

  return result;
}

async function runAutomaticChecks() {
  if (autoCheckRunning) return;
  autoCheckRunning = true;

  try {
    const config = await getConfig();

    if (!config.autoChecksEnabled) return;
    if (inQuotaBackoff()) {
      safeLog("🟠 Auto-check omitido por backoff de cuota Firestore.");
      return;
    }

    const workers = await getWorkersCached();
    const schedules = await getSchedulesCached();
    const attendance = await getAttendanceTodayCached(true);
    const current = nowMinutes();
    const tolerance = Number(config.toleranceMinutes || config.toleranceMinutes === 0 ? config.toleranceMinutes : config.toleranceMinutes || DEFAULT_CONFIG.toleranceMinutes);
    const reminder = Number(config.workerReminderMinutes || DEFAULT_CONFIG.workerReminderMinutes);
    const breakLimit = Number(config.breakLimitMinutes || DEFAULT_CONFIG.breakLimitMinutes);
    const missingExit = Number(config.missingExitMinutes || DEFAULT_CONFIG.missingExitMinutes);
    const today = new Date();

    for (const worker of workers) {
      const scheduleValue = getScheduleForWorker(worker, schedules, today);

      if (!isWorkSchedule(scheduleValue)) continue;

      const start = parseScheduleStart(scheduleValue);
      const end = parseScheduleEnd(scheduleValue);
      const trabajador = worker.trabajador || worker.nombre || worker.workerName || "Trabajador";

      if (start !== null) {
        const diffToStart = start - current;

        if (diffToStart <= reminder && diffToStart >= Math.max(0, reminder - 2)) {
          await createSystemAlertOnce("trabajador10MinAntes", worker, {
            horario: scheduleValue,
            fecha: toDateKey(today),
            minutosAviso: reminder,
          }, 20);
        }

        if (current > start + tolerance && !hasAttendance(attendance, worker, "Entrada")) {
          await createSystemAlertOnce("faltaIngreso", worker, {
            horario: scheduleValue,
            fecha: toDateKey(today),
            minutosRetraso: current - start,
          }, 360);
        }
      }

      const breakStart = getActiveBreakStart(attendance, worker);
      if (breakStart) {
        const breakMinutes = Math.floor((Date.now() - breakStart.getTime()) / 60000);

        if (breakMinutes > breakLimit) {
          await createSystemAlertOnce("breakExcedido", worker, {
            horario: scheduleValue,
            fecha: toDateKey(today),
            breakMinutos: breakMinutes,
            minutosExcesoBreak: breakMinutes - breakLimit,
          }, 90);
        }
      }

      if (end !== null && hasAttendance(attendance, worker, "Entrada") && !hasAttendance(attendance, worker, "Salida")) {
        // Para turno nocturno, el fin puede ser menor que inicio. Se mueve a día siguiente en minutos relativos.
        let effectiveEnd = end;
        if (start !== null && end <= start) effectiveEnd += 24 * 60;

        let effectiveCurrent = current;
        if (start !== null && end <= start && current < start) effectiveCurrent += 24 * 60;

        if (effectiveCurrent > effectiveEnd + missingExit) {
          await createSystemAlertOnce("salidaNoMarcada", worker, {
            horario: scheduleValue,
            fecha: toDateKey(today),
            minutosFueraHorario: effectiveCurrent - effectiveEnd,
          }, 180);
        }
      }
    }

    safeLog(`✅ Auto-check inteligente OK · workers=${workers.length} · asistenciaHoy=${attendance.length}`);

  } catch (error) {
    if (isQuotaError(error)) {
      const config = cache.config.value || DEFAULT_CONFIG;
      markQuotaBackoff(config);
    }
    safeLog("❌ Auto-check inteligente error:", error.message);
  } finally {
    autoCheckRunning = false;
  }
}

function startAutomaticChecks() {
  if (autoCheckTimer) clearInterval(autoCheckTimer);

  getConfig().then((config) => {
    const intervalMinutes = Math.max(3, Number(config.autoCheckIntervalMinutes || DEFAULT_CONFIG.autoCheckIntervalMinutes));
    const intervalMs = minutesToMs(intervalMinutes);

    safeLog(`🤖 Alertas automáticas quota-safe cada ${intervalMinutes} min`);
    autoCheckTimer = setInterval(runAutomaticChecks, intervalMs);

    setTimeout(runAutomaticChecks, 25000);
  });
}

function startListeners() {
  COLLECTIONS_TO_LISTEN.forEach(listenCollection);
}

app.get("/", (req, res) => {
  res.json({
    ok: true,
    service: "EL TABLÓN Push Bridge activo",
    mode: "quota-safe-pro",
    time: new Date().toISOString(),
  });
});

app.get("/health", (req, res) => {
  res.json({
    ok: true,
    mode: "quota-safe-pro",
    quotaBackoff: inQuotaBackoff(),
    quotaBackoffUntil: quotaBackoffUntil ? new Date(quotaBackoffUntil).toISOString() : null,
    time: new Date().toISOString(),
  });
});

app.get("/test-push", async (req, res) => {
  try {
    const result = await sendPush({
      title: "🚀 Push EL TABLÓN ACTIVO",
      message: "Render + OneSignal + Firebase funcionando en modo quota-safe PRO.",
      type: "aprobacionPendiente",
      source: "test",
      data: { trabajador: "Prueba Admin", id: `test-${Date.now()}` },
      antiSpamMinutes: 0.2,
    });

    res.json({ ok: true, result });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
});

app.post("/push", async (req, res) => {
  try {
    const body = req.body || {};
    const result = await sendPush({
      title: body.title || body.titulo || "🔔 EL TABLÓN",
      message: body.message || body.mensaje || "Nueva alerta operativa.",
      type: body.type || body.tipo || "aprobacionPendiente",
      source: body.source || "api",
      target: body.target || "admin",
      sede: body.sede || "",
      data: body.data || body,
      url: body.url || APP_URL,
      subscriptionIds: body.subscriptionIds || body.playerIds || [],
      antiSpamMinutes: body.antiSpamMinutes || null,
    });

    res.json({ ok: true, result });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
});

app.post("/auto-check", async (req, res) => {
  runAutomaticChecks()
    .then(() => res.json({ ok: true }))
    .catch((error) => res.status(500).json({ ok: false, error: error.message }));
});

process.on("unhandledRejection", (reason) => {
  safeLog("⚠️ UnhandledRejection:", reason?.message || reason);
});

process.on("uncaughtException", (error) => {
  safeLog("⚠️ UncaughtException:", error?.message || error);
});

initFirebase();

app.listen(PORT, () => {
  safeLog(`✅ Servidor activo en puerto ${PORT}`);

  if (db) {
    startListeners();
    startAutomaticChecks();
    safeLog("🚀 PUSH EL TABLÓN ACTIVO — RENDER 24/7");
    safeLog("🧠 Modo quota-safe / anti-spam / cache inteligente activo");
  } else {
    safeLog("❌ Firebase no inició. Servicio vivo para healthcheck, pero sin listeners.");
  }
});
