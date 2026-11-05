-- =============================================================================
-- Estado de la prueba del producto "Prueba Cuotas": qué cuotas ve el sistema
-- para el 20 de noviembre (solo con el producto activo en el dashboard) y en qué
-- quedó cada envío.
--
-- Uso: npm run db:sql -- db/pruebas/ver-prueba.sql
-- =============================================================================

-- 1. Lo que el sistema ve en cartera: cuota que vence el 20 de noviembre, si está pagada y qué link recibe.
SELECT left(f.nombre, 34) AS compra, f.concepto, f.pagada,
       f.pasarela || CASE WHEN f.referido THEN ' referido' ELSE '' END AS link, f.link_pago
FROM recordatorios.v_cuotas_fuente f
WHERE f.producto_id = '76ce2267-9f2f-4f2a-8d75-bd7d9f4b3265' AND f.fecha_vencimiento = DATE '2026-11-20'
ORDER BY f.nombre;

-- 2. Envíos: etapa, estado, botones y clics.
SELECT left(e.nombre, 34) AS compra, e.etapa, e.estado, e.respuesta, e.clicks,
       to_char(e.programado_para AT TIME ZONE 'America/Bogota', 'DD/MM HH24:MI') AS programado,
       left(e.ultimo_error, 70) AS detalle
FROM recordatorios.envios e
WHERE e.producto_id = '76ce2267-9f2f-4f2a-8d75-bd7d9f4b3265'
ORDER BY e.nombre, e.id;
