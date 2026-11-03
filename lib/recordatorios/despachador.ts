import "server-only";
import { configGeneral, configGhl } from "../config";
import { consultar, consultarUno } from "../db";
import { dispararWorkflow, ErrorGhl, type DatosWorkflow } from "../ghl";
import { normalizarTelefono } from "../telefonos";
import { esperar, esUrlHttp, formatearFechaLarga, mensajeDeError, primerNombre } from "../utilidades";
import { registrarEvento } from "./bitacora";
import { leerAjustes, pagoReportado, ventanaCerrada } from "./interacciones";
import {
  ESTADOS_REENVIABLES,
  ETAPA_SEGUIMIENTO,
  PASARELAS,
  type CuotaFuente,
  type Envio,
  type Etapa,
  type ResultadoDespacho,
} from "./tipos";

const TAMANO_LOTE = 20;
const CONCURRENCIA = 4; // una llamada a GHL por envío

type Desenlace = "enviado" | "fallido" | "omitido";

/** Qué pendientes despachar: los programados para una fecha (cron) o envíos puntuales (reenvío manual). */
export type Alcance = { fecha: string; ids?: never } | { ids: string[]; fecha?: never };

/**
 * Despacha los envíos pendientes del alcance hasta agotarlos o agotar el tiempo.
 * Nunca toma dos envíos del mismo teléfono a la vez ni dentro de la ventana
 * ESPERA_MISMO_CONTACTO_SEG (ver reclamarLote).
 */
export async function despacharPendientes(alcance: Alcance, limiteMs: number): Promise<ResultadoDespacho> {
  const general = configGeneral();
  const fin = Date.now() + limiteMs;
  const contexto: Contexto = { etapas: await cargarEtapas(), ajustes: await leerAjustes() };
  const resultado: ResultadoDespacho = { enviados: 0, fallidos: 0, omitidos: 0 };

  while (Date.now() < fin) {
    const lote = await reclamarLote(alcance, general.ESPERA_MISMO_CONTACTO_SEG);

    if (!lote.length) {
      if (!(await quedanPendientes(alcance))) break;
      // Lo que queda está en espera por teléfono repetido: aguardar y reintentar.
      const pausa = Math.min(10_000, fin - Date.now());
      if (pausa <= 0) break;
      await esperar(pausa);
      continue;
    }

    const desenlaces = await enParalelo(lote, CONCURRENCIA, (envio) => despacharEnvio(envio, contexto));
    for (const d of desenlaces) {
      if (d === "enviado") resultado.enviados++;
      else if (d === "fallido") resultado.fallidos++;
      else resultado.omitidos++;
    }
  }

  return resultado;
}

/**
 * Devuelve a 'pendiente' los envíos indicados que sean reenviables, conservando
 * su fecha programada (la fila no "salta" de fecha en el dashboard). El reenvío
 * queda en la bitácora con el estado anterior.
 */
export async function marcarParaReenvio(ids: string[]): Promise<string[]> {
  if (!ids.length) return [];
  const filas = await consultar<{ envio_id: string }>(
    `WITH previos AS (
       SELECT id, estado, ultimo_error
       FROM recordatorios.envios
       WHERE id = ANY($1::bigint[]) AND estado::text = ANY($2::text[])
       FOR UPDATE
     ), actualizados AS (
       UPDATE recordatorios.envios e
       SET estado = 'pendiente', ultimo_error = NULL
       FROM previos p
       WHERE e.id = p.id
       RETURNING e.id
     )
     INSERT INTO recordatorios.eventos (envio_id, tipo, detalle)
     SELECT p.id, 'reenvio_manual',
            jsonb_build_object('estado_anterior', p.estado, 'error_anterior', p.ultimo_error)
     FROM previos p JOIN actualizados a ON a.id = p.id
     RETURNING envio_id`,
    [ids, ESTADOS_REENVIABLES],
  );
  return filas.map((f) => f.envio_id);
}

// ---------------------------------------------------------------------------

/**
 * $1 = fecha (cron) o $2 = ids (reenvío); exactamente uno de los dos viene informado.
 * En el cron, los recordatorios salen en su fecha y los seguimientos cuando llega
 * su hora (si quedó fuera de la ventana, en la siguiente ejecución dentro de ella).
 */
const FILTRO_ALCANCE = `(CASE WHEN $2::bigint[] IS NOT NULL THEN e.id = ANY($2::bigint[])
                              WHEN e.programado_para IS NULL THEN e.fecha_programada = $1::date
                              ELSE e.programado_para <= now() AND e.programado_para > now() - interval '1 day' END)`;

/** Lo que todos los envíos de una ejecución comparten. */
interface Contexto {
  etapas: Map<string, Etapa>;
  ajustes: Awaited<ReturnType<typeof leerAjustes>>;
}

