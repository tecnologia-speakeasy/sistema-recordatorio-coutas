import { NextResponse, type NextRequest } from "next/server";
import { basicValido } from "@/lib/auth";

/**
 * Protege el dashboard (páginas y server actions) con HTTP Basic Auth.
 * Quedan fuera: el redirect público /p/<token>, el cron y los webhooks, que
 * validan su propio secreto. Las server actions vuelven a validar por su cuenta.
 */
export function proxy(request: NextRequest) {
  const usuario = process.env.DASHBOARD_USUARIO;
  const clave = process.env.DASHBOARD_CLAVE;
  if (!usuario || !clave) {
    return new NextResponse("Configura DASHBOARD_USUARIO y DASHBOARD_CLAVE", { status: 503 });
  }

  if (basicValido(request.headers.get("authorization"), usuario, clave)) {
    return NextResponse.next();
  }

  return new NextResponse("Autenticación requerida", {
    status: 401,
    headers: { "WWW-Authenticate": 'Basic realm="Recordatorios de cuotas", charset="UTF-8"' },
  });
}

export const config = {
  matcher: ["/((?!p/|api/cron|api/webhooks|_next/static|_next/image|favicon.ico|marca/).*)"],
};
