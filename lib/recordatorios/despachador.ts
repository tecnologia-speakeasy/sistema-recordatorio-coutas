import "server-only";
import { configGeneral, configGhl } from "../config";
import { consultar, consultarUno } from "../db";
import { ErrorGhl, inscribirEnWorkflow, upsertContacto } from "../ghl";
import {
  esperar,
  formatearFechaLarga,
  formatearMoneda,
  mensajeDeError,
  normalizarTelefono,
} from "../utilidades";
import { registrarEvento } from "./bitacora";
import {
  ESTADOS_REENVIABLES,
  type CuotaFuente,
  type Envio,
  type Etapa,
  type ResultadoDespacho,
} from "./tipos";

const TAMANO_LOTE = 20;
const CONCURRENCIA = 4; // ~2 llamadas a GHL por envío; holgado bajo 100 req / 10 s

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
  const etapas = await cargarEtapas();
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

    const desenlaces = await enParalelo(lote, CONCURRENCIA, (envio) => despacharEnvio(envio, etapas));
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

/** $1 = fecha (cron) o $2 = ids (reenvío); exactamente uno de los dos viene informado. */
const FILTRO_ALCANCE = `(CASE WHEN $2::bigint[] IS NULL THEN e.fecha_programada = $1::date
                              ELSE e.id = ANY($2::bigint[]) END)`;

async function cargarEtapas(): Promise<Map<string, Etapa>> {
  const etapas = await consultar<Etapa>("SELECT * FROM recordatorios.etapas");
  return new Map(etapas.map((e) => [e.codigo, e]));
}

/**
 * Toma hasta TAMANO_LOTE pendientes, uno por teléfono, excluyendo teléfonos con
 * un envío en curso o enviado hace menos de `esperaSeg`. El re-chequeo de
 * `estado = 'pendiente'` en el UPDATE evita que dos ejecuciones concurrentes
 * tomen el mismo envío.
 */
async function reclamarLote(alcance: Alcance, esperaSeg: number): Promise<Envio[]> {
  return consultar<Envio>(
    `WITH candidatos AS (
       SELECT DISTINCT ON (COALESCE(e.telefono, e.id::text)) e.id
       FROM recordatorios.envios e
       WHERE e.estado = 'pendiente'
         AND ${FILTRO_ALCANCE}
         AND NOT EXISTS (
           SELECT 1 FROM recordatorios.envios o
           WHERE o.telefono = e.telefono AND o.id <> e.id
             AND (o.estado = 'procesando' OR o.enviado_en > now() - make_interval(secs => $4))
         )
       ORDER BY COALESCE(e.telefono, e.id::text), e.id
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

async function despacharEnvio(envio: Envio, etapas: Map<string, Etapa>): Promise<Desenlace> {
  try {
    const { TELEFONO_CODIGO_PAIS, MONEDA } = configGeneral();

    // Siempre se relee la fuente: la cuota pudo pagarse o corregirse desde la planificación.
    const fuente = await consultarUno<CuotaFuente>(
      `SELECT * FROM recordatorios.v_cuotas_fuente
       WHERE cuota_id = $1 AND fecha_vencimiento = $2::date
       LIMIT 1`,
      [envio.cuota_id, envio.fecha_vencimiento],
    );
    if (!fuente) return await omitir(envio, "La cuota ya no aparece en la vista fuente");
    if (fuente.pagada) return await omitir(envio, "La cuota ya está pagada");

    await consultar(
      `UPDATE recordatorios.envios
       SET cliente_id = $2, nombre = $3, telefono = $4, email = $5, valor = $6, concepto = $7, link_pago = $8
       WHERE id = $1`,
      [envio.id, fuente.cliente_id, fuente.nombre, fuente.telefono, fuente.email, fuente.valor, fuente.concepto, fuente.link_pago],
    );

    const workflowId = etapas.get(envio.etapa)?.ghl_workflow_id;
    if (!workflowId) return await fallar(envio, `La etapa ${envio.etapa} no tiene workflow de GHL configurado`);

    const telefono = normalizarTelefono(fuente.telefono, TELEFONO_CODIGO_PAIS);
    if (!telefono) return await fallar(envio, `Teléfono inválido o vacío: "${fuente.telefono ?? ""}"`);

    if (!fuente.link_pago || !/^https?:\/\//i.test(fuente.link_pago) || !URL.canParse(fuente.link_pago)) {
      return await fallar(envio, "Link de pago vacío o inválido");
    }

    if (configGhl().GHL_DRY_RUN) {
      await marcarEnviado(envio.id, null, telefono, "SIMULADO: GHL_DRY_RUN activo, no se llamó a GHL");
      await registrarEvento(envio.id, "simulado", { telefono, workflowId });
      return "enviado";
    }

    const contactId = await upsertContacto({
      telefono,
      nombre: fuente.nombre,
      campos: {
        token: envio.token,
        valor: formatearMoneda(fuente.valor, MONEDA),
        fechaLimite: formatearFechaLarga(envio.fecha_vencimiento),
        concepto: fuente.concepto ?? "",
        etapa: envio.etapa,
        envioId: envio.id,
      },
    });
    await inscribirEnWorkflow(contactId, workflowId);

    await marcarEnviado(envio.id, contactId, telefono, null);
    await registrarEvento(envio.id, "enviado", { contactId, workflowId, telefono, intento: envio.intentos });
    return "enviado";
  } catch (error) {
    const detalle = error instanceof ErrorGhl ? { estadoHttp: error.estadoHttp, cuerpo: error.cuerpo } : undefined;
    return fallar(envio, mensajeDeError(error), detalle);
  }
}

async function marcarEnviado(id: string, contactId: string | null, telefono: string, nota: string | null) {
  await consultar(
    `UPDATE recordatorios.envios
     SET estado = 'enviado', enviado_en = now(), procesando_desde = NULL, ultimo_error = $4,
         ghl_conversation_id = CASE WHEN ghl_contact_id IS NOT DISTINCT FROM $2 THEN ghl_conversation_id END,
         ghl_contact_id = $2, telefono_e164 = $3,
         ghl_message_id = NULL, entregado_en = NULL, leido_en = NULL, confirmado_workflow_en = NULL
     WHERE id = $1`,
    [id, contactId, telefono, nota],
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
