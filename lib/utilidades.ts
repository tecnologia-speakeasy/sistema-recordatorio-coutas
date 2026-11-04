/** Fecha actual 'YYYY-MM-DD' en la zona horaria del negocio (no la del servidor). */
export function hoyEnZona(zona: string, ahora = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: zona,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(ahora);
}

export function esFechaIso(valor: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(valor) && !Number.isNaN(Date.parse(`${valor}T00:00:00Z`));
}

/** "MARÍA FERNANDA LÓPEZ" -> "María" (para el saludo de la plantilla). */
export function primerNombre(nombre: string | null | undefined): string {
  const primero = (nombre ?? "").trim().split(/\s+/)[0] ?? "";
  return primero ? primero.charAt(0).toLocaleUpperCase("es") + primero.slice(1).toLocaleLowerCase("es") : "";
}

export const esUrlHttp = (valor: string | null | undefined): valor is string =>
  !!valor && /^https?:\/\//i.test(valor) && URL.canParse(valor);

/** Forma básica de un correo (usuario@dominio.ext), sin espacios. */
export const esCorreo = (valor: string | null | undefined): valor is string =>
  !!valor && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(valor);

/** '2026-11-20' -> '20 de noviembre' (sin desfase de zona horaria). */
export function formatearFechaLarga(fechaIso: string): string {
  return new Intl.DateTimeFormat("es-CO", { day: "numeric", month: "long", timeZone: "UTC" }).format(
    new Date(`${fechaIso}T00:00:00Z`),
  );
}

/** Date -> '28 oct, 08:15' en la zona del negocio. */
export function formatearFechaHora(fecha: Date | null, zona: string): string {
  if (!fecha) return "";
  return new Intl.DateTimeFormat("es-CO", {
    timeZone: zona,
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(fecha);
}

/** '2026-11-20' -> '20 nov 2026' */
export function formatearFechaCorta(fechaIso: string): string {
  return new Intl.DateTimeFormat("es-CO", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" }).format(
    new Date(`${fechaIso}T00:00:00Z`),
  );
}

/** Suma días a una fecha 'YYYY-MM-DD' sin pasar por la zona horaria local. */
export function sumarDias(fechaIso: string, dias: number): string {
  const fecha = new Date(`${fechaIso}T00:00:00Z`);
  fecha.setUTCDate(fecha.getUTCDate() + dias);
  return fecha.toISOString().slice(0, 10);
}

export const esperar = (ms: number) => new Promise((resolver) => setTimeout(resolver, ms));

export function mensajeDeError(error: unknown): string {
  if (error instanceof Error) return error.message;
  return typeof error === "string" ? error : JSON.stringify(error);
}
