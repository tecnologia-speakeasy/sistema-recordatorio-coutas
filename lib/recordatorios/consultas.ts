import "server-only";
import { consultar, consultarUno } from "../db";
import {
  ESTADOS_ENVIO,
  ETAPA_SEGUIMIENTO,
  PREFIJO_SIN_CONTACTO,
  type EstadoEnvio,
  type Envio,
  type Etapa,
  type Pasarela,
} from "./tipos";

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
    where.push(
      `(e.nombre ILIKE ${p} OR e.telefono ILIKE ${p} OR e.telefono_e164 ILIKE ${p} OR e.email ILIKE ${p} OR e.cuota_id ILIKE ${p})`,
    );
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
  /** Recordatorios (sin seguimientos) con al menos un clic en el link. */
  conClick: number;
  /** Cuotas en las que tocó el botón "Realizar pago" (webhook del workflow). */
  tocaronRealizarPago: number;
  seguimientosEnviados: number;
  pagosReportados: number;
  pagadasTrasRecordatorio: number | null;
  cuotasRecordadas: number;
}

export async function kpis(desde: string, hasta: string): Promise<Kpis> {
  const [estados, extra] = await Promise.all([
    consultar<{ estado: EstadoEnvio; n: number }>(
      `SELECT estado, count(*)::int AS n FROM recordatorios.envios
       WHERE fecha_programada BETWEEN $1::date AND $2::date GROUP BY estado`,
      [desde, hasta],
    ),
    consultarUno<{ con_click: number; tocaron: number; seguimientos: number; reportados: number; cuotas: number }>(
      `SELECT count(*) FILTER (WHERE clicks > 0 AND etapa <> $3)::int AS con_click,
              count(DISTINCT (cuota_id, fecha_vencimiento)) FILTER (WHERE realizar_pago_en IS NOT NULL)::int AS tocaron,
              count(*) FILTER (WHERE etapa = $3 AND estado IN ('enviado','entregado','leido'))::int AS seguimientos,
              count(DISTINCT (cuota_id, fecha_vencimiento)) FILTER (WHERE pago_reportado_en IS NOT NULL)::int AS reportados,
              count(DISTINCT (cuota_id, fecha_vencimiento)) FILTER (WHERE estado IN ('enviado','entregado','leido'))::int AS cuotas
       FROM recordatorios.envios WHERE fecha_programada BETWEEN $1::date AND $2::date`,
      [desde, hasta, ETAPA_SEGUIMIENTO],
    ),
  ]);

  const porEstado = Object.fromEntries(ESTADOS_ENVIO.map((e) => [e, 0])) as Record<EstadoEnvio, number>;
  for (const { estado, n } of estados) porEstado[estado] = n;

  return {
    porEstado,
    total: estados.reduce((s, e) => s + e.n, 0),
    conClick: extra?.con_click ?? 0,
    tocaronRealizarPago: extra?.tocaron ?? 0,
    seguimientosEnviados: extra?.seguimientos ?? 0,
    pagosReportados: extra?.reportados ?? 0,
    cuotasRecordadas: extra?.cuotas ?? 0,
    pagadasTrasRecordatorio: await pagadasTrasRecordatorio(desde, hasta),
  };
}

