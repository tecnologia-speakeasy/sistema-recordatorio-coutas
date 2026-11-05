-- =============================================================================
-- Pestaña "Pagos por verificar" de Google Sheets: una fila por cuota en la que
-- el estudiante respondió "Pago realizado", con su estado en cartera.
-- huella = resumen de lo último que se envió de esa fila: se reenvía solo si
-- cambia (por ejemplo, cuando el pago aparece en cartera).
-- =============================================================================

CREATE TABLE IF NOT EXISTS recordatorios.sheets_verificacion (
  cuota_id           text        NOT NULL,
  fecha_vencimiento  date        NOT NULL,
  huella             text        NOT NULL,
  enviado_en         timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (cuota_id, fecha_vencimiento)
);
