# Cambios recomendados en Honcho core para sincronización perfecta con SillyTavern

## Contexto

SillyTavern permite operaciones normales de edición de chat:

- borrar mensajes del usuario o del personaje,
- editar mensajes del usuario o del personaje,
- regenerar respuestas,
- cambiar swipe/respuesta activa.

La extensión `honcho-custom-ST-extension` ya implementa una mitigación autocontenida: toma el chat actual de SillyTavern como fuente de verdad, guarda metadatos de sincronización en cada mensaje Honcho y marca mensajes antiguos como `deleted` o `superseded` mediante metadata cuando ST cambia.

Esto funciona sin tocar Honcho para contexto limpio en la extensión, pero no elimina físicamente contenido viejo de Honcho ni recalcula derivados. Para sincronización perfecta hace falta ampliar Honcho core.

## Problema actual en Honcho

Honcho API v3 permite crear mensajes:

```http
POST /v3/workspaces/{workspace_id}/sessions/{session_id}/messages
```

También permite actualizar mensaje:

```http
PUT /v3/workspaces/{workspace_id}/sessions/{session_id}/messages/{message_id}
```

Pero hoy `MessageUpdate` sólo acepta metadata:

```python
class MessageUpdate(BaseModel):
    metadata: dict | None = None
```

No hay endpoint público para:

- editar `content`,
- borrar mensaje,
- invalidar embeddings del mensaje,
- invalidar conclusiones/representaciones derivadas del mensaje,
- reconstruir memoria derivada tras cambios.

Resultado: si ST borra o edita, el mensaje viejo puede seguir influyendo en búsquedas, embeddings, summaries, conclusions o representations.

## Objetivo

Hacer que Honcho soporte sincronización de mensajes desde clientes donde el historial no es append-only.

SillyTavern debe poder decirle a Honcho:

```text
este mensaje cambió
este mensaje fue borrado
recalcula cualquier memoria derivada afectada
```

## Requisitos funcionales

### 1. Actualizar contenido de mensaje

Añadir soporte para editar `content` en `MessageUpdate`.

Propuesta:

```python
class MessageUpdate(BaseModel):
    content: str | None = None
    metadata: dict | None = None
```

Endpoint:

```http
PATCH /v3/workspaces/{workspace_id}/sessions/{session_id}/messages/{message_id}
```

o extender el `PUT` existente.

Recomendado: `PATCH`, porque actualización parcial expresa mejor intención.

Comportamiento esperado:

1. Verificar que mensaje pertenece a workspace y session.
2. Si cambia `content`:
   - sanitizar contenido igual que `MessageCreate`,
   - recalcular `token_count`,
   - actualizar `updated_at` si existe o añadirlo,
   - invalidar embeddings del mensaje,
   - reencolar embeddings si `EMBED_MESSAGES=true`,
   - invalidar summaries/session context derivados afectados,
   - invalidar conclusions/representations derivadas afectadas o marcarlas stale.
3. Si cambia metadata:
   - sobrescribir o mergear según contrato documentado. Recomendado: merge parcial para no perder metadata de otros clientes.

Respuesta esperada:

```json
{
  "id": "msg_x",
  "content": "nuevo contenido",
  "peer_id": "user",
  "session_id": "chat_1",
  "workspace_id": "st-rp",
  "metadata": { "...": "..." },
  "token_count": 42,
  "created_at": "...",
  "updated_at": "..."
}
```

### 2. Borrar mensaje

Añadir endpoint:

```http
DELETE /v3/workspaces/{workspace_id}/sessions/{session_id}/messages/{message_id}
```

Hay dos estrategias válidas.

#### Opción A: soft delete recomendado

No borrar fila inmediatamente. Marcar:

```text
deleted_at
deleted=true
```

Ventajas:

- auditable,
- menos riesgo de romper FK/eventos,
- permite reconciliación y debugging,
- reversible si se añade restore.

Obligatorio si se hace soft delete:

- `messages/list` no debe devolver mensajes borrados por defecto,
- `context` no debe incluir mensajes borrados,
- `search` no debe devolver mensajes borrados,
- summaries/conclusions/representations deben invalidarse o recalcularse.

Permitir opcional:

```http
GET/POST list?include_deleted=true
```

Sólo admin/debug.

#### Opción B: hard delete

Borrar fila y dependencias.

Requiere:

- borrar embeddings/vector rows,
- borrar referencias en queues,
- tratar summaries/conclusions/representations derivadas,
- evitar huecos problemáticos en secuencia si `seq_in_session` se usa para rangos.

Más peligroso. Recomendación: empezar con soft delete.

Respuesta esperada:

```http
204 No Content
```

o:

```json
{
  "ok": true,
  "id": "msg_x",
  "deleted": true
}
```

### 3. Borrado/actualización por ID externo del cliente

La integración ST necesita enlazar mensajes ST con mensajes Honcho. Hoy lo hace con metadata:

