"use client";

import { useActionState } from "react";
import { guardarAjustes } from "@/app/acciones";

/** Ajustes que llegan a todos los workflows (hoy: el link del chat de soporte). */
export function FormularioAjustes({ linkSoporte }: { linkSoporte: string | null }) {
  const [estado, guardar, pendiente] = useActionState(guardarAjustes, null);

  return (
    <form action={guardar} className="grid gap-2 rounded-2xl border border-morado/10 p-4">
      <label htmlFor="link-soporte" className="text-sm font-bold text-morado">
        Link del chat de soporte
      </label>
      <p className="text-xs text-neutral-600">
        Botón del mensaje de soporte. Llega a los workflows como <code>{"{{inboundWebhookRequest.link_soporte}}"}</code>.
      </p>
      <input
        id="link-soporte"
        name="link_soporte"
        type="url"
        defaultValue={linkSoporte ?? ""}
        placeholder="https://wa.me/57…"
        className="rounded-xl border border-neutral-300 px-3 py-2 font-mono text-xs"
      />
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
