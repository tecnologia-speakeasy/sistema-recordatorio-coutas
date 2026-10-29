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
import type { ResultadoDespacho } from "@/lib/recordatorios/tipos";
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

const esquemaEtapa = z.object({
  codigo: z.string().min(1).max(10),
  ghl_workflow_id: z
    .string()
    .trim()
    .regex(/^[A-Za-z0-9-]{0,64}$/, "ID de workflow inválido")
    .transform((v) => v || null),
  activa: z.literal("on").optional(),
});

export async function guardarEtapa(_previo: EstadoAccion, datos: FormData): Promise<EstadoAccion> {
  return ejecutar(async () => {
    const etapa = esquemaEtapa.parse(Object.fromEntries(datos));
    const fila = await consultarUno<{ codigo: string }>(
      "UPDATE recordatorios.etapas SET ghl_workflow_id = $2, activa = $3 WHERE codigo = $1 RETURNING codigo",
      [etapa.codigo, etapa.ghl_workflow_id, etapa.activa === "on"],
    );
    return fila ? { ok: true, mensaje: `Etapa ${fila.codigo} guardada.` } : { ok: false, mensaje: "Etapa no encontrada." };
  });
}
