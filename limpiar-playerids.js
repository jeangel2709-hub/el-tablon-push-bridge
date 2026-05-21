import "dotenv/config";
import admin from "firebase-admin";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const APPLY = process.argv.includes("--apply");

const serviceAccountPath = path.join(__dirname, "service-account.json");
const serviceAccount = JSON.parse(fs.readFileSync(serviceAccountPath, "utf8"));

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
    projectId: serviceAccount.project_id,
  });
}

const db = admin.firestore();

function isValidOneSignalId(id = "") {
  return /^[0-9a-fA-F-]{32,}$/.test(String(id || "").trim());
}

function uniqueValidIds(ids = []) {
  return [...new Set((ids || []).map((x) => String(x || "").trim()).filter(isValidOneSignalId))];
}

function collectIds(item = {}) {
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

  return ids;
}

const collections = ["admins_push", "push_tokens", "trabajadores", "usuarios_admin", "admins"];
let fixed = 0;

for (const collectionName of collections) {
  const snap = await db.collection(collectionName).get();

  console.log(`\n📌 Revisando ${collectionName}: ${snap.size}`);

  for (const docSnap of snap.docs) {
    const item = docSnap.data() || {};
    const raw = collectIds(item);
    const valid = uniqueValidIds(raw);

    const changed = raw.length !== valid.length || String(item.playerId || "") !== String(valid[0] || item.playerId || "");

    if (!raw.length) continue;

    console.log("-", collectionName, docSnap.id, "| raw:", raw.length, "| valid:", valid.length);

    if (APPLY && changed) {
      await docSnap.ref.set(
        {
          playerIds: valid,
          playerId: valid[0] || "",
          pushActivo: valid.length > 0,
          pushStatus: valid.length ? "validado" : "sin_player_id",
          pushUpdatedAt: new Date().toISOString(),
        },
        { merge: true }
      );
      fixed++;
    }
  }
}

console.log("\nResumen:");
console.log("Documentos corregidos:", fixed);
console.log(APPLY ? "Modo aplicado." : "Modo revisión. Para aplicar: node limpiar-playerids.js --apply");
