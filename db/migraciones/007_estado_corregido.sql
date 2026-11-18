-- Estado "corregido": un envío fallido cuyo contacto el equipo ya arregló en GHL
-- (teléfono, indicativo, contacto unido...). El mensaje de esa etapa no llegó, pero
-- sale de "Requieren atención" y de "Reenviar fallidos del filtro"; la siguiente
-- etapa debería llegar. Se marca y desmarca desde el dashboard.
ALTER TYPE recordatorios.estado_envio ADD VALUE IF NOT EXISTS 'corregido' AFTER 'fallido';