```json
{
  "honcho_st_sync": {
    "schema_version": 1,
    "st_message_index": 3,
    "st_message_key": "3",
    "st_message_hash": "abc123",
    "st_message_version": 2,
    "current": true,
    "deleted": false,
    "superseded": false
  }
}
```

Mejor en Honcho core: soportar `external_id` en mensajes.

Propuesta `MessageCreate`:

```python
external_id: str | None = None
source: str | None = None
```

Índice único recomendado:

```text
(workspace_name, session_name, source, external_id)
```

Endpoint upsert recomendado:

```http
PUT /v3/workspaces/{workspace_id}/sessions/{session_id}/messages/by_external_id/{source}/{external_id}
```

Body:

```json
{
  "peer_id": "user",
  "content": "texto vigente",
  "metadata": {}
}
```

Comportamiento:

- si existe: actualizar content/metadata,
- si no existe: crear mensaje,
- mantener id estable de Honcho.

Esto elimina necesidad de crear nuevos mensajes para cada edición.

### 4. Rebuild/invalidation de memoria derivada

Al editar/borrar mensajes, Honcho debe invalidar derivados.

Mínimo necesario:

- embeddings del mensaje,
- summaries de la sesión que cubren ese mensaje o mensajes posteriores,
- conclusions derivadas de ese mensaje,
- peer representations afectadas,
- caches de context/search.

Propuesta endpoint explícito:

```http
POST /v3/workspaces/{workspace_id}/sessions/{session_id}/rebuild
```

Body:

```json
{
  "from_message_id": "msg_x",
  "rebuild_embeddings": true,
  "rebuild_summaries": true,
  "rebuild_conclusions": true,
  "rebuild_representations": true
}
```

Respuesta:

```json
{
  "ok": true,
  "queued": {
    "embeddings": 1,
    "summaries": 1,
    "conclusions": 3,
    "representations": 2
  }
}
```

Si el rebuild es asíncrono, añadir estado:

```http
GET /v3/workspaces/{workspace_id}/sessions/{session_id}/rebuild/{job_id}
```

### 5. Filtros consistentes

Todos estos endpoints deben excluir mensajes borrados/superseded por defecto:

- `messages/list`,
- `session/context`,
- `workspace/search`,
- `session/search` si existe,
- summaries,
- deriver,
- dreamer,
- representation builders.

Si se implementa `superseded_at`, tratar igual que deleted para vistas normales.

## Cambios mínimos aceptables

Si no hay tiempo para todo, prioridad:

1. `PATCH message.content` + reembedding del mensaje.
2. `DELETE message` soft-delete.
3. Excluir deleted de `messages/list`, `context`, `search`.
4. Endpoint `rebuild session` básico.

Con eso SillyTavern queda saneado.

## Cómo verificar

### Preparación

Levantar Honcho con auth local igual que servidor real.

Variables relevantes:

```env
EMBED_MESSAGES=false
DERIVER_ENABLED=false
```

Primero verificar sin embeddings/deriver para aislar CRUD.

Después repetir con embeddings/deriver activos si se implementa invalidación completa.

### Test 1: crear mensaje

```bash
curl -sS -X POST "$HONCHO_URL/v3/workspaces/st-rp" \
  -H "Authorization: Bearer $HONCHO_KEY" \
  -H "Content-Type: application/json" \
  -d '{"id":"st-rp"}'

curl -sS -X POST "$HONCHO_URL/v3/workspaces/st-rp/peers" \
  -H "Authorization: Bearer $HONCHO_KEY" \
  -H "Content-Type: application/json" \
  -d '{"id":"user"}'

curl -sS -X POST "$HONCHO_URL/v3/workspaces/st-rp/sessions" \
  -H "Authorization: Bearer $HONCHO_KEY" \
  -H "Content-Type: application/json" \
  -d '{"id":"chat-1","peers":{"user":{"observe_me":true}}}'

curl -sS -X POST "$HONCHO_URL/v3/workspaces/st-rp/sessions/chat-1/messages" \
  -H "Authorization: Bearer $HONCHO_KEY" \
  -H "Content-Type: application/json" \
  -d '{"messages":[{"peer_id":"user","content":"mensaje original","metadata":{"source":"st"}}]}'
```

Esperado:

- HTTP 201,
- respuesta incluye `id`, `content: mensaje original`, `peer_id: user`.

Guardar `MESSAGE_ID`.

### Test 2: editar contenido

```bash
curl -sS -X PATCH "$HONCHO_URL/v3/workspaces/st-rp/sessions/chat-1/messages/$MESSAGE_ID" \
  -H "Authorization: Bearer $HONCHO_KEY" \
  -H "Content-Type: application/json" \
  -d '{"content":"mensaje editado","metadata":{"source":"st","edited":true}}'
```

Esperado:

- HTTP 200,
- `content` ahora es `mensaje editado`,
- `token_count` recalculado,
- metadata presente,
- no aparece `mensaje original` al pedir el mensaje.

