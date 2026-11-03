/**
 * Normalización de celulares a E.164 usando el país de la compra.
 *
 * En cartera los teléfonos llegan en muchos formatos ("+1 305...", "1 (305) 555-1234",
 * "573001234567", "3001234567"...) y de muchos países. Regla:
 *   1. "+..." o "00..." ya traen indicativo.
 *   2. Si los dígitos tienen la longitud de un número nacional del país de la
 *      compra (y no empiezan ya por su indicativo), se antepone el indicativo.
 *   3. En otro caso se asume que el número ya incluye su indicativo (pasa con
 *      quien vive en EE. UU. y registró un celular de su país de origen).
 */

interface Pais {
  indicativo: string;
  /** Longitudes posibles del número nacional, sin el 0 de marcación. */
  nacional: number[];
}

const NANP: Pais = { indicativo: "1", nacional: [10] };

const PAISES: Record<string, Pais> = {
  "ESTADOS UNIDOS": NANP,
  "UNITED STATES": NANP,
  USA: NANP,
  EEUU: NANP,
  CANADA: NANP,
  "PUERTO RICO": NANP,
  "REPUBLICA DOMINICANA": NANP,
  "ISLAS CAIMAN": NANP,
  COLOMBIA: { indicativo: "57", nacional: [10] },
  MEXICO: { indicativo: "52", nacional: [10] },
  PERU: { indicativo: "51", nacional: [9] },
  ECUADOR: { indicativo: "593", nacional: [9] },
  ARGENTINA: { indicativo: "54", nacional: [10] },
  CHILE: { indicativo: "56", nacional: [9] },
  VENEZUELA: { indicativo: "58", nacional: [10] },
  BOLIVIA: { indicativo: "591", nacional: [8] },
  PARAGUAY: { indicativo: "595", nacional: [9] },
  URUGUAY: { indicativo: "598", nacional: [8] },
  BRASIL: { indicativo: "55", nacional: [10, 11] },
  "COSTA RICA": { indicativo: "506", nacional: [8] },
  PANAMA: { indicativo: "507", nacional: [8] },
  HONDURAS: { indicativo: "504", nacional: [8] },
  "EL SALVADOR": { indicativo: "503", nacional: [8] },
  GUATEMALA: { indicativo: "502", nacional: [8] },
  NICARAGUA: { indicativo: "505", nacional: [8] },
  ARUBA: { indicativo: "297", nacional: [7] },
  ESPANA: { indicativo: "34", nacional: [9] },
  ITALIA: { indicativo: "39", nacional: [9, 10] },
  "REINO UNIDO": { indicativo: "44", nacional: [10] },
  "UNITED KINGDOM": { indicativo: "44", nacional: [10] },
  "PAISES BAJOS": { indicativo: "31", nacional: [9] },
  POLONIA: { indicativo: "48", nacional: [9] },
  MALTA: { indicativo: "356", nacional: [8] },
  AUSTRALIA: { indicativo: "61", nacional: [9] },
  "NUEVA ZELANDA": { indicativo: "64", nacional: [8, 9, 10] },
  FILIPINAS: { indicativo: "63", nacional: [10] },
};

/** "México " -> "MEXICO", "España" -> "ESPANA" */
const clavePais = (pais: string) =>
  pais.normalize("NFD").replace(/[̀-ͯ]/g, "").trim().toUpperCase().replace(/\s+/g, " ");

export function normalizarTelefono(
  crudo: string | null | undefined,
  pais: string | null | undefined,
  indicativoPorDefecto: string,
): string | null {
  if (!crudo) return null;
  const limpio = crudo.trim();
  let digitos = limpio.replace(/\D/g, "");
  if (!digitos) return null;

  if (limpio.startsWith("+")) {
    // ya trae indicativo
  } else if (digitos.startsWith("00")) {
    digitos = digitos.slice(2);
  } else {
    const info = (pais && PAISES[clavePais(pais)]) || { indicativo: indicativoPorDefecto, nacional: [10] };
    const nacional = digitos.replace(/^0+/, "");
    const yaTraeIndicativo =
      digitos.startsWith(info.indicativo) && info.nacional.includes(digitos.length - info.indicativo.length);
    if (!yaTraeIndicativo && info.nacional.includes(nacional.length)) digitos = info.indicativo + nacional;
  }

  return digitos.length >= 8 && digitos.length <= 15 ? `+${digitos}` : null;
}
