let iniciado = false;

db.collection("asistencia").onSnapshot(snapshot => {

  if (!iniciado) {
    iniciado = true;
    return;
  }

  snapshot.docChanges().forEach(async (change) => {
    if (change.type !== "added") return;

    const data = change.doc.data();

    if (data.estado === "tardanza") {
      await sendNotification(`⏰ Tardanza: ${data.trabajador}`);
    }

    if (data.estado === "falta") {
      await sendNotification(`❌ Falta: ${data.trabajador}`);
    }

    if (data.fueraRango) {
      await sendNotification(`📍 Fuera de rango: ${data.trabajador}`);
    }
  });

});