Verificar:

```bash
curl -sS "$HONCHO_URL/v3/workspaces/st-rp/sessions/chat-1/messages/$MESSAGE_ID" \
  -H "Authorization: Bearer $HONCHO_KEY"
```

### Test 3: context no contiene contenido viejo

```bash
curl -sS "$HONCHO_URL/v3/workspaces/st-rp/sessions/chat-1/context?tokens=2000&summary=false" \
  -H "Authorization: Bearer $HONCHO_KEY"
```

Esperado:

- contiene `mensaje editado`,
- no contiene `mensaje original`.

### Test 4: borrar mensaje

```bash
curl -i -X DELETE "$HONCHO_URL/v3/workspaces/st-rp/sessions/chat-1/messages/$MESSAGE_ID" \
  -H "Authorization: Bearer $HONCHO_KEY"
```

Esperado:

- HTTP 204 o JSON `deleted=true`.

### Test 5: list no devuelve borrado

```bash
curl -sS -X POST "$HONCHO_URL/v3/workspaces/st-rp/sessions/chat-1/messages/list" \
  -H "Authorization: Bearer $HONCHO_KEY" \
  -H "Content-Type: application/json" \
  -d '{}'
```

Esperado:

- mensaje borrado no aparece.

Si se añade `include_deleted=true`:

```bash
curl -sS -X POST "$HONCHO_URL/v3/workspaces/st-rp/sessions/chat-1/messages/list?include_deleted=true" \
  -H "Authorization: Bearer $HONCHO_KEY" \
  -H "Content-Type: application/json" \
  -d '{}'
```

Esperado:

- mensaje aparece con `deleted=true` o `deleted_at`.

### Test 6: search no devuelve borrado

Sólo si embeddings/search están activos.

```bash
curl -sS -X POST "$HONCHO_URL/v3/workspaces/st-rp/search" \
  -H "Authorization: Bearer $HONCHO_KEY" \
  -H "Content-Type: application/json" \
  -d '{"query":"mensaje original","limit":10,"filters":{"session_id":"chat-1"}}'
```

Esperado:

- no devuelve mensaje borrado,
- no devuelve contenido anterior si el mensaje fue editado.

### Test 7: rebuild

Si se implementa endpoint rebuild:

```bash
curl -sS -X POST "$HONCHO_URL/v3/workspaces/st-rp/sessions/chat-1/rebuild" \
  -H "Authorization: Bearer $HONCHO_KEY" \
  -H "Content-Type: application/json" \
  -d '{"from_message_id":"'$MESSAGE_ID'","rebuild_embeddings":true,"rebuild_summaries":true,"rebuild_conclusions":true,"rebuild_representations":true}'
```

Esperado:

- job creado o tareas encoladas,
- queue status refleja trabajo,
- al terminar, context/search/representation ya no mencionan contenido viejo.

## Verificación desde SillyTavern

Con extensión actualizada:

1. Abrir chat ST nuevo.
2. Activar Honcho Memory.
3. Enviar mensaje: `Mi color favorito es rojo`.
4. Verificar en Honcho `messages/list`: aparece mensaje actual.
5. Editar mensaje en ST a: `Mi color favorito es azul`.
6. Esperado con Honcho core mejorado:
   - mismo external_id o mismo message_id actualizado,
   - no queda `rojo` como mensaje vigente.
7. Borrar mensaje en ST.
8. Esperado:
   - mensaje no aparece en context/search normal,
   - si include_deleted, aparece marcado deleted.
9. Regenerar respuesta de bot.
10. Esperado:
    - respuesta antigua no aparece como vigente,
    - respuesta nueva sí.

## Criterios de aceptación

- Editar mensaje ST elimina contenido anterior de context/search/representation normal.
- Borrar mensaje ST elimina mensaje de context/search/representation normal.
- Regenerar respuesta no deja respuesta anterior como vigente.
- `messages/list` por defecto sólo muestra mensajes vigentes.
- `include_deleted=true` permite auditoría si se implementa soft delete.
- Embeddings no devuelven contenido viejo tras update/delete.
- Summaries no mantienen contenido viejo tras rebuild.
- No se rompen permisos JWT existentes.
- Peer/session scoping sigue igual.

## Notas para compatibilidad con la extensión actual

La extensión ya envía metadata bajo:

```json
metadata.honcho_st_sync
```

Honcho core no necesita depender de esa metadata para funcionar, pero puede usarla para depuración.

Campos útiles:

- `st_message_index`
- `st_message_key`
- `st_message_hash`
- `st_message_version`
- `current`
- `deleted`
- `superseded`

Si Honcho implementa `external_id`, la extensión puede migrar a un flujo más limpio:

```text
ST message stable id -> Honcho external_id
PATCH/PUT actualiza contenido real
DELETE borra real/lógico
```

Hasta entonces, la extensión usa tombstones por metadata y filtra contexto propio.
