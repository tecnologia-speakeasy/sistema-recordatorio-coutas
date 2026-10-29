import { igualSeguro } from "@/lib/auth";
import { consultarUno } from "@/lib/db";
import { registrarEvento } from "@/lib/recordatorios/bitacora";

/**
 * Confirmación opcional desde el workflow de GHL (acción "Webhook" después de
 * enviar el WhatsApp). URL: https://<app>/api/webhooks/ghl?secret=<GHL_WEBHOOK_SECRET>
 * Datos personalizados esperados: envio_id = {{contact.recordatorio_envio_id}}
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

  const envioId = extraerEnvioId(cuerpo);
  if (!envioId) return Response.json({ ok: false, error: "Falta envio_id" }, { status: 422 });

  const envio = await consultarUno<{ id: string }>(
    `UPDATE recordatorios.envios
     SET confirmado_workflow_en = now()
     WHERE id = $1 AND estado IN ('enviado', 'entregado', 'leido')
     RETURNING id`,
    [envioId],
  );
  if (!envio) return Response.json({ ok: false, error: "Envío no encontrado o no enviado" }, { status: 404 });

  await registrarEvento(envio.id, "webhook_workflow", {
    contactId: cuerpo.contact_id ?? null,
    workflow: (cuerpo.workflow as { name?: string } | undefined)?.name ?? null,
  });
  return Response.json({ ok: true });
}

/** GHL anida los datos personalizados de forma distinta según la acción; se buscan en ambos lugares. */
function extraerEnvioId(cuerpo: Record<string, unknown>): string | null {
  const custom = (cuerpo.customData ?? {}) as Record<string, unknown>;
  const valor =
    cuerpo.envio_id ?? custom.envio_id ?? cuerpo.recordatorio_envio_id ?? custom.recordatorio_envio_id;
  const texto = typeof valor === "number" ? String(valor) : typeof valor === "string" ? valor.trim() : "";
  return /^\d{1,18}$/.test(texto) ? texto : null;
}
