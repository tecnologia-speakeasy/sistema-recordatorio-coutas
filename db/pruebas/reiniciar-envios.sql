-- =============================================================================
-- Reinicia los envíos de la prueba del producto "Prueba Cuotas"
-- (76ce2267-9f2f-4f2a-8d75-bd7d9f4b3265) para volver a correr las etapas desde
-- cero: borra los envíos, su bitácora y sus filas de control de Google Sheets.
-- Conserva las compras de cartera y el registro del producto con sus links.
--
-- El sistema no repite una etapa ya enviada (cuota + fecha límite + etapa), y el
-- dashboard no reenvía lo que ya está "entregado" o "leído": por eso, para
-- repetir una prueba, hay que borrar los envíos.
--
-- Antes de volver a enviar, saca a los contactos de prueba de los workflows de
-- GHL donde sigan esperando respuesta: GHL ignora un nuevo disparo mientras el
-- contacto sigue dentro del mismo workflow.
--
-- Uso: npm run db:sql -- db/pruebas/reiniciar-envios.sql
-- =============================================================================

BEGIN;

DELETE FROM recordatorios.sheets_filas
WHERE cuota_id IN (
  SELECT cuota_id FROM recordatorios.envios
  WHERE producto_id = '76ce2267-9f2f-4f2a-8d75-bd7d9f4b3265'
);
DELETE FROM recordatorios.sheets_verificacion
WHERE cuota_id IN (
  SELECT cuota_id FROM recordatorios.envios
  WHERE producto_id = '76ce2267-9f2f-4f2a-8d75-bd7d9f4b3265'
);
DELETE FROM recordatorios.envios WHERE producto_id = '76ce2267-9f2f-4f2a-8d75-bd7d9f4b3265';

COMMIT;

SELECT (SELECT count(*) FROM recordatorios.envios
        WHERE producto_id = '76ce2267-9f2f-4f2a-8d75-bd7d9f4b3265') AS envios_de_prueba,
       (SELECT count(*) FROM public.cartera_compras
        WHERE producto_id = '76ce2267-9f2f-4f2a-8d75-bd7d9f4b3265') AS compras_conservadas;
