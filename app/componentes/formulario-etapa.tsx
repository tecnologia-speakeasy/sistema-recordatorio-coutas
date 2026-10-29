"use client";

import { useActionState } from "react";
import { guardarEtapa } from "@/app/acciones";
import type { Etapa } from "@/lib/recordatorios/tipos";

export function FormularioEtapa({ etapa }: { etapa: Etapa }) {
  const [estado, guardar, pendiente] = useActionState(guardarEtapa, null);
  const idCampo = `workflow-${etapa.codigo}`;
  const idActiva = `activa-${etapa.codigo}`;

  return (
    <form action={guardar} className="grid gap-3 rounded-2xl border border-morado/10 p-4 sm:grid-cols-[8rem_1fr_auto_auto] sm:items-end">
      <input type="hidden" name="codigo" value={etapa.codigo} />
      <div>
        <p className="text-sm font-bold text-morado">{etapa.codigo}</p>
        <p className="text-xs text-neutral-600">
          {etapa.nombre} ({etapa.offset_dias > 0 ? `+${etapa.offset_dias}` : etapa.offset_dias} d)
        </p>
      </div>
      <div className="flex flex-col gap-1">
        <label htmlFor={idCampo} className="text-xs font-semibold text-neutral-700">
          ID del workflow en GHL
        </label>
        <input
          id={idCampo}
          name="ghl_workflow_id"
          defaultValue={etapa.ghl_workflow_id ?? ""}
          placeholder="Sin configurar"
          className="rounded-xl border border-neutral-300 px-3 py-2 font-mono text-sm"
        />
      </div>
      <label htmlFor={idActiva} className="flex items-center gap-2 text-sm font-medium">
        <input id={idActiva} type="checkbox" name="activa" defaultChecked={etapa.activa} className="size-4 accent-fucsia-oscuro" />
        Activa
      </label>
      <div className="flex flex-col items-start gap-1">
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
