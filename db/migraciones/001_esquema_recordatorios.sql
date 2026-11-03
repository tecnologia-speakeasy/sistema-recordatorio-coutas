-- =============================================================================
-- Esquema `recordatorios`: estado propio del sistema de recordatorios de cuotas.
-- No modifica tablas de negocio; solo lee de ellas a través de la vista
-- recordatorios.v_cuotas_fuente (ver 002_vista_fuente.sql).
-- =============================================================================

CREATE SCHEMA IF NOT EXISTS recordatorios;

-- ---------------------------------------------------------------------------
-- Productos de cartera (public.cartera_productos) a los que se les envían
-- recordatorios. Se activan desde el dashboard.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS recordatorios.productos (
  producto_id  uuid PRIMARY KEY,
  nombre       text NOT NULL,
  activo       boolean NOT NULL DEFAULT true,
  creado_en    timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- Link de pago por producto, pasarela y número total de cuotas del plan.
-- Stripe -> link de Stripe; cualquier otro método (Hotmart, Zelle,
-- Bancolombia, Nequi...) -> link de Hotmart.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS recordatorios.links_pago (
  producto_id     uuid    NOT NULL REFERENCES recordatorios.productos (producto_id) ON DELETE CASCADE,
  pasarela        text    NOT NULL CHECK (pasarela IN ('hotmart', 'stripe')),
  cuotas          integer NOT NULL CHECK (cuotas BETWEEN 2 AND 12),
  url             text,
  actualizado_en  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (producto_id, pasarela, cuotas)
);

-- ---------------------------------------------------------------------------
-- Etapas. Las de offset_dias se planifican por fecha (relativas al día 20);
-- SEG (seguimiento) se crea cuando el estudiante hace clic en el link de pago.
-- Cada etapa dispara su workflow de GHL por el webhook entrante del workflow.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS recordatorios.etapas (
  codigo           text PRIMARY KEY,
  nombre           text    NOT NULL,
  offset_dias      integer UNIQUE,
  plantilla        text,
  ghl_webhook_url  text,
  activa           boolean NOT NULL DEFAULT true,
  orden            integer NOT NULL
);

INSERT INTO recordatorios.etapas (codigo, nombre, offset_dias, plantilla, orden) VALUES
  ('D-3', 'Faltan 3 días',          -3,   'utl_cuota_vencimiento_3dias', 1),
  ('D-1', 'Falta 1 día',            -1,   'utl_cuota_vencimiento_1dia',  2),
  ('D0',  'Día de vencimiento',      0,   'utl_cuota_vencimiento_hoy',   3),
  ('D+1', 'Vencida ayer',            1,   'utl_cuota_vencida_ayer',      4),
  ('SEG', 'Seguimiento tras el clic', NULL, 'utl_seguimiento_pago_3horas', 5)
ON CONFLICT (codigo) DO NOTHING;

-- ---------------------------------------------------------------------------
-- Estados de un envío.
--   pendiente   -> planificado, aún no se envía
--   procesando  -> tomado por una ejecución (bloqueo lógico)
--   enviado     -> webhook del workflow de GHL disparado
--   entregado / leido -> confirmado por GHL (estado del mensaje de WhatsApp)
--   fallido     -> error propio, de GHL o de WhatsApp (reenviable)
--   omitido     -> no se envió por regla de negocio (pagada, fuera de fecha...)
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace
    WHERE t.typname = 'estado_envio' AND n.nspname = 'recordatorios'
  ) THEN
    CREATE TYPE recordatorios.estado_envio AS ENUM (
      'pendiente', 'procesando', 'enviado', 'entregado', 'leido', 'fallido', 'omitido'
    );
  END IF;
END$$;

