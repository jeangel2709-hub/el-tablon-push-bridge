EL TABLÓN - PUSH AUTOMÁTICO ONESIGNAL

1. Copia .env.example como .env.
2. En .env usa estos nombres exactos:
   ONESIGNAL_APP_ID=...
   ONESIGNAL_REST_API_KEY=os_v2_app_...
3. Guarda serviceAccountKey.json en esta misma carpeta.
4. Ejecuta INICIAR_PUSH_AUTOMATICO.bat.

La consola debe mostrar:
🚀 Push automático OneSignal activo
📡 Escuchando colección: asistencia

Detecta en asistencia:
- fueraDeRango / requiresApproval / aprobacionPendiente / estado fuera de rango
- tardanza / tardanzaMin / compensaHora
- falta / sinMarcacion / ausencia
