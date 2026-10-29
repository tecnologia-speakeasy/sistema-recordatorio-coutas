# Sistema de recordatorios de cuotas (WhatsApp vía GHL)

Envía recordatorios de pago por WhatsApp (plantillas *Utility* con botón de URL dinámica) a partir de las cuotas de una base PostgreSQL, registra cada envío en un esquema propio, verifica la entrega real en GHL, refleja todo en Google Sheets y ofrece un dashboard para revisar y reenviar.

Stack: Next.js 16 (App Router, Cache Components, `proxy.ts`), `pg`, `zod`. Sin n8n ni SDKs externos.

---

## Arquitectura

```
                 ┌─────────────── cron (cada hora 8–19 h) ───────────────┐
                 ▼                                                        │
  GET /api/cron/recordatorios  (Bearer CRON_SECRET)                       │
        │                                                                 │
        ├─ 1. Higiene     colgados → fallido · pendientes de días previos → omitido
        ├─ 2. Planificar  v_cuotas_fuente × etapas activas → recordatorios.envios
        │                 (UNIQUE cuota+vencimiento+etapa ⇒ idempotente)
        ├─ 3. Despachar   relee la fuente (¿pagó? ¿cambió el teléfono?)
        │                 → GHL upsert contacto + campos personalizados
        │                 → GHL inscribir en workflow de la etapa ──► workflow envía la plantilla
        ├─ 4. Verificar   GHL conversaciones → entregado / leído / fallido (+ error de WhatsApp)
        └─ 5. Sheets      una fila por envío, actualizada en sitio

  Botón de la plantilla:  https://APP_URL/p/{{token}} ──► registra clic ──► 302 al link de pago del usuario
  Dashboard (/):          KPIs, filtros, reenvío individual/masivo, ejecuciones, configuración de etapas
```

### ¿Por qué un workflow de GHL y no la API de mensajes?

La API pública `POST /conversations/messages` acepta `type: "WhatsApp"` pero **no expone el envío de plantillas con variables** (no hay campos de nombre de plantilla, variables ni botones). Por eso el sistema escribe los datos del recordatorio en **campos personalizados del contacto** y lo **inscribe en un workflow**, que es quien envía la plantilla aprobada mapeando esos campos.

### ¿Se necesita un cron?

Sí, algo tiene que disparar el ciclo cada día. Lo recomendable es **cada hora dentro de la ventana de envío**, no una vez al día:

- el día 17 salen todos los D-3 a la vez; si no alcanzan en una ejecución, la siguiente continúa;
- la verificación de entrega solo es útil si corre unas horas después del envío (así reenvías el mismo día);
- todo el ciclo es idempotente: ejecutarlo de más no duplica mensajes.

---

## Requisitos

- Node.js ≥ 20.9
- PostgreSQL ≥ 13 (usa `gen_random_uuid()`)
- Subcuenta de GHL con WhatsApp conectado y plantillas aprobadas por Meta
- (Opcional) Proyecto de Google Cloud con Sheets API

---

## Puesta en marcha

### 1. Variables de entorno

```bash
cp .env.example .env.local
```

Genera los secretos con `openssl rand -hex 32`. Deja `GHL_DRY_RUN=true` hasta terminar las pruebas.

### 2. Vista fuente (contrato con tu BD)

El sistema **solo lee** `recordatorios.v_cuotas_fuente`. Adapta [db/vista_fuente.ejemplo.sql](db/vista_fuente.ejemplo.sql) a tus tablas y guárdalo como `db/migraciones/002_vista_fuente.sql`. Columnas obligatorias:

| Columna | Tipo | Notas |
|---|---|---|
| `cuota_id` | text | Único y estable por cuota |
| `cliente_id` | text | Informativo |
| `nombre` | text | Se usa como `firstName`/`lastName` en GHL |
| `telefono` | text | Se normaliza a E.164 con `TELEFONO_CODIGO_PAIS` |
| `email` | text | Informativo (no se envía a GHL) |
| `valor` | numeric | Se envía formateado: `$ 350.000` |
| `concepto` | text | Ej. `Cuota 3/10` |
| `fecha_vencimiento` | date | El día 20 (el ejemplo incluye la variante calculada) |
| `pagada` | boolean | `true` ⇒ no se planifica y, si ya estaba planificada, se omite |
| `link_pago` | text | URL `http(s)` propia de cada usuario |

### 3. Migraciones

```bash
npm run db:migrar
```

Crea el esquema `recordatorios` (etapas, envíos, eventos, ejecuciones y bloqueos) y aplica la vista. Es idempotente.

Usuario de BD recomendado, con privilegio mínimo:

```sql
CREATE ROLE recordatorios_app LOGIN PASSWORD '...';
GRANT USAGE ON SCHEMA public TO recordatorios_app;
GRANT SELECT ON public.cuotas, public.estudiantes TO recordatorios_app;   -- tus tablas
GRANT CREATE ON DATABASE tu_bd TO recordatorios_app;                      -- para crear el esquema
```

### 4. GHL

**a) Private Integration Token** (Settings → Private Integrations de la subcuenta) con scopes:
`contacts.write` (upsert e inscripción en workflow), `locations/customFields.readonly`, `conversations.readonly`, `conversations/message.readonly`.

