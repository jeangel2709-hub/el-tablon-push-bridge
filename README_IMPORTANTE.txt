EL TABLÓN · FIX PLAYERID PUSH

REEMPLAZAR EN:
onesignal-push-bridge

DOCUMENTOS COMPLETOS:
- server.js
- index.js
- package.json
- render.yaml
- .env.example

CORRIGE:
- Envío OneSignal usando include_player_ids.
- Ya NO usa include_external_user_ids.
- Usa los playerId guardados en Firestore.

MANTIENE SOLO PUSH CRÍTICOS:
- Tardanza mayor a tolerancia -> ADMIN/JEFATURA
- Break mayor a 1 hora -> ADMIN/JEFATURA
- Salida antes de hora -> ADMIN/JEFATURA
- Fuera de rango GPS -> ADMIN/JEFATURA
- Recordatorio 10 min antes -> SOLO TRABAJADOR

DESPUÉS:
npm install
git add .
git commit -m "fix playerid push"
git push
