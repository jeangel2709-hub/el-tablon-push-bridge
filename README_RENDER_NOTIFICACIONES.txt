# EL TABLÓN · Push Bridge Render 24/7

Este paquete mueve tus notificaciones a Render para que NO dependan de PowerShell ni de tu PC encendida.

## Qué toca

Solo notificaciones:

- Firebase Firestore listeners
- OneSignal
- Cola de alertas
- Procesamiento 24/7

## Qué NO toca

- Admin.jsx
- Dashboard visual
- Panel Operativo EN VIVO
- Ranking de Puntualidad
- Horario semanal inteligente
- Pestaña Horarios
- Configuración
- Marcaciones
- Diseño iPhone/SaaS

---

## Archivos incluidos

```txt
onesignal-push-bridge/
├─ server.js
├─ package.json
├─ render.yaml
├─ .env.example
└─ .gitignore
```

---

## Paso 1: subir a GitHub

1. Crea una carpeta nueva llamada:
   `onesignal-push-bridge`

2. Copia dentro todos los archivos de este paquete.

3. Sube esa carpeta a GitHub.

---

## Paso 2: crear servicio en Render

1. Entra a Render.
2. New +.
3. Web Service.
4. Conecta tu repositorio GitHub.
5. Selecciona la carpeta `onesignal-push-bridge`.
6. Usa:

```txt
Build Command:
npm install

Start Command:
npm start
```

---

## Paso 3: variables de entorno en Render

En Render > Environment, agrega:

```txt
ONE_SIGNAL_APP_ID
ONE_SIGNAL_REST_API_KEY
FIREBASE_PROJECT_ID
FIREBASE_CLIENT_EMAIL
FIREBASE_PRIVATE_KEY
```

Usa el archivo `.env.example` como guía.

IMPORTANTE:
`FIREBASE_PRIVATE_KEY` debe ir entre comillas y con `\n`.

Ejemplo:

```txt
"-----BEGIN PRIVATE KEY-----\nABC123...\n-----END PRIVATE KEY-----\n"
```

---

## Paso 4: probar

Cuando Render termine de desplegar, abre:

```txt
https://TU-SERVICIO.onrender.com/health
```

Debe responder:

```json
{
  "ok": true,
  "status": "online",
  "firebase": true,
  "oneSignal": true
}
```

---

## Paso 5: prueba manual de push

Puedes probar con Postman o Thunder Client:

```txt
POST https://TU-SERVICIO.onrender.com/test-push
```

Body JSON:

```json
{
  "title": "✅ Prueba EL TABLÓN",
  "body": "Notificaciones Render 24/7 funcionando."
}
```

---

## Resultado

Cuando Firestore registre alertas o marcaciones, Render procesará las notificaciones automáticamente.

Ya no necesitas:

- PowerShell abierto
- PM2 local
- PC encendida
- npm start local
