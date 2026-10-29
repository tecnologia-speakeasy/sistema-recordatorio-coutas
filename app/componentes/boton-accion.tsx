"use client";

import { useActionState } from "react";
import type { EstadoAccion } from "@/app/acciones";

const VARIANTES = {
  primario: "bg-fucsia-oscuro text-white hover:bg-[#b80f50]",
  secundario: "bg-white text-morado ring-1 ring-morado/25 hover:bg-morado-claro",
  sutil: "bg-transparent text-morado underline-offset-2 hover:underline px-1",
} as const;

interface Props {
  accion: (previo: EstadoAccion, datos: FormData) => Promise<EstadoAccion>;
  etiqueta: string;
  etiquetaPendiente?: string;
  campos?: Record<string, string | undefined>;
  variante?: keyof typeof VARIANTES;
  confirmar?: string;
  /** Muestra el resultado debajo del botón (en filas de tabla conviene ocultarlo). */
  mostrarResultado?: boolean;
}

export function BotonAccion({
  accion,
  etiqueta,
  etiquetaPendiente = "Procesando…",
  campos = {},
  variante = "primario",
  confirmar,
  mostrarResultado = true,
}: Props) {
  const [estado, ejecutar, pendiente] = useActionState(accion, null);

  return (
    <form
      action={ejecutar}
      onSubmit={(e) => {
        if (confirmar && !window.confirm(confirmar)) e.preventDefault();
      }}
      className="flex flex-col items-start gap-1"
    >
      {Object.entries(campos).map(([nombre, valor]) =>
        valor === undefined ? null : <input key={nombre} type="hidden" name={nombre} value={valor} />,
      )}
      <button
        type="submit"
        disabled={pendiente}
        className={`rounded-full px-4 py-2 text-sm font-semibold transition-colors disabled:cursor-wait disabled:opacity-60 ${VARIANTES[variante]}`}
      >
        {pendiente ? etiquetaPendiente : etiqueta}
      </button>
      <p
        role="status"
        aria-live="polite"
        title={!mostrarResultado ? (estado?.mensaje ?? undefined) : undefined}
        className={`max-w-md text-xs ${estado?.ok ? "text-emerald-800" : "text-red-700"} ${
          mostrarResultado ? "" : "sr-only"
        }`}
      >
        {estado?.mensaje}
      </p>
    </form>
  );
}
