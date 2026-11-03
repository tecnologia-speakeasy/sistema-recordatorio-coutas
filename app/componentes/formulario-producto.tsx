"use client";

import { useActionState } from "react";
import { guardarProducto } from "@/app/acciones";
import type { Lanzamiento, ProductoCartera } from "@/lib/recordatorios/consultas";
import { campoLink, COLUMNAS_LINK, CUOTAS_CON_LINK, type Pasarela } from "@/lib/recordatorios/tipos";

/**
 * Activa/pausa un producto de cartera, elige el lanzamiento del que salen sus
 * links (enlaces de ventas) y permite ajustar a mano cualquier link.
 */
export function FormularioProducto({ producto, lanzamientos }: { producto: ProductoCartera; lanzamientos: Lanzamiento[] }) {
  const [estado, guardar, pendiente] = useActionState(guardarProducto, null);
  const buscar = <T extends { pasarela: Pasarela; referido: boolean; cuotas: number }>(lista: T[], pasarela: Pasarela, referido: boolean, cuotas: number) =>
    lista.find((l) => l.pasarela === pasarela && l.referido === referido && l.cuotas === cuotas);
  const idActivo = `producto-${producto.producto_id}`;
  const idLanzamiento = `lanzamiento-${producto.producto_id}`;

  return (
    <form action={guardar} className="flex flex-col gap-4 rounded-2xl border border-morado/10 p-4">
      <input type="hidden" name="producto_id" value={producto.producto_id} />
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="text-sm font-bold text-morado">{producto.nombre}</p>
          <p className="text-xs text-neutral-600">{producto.compras_en_cuotas} compras en cuotas</p>
        </div>
        <label htmlFor={idActivo} className="flex items-center gap-2 text-sm font-medium">
          <input id={idActivo} type="checkbox" name="activo" defaultChecked={producto.activo} className="size-4 accent-fucsia-oscuro" />
          Enviar recordatorios
        </label>
      </div>

      <div className="flex flex-col gap-1">
        <label htmlFor={idLanzamiento} className="text-xs font-semibold text-neutral-700">
          Lanzamiento (los links salen de su sección «Enlaces de ventas»)
        </label>
        <select
          id={idLanzamiento}
          name="lanzamiento_id"
          defaultValue={producto.lanzamiento_id ?? ""}
          className="max-w-md rounded-xl border border-neutral-300 bg-white px-3 py-2 text-sm"
        >
          <option value="">Ninguno (solo links manuales)</option>
          {lanzamientos.map((l) => (
            <option key={l.id} value={l.id}>
              {l.nombre}
            </option>
          ))}
        </select>
      </div>

      <div className="overflow-x-auto">
        <table className="w-full min-w-[48rem] text-left text-xs">
          <caption className="sr-only">Links de pago de {producto.nombre}</caption>
          <thead className="text-neutral-700">
            <tr>
              <th scope="col" className="w-20 py-1 pr-2 font-semibold">
                Plan
              </th>
              {COLUMNAS_LINK.map((c) => (
                <th key={c.titulo} scope="col" className="py-1 pr-2 font-semibold">
                  {c.titulo}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {CUOTAS_CON_LINK.map((cuotas) => (
              <tr key={cuotas} className="align-top">
                <th scope="row" className="py-1.5 pr-2 font-medium text-neutral-700">
                  {cuotas} cuotas
                </th>
                {COLUMNAS_LINK.map(({ pasarela, referido, titulo }) => {
                  const manual = buscar(producto.links, pasarela, referido, cuotas)?.url ?? "";
                  const delLanzamiento = buscar(producto.links_lanzamiento, pasarela, referido, cuotas);
                  return (
                    <td key={titulo} className="py-1.5 pr-2">
                      <input
                        name={campoLink(pasarela, referido, cuotas)}
                        type="url"
                        aria-label={`${titulo} · ${cuotas} cuotas`}
                        defaultValue={manual}
                        placeholder={delLanzamiento ? "Usa el del lanzamiento" : "Falta el link"}
                        className={`w-full rounded-lg border px-2 py-1 font-mono ${
                          manual || delLanzamiento ? "border-neutral-300" : "border-red-300 bg-red-50"
                        }`}
                      />
                      {delLanzamiento && !manual && (
                        <a
                          href={delLanzamiento.url ?? undefined}
                          target="_blank"
                          rel="noreferrer"
                          title={delLanzamiento.url ?? undefined}
                          className="mt-0.5 block truncate text-neutral-600 underline-offset-2 hover:underline"
                        >
                          {delLanzamiento.nombre}
                        </a>
                      )}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="text-xs text-neutral-600">
        Vacío = se usa el link del lanzamiento. Escribe una URL solo para reemplazarlo o para los planes que no tiene
        (en rojo).
      </p>

      <div className="flex flex-wrap items-center gap-3">
        <button
          type="submit"
          disabled={pendiente}
          className="rounded-full bg-morado px-4 py-2 text-sm font-semibold text-white hover:bg-morado-oscuro disabled:opacity-60"
        >
          {pendiente ? "Guardando…" : "Guardar"}
        </button>
        <p role="status" aria-live="polite" className={`text-xs ${estado?.ok ? "text-emerald-800" : "text-red-700"}`}>
          {estado?.mensaje}
        </p>
      </div>
    </form>
  );
}