-- ---------------------------------------------------------------------------
-- Un envío = una cuota (compra x número de cuota) x una etapa. La restricción
-- única hace idempotente la planificación y limita el seguimiento a uno por
-- cuota. Los datos del estudiante son una instantánea; se refrescan desde la
-- fuente en cada intento de envío.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS recordatorios.envios (
  id                   bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  cuota_id             text    NOT NULL,           -- '<compra_id>:<numero>'
  compra_id            uuid    NOT NULL,           -- public.cartera_compras.id
  producto_id          uuid    NOT NULL,
  cuota_numero         integer NOT NULL,
  total_cuotas         integer NOT NULL,
  etapa                text    NOT NULL REFERENCES recordatorios.etapas (codigo),
  fecha_vencimiento    date    NOT NULL,
  fecha_programada     date    NOT NULL,
  programado_para      timestamptz,                -- solo seguimiento: no antes de esta hora
  origen_envio_id      bigint REFERENCES recordatorios.envios (id) ON DELETE SET NULL,

  nombre               text,
  telefono             text,                       -- tal como viene de la fuente
  telefono_e164        text,                       -- normalizado y enviado a GHL
  email                text,
  pais                 text,
  producto             text,
  metodo_pago          text,
  pasarela             text,
  concepto             text,
  link_pago            text,                       -- link real (Hotmart/Stripe) al momento del envío

  -- Link rastreado que recibe el estudiante: https://<app>/p/<token>
  token                text NOT NULL UNIQUE DEFAULT replace(gen_random_uuid()::text, '-', ''),

  estado               recordatorios.estado_envio NOT NULL DEFAULT 'pendiente',
  simulado             boolean NOT NULL DEFAULT false,
  intentos             integer NOT NULL DEFAULT 0,
  ultimo_error         text,

  ghl_contact_id       text,
  ghl_conversation_id  text,
  ghl_message_id       text,

  procesando_desde     timestamptz,
  enviado_en           timestamptz,
  entregado_en         timestamptz,
  leido_en             timestamptz,

  clicks               integer NOT NULL DEFAULT 0,
  primer_click_en      timestamptz,

  -- Botón respondido en WhatsApp (lo informa el workflow por webhook).
  respuesta            text,
  respondido_en        timestamptz,
  pago_reportado_en    timestamptz,

  creado_en            timestamptz NOT NULL DEFAULT now(),
  actualizado_en       timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT envios_cuota_etapa_uk UNIQUE (cuota_id, fecha_vencimiento, etapa)
);

CREATE INDEX IF NOT EXISTS envios_estado_fecha_idx  ON recordatorios.envios (estado, fecha_programada);
CREATE INDEX IF NOT EXISTS envios_fecha_prog_idx    ON recordatorios.envios (fecha_programada DESC, id DESC);
CREATE INDEX IF NOT EXISTS envios_actualizado_idx   ON recordatorios.envios (actualizado_en);

CREATE OR REPLACE FUNCTION recordatorios.tocar_actualizado_en() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  NEW.actualizado_en := now();
  RETURN NEW;
END$$;

DROP TRIGGER IF EXISTS envios_actualizado_en ON recordatorios.envios;
CREATE TRIGGER envios_actualizado_en
  BEFORE UPDATE ON recordatorios.envios
  FOR EACH ROW EXECUTE FUNCTION recordatorios.tocar_actualizado_en();

-- ---------------------------------------------------------------------------
-- Bitácora por envío: cada intento, respuesta de GHL, clic, webhook, etc.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS recordatorios.eventos (
  id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  envio_id   bigint REFERENCES recordatorios.envios (id) ON DELETE CASCADE,
  tipo       text NOT NULL,
  detalle    jsonb,
  creado_en  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS eventos_envio_idx ON recordatorios.eventos (envio_id, creado_en DESC);

-- ---------------------------------------------------------------------------
-- Google Sheets: una fila por cuota (pestañas "Cuota 2", "Cuota 3"...).
-- version = max(actualizado_en) de los envíos de esa cuota ya reflejado.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS recordatorios.sheets_filas (
  cuota_id           text    NOT NULL,
  fecha_vencimiento  date    NOT NULL,
  pestana            text    NOT NULL,
  fila               integer NOT NULL,
  version            timestamptz NOT NULL,
  PRIMARY KEY (cuota_id, fecha_vencimiento)
);

-- ---------------------------------------------------------------------------
-- Registro de cada ejecución del ciclo (cron o manual).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS recordatorios.ejecuciones (
  id                   bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  origen               text NOT NULL,
  fecha_referencia     date NOT NULL,
  iniciada_en          timestamptz NOT NULL DEFAULT now(),
  finalizada_en        timestamptz,
  planificados         integer NOT NULL DEFAULT 0,
  enviados             integer NOT NULL DEFAULT 0,
  fallidos             integer NOT NULL DEFAULT 0,
  omitidos             integer NOT NULL DEFAULT 0,
  verificados          integer NOT NULL DEFAULT 0,
  sincronizados_sheets integer NOT NULL DEFAULT 0,
  error                text
);

CREATE INDEX IF NOT EXISTS ejecuciones_iniciada_idx ON recordatorios.ejecuciones (iniciada_en DESC);

-- ---------------------------------------------------------------------------
-- Bloqueos con expiración (evita ejecuciones solapadas del ciclo y de la
-- sincronización con Sheets). Basado en filas para funcionar también detrás
-- de poolers en modo transacción (PgBouncer, Supabase, Neon).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS recordatorios.bloqueos (
  nombre        text PRIMARY KEY,
  tomado_hasta  timestamptz NOT NULL
);
