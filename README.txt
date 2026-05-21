EL TABLÓN - OPTIMIZAR FIRESTORE PRO

QUÉ CAMBIA:
- Elimina lectura repetitiva cada 30 segundos.
- Usa onSnapshot en tiempo real.
- Reduce consumo de Firestore.
- Evita push duplicados con colección push_logs.
- Mantiene dashboard, diseño y Firebase intactos.

PASOS:

1) Detener proceso anterior:
CTRL + C
Luego escribir:
Y

2) Copiar esta carpeta:
onesignal-push-bridge

dentro de:
C:\Users\callCenter\Desktop\el-tablon-dashboard\

3) Crear archivo .env:
Copia .env.example y renómbralo a:
.env

Completa:
ONESIGNAL_APP_ID=
ONESIGNAL_REST_API_KEY=

4) Colocar serviceAccountKey.json dentro de:
C:\Users\callCenter\Desktop\el-tablon-dashboard\onesignal-push-bridge\

5) Ejecutar:
cd C:\Users\callCenter\Desktop\el-tablon-dashboard\onesignal-push-bridge
npm install
npm start

IMPORTANTE:
Si Firestore ya muestra RESOURCE_EXHAUSTED, debes esperar recuperación de cuota.
Este ZIP evita que vuelva a consumir cuota excesiva, pero no puede desbloquear una cuota diaria ya agotada.
