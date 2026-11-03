-- =============================================================================
-- Google Sheets vía n8n: n8n ubica cada fila por la columna ID ("Append or
-- Update"), así que el sistema ya no necesita guardar el número de fila.
-- sheets_filas queda solo como registro de la versión ya enviada por cuota.
-- =============================================================================

ALTER TABLE recordatorios.sheets_filas ALTER COLUMN fila DROP NOT NULL;