async function cargarEtapas(): Promise<Map<string, Etapa>> {
  const etapas = await consultar<Etapa>("SELECT * FROM recordatorios.etapas");
  return new Map(etapas.map((e) => [e.codigo, e]));
}

/**
 * Mismo teléfono aunque cartera lo tenga en formatos distintos ("1 (305) 555-1001",
 * "+1 305 555 1001"): últimos 10 dígitos. Un falso positivo solo retrasa el envío.
 */
const claveTelefono = (alias: string) => `NULLIF(right(regexp_replace(${alias}.telefono, '\\D', '', 'g'), 10), '')`;

/**
 * Toma hasta TAMANO_LOTE pendientes, uno por teléfono, excluyendo teléfonos con
 * un envío en curso o enviado hace menos de `esperaSeg`. El re-chequeo de
 * `estado = 'pendiente'` en el UPDATE evita que dos ejecuciones concurrentes
 * tomen el mismo envío.
 */
async function reclamarLote(alcance: Alcance, esperaSeg: number): Promise<Envio[]> {
  return consultar<Envio>(
    `WITH candidatos AS (
       SELECT DISTINCT ON (COALESCE(${claveTelefono("e")}, e.id::text)) e.id
       FROM recordatorios.envios e
       WHERE e.estado = 'pendiente'
         AND ${FILTRO_ALCANCE}
         AND NOT EXISTS (
           SELECT 1 FROM recordatorios.envios o
           WHERE (o.estado = 'procesando' OR o.enviado_en > now() - make_interval(secs => $4))
             AND o.id <> e.id AND ${claveTelefono("o")} = ${claveTelefono("e")}
         )
       ORDER BY COALESCE(${claveTelefono("e")}, e.id::text), e.id
       LIMIT $3
     )
     UPDATE recordatorios.envios e
     SET estado = 'procesando', procesando_desde = now(), intentos = e.intentos + 1
     FROM candidatos c
     WHERE e.id = c.id AND e.estado = 'pendiente'
     RETURNING e.*`,
    [alcance.fecha ?? null, alcance.ids ?? null, TAMANO_LOTE, esperaSeg],
  );
}

