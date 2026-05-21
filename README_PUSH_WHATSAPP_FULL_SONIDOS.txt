EL TABLÓN · Push WhatsApp FULL + Sonidos Admin

Reemplazar SOLO el contenido de:
onesignal-push-bridge/

Cambios SOLO en notificaciones:
1. Fuerza nombre del trabajador en título y cuerpo.
2. Mensajes más claros:
   - ✅ Nombre: Ingreso registrado
   - ☕ Nombre: Inició break / Break excedido
   - ⚠️ Nombre: Tardanza / salida anticipada
3. Push estilo WhatsApp FULL:
   - prioridad alta
   - ttl 24h
   - data operativa
   - canal Android configurable
4. Sonido y vibración personalizados para admin:
   - ADMIN_PUSH_SOUND=alerta_admin
   - ADMIN_PUSH_SOUND_IOS=alerta_admin.wav
   - ADMIN_VIBRATION_PATTERN=200,100,200,100,350

Variables opcionales en Render:
PUSH_ACCENT_COLOR=00D9FF
PUSH_SMALL_ICON=ic_stat_onesignal_default
PUSH_WEB_ICON=https://TU-URL/icon-192.png
PUSH_WEB_BADGE=https://TU-URL/badge-72.png
ADMIN_PUSH_SOUND=alerta_admin
ADMIN_PUSH_SOUND_IOS=alerta_admin.wav
ADMIN_VIBRATION_PATTERN=200,100,200,100,350
PUSH_TTL_SECONDS=86400

IMPORTANTE:
Para sonido personalizado REAL en Android, el sonido debe existir dentro de la app nativa.
En Web Push/Chrome, el navegador puede limitar sonidos personalizados; la vibración depende del sistema/dispositivo.

NO toca:
- Admin.jsx
- Dashboard
- Panel Operativo
- Ranking
- Horarios
- Configuración
- Diseño
