import "dotenv/config";
import admin from "firebase-admin";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const serviceAccountPath = path.join(__dirname, "service-account.json");
const serviceAccount = JSON.parse(fs.readFileSync(serviceAccountPath, "utf8"));

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
    projectId: serviceAccount.project_id,
  });
}

const db = admin.firestore();
const APPLY = process.argv.includes("--apply");

function norm(value = "") {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim()
    .toLowerCase();
}

function isLikelyPushClone(item = {}) {
  const hasPushFields =
    item.pushStatus ||
    item.playerId ||
    item.oneSignalPlayerId ||
    item.onesignalPlayerId ||
    item.pushPlayerId ||
    Array.isArray(item.playerIds);

  const lacksWorkerCore =
    !item.pin &&
    !item.PIN &&
    !item.password &&
    !item.cargo &&
    !item.jornada &&
    !item.createdAt;

  return Boolean(hasPushFields && lacksWorkerCore);
}

const snap = await db.collection("trabajadores").get();
const groups = new Map();

snap.docs.forEach((docSnap) => {
  const item = docSnap.data() || {};
  const key =
    norm(item.dni || "") ||
    norm(item.nombre || item.trabajador || "") ||
    docSnap.id;

  if (!groups.has(key)) groups.set(key, []);
  groups.get(key).push({ id: docSnap.id, ref: docSnap.ref, data: item });
});

let found = 0;
let deleted = 0;

for (const [key, docs] of groups.entries()) {
  if (docs.length <= 1) continue;

  found += docs.length - 1;

  console.log("\nPOSIBLE DUPLICADO:", key);
  docs.forEach((d) => {
    console.log("-", d.id, "|", d.data.nombre || d.data.trabajador || "", "| pushClone:", isLikelyPushClone(d.data));
  });

  const clones = docs.filter((d) => isLikelyPushClone(d.data));

  if (APPLY) {
    for (const clone of clones) {
      await clone.ref.delete();
      deleted++;
      console.log("ELIMINADO:", clone.id);
    }
  }
}

console.log("\nResumen:");
console.log("Duplicados detectados:", found);
console.log("Eliminados:", deleted);
console.log(APPLY ? "Modo aplicado." : "Modo revisión. Para borrar clones seguros: node limpiar-duplicados-trabajadores.js --apply");
