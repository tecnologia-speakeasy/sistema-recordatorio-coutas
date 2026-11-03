"use client";

import { useActionState } from "react";
import { guardarEtapa } from "@/app/acciones";
import type { Etapa } from "@/lib/recordatorios/tipos";

function cuando(etapa: Etapa, horasSeguimiento: number) {
  if (etapa.offset_dias === null) return `${horasSeguimiento} h después del clic en el link`;
  if (etapa.offset_dias === 0) return "el día 20";
  const dias = Math.abs(etapa.offset_dias);
  return `${dias} día${dias === 1 ? "" : "s"} ${etapa.offset_dias < 0 ? "antes" : "después"} del 20`;
}

export function FormularioEtapa({ etapa, horasSeguimiento }: { etapa: Etapa; horasSeguimiento: number }) {
  const [estado, guardar, pendiente] = useActionState(guardarEtapa, null);
  const idCampo = `webhook-${etapa.codigo}`;
  const idActiva = `activa-${etapa.codigo}`;

  return (
    <form action={guardar} className="grid gap-3 rounded-2xl border border-morado/10 p-4">
      <input type="hidden" name="codigo" value={etapa.codigo} />
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <p className="text-sm font-bold text-morado">
            {etapa.codigo} · {etapa.nombre}
          </p>
          <p className="text-xs text-neutral-600">
            Sale {cuando(etapa, horasSeguimiento)}
            {etapa.plantilla ? (
              <>
                {" "}
                · plantilla <code>{etapa.plantilla}</code>
              </>
            ) : (
              " · mensaje normal (sin plantilla)"
            )}
          </p>
        </div>
        <label htmlFor={idActiva} className="flex items-center gap-2 text-sm font-medium">
          <input id={idActiva} type="checkbox" name="activa" defaultChecked={etapa.activa} className="size-4 accent-fucsia-oscuro" />
          Activa
        </label>
      </div>
      <div className="flex flex-col gap-1">
        <label htmlFor={idCampo} className="text-xs font-semibold text-neutral-700">
          URL del webhook entrante del workflow (disparador Inbound Webhook)
        </label>
        <input
          id={idCampo}
          name="ghl_webhook_url"
          type="url"
          defaultValue={etapa.ghl_webhook_url ?? ""}
          placeholder="https://services.leadconnectorhq.com/hooks/…"
          className="rounded-xl border border-neutral-300 px-3 py-2 font-mono text-xs"
        />
      </div>
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
