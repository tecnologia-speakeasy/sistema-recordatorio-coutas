import Form from "next/form";
import Link from "next/link";
import type { FiltrosEnvios } from "@/lib/recordatorios/consultas";
import { ESTADOS_ENVIO, type Etapa } from "@/lib/recordatorios/tipos";
import { ETIQUETAS_ESTADO } from "./insignia-estado";

const campo = "rounded-xl border border-neutral-300 bg-white px-3 py-2 text-sm";
const etiqueta = "flex flex-col gap-1 text-xs font-semibold text-neutral-700";

export function Filtros({ filtros, etapas }: { filtros: FiltrosEnvios; etapas: Etapa[] }) {
  return (
    <Form action="/" className="flex flex-wrap items-end gap-3">
      <label className={etiqueta}>
        Desde
        <input type="date" name="desde" defaultValue={filtros.desde} className={campo} />
      </label>
      <label className={etiqueta}>
        Hasta
        <input type="date" name="hasta" defaultValue={filtros.hasta} className={campo} />
      </label>
      <label className={etiqueta}>
        Estado
        <select name="estado" defaultValue={filtros.estado ?? ""} className={campo}>
          <option value="">Todos</option>
          {ESTADOS_ENVIO.map((e) => (
            <option key={e} value={e}>
              {ETIQUETAS_ESTADO[e]}
            </option>
          ))}
        </select>
      </label>
      <label className={etiqueta}>
        Etapa
        <select name="etapa" defaultValue={filtros.etapa ?? ""} className={campo}>
          <option value="">Todas</option>
          {etapas.map((e) => (
            <option key={e.codigo} value={e.codigo}>
              {e.codigo} · {e.nombre}
            </option>
          ))}
        </select>
      </label>
      <label className={`${etiqueta} min-w-48 flex-1`}>
        Buscar
        <input
          type="search"
          name="q"
          defaultValue={filtros.q ?? ""}
          placeholder="Nombre, teléfono, cuota o cliente"
          className={campo}
        />
      </label>
      <div className="flex items-center gap-3">
        <button type="submit" className="rounded-full bg-morado px-5 py-2 text-sm font-semibold text-white hover:bg-morado-oscuro">
          Filtrar
        </button>
        <Link href="/" className="text-sm font-semibold text-morado underline-offset-2 hover:underline">
          Limpiar
        </Link>
      </div>
    </Form>
  );
}