**b) Campos personalizados de contacto** (tipo *Text*). Créalos con estos nombres para que GHL genere exactamente estas claves; el sistema las resuelve a IDs automáticamente y avisa si falta alguna:

| Clave | Contenido |
|---|---|
| `contact.recordatorio_token` | Sufijo del botón (`/p/{{token}}`) |
| `contact.recordatorio_valor` | `$ 350.000` |
| `contact.recordatorio_fecha_limite` | `20 de noviembre` |
| `contact.recordatorio_concepto` | `Cuota 3/10` |
| `contact.recordatorio_etapa` | `D-3`, `D-1`, `D0`, `D+1` |
| `contact.recordatorio_envio_id` | ID interno (para el webhook opcional) |

**c) Plantillas de WhatsApp** (categoría *Utility*, una por etapa). Botón tipo *Visitar sitio web* → **URL dinámica**: `https://APP_URL/p/{{1}}`, con `{{1}}` = `{{contact.recordatorio_token}}`. Meta solo permite la variable al final de la URL, y por eso cada usuario recibe un token que redirige a su propio link de pago (además, así se registran los clics).

Textos sugeridos (transaccionales; el lenguaje promocional puede hacer que Meta reclasifique la plantilla como *Marketing*):

| Etapa | Cuerpo |
|---|---|
| D-3 | Hola {{1}}, te recordamos que tu {{2}} por {{3}} vence el {{4}}. Puedes pagarla desde el botón. |
| D-1 | Hola {{1}}, mañana {{4}} vence tu {{2}} por {{3}}. Puedes pagarla en línea desde el botón. |
| D0 | Hola {{1}}, hoy vence tu {{2}} por {{3}}. Si ya realizaste el pago, ignora este mensaje. |
| D+1 | Hola {{1}}, tu {{2}} por {{3}} venció el {{4}} y aún no registramos el pago. Puedes ponerte al día desde el botón. |

Variables: `{{1}}` = `contact.first_name`, `{{2}}` = `recordatorio_concepto`, `{{3}}` = `recordatorio_valor`, `{{4}}` = `recordatorio_fecha_limite`. Botón: **Pagar cuota**.

**d) Workflows** (uno por etapa, o uno solo que ramifique por `recordatorio_etapa`):

1. No necesita disparador: el sistema inscribe al contacto por API. Si tu cuenta exige uno para publicar, usa uno que nunca ocurra (p. ej. una etiqueta que no uses).
2. Acción *WhatsApp* con la plantilla de la etapa y las variables mapeadas.
3. *(Opcional)* Acción *Webhook* `POST https://APP_URL/api/webhooks/ghl?secret=GHL_WEBHOOK_SECRET` con dato personalizado `envio_id = {{contact.recordatorio_envio_id}}`.
4. **Settings → Allow re-entry: activado** (el mismo contacto entra cada mes). Publicar.

Copia el ID de cada workflow (está en su URL) en el panel **Etapas y workflows de GHL** del dashboard.

### 5. Google Sheets (opcional)

1. En Google Cloud: habilita *Google Sheets API* y crea una cuenta de servicio con una llave JSON.
2. Comparte la hoja con el email de la cuenta de servicio como **Editor**.
3. Configura `GOOGLE_SHEETS_ID` (está en la URL de la hoja), `GOOGLE_SA_EMAIL` y `GOOGLE_SA_PRIVATE_KEY` (en una sola línea, con `\n`).

La pestaña `Envios` se mantiene con **una fila por envío** que se actualiza en sitio. No ordenes ni borres filas de esa pestaña: para análisis usa vistas de filtro u otra pestaña con `=QUERY(Envios!A:Q; "...")`. Los valores se escriben en modo `RAW`, así que ningún dato se interpreta como fórmula.

### 6. Cron

El endpoint acepta `GET` o `POST` con `Authorization: Bearer $CRON_SECRET`.

- **Vercel**: [vercel.json](vercel.json) lo programa cada hora de 8:00 a 19:00 (hora de Bogotá; Vercel usa UTC). Define `CRON_SECRET` en el proyecto y Vercel enviará el header automáticamente. Revisa los límites de cron de tu plan: si solo permite ejecuciones diarias, usa un programador externo.
- **VPS / externo** (crontab, cron-job.org, GitHub Actions):

  ```cron
  CRON_TZ=America/Bogota
  0 8-19 * * * curl -fsS -m 310 -H "Authorization: Bearer $CRON_SECRET" https://APP_URL/api/cron/recordatorios > /dev/null
  ```

Respuestas: `200` correcto, `500` con detalle en `errores`, `409` si ya hay otra ejecución en curso.

### 7. Prueba antes de producción

1. Con `GHL_DRY_RUN=true`, simula un día de envío: `curl -H "Authorization: Bearer $CRON_SECRET" "https://APP_URL/api/cron/recordatorios?fecha=2026-11-17"`. Revisa en el dashboard qué se planificó y qué falló (teléfonos o links inválidos).
2. Con `GHL_DRY_RUN=false`, prueba usando una vista temporal que devuelva solo tu número.

