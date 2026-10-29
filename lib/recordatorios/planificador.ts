import "server-only";
import { consultar } from "../db";

/**
 * Crea los envíos que corresponden a `fecha` para cada etapa activa:
 * cuota no pagada cuyo vencimiento = fecha - offset de la etapa.
 * Idempotente gracias a UNIQUE (cuota_id, fecha_vencimiento, etapa).
 */
export async function planificar(fecha: string): Promise<number> {
  const filas = await consultar<{ id: string }>(
    `INSERT INTO recordatorios.envios
       (cuota_id, etapa, fecha_vencimiento, fecha_programada,
        cliente_id, nombre, telefono, email, valor, concepto, link_pago)
     SELECT f.cuota_id, e.codigo, f.fecha_vencimiento, $1::date,
            f.cliente_id, f.nombre, f.telefono, f.email, f.valor, f.concepto, f.link_pago
     FROM recordatorios.etapas e
     JOIN recordatorios.v_cuotas_fuente f
       ON f.fecha_vencimiento = $1::date - e.offset_dias
     WHERE e.activa AND NOT f.pagada
     ON CONFLICT (cuota_id, fecha_vencimiento, etapa) DO NOTHING
     RETURNING id`,
    [fecha],
  );
  return filas.length;
}

/**
 * Higiene previa al despacho:
 *  - Envíos colgados en 'procesando' (proceso muerto a mitad de un envío) pasan a
 *    'fallido' en vez de reintentarse solos: pudieron llegar a GHL y un reintento
 *    automático duplicaría el mensaje. Se revisan y reenvían desde el dashboard.
 *  - Pendientes de días anteriores se omiten: un "faltan 3 días" no se envía tarde.
 */
export async function prepararDia(fecha: string): Promise<number> {
  await consultar(
    `WITH colgados AS (
       UPDATE recordatorios.envios
       SET estado = 'fallido', procesando_desde = NULL,
           ultimo_error = 'Envío interrumpido. Verifica en GHL si salió antes de reenviar.'
       WHERE estado = 'procesando' AND procesando_desde < now() - interval '15 minutes'
       RETURNING id
     )
     INSERT INTO recordatorios.eventos (envio_id, tipo, detalle)
     SELECT id, 'recuperado', '{"motivo":"procesando > 15 min"}'::jsonb FROM colgados`,
  );

  const expirados = await consultar<{ id: string }>(
    `UPDATE recordatorios.envios
     SET estado = 'omitido', ultimo_error = 'No se despachó en su fecha programada'
     WHERE estado = 'pendiente' AND fecha_programada < $1::date
     RETURNING id`,
    [fecha],
  );
  return expirados.length;
}
