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

function norm(value = "") {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim()
    .toLowerCase();
}

function onlyDigits(value = "") {
  return String(value || "").replace(/\D/g, "");
}

function hasValidPin(item = {}) {
  const pin = String(item.pin || item.PIN || "").trim();
  return !!pin && pin !== "-" && pin !== "null" && pin !== "undefined";
}

function scoreDoc(doc) {
  const item = doc.data || {};
  let score = 0;

  if (hasValidPin(item)) score += 100;
  if (item.tipoJornada || item.tipo) score += 25;
  if (item.cargo) score += 20;
  if (item.sede || item.sucursal) score += 15;
  if (item.dni || item.documento) score += 15;
  if (String(doc.id || "").includes("-")) score -= 10;
  if (item.pushStatus || item.playerId || item.oneSignalPlayerId || item.onesignalPlayerId || Array.isArray(item.playerIds)) score -= 30;

  return score;
}

function keyFor(item = {}) {
  const dni = onlyDigits(item.dni || item.documento || "");
  if (dni) return `dni:${dni}`;

  const name = norm(item.nombre || item.trabajador || item.workerName || "");
  if (name) return `name:${name}`;

  return "";
}

const snap = await db.collection("trabajadores").get();
const groups = new Map();

snap.docs.forEach((docSnap) => {
  const item = docSnap.data() || {};
  const key = keyFor(item);
  if (!key) return;

  if (!groups.has(key)) groups.set(key, []);
  groups.get(key).push({
    id: docSnap.id,
    ref: docSnap.ref,
    data: item,
  });
});

let groupsFound = 0;
let toDelete = 0;
let deleted = 0;

for (const [key, docs] of groups.entries()) {
  if (docs.length <= 1) continue;

  groupsFound++;

  const sorted = [...docs].sort((a, b) => scoreDoc(b) - scoreDoc(a));
  const keep = sorted[0];
  const remove = sorted.slice(1);

  toDelete += remove.length;

  console.log("\nDUPLICADO TRABAJADOR:", key);
  console.log("CONSERVAR:", keep.id, "|", keep.data.nombre || keep.data.trabajador || "", "| PIN:", keep.data.pin || keep.data.PIN || "-", "| score:", scoreDoc(keep));
  remove.forEach((d) => {
    console.log("ELIMINAR :", d.id, "|", d.data.nombre || d.data.trabajador || "", "| PIN:", d.data.pin || d.data.PIN || "-", "| score:", scoreDoc(d));
  });

  if (APPLY) {
    for (const d of remove) {
      await d.ref.delete();
      deleted++;
    }
  }
}

console.log("\nResumen:");
console.log("Grupos duplicados:", groupsFound);
console.log("Documentos a eliminar:", toDelete);
console.log("Eliminados:", deleted);
console.log(APPLY ? "Modo aplicado." : "Modo revisión. Para aplicar: node limpiar-duplicados-trabajadores-v2.js --apply");