---

## Dashboard

Protegido con HTTP Basic (`DASHBOARD_USUARIO` / `DASHBOARD_CLAVE`). Las server actions vuelven a validar la credencial, porque son alcanzables por POST directo.

- **KPIs del rango**: enviados, entregados, leídos, fallidos, omitidos, clics y cuotas pagadas tras el recordatorio.
- **Tabla** con filtros por fecha, estado, etapa y búsqueda. **Reenviar** por fila y **Reenviar fallidos del filtro** (máx. 200 por acción).
- **Detalle** `/envios/:id`: datos, link del botón y bitácora completa (intentos, respuestas de GHL, estados de WhatsApp, clics, webhooks).
- **Ejecutar ciclo ahora** (ignora la ventana horaria) y **Sincronizar Sheets**.

### Estados

| Estado | Significado | ¿Reenviable? |
|---|---|---|
| pendiente | Planificado, en cola | Sí (envía ya) |
| procesando | Tomado por una ejecución | No |
| enviado | Contacto actualizado y workflow disparado | Sí (con confirmación) |
| entregado / leído | Confirmado por WhatsApp vía GHL | No |
| fallido | Error de datos, de GHL o de WhatsApp (`ultimo_error`) | Sí |
| omitido | Pagada, ya no está en la fuente o no salió en su fecha | Sí |

---

## Reglas de negocio implementadas

- **Idempotencia**: la planificación usa `ON CONFLICT DO NOTHING` y el despacho reclama filas con `UPDATE … WHERE estado = 'pendiente'`. Dos ejecuciones simultáneas no duplican mensajes, y un bloqueo por filas en `recordatorios.bloqueos` evita ciclos solapados (funciona detrás de PgBouncer, Supabase o Neon).
- **Revalidación**: justo antes de enviar se relee la vista. Si la cuota se pagó, se omite; si cambió el teléfono o el link, se usa el dato nuevo.
- **Mismo teléfono**: los campos del contacto en GHL se sobrescriben en cada envío. Por eso dos recordatorios al mismo número se separan al menos `ESPERA_MISMO_CONTACTO_SEG`, y el workflow anterior alcanza a leer sus valores.
- **Sin envíos tardíos**: un pendiente que no salió en su día pasa a *omitido* (un "faltan 3 días" no se envía después). Se puede reenviar a mano.
- **Interrumpidos**: un envío en *procesando* por más de 15 min pasa a *fallido* y no se reintenta solo, porque pudo llegar a GHL. Revísalo en GHL antes de reenviar.
- **Verificación**: se revisan los envíos de las últimas 72 h. Si el workflow no generó ningún mensaje de WhatsApp en 2 h, se marca *fallido* con indicaciones (re-entrada, plantilla, acción).
- **Clics**: las vistas previas de enlaces (WhatsApp, Facebook, bots) redirigen pero no cuentan como clic.

## Seguridad

- Secretos solo en variables de entorno; comparación en tiempo constante (`timingSafeEqual`).
- Endpoints públicos mínimos: `/p/:token` (token aleatorio de 128 bits), cron (Bearer) y webhook (secreto). Todo lo demás pasa por `proxy.ts`.
- `robots: noindex`. El email no se envía a GHL.
- Usuario de BD con `SELECT` sobre las tablas de negocio; solo escribe en `recordatorios`.

## Operación y backups

- Incluye el esquema en los respaldos: `pg_dump -n recordatorios …`. La bitácora (`recordatorios.eventos`) crece con cada intento; si hace falta, depúrala por antigüedad (p. ej. > 12 meses).
- `recordatorios.ejecuciones` sirve de log de cada corrida, y su columna `error` es lo primero que hay que revisar.
- Cambios de esquema: agrega archivos `db/migraciones/00N_*.sql` y ejecuta `npm run db:migrar`.

## Estructura

```
app/
  page.tsx                      dashboard (KPIs, filtros, tabla, ejecuciones, etapas)
  envios/[id]/page.tsx          detalle + bitácora
  acciones.ts                   server actions (reenviar, ciclo manual, Sheets, etapas)
  api/cron/recordatorios/       ciclo completo (cron)
  api/webhooks/ghl/             confirmación opcional del workflow
  p/[token]/                    redirect del botón + registro de clics
lib/
  config.ts                     variables tipadas (zod), validadas por dominio
  db.ts                         pool pg + bloqueo con expiración
  ghl.ts                        cliente HighLevel API v2 (Version: v3)
  sheets.ts                     cliente Google Sheets (JWT de cuenta de servicio, sin SDK)
  recordatorios/
    planificador.ts             higiene + planificación
    despachador.ts              reclamo concurrente, revalidación y envío
    verificador.ts              estado real de WhatsApp en GHL
    sincronizar-sheets.ts       espejo en Google Sheets
    ciclo.ts                    orquestación de una ejecución
    consultas.ts                lecturas del dashboard
db/
  migraciones/001_…sql          esquema `recordatorios`
  vista_fuente.ejemplo.sql      plantilla de la vista a adaptar
proxy.ts                        Basic Auth del dashboard
```
