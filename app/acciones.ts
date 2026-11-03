"use server";

import { refresh } from "next/cache";
import { headers } from "next/headers";
import { z } from "zod";
import { basicValido } from "@/lib/auth";
import { configSeguridad } from "@/lib/config";
import { consultarUno } from "@/lib/db";
import { ejecutarCiclo } from "@/lib/recordatorios/ciclo";
import { idsFiltrados } from "@/lib/recordatorios/consultas";
import { despacharPendientes, marcarParaReenvio } from "@/lib/recordatorios/despachador";
import { sincronizarSheets } from "@/lib/recordatorios/sincronizar-sheets";
import { campoLink, COLUMNAS_LINK, CUOTAS_CON_LINK, type ResultadoDespacho } from "@/lib/recordatorios/tipos";
import { mensajeDeError } from "@/lib/utilidades";

export type EstadoAccion = { ok: boolean; mensaje: string } | null;

const MAX_REENVIO_MASIVO = 200;

/** Las server actions son POST alcanzables directamente: se valida aquí, no solo en el proxy. */
async function exigirAdmin() {
  const { DASHBOARD_USUARIO, DASHBOARD_CLAVE } = configSeguridad();
  const encabezados = await headers();
  if (!basicValido(encabezados.get("authorization"), DASHBOARD_USUARIO, DASHBOARD_CLAVE)) {
    throw new Error("No autorizado");
  }
}

async function ejecutar(trabajo: () => Promise<EstadoAccion>): Promise<EstadoAccion> {
  try {
    await exigirAdmin();
    const resultado = await trabajo();
    refresh();
    return resultado;
  } catch (error) {
    return { ok: false, mensaje: error instanceof z.ZodError ? z.prettifyError(error) : mensajeDeError(error) };
  }
}

const describir = ({ enviados, fallidos, omitidos }: ResultadoDespacho) =>
  `Enviados: ${enviados} · Fallidos: ${fallidos} · Omitidos: ${omitidos}`;

async function reenviar(ids: string[]): Promise<EstadoAccion> {
  const marcados = await marcarParaReenvio(ids);
  if (!marcados.length) return { ok: false, mensaje: "No hay envíos en estado reenviable." };

  const resultado = await despacharPendientes({ ids: marcados }, 240_000);
  const pendientes = marcados.length - resultado.enviados - resultado.fallidos - resultado.omitidos;
  const sufijo = pendientes > 0 ? ` · ${pendientes} siguen pendientes: vuelve a reenviarlos` : "";
  return { ok: resultado.fallidos === 0, mensaje: describir(resultado) + sufijo };
}

export async function reenviarEnvio(_previo: EstadoAccion, datos: FormData): Promise<EstadoAccion> {
  return ejecutar(async () => {
    const id = z.string().regex(/^\d+$/).parse(datos.get("id"));
    return reenviar([id]);
  });
}

const esquemaFiltros = z.object({
  desde: z.iso.date(),
  hasta: z.iso.date(),
  etapa: z.string().max(10).optional().transform((v) => v || undefined),
  q: z.string().max(100).optional().transform((v) => v || undefined),
});

export async function reenviarFallidos(_previo: EstadoAccion, datos: FormData): Promise<EstadoAccion> {
  return ejecutar(async () => {
    const filtros = esquemaFiltros.parse(Object.fromEntries(datos));
    const ids = await idsFiltrados({ ...filtros, estado: "fallido" }, MAX_REENVIO_MASIVO);
    if (!ids.length) return { ok: true, mensaje: "No hay envíos fallidos con estos filtros." };
    return reenviar(ids);
  });
}

export async function ejecutarCicloAhora(): Promise<EstadoAccion> {
  return ejecutar(async () => {
    const resumen = await ejecutarCiclo({ origen: "manual", forzarVentana: true });
    if (!resumen) return { ok: false, mensaje: "Hay otra ejecución en curso. Intenta en unos minutos." };
    const base =
      `Planificados: ${resumen.planificados} · ${describir(resumen)} · ` +
      `Verificados: ${resumen.verificados} · Sheets: ${resumen.sincronizadosSheets}`;
    return resumen.errores.length
      ? { ok: false, mensaje: `${base}. Errores: ${resumen.errores.join(" | ")}` }
      : { ok: true, mensaje: base };
  });
}

export async function sincronizarSheetsAhora(): Promise<EstadoAccion> {
  return ejecutar(async () => {
    const n = await sincronizarSheets();
    return { ok: true, mensaje: n ? `${n} filas sincronizadas con Google Sheets.` : "Google Sheets ya estaba al día (o no está configurado)." };
  });
}

const urlHttpsOpcional = (mensaje: string) =>
  z
    .string()
    .trim()
    .max(2000)
    .refine((v) => v === "" || (URL.canParse(v) && new URL(v).protocol === "https:"), mensaje)
    .transform((v) => v || null);

