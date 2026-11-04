import "server-only";
import { configGeneral } from "../config";
import { consultar, consultarUno } from "../db";
import { mensajeDeError } from "../utilidades";
import { registrarEvento } from "./bitacora";
import { ETAPA_SEGUIMIENTO, PREFIJO_SIN_CONTACTO, type Respuesta } from "./tipos";

/**
 * Clic en el link rastreado (https://<app>/p/<token>). Devuelve el link de pago
 * vigente según cartera (pasarela, plan y referido de hoy) o, si la cuota ya no
 * está en la vista, el que se usó al enviar.
 * Las vistas previas de enlaces no cuentan como clic ni programan seguimiento.
 */
export async function registrarClic(token: string, agente: string, esPrevisualizacion: boolean): Promise<string | null> {
  const destino = `COALESCE(
       (SELECT f.link_pago FROM recordatorios.v_cuotas_fuente f
        WHERE f.compra_id = e.compra_id AND f.cuota_numero = e.cuota_numero
          AND f.fecha_vencimiento = e.fecha_vencimiento),
       e.link_pago) AS destino
     FROM e`;

  const envio = await consultarUno<{ id: string; destino: string | null }>(
    esPrevisualizacion
      ? `WITH e AS (SELECT * FROM recordatorios.envios WHERE token = $1) SELECT e.id, ${destino}`
      : `WITH e AS (
           UPDATE recordatorios.envios
           SET clicks = clicks + 1, primer_click_en = COALESCE(primer_click_en, now())
           WHERE token = $1
           RETURNING *
         )
         SELECT e.id, ${destino}`,
    [token],
  );
  if (!envio) return null;

  if (!esPrevisualizacion) {
    await registrarEvento(envio.id, "click", { agente: agente.slice(0, 200) });
    try {
      await programarSeguimiento(envio.id);
    } catch (error) {
      // El clic no debe fallar por esto: el estudiante igual llega a su link de pago.
      console.error(`[seguimiento] envío ${envio.id}:`, mensajeDeError(error));
    }
  }
  return envio.destino;
}

/**
 * Crea, una sola vez por cuota, el envío de seguimiento que sale SEGUIMIENTO_HORAS
 * después del primer clic en el link de pago. No se crea si la etapa SEG está
 * inactiva o si el estudiante ya reportó el pago.
 *
 * El seguimiento es un mensaje normal: solo sale con la ventana de 24 h abierta.
 * Si se conoce la última respuesta del estudiante (webhook "Realizar pago"...) y
 * la ventana cerraría antes, se adelanta para que salga una hora antes del cierre.
 */
export async function programarSeguimiento(envioOrigenId: string): Promise<string | null> {
  const { APP_TIMEZONE, SEGUIMIENTO_HORAS } = configGeneral();
  const fila = await consultarUno<{ id: string; programado_para: Date }>(
    `WITH o AS (
       SELECT * FROM recordatorios.envios WHERE id = $1 AND etapa <> $4
     ), t AS (
       SELECT GREATEST(now(), LEAST(
                now() + $2::float8 * interval '1 hour',
                COALESCE((SELECT max(r.respondido_en) FROM recordatorios.envios r, o
                          WHERE r.cuota_id = o.cuota_id AND r.fecha_vencimiento = o.fecha_vencimiento)
                         + interval '23 hours', 'infinity'))) AS hora
     )
     INSERT INTO recordatorios.envios
       (cuota_id, compra_id, producto_id, cuota_numero, total_cuotas, etapa, fecha_vencimiento,
        fecha_programada, programado_para, origen_envio_id,
        nombre, telefono, email, pais, producto, metodo_pago, pasarela, referido, descuento, concepto, link_pago)
     SELECT o.cuota_id, o.compra_id, o.producto_id, o.cuota_numero, o.total_cuotas, s.codigo, o.fecha_vencimiento,
            (t.hora AT TIME ZONE $3)::date, t.hora, o.id,
            o.nombre, o.telefono, o.email, o.pais, o.producto, o.metodo_pago, o.pasarela, o.referido, o.descuento,
            o.concepto, o.link_pago
     FROM o CROSS JOIN t
     JOIN recordatorios.etapas s ON s.codigo = $4 AND s.activa
     WHERE NOT EXISTS (
       SELECT 1 FROM recordatorios.envios r
       WHERE r.cuota_id = o.cuota_id AND r.fecha_vencimiento = o.fecha_vencimiento
         AND r.pago_reportado_en IS NOT NULL
     )
     ON CONFLICT (cuota_id, fecha_vencimiento, etapa) DO NOTHING
     RETURNING id, programado_para`,
    [envioOrigenId, SEGUIMIENTO_HORAS, APP_TIMEZONE, ETAPA_SEGUIMIENTO],
  );
  if (!fila) return null;

  await registrarEvento(fila.id, "programado", { origen: envioOrigenId, programadoPara: fila.programado_para });
  await registrarEvento(envioOrigenId, "seguimiento_programado", { seguimiento: fila.id });
  return fila.id;
}

