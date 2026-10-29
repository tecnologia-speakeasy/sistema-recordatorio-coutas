import "server-only";
import { configGeneral, configSheets } from "../config";
import { conBloqueo, consultar } from "../db";
import { actualizarFilas, anexarFilas, asegurarEncabezados, type Celda } from "../sheets";

const ENCABEZADOS = [
  "ID envío", "Fecha programada", "Etapa", "Cuota", "Cliente", "Nombre", "Teléfono",
  "Valor", "Vencimiento", "Estado", "Intentos", "Detalle", "Enviado", "Entregado",
  "Leído", "Clicks", "Actualizado",
];

interface FilaSync {
  id: string;
  sheets_fila: number | null;
  version: string; // actualizado_en como texto, con microsegundos
  valores: Celda[];
}

/**
 * Refleja en Google Sheets una fila por envío (alta con append, cambios con
 * batchUpdate sobre la fila guardada en sheets_fila). Procesa solo lo que cambió
 * desde la última sincronización. No ordenes ni borres filas de esa pestaña:
 * usa vistas de filtro u otra pestaña con QUERY().
 */
export async function sincronizarSheets(): Promise<number> {
  const config = configSheets();
  if (!config) return 0;
  const { APP_TIMEZONE } = configGeneral();
  const pestana = config.GOOGLE_SHEETS_PESTANA;

  const total = await conBloqueo("sheets", 300, async () => {
    await asegurarEncabezados(pestana, ENCABEZADOS);
    let sincronizados = 0;

    for (let vuelta = 0; vuelta < 10; vuelta++) {
      const filas = await consultar<FilaSync>(
        `SELECT e.id, e.sheets_fila, e.actualizado_en::text AS version,
                jsonb_build_array(
                  e.id, e.fecha_programada, e.etapa, e.cuota_id, e.cliente_id, e.nombre,
                  COALESCE(e.telefono_e164, e.telefono), e.valor, e.fecha_vencimiento, e.estado,
                  e.intentos, e.ultimo_error,
                  to_char(e.enviado_en   AT TIME ZONE $1, 'YYYY-MM-DD HH24:MI'),
                  to_char(e.entregado_en AT TIME ZONE $1, 'YYYY-MM-DD HH24:MI'),
                  to_char(e.leido_en     AT TIME ZONE $1, 'YYYY-MM-DD HH24:MI'),
                  e.clicks,
                  to_char(e.actualizado_en AT TIME ZONE $1, 'YYYY-MM-DD HH24:MI')
                ) AS valores
         FROM recordatorios.envios e
         WHERE e.sheets_sincronizado_en IS NULL OR e.actualizado_en > e.sheets_sincronizado_en
         ORDER BY e.id
         LIMIT 500`,
        [APP_TIMEZONE],
      );
      if (!filas.length) break;

      const nuevas = filas.filter((f) => f.sheets_fila === null);
      const existentes = filas.filter((f) => f.sheets_fila !== null);

      const numeros = nuevas.length ? await anexarFilas(pestana, nuevas.map((f) => f.valores)) : [];
      nuevas.forEach((f, i) => (f.sheets_fila = numeros[i]));
      await actualizarFilas(pestana, existentes.map((f) => ({ fila: f.sheets_fila!, valores: f.valores })));

      // Se marca con la versión leída: si el envío cambió mientras tanto, vuelve a salir.
      await consultar(
        `UPDATE recordatorios.envios e
         SET sheets_fila = v.fila, sheets_sincronizado_en = v.version
         FROM unnest($1::bigint[], $2::int[], $3::timestamptz[]) AS v(id, fila, version)
         WHERE e.id = v.id`,
        [filas.map((f) => f.id), filas.map((f) => f.sheets_fila), filas.map((f) => f.version)],
      );
      sincronizados += filas.length;
    }
    return sincronizados;
  });

  return total ?? 0;
}
