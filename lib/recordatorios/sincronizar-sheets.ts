import "server-only";
import { configGeneral, configSheets } from "../config";
import { conBloqueo, consultar } from "../db";
import { actualizarFilas, anexarFilas, asegurarPestanas, type Celda } from "../sheets";
import { ETIQUETAS_ESTADO, RESPUESTAS, type Etapa, type EstadoEnvio, type Respuesta } from "./tipos";

interface CuotaSync {
  cuota_id: string;
  fecha_vencimiento: string;
  version: string; // max(actualizado_en) como texto, con microsegundos
  fila: number | null;
  pestana: string | null;
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
 * Refleja en Google Sheets una fila por cuota de estudiante, en pestañas
 * "Cuota 2", "Cuota 3"... con el estado de cada recordatorio, los clics y si
 * respondió "Pago realizado". Alta con append, cambios en sitio. Procesa solo
 * lo que cambió desde la última sincronización. No ordenes ni borres filas de
 * esas pestañas: usa vistas de filtro u otra pestaña con QUERY().
 */
export async function sincronizarSheets(): Promise<number> {
  if (!configSheets()) return 0;
  const { APP_TIMEZONE } = configGeneral();

  const total = await conBloqueo("sheets", 300, async () => {
    const etapas = await consultar<Etapa>("SELECT * FROM recordatorios.etapas ORDER BY orden");
    const encabezados = [
      "Producto", "Cuota", "Fecha límite", "Nombre", "Correo", "Teléfono", "País", "Método de pago", "Descuento",
      ...etapas.map((e) => e.nombre),
      "Tocó «Realizar pago»", "Clics en el link", "Primer clic", "Pidió soporte", "Respuesta", "Pagó (reportado)",
      "Fecha del reporte", "Actualizado",
    ];
    const pestanasListas = new Set<string>();
    let sincronizadas = 0;

    for (let vuelta = 0; vuelta < 10; vuelta++) {
      const cuotas = await pendientes(APP_TIMEZONE);
      if (!cuotas.length) break;

      const filas = cuotas.map((c) => ({
        c,
        pestana: c.pestana ?? `Cuota ${c.cuota_numero}`,
        valores: valores(c, etapas),
      }));

      const porCrear = [...new Set(filas.map((f) => f.pestana))].filter((p) => !pestanasListas.has(p));
      await asegurarPestanas(porCrear, encabezados);
      porCrear.forEach((p) => pestanasListas.add(p));

      const nuevas = filas.filter((f) => f.c.fila === null);
      for (const pestana of new Set(nuevas.map((f) => f.pestana))) {
        const delaPestana = nuevas.filter((f) => f.pestana === pestana);
        const numeros = await anexarFilas(pestana, delaPestana.map((f) => f.valores));
        delaPestana.forEach((f, i) => (f.c.fila = numeros[i]));
      }
      await actualizarFilas(
        filas
          .filter((f) => !nuevas.includes(f))
          .map((f) => ({ pestana: f.pestana, fila: f.c.fila!, valores: f.valores })),
      );

      // Se marca con la versión leída: si la cuota cambió mientras tanto, vuelve a salir.
      await consultar(
        `INSERT INTO recordatorios.sheets_filas (cuota_id, fecha_vencimiento, pestana, fila, version)
         SELECT * FROM unnest($1::text[], $2::date[], $3::text[], $4::int[], $5::timestamptz[])
         ON CONFLICT (cuota_id, fecha_vencimiento)
           DO UPDATE SET pestana = EXCLUDED.pestana, fila = EXCLUDED.fila, version = EXCLUDED.version`,
        [
          filas.map((f) => f.c.cuota_id),
          filas.map((f) => f.c.fecha_vencimiento),
          filas.map((f) => f.pestana),
          filas.map((f) => f.c.fila),
          filas.map((f) => f.c.version),
        ],
      );
      sincronizadas += filas.length;
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
       SELECT g.cuota_id, g.fecha_vencimiento, g.version, s.fila, s.pestana
       FROM g LEFT JOIN recordatorios.sheets_filas s USING (cuota_id, fecha_vencimiento)
       WHERE s.version IS NULL OR g.version > s.version
       ORDER BY g.fecha_vencimiento, g.cuota_id
       LIMIT 300
     )
     SELECT p.cuota_id, p.fecha_vencimiento::text AS fecha_vencimiento, p.version::text AS version,
            p.fila, p.pestana,
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

function valores(c: CuotaSync, etapas: Etapa[]): Celda[] {
  return [
    c.producto,
    `${c.cuota_numero} de ${c.total_cuotas}`,
    c.fecha_vencimiento,
    c.nombre,
    c.email,
    c.telefono,
    c.pais,
    c.metodo_pago,
    c.descuento,
    ...etapas.map((e) => (c.estados[e.codigo] ? ETIQUETAS_ESTADO[c.estados[e.codigo]] : "")),
    c.realizar_pago,
    c.clicks,
    c.primer_click,
    c.soporte,
    c.respuesta ? (RESPUESTAS[c.respuesta] ?? c.respuesta) : "",
    c.pago_reportado ? "Sí" : "",
    c.pago_reportado,
    c.actualizado,
  ];
}
