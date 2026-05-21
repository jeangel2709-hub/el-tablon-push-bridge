EL TABLÓN · Push trabajadores FINAL

Reemplazar SOLO el contenido de:
onesignal-push-bridge/

Cambio aplicado SOLO en notificaciones Render:
- A cada trabajador le llega recordatorio 10 min antes de su ingreso.
- Alerta al trabajador cuando pasan 8 min de tolerancia.
- Alerta al trabajador cuando su break supera 1 hora.
- Alerta al trabajador cuando marca salida antes de su horario.

NO toca:
- Admin.jsx
- Dashboard
- Panel Operativo
- Ranking
- Horarios
- Configuración
- Diseño
- Firestore Rules

IMPORTANTE:
Para que llegue al celular de cada trabajador, cada documento de trabajadores debe tener:
- playerId
o
- oneSignalPlayerId
o
- pushPlayerId
o
- subscriptionId
o
- playerIds: []

Variables opcionales en Render:
ENTRY_REMINDER_MINUTES=10
LATE_TOLERANCE_MINUTES=8
BREAK_LIMIT_MINUTES=60
WORKER_ALERT_INTERVAL_MS=60000
