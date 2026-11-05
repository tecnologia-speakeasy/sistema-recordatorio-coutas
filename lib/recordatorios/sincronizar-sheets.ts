import "server-only";
import { configGeneral, configSheets } from "../config";
import { conBloqueo, consultar } from "../db";
import { enviarFilas, type FilaSheets } from "../sheets";
import { ETIQUETAS_ESTADO, RESPUESTAS, type Etapa, type EstadoEnvio, type Respuesta } from "./tipos";

interface CuotaSync {
  cuota_id: string;
  fecha_vencimiento: string;
  version: string; // max(actualizado_en) como texto, con microsegundos
  cuota_numero: number;
  total_cuotas: number;
  producto: string | null;
  nombre: string | null;
  email: string | null;
  telefono: string | null;
  pais: string | null;
  metodo_pago: string | null;
  descuento: string | null;
  estados: Record<string, EstadoEnvio>;
  clicks: number;
  primer_click: string | null;
  respuesta: Respuesta | null;
  realizar_pago: string | null;
  soporte: string | null;
  pago_reportado: string | null;
  actualizado: string;
}

/**
 * Refleja en Google Sheets (vía n8n) una fila por cuota de estudiante, en
 * pestañas "Cuota 2", "Cuota 3"... con el estado de cada recordatorio, los clics
 * y las respuestas. n8n hace "Append or Update" por la columna ID, así que
 * reenviar una fila la actualiza en su sitio. Solo envía lo que cambió desde la
 * última sincronización; si n8n falla, esas filas se reintentan en la siguiente.
 * Después actualiza la pestaña "Pagos por verificar" (ver sincronizarVerificacion).
 */
export async function sincronizarSheets(): Promise<number> {
  if (!configSheets()) return 0;
  const { APP_TIMEZONE } = configGeneral();

  const total = await conBloqueo("sheets", 300, async () => {
    const etapas = await consultar<Etapa>("SELECT * FROM recordatorios.etapas ORDER BY orden");
    let sincronizadas = 0;

    for (let vuelta = 0; vuelta < 20; vuelta++) {
      const cuotas = await pendientes(APP_TIMEZONE);
      if (!cuotas.length) break;

      const porPestana = new Map<string, CuotaSync[]>();
      for (const c of cuotas) {
        const pestana = `Cuota ${c.cuota_numero}`;
        porPestana.set(pestana, [...(porPestana.get(pestana) ?? []), c]);
      }
      for (const [pestana, delaPestana] of porPestana) {
        await enviarFilas(pestana, delaPestana.map((c) => fila(c, etapas)));

        // Se marca con la versión leída: si la cuota cambió mientras tanto, vuelve a salir.
        await consultar(
          `INSERT INTO recordatorios.sheets_filas (cuota_id, fecha_vencimiento, pestana, version)
           SELECT v.cuota_id, v.fecha_vencimiento, $3, v.version
           FROM unnest($1::text[], $2::date[], $4::timestamptz[]) AS v (cuota_id, fecha_vencimiento, version)
           ON CONFLICT (cuota_id, fecha_vencimiento)
             DO UPDATE SET pestana = EXCLUDED.pestana, version = EXCLUDED.version`,
          [
            delaPestana.map((c) => c.cuota_id),
            delaPestana.map((c) => c.fecha_vencimiento),
            pestana,
            delaPestana.map((c) => c.version),
          ],
        );
        sincronizadas += delaPestana.length;
      }
    }
    return sincronizadas + (await sincronizarVerificacion(APP_TIMEZONE));
  });

  return total ?? 0;
}

// ---------------------------------------------------------------------------
// Pestaña "Pagos por verificar"
// ---------------------------------------------------------------------------

/** Pestaña para soporte: quien dijo "Pago realizado", y si cartera ya lo muestra. */
export const PESTANA_VERIFICACION = "Pagos por verificar";

interface Verificacion {
  cuota_id: string;
  fecha_vencimiento: string;
  huella: string;
  estado: string;
  nombre: string | null;
  email: string | null;
  telefono: string | null;
  producto: string | null;
  cuota: string;
  metodo_pago: string | null;
  reportado: string;
  pago_cartera: string | null;
  actualizado: string;
}

/**
 * Una fila por cuota en la que el estudiante respondió "Pago realizado". Se
 * reenvía cuando cambia algo de lo que muestra: sobre todo, cuando el pago
 * aparece en cartera ("Por verificar" -> "Confirmado en cartera"). Las columnas
 * "Atendido por" y "Notas" son de soporte: el sistema no las envía.
 */
