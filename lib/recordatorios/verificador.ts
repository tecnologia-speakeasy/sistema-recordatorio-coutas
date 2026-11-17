import "server-only";
import { apiGhlConfigurada } from "../config";
import { consultar } from "../db";
import { buscarContacto, buscarConversacion, ErrorGhl, mensajesWhatsapp, type MensajeGhl } from "../ghl";
import { mensajeDeError } from "../utilidades";
import { registrarEvento } from "./bitacora";
import { errorSinContacto, marcarSinContacto } from "./interacciones";
import { ETAPA_SEGUIMIENTO, type Envio } from "./tipos";

/** Si tras este tiempo el workflow no generó mensaje de WhatsApp, el envío se marca fallido. */
const MINUTOS_SIN_MENSAJE = 120;
const MAX_POR_EJECUCION = 150;
/**
 * enviado_en se guarda cuando responde el webhook (máximo 20 s de espera), así que el
 * mensaje del workflow no puede ser más antiguo que esto. Un mensaje anterior es de otro
 * intento (p. ej. uno manual desde GHL justo antes del reenvío) y no debe tomarse.
 */
const SEGUNDOS_ANTES_DEL_ENVIO = 30;

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
     -- Primero los que WhatsApp aún no confirma: ahí se detectan los fallos. Los
     -- 'entregado' solo pueden pasar a leído y no deben ocupar los cupos de una
     -- etapa nueva (si no, el D-1 quedaría detrás de los entregados del D-3).
     ORDER BY estado = 'entregado', enviado_en
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

interface Lectura {
  contacto: string | null;
  conversacion: string | null;
  mensaje: MensajeGhl | null;
}

/** Conversación y mensaje del envío dentro de un contacto (la conversación guardada, si la hay). */
async function leer(envio: Envio, contacto: string | null, conversacionGuardada: string | null): Promise<Lectura> {
  const conversacion = contacto ? (conversacionGuardada ?? (await buscarConversacion(contacto))) : null;
  const mensaje = contacto && conversacion ? await localizarMensaje(envio, contacto, conversacion) : null;
  return { contacto, conversacion, mensaje };
}

/** 4xx (no 429): el contacto o la conversación guardados ya no existen en GHL. */
const recursoInexistente = (error: unknown) =>
  error instanceof ErrorGhl && error.estadoHttp >= 400 && error.estadoHttp < 500 && error.estadoHttp !== 429;

async function verificarEnvio(envio: Envio): Promise<boolean> {
  // El workflow busca el contacto por correo (sin crearlo); aquí igual, sin modificarlo.
  const email = envio.email!.trim();
  let lectura: Lectura;
  try {
    lectura = await leer(envio, envio.ghl_contact_id ?? (await buscarContacto(email)), envio.ghl_conversation_id);
  } catch (error) {
    // Soporte unió o borró el contacto guardado en GHL: se vuelve a buscar por correo.
    if (!envio.ghl_contact_id || !recursoInexistente(error)) throw error;
    lectura = await leer(envio, await buscarContacto(email), null);
  }

  const minutos = (Date.now() - envio.enviado_en!.getTime()) / 60_000;
  // Antes de dar por fallido un envío sin mensaje, confirmar que el correo sigue en
  // ese contacto: si soporte unió o corrigió contactos en GHL, el mensaje quedó en el
  // contacto que hoy tiene el correo.
  if (!lectura.mensaje && lectura.contacto && envio.estado === "enviado" && minutos > MINUTOS_SIN_MENSAJE) {
    const actual = await buscarContacto(email);
    if (actual && actual !== lectura.contacto) lectura = await leer(envio, actual, null);
  }
  const { contacto, conversacion, mensaje } = lectura;

  if (!mensaje) {
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

  const desde = envio.enviado_en!.getTime() - SEGUNDOS_ANTES_DEL_ENVIO * 1000;
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
