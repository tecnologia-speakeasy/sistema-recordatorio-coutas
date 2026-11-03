import { igualSeguro } from "@/lib/auth";
import { registrarRespuesta } from "@/lib/recordatorios/interacciones";
import { RESPUESTAS, type Respuesta } from "@/lib/recordatorios/tipos";

/**
 * Respuestas a los botones de WhatsApp, informadas por la acción "Webhook" del
 * workflow de GHL en la rama de cada botón.
 *   URL:   https://<app>/api/webhooks/ghl?secret=<GHL_WEBHOOK_SECRET>
 *   Datos: token     = {{inboundWebhookRequest.token}}
 *          respuesta = pago_realizado | realizar_pago | soporte
 *                      (también acepta el texto del botón: "Pago realizado")
 * "Pago realizado" queda en el dashboard y en Google Sheets, y detiene los
 * recordatorios restantes de esa cuota.
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
  const respuesta = normalizarRespuesta(custom.respuesta ?? cuerpo.respuesta);

  if (!/^[a-f0-9]{32}$/.test(token)) return Response.json({ ok: false, error: "Falta token" }, { status: 422 });
  if (!respuesta) {
    const validas = Object.keys(RESPUESTAS).join(", ");
    return Response.json({ ok: false, error: `respuesta debe ser una de: ${validas}` }, { status: 422 });
  }

  const envioId = await registrarRespuesta(token, respuesta);
  if (!envioId) return Response.json({ ok: false, error: "Envío no encontrado" }, { status: 404 });
  return Response.json({ ok: true, envio_id: envioId });
}

const texto = (valor: unknown) => (typeof valor === "string" ? valor.trim() : "");

/** "Pago realizado" -> "pago_realizado" */
function normalizarRespuesta(valor: unknown): Respuesta | null {
  const clave = texto(valor)
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[\s-]+/g, "_");
  return Object.hasOwn(RESPUESTAS, clave) ? (clave as Respuesta) : null;
}
