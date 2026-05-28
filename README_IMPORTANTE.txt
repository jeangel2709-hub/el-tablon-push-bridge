EL TABLÓN · PUSH ULTRA LIGHT + TARDANZA CALCULADA

REEMPLAZAR EN:
onesignal-push-bridge

DOCUMENTOS COMPLETOS:
- server.js
- index.js
- package.json
- render.yaml
- .env.example

CAMBIO PUNTUAL:
✅ La tardanza ahora se calcula por horario real:
   horaIngreso vs inicioHorario + tolerancia.
✅ Ya no depende solo de campos Firestore como tardanza/minutosTardanza.

MANTIENE:
✅ polling cada 60 segundos
✅ cache memoria real
✅ solo lectura incremental
✅ sin onSnapshot
✅ notificaciones solo del día
✅ anti duplicados persistente en push_sent_log
✅ include_player_ids correcto para OneSignal
✅ menor consumo Firestore

PUSH SOLO PARA:
- Tardanza mayor a tolerancia -> ADMIN/JEFATURA
- Break mayor a 1 hora -> ADMIN/JEFATURA
- Salida antes de hora -> ADMIN/JEFATURA
- Fuera de rango GPS -> ADMIN/JEFATURA
- Recordatorio 10 min antes -> SOLO TRABAJADOR

DESPUÉS:
npm install
git add .
git commit -m "push tardanza calculada"
git push
