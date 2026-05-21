EL TABLON - FIX 403 ONESIGNAL

Reemplaza dentro de onesignal-push-bridge:
- index.js
- package.json
- INICIAR_PUSH_AUTOMATICO.bat

Tu .env debe quedar así:
ONESIGNAL_APP_ID=512ffec0-8d6b-410c-b877-b18ab4cbb10b
ONESIGNAL_REST_API_KEY=TU_KEY_LARGA_QUE_EMPIEZA_CON_os_v2_app
FIREBASE_SERVICE_ACCOUNT=./serviceAccountKey.json
CHECK_INTERVAL_SECONDS=20

Luego ejecuta:
npm install
npm start

El cambio principal es usar:
Authorization: Key TU_API_KEY
y el endpoint nuevo:
https://api.onesignal.com/notifications
