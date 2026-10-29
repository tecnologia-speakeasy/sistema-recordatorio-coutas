import { createHash, timingSafeEqual } from "node:crypto";

/** Comparación en tiempo constante (se hashea para igualar longitudes). */
export function igualSeguro(a: string, b: string): boolean {
  const ha = createHash("sha256").update(a).digest();
  const hb = createHash("sha256").update(b).digest();
  return timingSafeEqual(ha, hb);
}

/** Valida un encabezado `Authorization: Basic ...` contra usuario y clave. */
export function basicValido(encabezado: string | null, usuario: string, clave: string): boolean {
  if (!encabezado?.startsWith("Basic ")) return false;
  const decodificado = Buffer.from(encabezado.slice(6), "base64").toString("utf8");
  const separador = decodificado.indexOf(":");
  if (separador < 0) return false;
  const usuarioOk = igualSeguro(decodificado.slice(0, separador), usuario);
  const claveOk = igualSeguro(decodificado.slice(separador + 1), clave);
  return usuarioOk && claveOk;
}

/** Valida `Authorization: Bearer <secreto>` (formato que usa Vercel Cron). */
export function bearerValido(encabezado: string | null, secreto: string): boolean {
  if (!encabezado?.startsWith("Bearer ")) return false;
  return igualSeguro(encabezado.slice(7), secreto);
}
