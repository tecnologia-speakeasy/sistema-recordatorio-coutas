import { igualSeguro } from "@/lib/auth";
import { registrarRespuesta, registrarSinContacto } from "@/lib/recordatorios/interacciones";
import { AVISO_SIN_CONTACTO, RESPUESTAS, type Respuesta } from "@/lib/recordatorios/tipos";

/**
 * Avisos de los workflows de GHL, por su acción "Webhook":
 *   URL:   https://<app>/api/webhooks/ghl?secret=<GHL_WEBHOOK_SECRET>
 *   Datos: token     = {{inboundWebhookRequest.token}}
 *          respuesta = pago_realizado | realizar_pago | soporte   (botón tocado; también
 *                      acepta el texto del botón: "Pago realizado")
 *                    | contacto_no_encontrado                    (rama "no encontrado" de
 *                      Find Contact: el WhatsApp no salió)
 * "Pago realizado" queda en el dashboard y en Google Sheets, y detiene los
 * recordatorios restantes de esa cuota. "contacto_no_encontrado" deja el envío
 * fallido en la alerta "Sin contacto en GHL".
 */
export async function POST(request: Request) {
  const secreto = process.env.GHL_WEBHOOK_SECRET;
  if (!secreto) return Response.json({ ok: false, error: "Webhook deshabilitado" }, { status: 404 });

  const recibido = new URL(request.url).searchParams.get("secret") ?? request.headers.get("x-webhook-secret") ?? "";
  if (!igualSeguro(recibido, secreto)) return Response.json({ ok: false, error: "No autorizado" }, { status: 401 });

  let cuerpo: Record<string, unknown>;
  try {
    cuerpo = (await request.json()) as Record<string, unknown>;
  } catch {
    return Response.json({ ok: false, error: "JSON inválido" }, { status: 400 });
  }

  // GHL manda los datos personalizados en `customData` (acción Webhook) o en la raíz.
  const custom = (cuerpo.customData ?? {}) as Record<string, unknown>;
  const token = texto(custom.token ?? cuerpo.token);
  const aviso = normalizar(custom.respuesta ?? cuerpo.respuesta);

  if (!/^[a-f0-9]{32}$/.test(token)) return Response.json({ ok: false, error: "Falta token" }, { status: 422 });

  let envioId: string | null;
  if (aviso === AVISO_SIN_CONTACTO) {
    envioId = await registrarSinContacto(token);
  } else if (esRespuesta(aviso)) {
    envioId = await registrarRespuesta(token, aviso);
  } else {
    const validas = [...Object.keys(RESPUESTAS), AVISO_SIN_CONTACTO].join(", ");
    return Response.json({ ok: false, error: `respuesta debe ser una de: ${validas}` }, { status: 422 });
  }

  if (!envioId) return Response.json({ ok: false, error: "Envío no encontrado" }, { status: 404 });
  return Response.json({ ok: true, envio_id: envioId });
}

const texto = (valor: unknown) => (typeof valor === "string" ? valor.trim() : "");

/** "Pago realizado" -> "pago_realizado" */
const normalizar = (valor: unknown) =>
  texto(valor)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[\s-]+/g, "_");

const esRespuesta = (clave: string): clave is Respuesta => Object.hasOwn(RESPUESTAS, clave);