async function sincronizarVerificacion(zona: string): Promise<number> {
  let sincronizadas = 0;
  for (let vuelta = 0; vuelta < 20; vuelta++) {
    const filas = await verificacionesPendientes(zona);
    if (!filas.length) break;

    await enviarFilas(
      PESTANA_VERIFICACION,
      filas.map((v) => ({
        Estado: v.estado,
        Nombre: v.nombre,
        Correo: v.email,
        Teléfono: v.telefono,
        Producto: v.producto,
        Cuota: v.cuota,
        "Fecha límite": v.fecha_vencimiento,
        "Método de pago": v.metodo_pago,
        "Fecha del reporte": v.reportado,
        "Pago en cartera": v.pago_cartera ?? "",
        Actualizado: v.actualizado,
        ID: `${v.cuota_id}|${v.fecha_vencimiento}`,
      })),
    );
    await consultar(
      `INSERT INTO recordatorios.sheets_verificacion (cuota_id, fecha_vencimiento, huella)
       SELECT * FROM unnest($1::text[], $2::date[], $3::text[])
       ON CONFLICT (cuota_id, fecha_vencimiento)
         DO UPDATE SET huella = EXCLUDED.huella, enviado_en = now()`,
      [filas.map((v) => v.cuota_id), filas.map((v) => v.fecha_vencimiento), filas.map((v) => v.huella)],
    );
    sincronizadas += filas.length;
  }
  return sincronizadas;
}

/** Cuotas reportadas como pagadas cuya fila cambió desde el último envío a la pestaña. */
function verificacionesPendientes(zona: string) {
  return consultar<Verificacion>(
    `WITH r AS (
       SELECT e.cuota_id, e.fecha_vencimiento,
              min(e.pago_reportado_en) AS reportado,
              (array_agg(e.compra_id ORDER BY e.id DESC))[1] AS compra_id,
              (array_agg(e.cuota_numero ORDER BY e.id DESC))[1] AS cuota_numero,
              (array_agg(e.total_cuotas ORDER BY e.id DESC))[1] AS total_cuotas,
              (array_agg(e.nombre ORDER BY e.id DESC))[1] AS nombre,
              (array_agg(e.email ORDER BY e.id DESC))[1] AS email,
              (array_agg(COALESCE(e.telefono_e164, e.telefono) ORDER BY e.telefono_e164 IS NULL, e.id DESC))[1] AS telefono,
              (array_agg(e.producto ORDER BY e.id DESC))[1] AS producto,
              (array_agg(e.metodo_pago ORDER BY e.id DESC))[1] AS metodo_pago
       FROM recordatorios.envios e
       WHERE (e.cuota_id, e.fecha_vencimiento) IN (
         SELECT cuota_id, fecha_vencimiento FROM recordatorios.envios WHERE pago_reportado_en IS NOT NULL
       )
       GROUP BY e.cuota_id, e.fecha_vencimiento
     ), v AS (
       SELECT r.*,
              CASE WHEN f.pagada THEN 'Confirmado en cartera'
                   WHEN f.pagada IS NULL THEN 'Compra no activa en cartera'
                   ELSE 'Por verificar' END AS estado,
              CASE WHEN f.pagada THEN
                (SELECT to_char(max(x.fecha_pago), 'YYYY-MM-DD') FROM public.cartera_compras_pagos x
                 WHERE x.compra_id = r.compra_id)
              END AS pago_cartera
       FROM r
       LEFT JOIN recordatorios.v_cuotas_fuente f
         ON f.compra_id = r.compra_id AND f.cuota_numero = r.cuota_numero AND f.fecha_vencimiento = r.fecha_vencimiento
     ), h AS (
       SELECT v.*, md5(concat_ws('|', v.estado, v.pago_cartera, v.reportado, v.nombre, v.email, v.telefono,
                                 v.producto, v.metodo_pago, v.cuota_numero, v.total_cuotas)) AS huella
       FROM v
     )
     SELECT h.cuota_id, h.fecha_vencimiento::text AS fecha_vencimiento, h.huella, h.estado,
            h.nombre, h.email, h.telefono, h.producto, h.cuota_numero || ' de ' || h.total_cuotas AS cuota,
            h.metodo_pago, to_char(h.reportado AT TIME ZONE $1, 'YYYY-MM-DD HH24:MI') AS reportado, h.pago_cartera,
            to_char(now() AT TIME ZONE $1, 'YYYY-MM-DD HH24:MI') AS actualizado
     FROM h
     LEFT JOIN recordatorios.sheets_verificacion s USING (cuota_id, fecha_vencimiento)
     WHERE s.huella IS DISTINCT FROM h.huella
     ORDER BY h.reportado
     LIMIT 100`,
    [zona],
  );
}

