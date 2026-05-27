EL TABLÓN · PUSH CRÍTICO LIMITADO

REEMPLAZAR EN:
onesignal-push-bridge

DOCUMENTOS COMPLETOS:
- server.js
- index.js
- package.json
- render.yaml
- .env.example

ENVÍA PUSH SOLO POR:
1. Tardanza mayor a tolerancia -> ADMIN/JEFATURA
2. Break mayor a 1 hora -> ADMIN/JEFATURA
3. Salida antes de hora -> ADMIN/JEFATURA
4. Fuera de rango GPS -> ADMIN/JEFATURA
5. Recordatorio 10 min antes de ingreso -> SOLO TRABAJADOR

Todas las alertas incluyen nombre del trabajador.
Tiene anti-spam por trabajador + evento + día.
Reduce consumo Firestore.

DESPUÉS:
npm install
git add .
git commit -m "push critico limitado"
git push
