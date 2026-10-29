import type { Ejecucion } from "@/lib/recordatorios/consultas";
import { formatearFechaHora } from "@/lib/utilidades";

export function Ejecuciones({ ejecuciones, zona }: { ejecuciones: Ejecucion[]; zona: string }) {
  if (!ejecuciones.length) {
    return <p className="text-sm text-neutral-600">Aún no hay ejecuciones. El cron o el botón “Ejecutar ciclo ahora” crean la primera.</p>;
  }

  return (
    <ol className="divide-y divide-neutral-100">
      {ejecuciones.map((x) => (
        <li key={x.id} className="py-3 text-sm">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <span className="font-semibold">
              {formatearFechaHora(x.iniciada_en, zona)}{" "}
              <span className="font-normal text-neutral-600">· {x.origen === "cron" ? "Cron" : "Manual"}</span>
            </span>
            <span className={`text-xs font-semibold ${x.error ? "text-red-700" : x.finalizada_en ? "text-emerald-800" : "text-sky-800"}`}>
              {x.error ? "Con errores" : x.finalizada_en ? "Completa" : "En curso"}
            </span>
          </div>
          <p className="mt-1 text-xs text-neutral-600">
            Planificados {x.planificados} · Enviados {x.enviados} · Fallidos {x.fallidos} · Omitidos {x.omitidos} ·
            Verificados {x.verificados} · Sheets {x.sincronizados_sheets}
          </p>
          {x.error && <p className="mt-1 text-xs break-words text-red-700">{x.error}</p>}
        </li>
      ))}
    </ol>
  );
}