const esquemaEtapa = z.object({
  codigo: z.string().min(1).max(10),
  ghl_webhook_url: urlHttpsOpcional("La URL del webhook debe empezar por https://"),
  activa: z.literal("on").optional(),
});

export async function guardarEtapa(_previo: EstadoAccion, datos: FormData): Promise<EstadoAccion> {
  return ejecutar(async () => {
    const etapa = esquemaEtapa.parse(Object.fromEntries(datos));
    const fila = await consultarUno<{ codigo: string }>(
      "UPDATE recordatorios.etapas SET ghl_webhook_url = $2, activa = $3 WHERE codigo = $1 RETURNING codigo",
      [etapa.codigo, etapa.ghl_webhook_url, etapa.activa === "on"],
    );
    return fila ? { ok: true, mensaje: `Etapa ${fila.codigo} guardada.` } : { ok: false, mensaje: "Etapa no encontrada." };
  });
}

const esquemaProducto = z.object({
  producto_id: z.guid(),
  activo: z.literal("on").optional(),
  lanzamiento_id: z.union([z.literal(""), z.guid()]).transform((v) => v || null),
  ...Object.fromEntries(
    COLUMNAS_LINK.flatMap(({ pasarela, referido, titulo }) =>
      CUOTAS_CON_LINK.map((cuotas) => [
        campoLink(pasarela, referido, cuotas),
        urlHttpsOpcional(`El link de ${titulo} · ${cuotas} cuotas debe empezar por https://`),
      ]),
    ),
  ),
});

/**
 * Activa o pausa un producto de cartera, lo asocia a su lanzamiento (de cuyos
 * enlaces de ventas salen los links) y guarda los ajustes manuales de links.
 */
export async function guardarProducto(_previo: EstadoAccion, datos: FormData): Promise<EstadoAccion> {
  return ejecutar(async () => {
    const producto = esquemaProducto.parse(Object.fromEntries(datos)) as Record<string, string | null | undefined>;
    const links = COLUMNAS_LINK.flatMap(({ pasarela, referido }) =>
      CUOTAS_CON_LINK.map((cuotas) => ({
        pasarela,
        referido,
        cuotas,
        url: producto[campoLink(pasarela, referido, cuotas)] ?? null,
      })),
    );

    // El nombre se toma de cartera; el FK de links_pago se valida al final de la sentencia.
    const fila = await consultarUno<{ nombre: string }>(
      `WITH p AS (
         INSERT INTO recordatorios.productos (producto_id, nombre, activo, lanzamiento_id)
         SELECT id, nombre, $2, $3 FROM public.cartera_productos WHERE id = $1
         ON CONFLICT (producto_id) DO UPDATE
           SET activo = EXCLUDED.activo, nombre = EXCLUDED.nombre, lanzamiento_id = EXCLUDED.lanzamiento_id
         RETURNING producto_id, nombre
       ), l AS (
         INSERT INTO recordatorios.links_pago (producto_id, pasarela, referido, cuotas, url)
         SELECT p.producto_id, v.pasarela, v.referido, v.cuotas, v.url
         FROM p, unnest($4::text[], $5::boolean[], $6::int[], $7::text[]) AS v (pasarela, referido, cuotas, url)
         ON CONFLICT (producto_id, pasarela, cuotas, referido) DO UPDATE SET url = EXCLUDED.url, actualizado_en = now()
           WHERE recordatorios.links_pago.url IS DISTINCT FROM EXCLUDED.url
       )
       SELECT nombre FROM p`,
      [
        producto.producto_id,
        producto.activo === "on",
        producto.lanzamiento_id,
        links.map((l) => l.pasarela),
        links.map((l) => l.referido),
        links.map((l) => l.cuotas),
        links.map((l) => l.url),
      ],
    );
    if (!fila) return { ok: false, mensaje: "Producto no encontrado en cartera." };
    const manuales = links.filter((l) => l.url).length;
    return {
      ok: true,
      mensaje: `${fila.nombre}: ${producto.activo === "on" ? "activo" : "pausado"}${manuales ? ` · ${manuales} links manuales` : ""}.`,
    };
  });
}

const esquemaAjustes = z.object({
  link_soporte: urlHttpsOpcional("El link de soporte debe empezar por https://"),
});

export async function guardarAjustes(_previo: EstadoAccion, datos: FormData): Promise<EstadoAccion> {
  return ejecutar(async () => {
    const ajustes = esquemaAjustes.parse(Object.fromEntries(datos));
    await consultarUno(
      `INSERT INTO recordatorios.ajustes (clave, valor) VALUES ('link_soporte', $1)
       ON CONFLICT (clave) DO UPDATE SET valor = EXCLUDED.valor, actualizado_en = now()`,
      [ajustes.link_soporte],
    );
    return { ok: true, mensaje: ajustes.link_soporte ? "Link de soporte guardado." : "Link de soporte borrado." };
  });
}
