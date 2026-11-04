import "server-only";
import { apiGhlConfigurada } from "../config";
import { consultar } from "../db";
import { buscarContacto, buscarConversacion, mensajesWhatsapp, type MensajeGhl } from "../ghl";
import { mensajeDeError } from "../utilidades";
import { registrarEvento } from "./bitacora";
import { errorSinContacto, marcarSinContacto } from "./interacciones";
import { ETAPA_SEGUIMIENTO, type Envio } from "./tipos";

/** Si tras este tiempo el workflow no generó mensaje de WhatsApp, el envío se marca fallido. */
const MINUTOS_SIN_MENSAJE = 120;
const MAX_POR_EJECUCION = 150;

/**
 * Lee en GHL el estado real del mensaje de WhatsApp de los envíos recientes
 * ('enviado' o 'entregado', últimas 72 h) y actualiza entregado/leído/fallido.
 * Devuelve cuántos envíos cambiaron de estado. Sin GHL_TOKEN no hace nada.
 */
export async function verificarEntregas(): Promise<number> {
  if (!apiGhlConfigurada()) return 0;
  const envios = await consultar<Envio>(
    `SELECT * FROM recordatorios.envios
     WHERE estado IN ('enviado', 'entregado')
       AND NOT simulado AND NULLIF(btrim(email), '') IS NOT NULL
       AND enviado_en BETWEEN now() - interval '72 hours' AND now() - interval '1 minute'
     ORDER BY enviado_en
     LIMIT $1`,
    [MAX_POR_EJECUCION],
  );

  let cambios = 0;
  for (const envio of envios) {
    try {
      if (await verificarEnvio(envio)) cambios++;
    } catch (error) {
      // Un fallo de lectura no cambia el estado; se reintenta en la próxima ejecución.
      console.error(`[verificador] envío ${envio.id}:`, mensajeDeError(error));
    }
  }
  return cambios;
}

async function verificarEnvio(envio: Envio): Promise<boolean> {
  // El workflow busca el contacto por correo (sin crearlo); aquí igual, sin modificarlo.
  const contacto = envio.ghl_contact_id ?? (await buscarContacto(envio.email!.trim()));
  const conversacion = contacto ? (envio.ghl_conversation_id ?? (await buscarConversacion(contacto))) : null;
  const mensaje = contacto && conversacion ? await localizarMensaje(envio, contacto, conversacion) : null;

  if (!mensaje) {
    const minutos = (Date.now() - envio.enviado_en!.getTime()) / 60_000;
    if (envio.estado === "enviado" && minutos > MINUTOS_SIN_MENSAJE) {
      if (!contacto) {
        await marcarSinContacto(envio.id, errorSinContacto(envio.email), {
          origen: "verificacion",
          email: envio.email,
          minutos: Math.round(minutos),
        });
        return true;
      }
      const error =
        envio.etapa === ETAPA_SEGUIMIENTO
          ? "GHL no envió el seguimiento. Lo más probable es que la ventana de 24 h ya estuviera cerrada " +
            "(el estudiante no había respondido en el último día)."
          : "GHL no registró un mensaje de WhatsApp para este envío. Revisa el workflow " +
            "(re-entrada permitida, plantilla aprobada, acción de WhatsApp activa) y que el contacto " +
            "tenga un teléfono con WhatsApp.";
      await actualizar(envio.id, "fallido", { contacto, conversacion, mensajeId: null, error });
      await registrarEvento(envio.id, "estado_ghl", { estado: "sin_mensaje", contacto, minutos: Math.round(minutos) });
      return true;
    }
    if (contacto !== envio.ghl_contact_id || conversacion !== envio.ghl_conversation_id) {
      await actualizar(envio.id, envio.estado, { contacto, conversacion, mensajeId: null, error: null });
    }
    return false;
  }

  const nuevoEstado = mapearEstado(mensaje.status);
  const cambia = nuevoEstado !== null && nuevoEstado !== envio.estado;
  if (!cambia && mensaje.id === envio.ghl_message_id) return false;

  const estadoFinal = nuevoEstado ?? envio.estado;
  const error = estadoFinal === "fallido" ? mensaje.error || `WhatsApp reportó el estado "${mensaje.status}"` : null;
  await actualizar(envio.id, estadoFinal, { contacto, conversacion, mensajeId: mensaje.id, error });
  if (cambia) await registrarEvento(envio.id, "estado_ghl", { estado: mensaje.status, mensajeId: mensaje.id, error });
  return cambia;
}

/**
 * Mensaje de WhatsApp saliente creado por el workflow: el primero posterior al
 * envío que no esté ya asignado a otro envío del mismo contacto.
 */
async function localizarMensaje(envio: Envio, contacto: string, conversacion: string): Promise<MensajeGhl | null> {
  const mensajes = await mensajesWhatsapp(conversacion);
  if (envio.ghl_message_id) {
    const propio = mensajes.find((m) => m.id === envio.ghl_message_id);
    if (propio) return propio;
  }

  const asignados = new Set(
    (
      await consultar<{ ghl_message_id: string }>(
        `SELECT ghl_message_id FROM recordatorios.envios
         WHERE ghl_contact_id = $1 AND id <> $2 AND ghl_message_id IS NOT NULL`,
        [contacto, envio.id],
      )
    ).map((f) => f.ghl_message_id),
  );

  const desde = envio.enviado_en!.getTime() - 60_000;
  return (
    mensajes
      .filter((m) => m.direction === "outbound" && !asignados.has(m.id) && Date.parse(m.dateAdded) >= desde)
      .sort((a, b) => Date.parse(a.dateAdded) - Date.parse(b.dateAdded))[0] ?? null
  );
}

function mapearEstado(status: string | undefined): Envio["estado"] | null {
  switch (status) {
    case "delivered":
      return "entregado";
    case "read":
    case "opened":
    case "clicked":
      return "leido";
    case "failed":
    case "undelivered":
      return "fallido";
    default:
      return null; // pending, scheduled, sent...: sin cambio
  }
}

async function actualizar(
  id: string,
  estado: Envio["estado"],
  {
    contacto,
    conversacion,
    mensajeId,
    error,
  }: { contacto: string | null; conversacion: string | null; mensajeId: string | null; error: string | null },
) {
  await consultar(
    `UPDATE recordatorios.envios
     SET estado = $2::recordatorios.estado_envio,
         ghl_contact_id = COALESCE($6, ghl_contact_id),
         ghl_conversation_id = COALESCE($3, ghl_conversation_id),
         ghl_message_id = COALESCE($4, ghl_message_id),
         ultimo_error = CASE WHEN $2::recordatorios.estado_envio = 'fallido' THEN $5 ELSE ultimo_error END,
         entregado_en = CASE WHEN $2::recordatorios.estado_envio IN ('entregado', 'leido')
                             THEN COALESCE(entregado_en, now()) ELSE entregado_en END,
         leido_en = CASE WHEN $2::recordatorios.estado_envio = 'leido' THEN COALESCE(leido_en, now()) ELSE leido_en END
     WHERE id = $1`,
    [id, estado, conversacion, mensajeId, error, contacto],
  );
}