/**
 * Botón respondido en WhatsApp ("Realizar pago", "Soporte", "Pago realizado"),
 * informado por la acción Webhook del workflow. Una respuesta implica que el
 * mensaje se leyó, y abre (o renueva) la ventana de 24 h de WhatsApp.
 */
export async function registrarRespuesta(token: string, respuesta: Respuesta): Promise<string | null> {
  const fila = await consultarUno<{ id: string }>(
    `UPDATE recordatorios.envios
     SET respuesta = $2, respondido_en = now(),
         realizar_pago_en = CASE WHEN $2 = 'realizar_pago' THEN COALESCE(realizar_pago_en, now())
                                 ELSE realizar_pago_en END,
         soporte_en = CASE WHEN $2 = 'soporte' THEN now() ELSE soporte_en END,
         pago_reportado_en = CASE WHEN $2 = 'pago_realizado' THEN COALESCE(pago_reportado_en, now())
                                  ELSE pago_reportado_en END,
         leido_en = CASE WHEN estado IN ('enviado', 'entregado', 'leido') THEN COALESCE(leido_en, now())
                         ELSE leido_en END,
         estado = CASE WHEN estado IN ('enviado', 'entregado') THEN 'leido'::recordatorios.estado_envio
                       ELSE estado END
     WHERE token = $1
     RETURNING id`,
    [token, respuesta],
  );
  if (fila) await registrarEvento(fila.id, "respuesta", { respuesta });
  return fila?.id ?? null;
}

/** `ultimo_error` cuando GHL no tiene un contacto con el correo del estudiante. */
export const errorSinContacto = (email: string | null) =>
  `${PREFIJO_SIN_CONTACTO}: no hay un contacto con el correo ${email || "(vacío)"}. ` +
  "Créalo en GHL o corrige el correo en cartera, y reenvía.";

/** El WhatsApp no salió por falta de contacto en GHL: el envío queda fallido, en su propia alerta. */
export async function marcarSinContacto(envioId: string, mensaje: string, detalle: Record<string, unknown>) {
  await consultar(
    `UPDATE recordatorios.envios
     SET estado = 'fallido', procesando_desde = NULL, ultimo_error = $2
     WHERE id = $1`,
    [envioId, mensaje.slice(0, 1000)],
  );
  await registrarEvento(envioId, "sin_contacto", detalle);
}

/**
 * "Find Contact" no encontró el correo del estudiante en GHL, así que el workflow
 * terminó sin enviar el WhatsApp (acción Webhook de la rama "no encontrado").
 * Un envío aún 'pendiente' no se toca: el aviso sería de un intento anterior.
 */
export async function registrarSinContacto(token: string): Promise<string | null> {
  const envio = await consultarUno<{ id: string; email: string | null }>(
    "SELECT id, email FROM recordatorios.envios WHERE token = $1 AND estado <> 'pendiente'",
    [token],
  );
  if (!envio) return null;
  await marcarSinContacto(envio.id, errorSinContacto(envio.email), { origen: "workflow", email: envio.email });
  return envio.id;
}

/** ¿El estudiante ya dijo "Pago realizado" para esta cuota? */
export async function pagoReportado(cuotaId: string, fechaVencimiento: string): Promise<boolean> {
  const filas = await consultar(
    `SELECT 1 FROM recordatorios.envios
     WHERE cuota_id = $1 AND fecha_vencimiento = $2::date AND pago_reportado_en IS NOT NULL
     LIMIT 1`,
    [cuotaId, fechaVencimiento],
  );
  return filas.length > 0;
}

/**
 * ¿Se sabe que la ventana de 24 h ya se cerró? Solo si conocemos alguna respuesta
 * del estudiante para esta cuota; sin datos se asume abierta (y el workflow la
 * vuelve a comprobar con "Customer Service Window Check").
 */
export async function ventanaCerrada(cuotaId: string, fechaVencimiento: string): Promise<boolean> {
  const fila = await consultarUno<{ cerrada: boolean | null }>(
    `SELECT max(respondido_en) + interval '24 hours' < now() AS cerrada
     FROM recordatorios.envios
     WHERE cuota_id = $1 AND fecha_vencimiento = $2::date`,
    [cuotaId, fechaVencimiento],
  );
  return fila?.cerrada === true;
}

/** Ajustes generales editables desde el dashboard. */
export async function leerAjustes(): Promise<{ link_soporte: string | null }> {
  const filas = await consultar<{ clave: string; valor: string | null }>("SELECT clave, valor FROM recordatorios.ajustes");
  const mapa = new Map(filas.map((f) => [f.clave, f.valor]));
  return { link_soporte: mapa.get("link_soporte") || null };
}
