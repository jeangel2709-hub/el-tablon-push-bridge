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

function normalizeText(value = "") {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim()
    .toLowerCase();
}

function normalizeTipo(value = "") {
  const text = normalizeText(value);

  if (text.includes("entrada") || text.includes("ingreso")) return "entrada";
  if (text.includes("inicio") && text.includes("break")) return "inicio_break";
  if ((text.includes("termino") || text.includes("término") || text.includes("fin")) && text.includes("break")) return "termino_break";
  if (text.includes("salida")) return "salida";

  return text || "sin_tipo";
}

function normalizeDate(item = {}) {
  return (
    item.workDate ||
    item.fechaOperativa ||
    item.fechaIso ||
    item.fechaMarcacion ||
    item.fecha ||
    "sin_fecha"
  );
}

function getCreatedAtMs(item = {}) {
  try {
    if (item.createdAt?.toMillis) return item.createdAt.toMillis();
    if (item.createdAt?._seconds) return item.createdAt._seconds * 1000;
    if (typeof item.createdAt === "number") return item.createdAt;
    if (typeof item.createdAt === "string") {
      const t = new Date(item.createdAt).getTime();
      if (!Number.isNaN(t)) return t;
    }
  } catch {}

  return 0;
}

function workerKey(item = {}) {
  const dni = String(item.dni || item.documento || "").replace(/\D/g, "");
  if (dni) return dni;

  return normalizeText(item.trabajador || item.nombre || item.workerName || item.workerId || item.idWorker || "sin_trabajador");
}

function duplicateKey(item = {}) {
  return [
    workerKey(item),
    normalizeDate(item),
    normalizeTipo(item.tipo || item.tipoMarcacion || item.marcacion || item.accion || item.evento),
  ].join("|");
}

const snap = await db.collection("asistencia").get();

const groups = new Map();

snap.docs.forEach((docSnap) => {
  const item = docSnap.data() || {};
  const key = duplicateKey(item);

  if (!groups.has(key)) groups.set(key, []);
  groups.get(key).push({
    id: docSnap.id,
    ref: docSnap.ref,
    data: item,
  });
});

let duplicateGroups = 0;
let duplicatesToDelete = 0;
let deleted = 0;

for (const [key, docs] of groups.entries()) {
  if (docs.length <= 1) continue;

  duplicateGroups++;

  const sorted = [...docs].sort((a, b) => {
    const aMs = getCreatedAtMs(a.data);
    const bMs = getCreatedAtMs(b.data);
    return bMs - aMs;
  });

  const keep = sorted[0];
  const remove = sorted.slice(1);

  duplicatesToDelete += remove.length;

  console.log("\nDUPLICADO MARCACIÓN:", key);
  console.log("CONSERVAR:", keep.id, "|", keep.data.trabajador || keep.data.nombre || "", "|", keep.data.tipo, "|", keep.data.hora || "");
  remove.forEach((d) => {
    console.log("ELIMINAR :", d.id, "|", d.data.trabajador || d.data.nombre || "", "|", d.data.tipo, "|", d.data.hora || "");
  });

  if (APPLY) {
    for (const d of remove) {
      await d.ref.delete();
      deleted++;
    }
  }
}

console.log("\nResumen asistencia:");
console.log("Grupos duplicados:", duplicateGroups);
console.log("Marcaciones duplicadas a eliminar:", duplicatesToDelete);
console.log("Eliminadas:", deleted);
console.log(APPLY ? "Modo aplicado." : "Modo revisión. Para aplicar: node limpiar-duplicados-asistencia.js --apply");