/** Cuotas con al menos un recordatorio enviado en el rango que hoy figuran pagadas en cartera. */
async function pagadasTrasRecordatorio(desde: string, hasta: string): Promise<number | null> {
  try {
    const fila = await consultarUno<{ n: number }>(
      `SELECT count(*)::int AS n FROM (
         SELECT DISTINCT e.compra_id, e.cuota_numero, e.fecha_vencimiento
         FROM recordatorios.envios e
         WHERE e.fecha_programada BETWEEN $1::date AND $2::date
           AND e.estado IN ('enviado','entregado','leido')
       ) r
       JOIN recordatorios.v_cuotas_fuente f
         ON f.compra_id = r.compra_id AND f.cuota_numero = r.cuota_numero
        AND f.fecha_vencimiento = r.fecha_vencimiento
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

export interface LinkPago {
  pasarela: Pasarela;
  cuotas: number;
  referido: boolean;
  url: string | null;
}

export interface ProductoCartera {
  producto_id: string;
  nombre: string;
  activo: boolean;
  compras_en_cuotas: number;
  lanzamiento_id: string | null;
  /** Ajustes manuales (recordatorios.links_pago); si tienen URL, mandan. */
  links: LinkPago[];
  /** Tomados de los enlaces de ventas del lanzamiento. */
  links_lanzamiento: (LinkPago & { nombre: string })[];
}

/** Productos de cartera con cuotas, con su estado en este sistema y sus links de pago. */
export const listarProductos = () =>
  consultar<ProductoCartera>(
    `SELECT p.id AS producto_id, p.nombre, COALESCE(rp.activo, false) AS activo, rp.lanzamiento_id,
            (SELECT count(*)::int FROM public.cartera_compras c
             WHERE c.producto_id = p.id AND c.medio_pago = 'CUOTAS') AS compras_en_cuotas,
            COALESCE((SELECT jsonb_agg(jsonb_build_object('pasarela', l.pasarela, 'cuotas', l.cuotas,
                                                          'referido', l.referido, 'url', l.url))
                      FROM recordatorios.links_pago l WHERE l.producto_id = p.id), '[]') AS links,
            COALESCE((SELECT jsonb_agg(jsonb_build_object('pasarela', ll.pasarela, 'cuotas', ll.cuotas,
                                                          'referido', ll.referido, 'url', ll.url, 'nombre', ll.nombre))
                      FROM recordatorios.v_links_lanzamiento ll WHERE ll.lanzamiento_id = rp.lanzamiento_id), '[]')
              AS links_lanzamiento
     FROM public.cartera_productos p
     LEFT JOIN recordatorios.productos rp ON rp.producto_id = p.id
     WHERE p.cuotas_habilitadas
     ORDER BY COALESCE(rp.activo, false) DESC, p.created_at DESC`,
  );

export interface Lanzamiento {
  id: string;
  nombre: string;
  fecha: string;
}

export const listarLanzamientos = () =>
  consultar<Lanzamiento>("SELECT id, nombre, fecha FROM public.lanzamientos ORDER BY fecha DESC LIMIT 50");

export interface PlanSinLink {
  producto: string;
  pasarela: Pasarela;
  total_cuotas: number;
  referido: boolean;
  estudiantes: number;
}

/** Planes con cuotas por vencer (desde ayer) que no tienen link de pago. */
export const planesSinLink = (hoy: string) =>
  consultar<PlanSinLink>(
    `SELECT producto, pasarela, total_cuotas, referido, count(DISTINCT compra_id)::int AS estudiantes
     FROM recordatorios.v_cuotas_fuente
     WHERE NOT pagada AND link_pago IS NULL AND fecha_vencimiento >= $1::date - 1
     GROUP BY producto, pasarela, total_cuotas, referido
     ORDER BY estudiantes DESC`,
    [hoy],
  );

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

export const leerLinkSoporte = async () =>
  (await consultarUno<{ valor: string | null }>("SELECT valor FROM recordatorios.ajustes WHERE clave = 'link_soporte'"))
    ?.valor ?? null;

// ---------------------------------------------------------------------------
// Requieren atención
// ---------------------------------------------------------------------------

export interface FilaAlerta {
  envio_id: string;
  nombre: string | null;
  telefono: string | null;
  email: string | null;
  concepto: string | null;
  fecha_vencimiento: string;
  etapa: string | null;
  detalle: string | null;
  cuando: Date | null;
}

export type ClaveAlerta =
  | "whatsapp_fallido"
  | "sin_contacto_ghl"
  | "reporto_sin_registro"
  | "pidio_soporte"
  | "sin_abrir_link"
  | "abrio_sin_pagar"
  | "vencida_sin_pagar";

export interface Alerta {
  clave: ClaveAlerta;
  filas: FilaAlerta[];
}

interface CuotaResumen {
  envio_id: string;
  nombre: string | null;
  telefono: string | null;
  email: string | null;
  concepto: string | null;
  fecha_vencimiento: string;
  clicks: number;
  primer_click_en: Date | null;
  realizar_pago_en: Date | null;
  soporte_en: Date | null;
  pago_reportado_en: Date | null;
  recibio: boolean;
  /** null = la cuota ya no está en cartera (no se puede saber). */
  pagada: boolean | null;
}

/**
 * Lo que alguien del equipo debería revisar, para los envíos del rango:
 * mensajes que fallaron y cuotas cuyo estado pide una acción (verificar un pago
 * reportado, atender soporte, llamar a quien no pagó...).
 */
export async function alertas(desde: string, hasta: string, hoy: string): Promise<Alerta[]> {
  const [fallidos, cuotas] = await Promise.all([
    consultar<FilaAlerta>(
      `SELECT e.id AS envio_id, e.nombre, COALESCE(e.telefono_e164, e.telefono) AS telefono, e.email, e.concepto,
              e.fecha_vencimiento, e.etapa, e.ultimo_error AS detalle, e.actualizado_en AS cuando
       FROM recordatorios.envios e
       WHERE e.estado = 'fallido' AND e.fecha_programada BETWEEN $1::date AND $2::date
       ORDER BY e.actualizado_en DESC`,
      [desde, hasta],
    ),
    consultar<CuotaResumen>(
      `WITH c AS (
         SELECT e.cuota_id, e.fecha_vencimiento,
                (array_agg(e.id ORDER BY e.id DESC))[1] AS envio_id,
                (array_agg(e.compra_id ORDER BY e.id DESC))[1] AS compra_id,
                (array_agg(e.cuota_numero ORDER BY e.id DESC))[1] AS cuota_numero,
                (array_agg(e.nombre ORDER BY e.id DESC))[1] AS nombre,
                (array_agg(COALESCE(e.telefono_e164, e.telefono) ORDER BY e.telefono_e164 IS NULL, e.id DESC))[1] AS telefono,
                (array_agg(e.email ORDER BY e.id DESC))[1] AS email,
                (array_agg(e.concepto ORDER BY e.id DESC))[1] AS concepto,
                sum(e.clicks)::int AS clicks,
                min(e.primer_click_en) AS primer_click_en,
                min(e.realizar_pago_en) AS realizar_pago_en,
                max(e.soporte_en) AS soporte_en,
                min(e.pago_reportado_en) AS pago_reportado_en,
                bool_or(e.estado IN ('enviado', 'entregado', 'leido')) AS recibio
         FROM recordatorios.envios e
         WHERE e.fecha_programada BETWEEN $1::date AND $2::date
         GROUP BY e.cuota_id, e.fecha_vencimiento
       )
       SELECT c.*, f.pagada
       FROM c
       LEFT JOIN recordatorios.v_cuotas_fuente f
         ON f.compra_id = c.compra_id AND f.cuota_numero = c.cuota_numero AND f.fecha_vencimiento = c.fecha_vencimiento`,
      [desde, hasta],
    ).catch(() => [] as CuotaResumen[]),
  ]);

  const tresHorasAtras = Date.now() - 3 * 3600_000;
  const fila = (c: CuotaResumen, detalle: string, cuando: Date | null): FilaAlerta => ({
    envio_id: c.envio_id,
    nombre: c.nombre,
    telefono: c.telefono,
    email: c.email,
    concepto: c.concepto,
    fecha_vencimiento: c.fecha_vencimiento,
    etapa: null,
    detalle,
    cuando,
  });
  const reciente = (a: Date | null, b: Date | null) => (b?.getTime() ?? 0) - (a?.getTime() ?? 0);

  const noPagada = (c: CuotaResumen) => c.pagada === false;
  const sinContacto = (f: FilaAlerta) => f.detalle?.startsWith(PREFIJO_SIN_CONTACTO) ?? false;
  return [
    { clave: "whatsapp_fallido", filas: fallidos.filter((f) => !sinContacto(f)) },
    { clave: "sin_contacto_ghl", filas: fallidos.filter(sinContacto) },
    {
      clave: "reporto_sin_registro",
      filas: cuotas
        .filter((c) => c.pago_reportado_en && noPagada(c))
        .sort((a, b) => reciente(a.pago_reportado_en, b.pago_reportado_en))
        .map((c) => fila(c, "Respondió «Pago realizado», pero en cartera la cuota sigue sin pagar", c.pago_reportado_en)),
    },
    {
      clave: "pidio_soporte",
      filas: cuotas
        .filter((c) => c.soporte_en && c.pagada !== true)
        .sort((a, b) => reciente(a.soporte_en, b.soporte_en))
        .map((c) => fila(c, "Tocó «Soporte»", c.soporte_en)),
    },
    {
      clave: "sin_abrir_link",
      filas: cuotas
        .filter((c) => c.realizar_pago_en && c.clicks === 0 && noPagada(c) && !c.pago_reportado_en)
        .sort((a, b) => reciente(a.realizar_pago_en, b.realizar_pago_en))
        .map((c) => fila(c, "Tocó «Realizar pago» y no abrió el link de pago", c.realizar_pago_en)),
    },
    {
      clave: "abrio_sin_pagar",
      filas: cuotas
        .filter(
          (c) =>
            c.clicks > 0 && noPagada(c) && !c.pago_reportado_en && (c.primer_click_en?.getTime() ?? 0) < tresHorasAtras,
        )
        .sort((a, b) => reciente(a.primer_click_en, b.primer_click_en))
        .map((c) => fila(c, `Abrió el link de pago (${c.clicks} clic${c.clicks === 1 ? "" : "s"}) y no ha pagado`, c.primer_click_en)),
    },
    {
      clave: "vencida_sin_pagar",
      filas: cuotas
        .filter((c) => c.fecha_vencimiento < hoy && c.recibio && noPagada(c) && !c.pago_reportado_en)
        .sort((a, b) => a.fecha_vencimiento.localeCompare(b.fecha_vencimiento))
        .map((c) => fila(c, "Venció y sigue sin pagar en cartera", null)),
    },
  ];
}
