
export const handleShiftRequest = async (data, sendPush) => {
  if (data.estado === "pendiente") {
    sendPush("🔁 Solicitud de cambio", `${data.fromUser} solicita cambio con ${data.toUser}`);
  }

  if (data.estado === "aprobado") {
    sendPush("✅ Cambio aprobado", "Tu turno fue actualizado");
  }

  if (data.estado === "rechazado") {
    sendPush("❌ Cambio rechazado", "Consulta con tu administrador");
  }
};
