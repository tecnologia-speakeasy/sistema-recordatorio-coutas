-- =============================================================================
-- Borra todo lo de la prueba del producto "Prueba Cuotas"
-- (76ce2267-9f2f-4f2a-8d75-bd7d9f4b3265): envíos y su bitácora, el registro en
-- recordatorios (con sus links) y las compras, pagos, estados, métodos y
-- descuentos de cartera. El producto de cartera se conserva.
-- Las filas de Google Sheets se borran a mano (Producto = "Prueba Cuotas").
--
-- Uso: npm run db:sql -- db/pruebas/limpiar-prueba.sql
-- =============================================================================

BEGIN;

DELETE FROM recordatorios.sheets_filas
WHERE cuota_id IN (
  SELECT cuota_id FROM recordatorios.envios
  WHERE producto_id = '76ce2267-9f2f-4f2a-8d75-bd7d9f4b3265'
);
DELETE FROM recordatorios.envios WHERE producto_id = '76ce2267-9f2f-4f2a-8d75-bd7d9f4b3265';
DELETE FROM recordatorios.productos WHERE producto_id = '76ce2267-9f2f-4f2a-8d75-bd7d9f4b3265';

-- Los pagos y el historial de cada compra se borran en cascada.
DELETE FROM public.cartera_compras WHERE producto_id = '76ce2267-9f2f-4f2a-8d75-bd7d9f4b3265';
DELETE FROM public.cartera_estados WHERE producto_id = '76ce2267-9f2f-4f2a-8d75-bd7d9f4b3265';
DELETE FROM public.cartera_metodos_pago WHERE producto_id = '76ce2267-9f2f-4f2a-8d75-bd7d9f4b3265';
DELETE FROM public.cartera_descuentos WHERE producto_id = '76ce2267-9f2f-4f2a-8d75-bd7d9f4b3265';

COMMIT;

SELECT 'Prueba borrada' AS resultado;
