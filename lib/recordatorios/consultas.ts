import "server-only";
import { consultar, consultarUno } from "../db";
import { ESTADOS_ENVIO, type EstadoEnvio, type Envio, type Etapa } from "./tipos";

export const TAMANO_PAGINA = 50;

export interface FiltrosEnvios {
  desde: string;
  hasta: string;
  estado?: EstadoEnvio;
  etapa?: string;
  q?: string;
  pagina: number;
}

/** Arma el WHERE compartido por el listado, los KPIs y el reenvío masivo. */
function condiciones(f: Omit<FiltrosEnvios, "pagina">) {
  const params: unknown[] = [f.desde, f.hasta];
  const where = ["e.fecha_programada BETWEEN $1::date AND $2::date"];
  if (f.estado) {
    params.push(f.estado);
    where.push(`e.estado = $${params.length}`);
  }
  if (f.etapa) {
    params.push(f.etapa);
    where.push(`e.etapa = $${params.length}`);
  }
  if (f.q) {
    params.push(`%${f.q.replace(/[\\%_]/g, "\\$&")}%`);
    const p = `$${params.length}`;
    where.push(`(e.nombre ILIKE ${p} OR e.telefono ILIKE ${p} OR e.cuota_id ILIKE ${p} OR e.cliente_id ILIKE ${p})`);
  }
  return { sql: where.join(" AND "), params };
}

export async function listarEnvios(filtros: FiltrosEnvios) {
  const { sql, params } = condiciones(filtros);
  const offset = (filtros.pagina - 1) * TAMANO_PAGINA;
  const [filas, total] = await Promise.all([
    consultar<Envio>(
      `SELECT e.* FROM recordatorios.envios e WHERE ${sql}
       ORDER BY e.fecha_programada DESC, e.id DESC
       LIMIT ${TAMANO_PAGINA} OFFSET ${offset}`,
      params,
    ),
    consultarUno<{ total: number }>(`SELECT count(*)::int AS total FROM recordatorios.envios e WHERE ${sql}`, params),
  ]);
  return { filas, total: total?.total ?? 0 };
}

export async function idsFiltrados(filtros: Omit<FiltrosEnvios, "pagina">, limite: number): Promise<string[]> {
  const { sql, params } = condiciones(filtros);
  const filas = await consultar<{ id: string }>(
    `SELECT e.id FROM recordatorios.envios e WHERE ${sql} ORDER BY e.id LIMIT ${limite}`,
    params,
  );
  return filas.map((f) => f.id);
}

export interface Kpis {
  porEstado: Record<EstadoEnvio, number>;
  total: number;
  conClick: number;
  pagadasTrasRecordatorio: number | null;
  cuotasRecordadas: number;
}

export async function kpis(desde: string, hasta: string): Promise<Kpis> {
  const [estados, clicks] = await Promise.all([
    consultar<{ estado: EstadoEnvio; n: number }>(
      `SELECT estado, count(*)::int AS n FROM recordatorios.envios
       WHERE fecha_programada BETWEEN $1::date AND $2::date GROUP BY estado`,
      [desde, hasta],
    ),
    consultarUno<{ con_click: number; cuotas: number }>(
      `SELECT count(*) FILTER (WHERE clicks > 0)::int AS con_click,
              count(DISTINCT (cuota_id, fecha_vencimiento)) FILTER (WHERE estado IN ('enviado','entregado','leido'))::int AS cuotas
       FROM recordatorios.envios WHERE fecha_programada BETWEEN $1::date AND $2::date`,
      [desde, hasta],
    ),
  ]);

  const porEstado = Object.fromEntries(ESTADOS_ENVIO.map((e) => [e, 0])) as Record<EstadoEnvio, number>;
  for (const { estado, n } of estados) porEstado[estado] = n;

  return {
    porEstado,
    total: estados.reduce((s, e) => s + e.n, 0),
    conClick: clicks?.con_click ?? 0,
    cuotasRecordadas: clicks?.cuotas ?? 0,
    pagadasTrasRecordatorio: await pagadasTrasRecordatorio(desde, hasta),
  };
}

/** Cuotas con al menos un recordatorio enviado en el rango que hoy figuran pagadas. */
async function pagadasTrasRecordatorio(desde: string, hasta: string): Promise<number | null> {
  try {
    const fila = await consultarUno<{ n: number }>(
      `SELECT count(*)::int AS n FROM (
         SELECT DISTINCT e.cuota_id, e.fecha_vencimiento
         FROM recordatorios.envios e
         WHERE e.fecha_programada BETWEEN $1::date AND $2::date
           AND e.estado IN ('enviado','entregado','leido')
       ) r
       JOIN recordatorios.v_cuotas_fuente f
         ON f.cuota_id = r.cuota_id AND f.fecha_vencimiento = r.fecha_vencimiento
       WHERE f.pagada`,
      [desde, hasta],
    );
    return fila?.n ?? 0;
  } catch {
    return null; // la vista fuente no existe o falló: el dashboard muestra "—"
  }
}

export interface Ejecucion {
  id: string;
  origen: string;
  fecha_referencia: string;
  iniciada_en: Date;
  finalizada_en: Date | null;
  planificados: number;
  enviados: number;
  fallidos: number;
  omitidos: number;
  verificados: number;
  sincronizados_sheets: number;
  error: string | null;
}

export const ejecucionesRecientes = (limite = 8) =>
  consultar<Ejecucion>("SELECT * FROM recordatorios.ejecuciones ORDER BY iniciada_en DESC LIMIT $1", [limite]);

export const listarEtapas = () => consultar<Etapa>("SELECT * FROM recordatorios.etapas ORDER BY orden");

export const obtenerEnvio = (id: string) =>
  consultarUno<Envio>("SELECT * FROM recordatorios.envios WHERE id = $1", [id]);

export interface Evento {
  id: string;
  tipo: string;
  detalle: unknown;
  creado_en: Date;
}

export const eventosDeEnvio = (id: string) =>
  consultar<Evento>(
    "SELECT id, tipo, detalle, creado_en FROM recordatorios.eventos WHERE envio_id = $1 ORDER BY creado_en DESC LIMIT 100",
    [id],
  );
