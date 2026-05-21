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

const ONE_SIGNAL_APP_ID = process.env.ONE_SIGNAL_APP_ID;
const ONE_SIGNAL_REST_API_KEY = process.env.ONE_SIGNAL_REST_API_KEY;

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

function buildNotificationPayload(source = {}, collectionName = "") {
  const trabajador = normalizeText(source.trabajador || source.nombre || source.workerName || source.worker || "");
  const tipo = normalizeText(source.tipo || source.evento || source.type || collectionName);
  const sede = normalizeText(source.sede || source.sucursal || "");
  const mensaje = normalizeText(source.mensaje || source.message || source.descripcion || "");

  const isLate = tipo.toLowerCase().includes("tard") || mensaje.toLowerCase().includes("tard");
  const isGps = mensaje.toLowerCase().includes("gps") || mensaje.toLowerCase().includes("rango") || mensaje.toLowerCase().includes("fuera");
  const isBreak = tipo.toLowerCase().includes("break") || mensaje.toLowerCase().includes("break");
  const isSalida = tipo.toLowerCase().includes("salida");
  const isEntrada = tipo.toLowerCase().includes("entrada");

  let title = "🔔 EL TABLÓN - Alerta operativa";
  let body = mensaje || "Nueva actualización operativa registrada.";

  if (trabajador) {
    if (isEntrada) {
      title = "✅ Ingreso registrado";
      body = `${trabajador}${sede ? ` · ${sede}` : ""} marcó ingreso.`;
    } else if (isBreak) {
      title = "☕ Movimiento de break";
      body = `${trabajador}${sede ? ` · ${sede}` : ""} registró ${tipo || "break"}.`;
    } else if (isSalida) {
      title = "🏁 Salida registrada";
      body = `${trabajador}${sede ? ` · ${sede}` : ""} marcó salida.`;
    } else if (isLate) {
      title = "⚠️ Tardanza detectada";
      body = `${trabajador}${sede ? ` · ${sede}` : ""} registra tardanza.`;
    } else if (isGps) {
      title = "📍 Alerta GPS";
      body = `${trabajador}${sede ? ` · ${sede}` : ""} requiere validación de ubicación.`;
    } else {
      title = "🔔 Nueva alerta operativa";
      body = mensaje || `${trabajador}${sede ? ` · ${sede}` : ""}: ${tipo}`;
    }
  }

  return {
    title,
    body,
    data: {
      collectionName,
      trabajador,
      tipo,
      sede,
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

function startListeners() {
  const firestore = initFirebase();

  if (!firestore) {
    safeLog("❌ Firebase no inició. El servicio queda vivo para healthcheck, pero sin listeners.");
    return;
  }

  COLLECTIONS_TO_LISTEN.forEach(listenCollection);

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