async function quedanPendientes(alcance: Alcance): Promise<boolean> {
  const fila = await consultarUno<{ hay: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM recordatorios.envios e
       WHERE e.estado = 'pendiente' AND ${FILTRO_ALCANCE}
     ) AS hay`,
    [alcance.fecha ?? null, alcance.ids ?? null],
  );
  return fila?.hay ?? false;
}

async function despacharEnvio(envio: Envio, { etapas, ajustes }: Contexto): Promise<Desenlace> {
  try {
    const { TELEFONO_CODIGO_PAIS, APP_URL } = configGeneral();

    // Siempre se relee cartera: la cuota pudo pagarse o corregirse desde la planificación.
    const fuente = await consultarUno<CuotaFuente>(
      `SELECT * FROM recordatorios.v_cuotas_fuente
       WHERE compra_id = $1 AND cuota_numero = $2 AND fecha_vencimiento = $3::date`,
      [envio.compra_id, envio.cuota_numero, envio.fecha_vencimiento],
    );
    if (!fuente) {
      return await omitir(envio, "La cuota ya no aparece en cartera (compra no activa, producto inactivo o plan cambiado)");
    }
    if (fuente.pagada) return await omitir(envio, "La cuota ya está pagada en cartera");
    if (await pagoReportado(envio.cuota_id, envio.fecha_vencimiento)) {
      return await omitir(envio, "El estudiante respondió por WhatsApp que ya pagó esta cuota");
    }
    // El seguimiento es un mensaje normal: fuera de la ventana de 24 h WhatsApp lo rechaza.
    if (envio.etapa === ETAPA_SEGUIMIENTO && (await ventanaCerrada(envio.cuota_id, envio.fecha_vencimiento))) {
      return await omitir(envio, "Se cerró la ventana de 24 h de WhatsApp: el seguimiento (mensaje normal) ya no se puede enviar");
    }

    await consultar(
      `UPDATE recordatorios.envios
       SET nombre = $2, telefono = $3, email = $4, pais = $5, producto = $6, metodo_pago = $7,
           pasarela = $8, concepto = $9, link_pago = $10, total_cuotas = $11, referido = $12, descuento = $13
       WHERE id = $1`,
      [
        envio.id, fuente.nombre, fuente.telefono, fuente.email, fuente.pais, fuente.producto,
        fuente.metodo_pago, fuente.pasarela, fuente.concepto, fuente.link_pago, fuente.total_cuotas,
        fuente.referido, fuente.descuento,
      ],
    );

    const etapa = etapas.get(envio.etapa);
    if (!etapa?.ghl_webhook_url) {
      return await fallar(envio, `La etapa ${envio.etapa} no tiene configurado el webhook del workflow de GHL`);
    }

    const telefono = normalizarTelefono(fuente.telefono, fuente.pais, TELEFONO_CODIGO_PAIS);
    if (!telefono) return await fallar(envio, `Teléfono inválido o vacío: "${fuente.telefono ?? ""}"`);

    // El seguimiento no lleva link de pago; los recordatorios sí.
    if (etapa.offset_dias !== null && !esUrlHttp(fuente.link_pago)) {
      return await fallar(
        envio,
        `Falta el link de ${PASARELAS[fuente.pasarela]}${fuente.referido ? " con descuento de referido" : ""} ` +
          `para el plan de ${fuente.total_cuotas} cuotas (${fuente.producto}). Agrégalo en los enlaces de ventas ` +
          `del lanzamiento o en "Productos y links de pago".`,
      );
    }

    const datos: DatosWorkflow = {
      envio_id: envio.id,
      etapa: envio.etapa,
      plantilla: etapa.plantilla ?? "",
      primer_nombre: primerNombre(fuente.nombre) || "estudiante",
      nombre: fuente.nombre ?? "",
      telefono,
      email: fuente.email ?? "",
      link_pago: `${APP_URL}/p/${envio.token}`,
      link_soporte: ajustes.link_soporte ?? "",
      token: envio.token,
      cuota: String(fuente.cuota_numero),
      total_cuotas: String(fuente.total_cuotas),
      concepto: fuente.concepto,
      fecha_limite: formatearFechaLarga(envio.fecha_vencimiento),
      metodo_pago: fuente.metodo_pago ?? "",
      pasarela: fuente.pasarela,
      referido: fuente.referido ? "si" : "no",
      producto: fuente.producto,
    };

    if (configGhl().GHL_DRY_RUN) {
      await marcarEnviado(envio.id, telefono, true, "SIMULADO: GHL_DRY_RUN activo, no se llamó a GHL");
      await registrarEvento(envio.id, "simulado", { datos });
      return "enviado";
    }

    const respuestaGhl = await dispararWorkflow(etapa.ghl_webhook_url, datos);
    await marcarEnviado(envio.id, telefono, false, null);
    await registrarEvento(envio.id, "enviado", { telefono, intento: envio.intentos, respuestaGhl });
    return "enviado";
  } catch (error) {
    const detalle = error instanceof ErrorGhl ? { estadoHttp: error.estadoHttp, cuerpo: error.cuerpo } : undefined;
    return fallar(envio, mensajeDeError(error), detalle);
  }
}

/** Si cambió el teléfono, el contacto/conversación de GHL se vuelven a buscar al verificar. */
async function marcarEnviado(id: string, telefono: string, simulado: boolean, nota: string | null) {
  await consultar(
    `UPDATE recordatorios.envios
     SET estado = 'enviado', enviado_en = now(), procesando_desde = NULL, ultimo_error = $4, simulado = $3,
         ghl_contact_id = CASE WHEN telefono_e164 IS NOT DISTINCT FROM $2 THEN ghl_contact_id END,
         ghl_conversation_id = CASE WHEN telefono_e164 IS NOT DISTINCT FROM $2 THEN ghl_conversation_id END,
         telefono_e164 = $2,
         ghl_message_id = NULL, entregado_en = NULL, leido_en = NULL
     WHERE id = $1`,
    [id, telefono, simulado, nota],
  );
}

async function fallar(envio: Envio, mensaje: string, detalle?: unknown): Promise<Desenlace> {
  await consultar(
    `UPDATE recordatorios.envios
     SET estado = 'fallido', procesando_desde = NULL, ultimo_error = $2
     WHERE id = $1`,
    [envio.id, mensaje.slice(0, 1000)],
  );
  await registrarEvento(envio.id, "error", { mensaje, intento: envio.intentos, ...(detalle ? { detalle } : {}) });
  return "fallido";
}

async function omitir(envio: Envio, motivo: string): Promise<Desenlace> {
  await consultar(
    `UPDATE recordatorios.envios
     SET estado = 'omitido', procesando_desde = NULL, ultimo_error = $2
     WHERE id = $1`,
    [envio.id, motivo],
  );
  await registrarEvento(envio.id, "omitido", { motivo });
  return "omitido";
}

async function enParalelo<T, R>(items: T[], limite: number, tarea: (item: T) => Promise<R>): Promise<R[]> {
  const resultados = new Array<R>(items.length);
  let siguiente = 0;
  const trabajadores = Array.from({ length: Math.min(limite, items.length) }, async () => {
    while (siguiente < items.length) {
      const i = siguiente++;
      resultados[i] = await tarea(items[i]);
    }
  });
  await Promise.all(trabajadores);
  return resultados;
}
