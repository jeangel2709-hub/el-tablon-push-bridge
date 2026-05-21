import "dotenv/config";
import admin from "firebase-admin";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const playerId = process.argv[2];

if (!playerId) {
  console.log("Uso:");
  console.log("node registrar-admin-push.js TU_PLAYER_ID_REAL");
  process.exit(1);
}

const serviceAccountPath = path.join(__dirname, "service-account.json");
const serviceAccount = JSON.parse(fs.readFileSync(serviceAccountPath, "utf8"));

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
    projectId: serviceAccount.project_id,
  });
}

const db = admin.firestore();

await db.collection("admins_push").doc("principal").set(
  {
    nombre: "ADMIN PRINCIPAL",
    rol: "admin",
    admin: true,
    esAdmin: true,
    playerId,
    playerIds: [playerId],
    activo: true,
    pushActivo: true,
    updatedAt: new Date().toISOString(),
  },
  { merge: true }
);

console.log("✅ Admin push registrado correctamente:", playerId);
