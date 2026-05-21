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
const collections = ["notificacionesCola", "colaPushTemporal", "push_queue", "notificaciones_cola"];

let total = 0;
let deleted = 0;

for (const name of collections) {
  const snap = await db.collection(name).get();
  console.log(`${name}: ${snap.size}`);
  total += snap.size;

  if (APPLY) {
    for (const docSnap of snap.docs) {
      await docSnap.ref.delete();
      deleted++;
    }
  }
}

console.log("Encontrados:", total);
console.log("Eliminados:", deleted);
console.log(APPLY ? "Modo aplicado." : "Modo revisión. Para limpiar: node limpiar-cola-push.js --apply");
