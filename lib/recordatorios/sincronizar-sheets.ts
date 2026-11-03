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
    return sincronizadas;
  });

  return total ?? 0;
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
