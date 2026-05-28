EL TABLÓN · PUSH TARDANZA REAL FECHA/HORA

REEMPLAZAR EN:
onesignal-push-bridge

DOCUMENTOS COMPLETOS:
- server.js
- index.js
- package.json
- render.yaml
- .env.example

CAMBIO PUNTUAL:
✅ La detección de tardanza ahora revisa registros del día por:
   - fechaOperativa
   - fechaIso
   - hora
   - horario
✅ Ya no depende solo de createdAt.
✅ Agrega log claro:
   Tardanza detectada: [trabajador]

MANTIENE:
✅ polling cada 60 segundos
✅ cache memoria real
✅ sin onSnapshot
✅ solo día actual
✅ anti duplicados persistente en push_sent_log
✅ include_player_ids correcto para OneSignal

NO TOCA:
- dashboard
- diseño
- frontend
- móvil
- GPS
- horarios
- estructura visual

DESPUÉS:
npm install
git add .
git commit -m "push tardanza real fecha hora"
git push