/** Cuotas cuyos envíos cambiaron desde la última sincronización, con sus datos agregados. */
function pendientes(zona: string) {
  return consultar<CuotaSync>(
    `WITH g AS (
       SELECT cuota_id, fecha_vencimiento, max(actualizado_en) AS version
       FROM recordatorios.envios
       GROUP BY cuota_id, fecha_vencimiento
     ), pend AS (
       SELECT g.cuota_id, g.fecha_vencimiento, g.version
       FROM g LEFT JOIN recordatorios.sheets_filas s USING (cuota_id, fecha_vencimiento)
       WHERE s.version IS NULL OR g.version > s.version
       ORDER BY g.fecha_vencimiento, g.cuota_id
       LIMIT 100
     )
     SELECT p.cuota_id, p.fecha_vencimiento::text AS fecha_vencimiento, p.version::text AS version,
            u.cuota_numero, u.total_cuotas, u.producto, u.nombre, u.email,
            COALESCE(a.telefono_e164, u.telefono) AS telefono, u.pais, u.metodo_pago, u.descuento,
            a.estados, a.clicks, a.respuesta,
            to_char(a.primer_click AT TIME ZONE $1, 'YYYY-MM-DD HH24:MI') AS primer_click,
            to_char(a.realizar_pago AT TIME ZONE $1, 'YYYY-MM-DD HH24:MI') AS realizar_pago,
            to_char(a.soporte AT TIME ZONE $1, 'YYYY-MM-DD HH24:MI') AS soporte,
            to_char(a.pago_reportado AT TIME ZONE $1, 'YYYY-MM-DD HH24:MI') AS pago_reportado,
            to_char(p.version AT TIME ZONE $1, 'YYYY-MM-DD HH24:MI') AS actualizado
     FROM pend p
     CROSS JOIN LATERAL (
       SELECT * FROM recordatorios.envios e
       WHERE e.cuota_id = p.cuota_id AND e.fecha_vencimiento = p.fecha_vencimiento
       ORDER BY e.id DESC
       LIMIT 1
     ) u
     CROSS JOIN LATERAL (
       SELECT jsonb_object_agg(e.etapa, e.estado) AS estados,
              sum(e.clicks)::int AS clicks,
              min(e.primer_click_en) AS primer_click,
              min(e.realizar_pago_en) AS realizar_pago,
              max(e.soporte_en) AS soporte,
              (array_agg(e.respuesta ORDER BY e.respondido_en DESC NULLS LAST))[1] AS respuesta,
              min(e.pago_reportado_en) AS pago_reportado,
              (array_agg(e.telefono_e164 ORDER BY e.id DESC) FILTER (WHERE e.telefono_e164 IS NOT NULL))[1] AS telefono_e164
       FROM recordatorios.envios e
       WHERE e.cuota_id = p.cuota_id AND e.fecha_vencimiento = p.fecha_vencimiento
     ) a
     ORDER BY p.fecha_vencimiento, p.cuota_id`,
    [zona],
  );
}

/**
 * Una fila con los nombres de columna de la hoja (fila 1 de cada pestaña; ver
 * integraciones/encabezados-sheets.tsv). n8n la ubica por "ID".
 */
function fila(c: CuotaSync, etapas: Etapa[]): FilaSheets {
  return {
    Producto: c.producto,
    Cuota: `${c.cuota_numero} de ${c.total_cuotas}`,
    "Fecha límite": c.fecha_vencimiento,
    Nombre: c.nombre,
    Correo: c.email,
    Teléfono: c.telefono,
    País: c.pais,
    "Método de pago": c.metodo_pago,
    Descuento: c.descuento,
    ...Object.fromEntries(etapas.map((e) => [e.nombre, c.estados[e.codigo] ? ETIQUETAS_ESTADO[c.estados[e.codigo]] : ""])),
    "Tocó Realizar pago": c.realizar_pago,
    "Clics en el link": c.clicks,
    "Primer clic": c.primer_click,
    "Pidió soporte": c.soporte,
    "Última respuesta": c.respuesta ? (RESPUESTAS[c.respuesta] ?? c.respuesta) : "",
    "Reportó pago": c.pago_reportado ? "Sí" : "",
    "Fecha del reporte": c.pago_reportado,
    Actualizado: c.actualizado,
    ID: `${c.cuota_id}|${c.fecha_vencimiento}`,
  };
}
