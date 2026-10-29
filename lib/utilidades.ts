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

/**
 * Normaliza un celular a E.164. Acepta "+57 300 123 4567", "573001234567",
 * "3001234567" (asume el código de país por defecto) o "0057...".
 * Devuelve null si no parece un número válido.
 */
export function normalizarTelefono(crudo: string | null | undefined, codigoPais: string): string | null {
  if (!crudo) return null;
  const limpio = crudo.trim();
  let digitos = limpio.replace(/\D/g, "");
  if (!digitos) return null;

  if (limpio.startsWith("+")) {
    // ya trae código de país
  } else if (digitos.startsWith("00")) {
    digitos = digitos.slice(2);
  } else if (digitos.length <= 10) {
    digitos = codigoPais + digitos.replace(/^0+/, "");
  }

  return digitos.length >= 10 && digitos.length <= 15 ? `+${digitos}` : null;
}

export function formatearMoneda(valor: string | number | null, moneda = "COP"): string {
  if (valor === null || valor === "") return "";
  return new Intl.NumberFormat("es-CO", {
    style: "currency",
    currency: moneda,
    maximumFractionDigits: 0,
  }).format(Number(valor));
}

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
