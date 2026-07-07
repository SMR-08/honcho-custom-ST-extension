# SillyTavern Honcho Memory Local-First

Extensión real de SillyTavern para conectar chats con una API Honcho y usar memoria persistente desde el panel de extensiones.

Se instala como cualquier extensión third-party de SillyTavern: pegando la URL del repositorio.

## Instalación

1. Abre SillyTavern.
2. Ve a `Extensions`.
3. Pulsa `Install extension`.
4. Pega la URL de este repositorio Git.
5. Instala y recarga SillyTavern si lo pide.

No hay instalador `.sh`. No hay copia manual. No hay server plugin.

## Archivos de extensión

```text
manifest.json
index.js
settings.html
style.css
README.md
HONCHO_CORE_SYNC_REQUIREMENTS.md
```

## Requisitos

- SillyTavern reciente con soporte de extensiones third-party.
- Git instalado en la máquina donde corre SillyTavern.
- Una API Honcho accesible desde el navegador.
- CORS habilitado en Honcho para el origen de SillyTavern.

Ejemplo para Honcho self-hosted si SillyTavern está en `http://127.0.0.1:8000`:

```env
HONCHO_CORS_ORIGINS='["http://127.0.0.1:8000","http://localhost:8000"]'
```

Si SillyTavern usa otro puerto/origen, añádelo. Sin CORS, el navegador bloqueará las llamadas aunque Honcho funcione.

## Configuración

Abre `Extensions -> Honcho Memory` y configura:

- `Enable Honcho Memory`: activa/desactiva memoria.
- `Honcho URL`: URL pública de Honcho desde el navegador, por ejemplo `http://127.0.0.1:8000` o `https://honcho.example.com`.
- `Test`: validación funcional. Crea workspace/session/peer/message temporal y lista mensajes.
- `API Key`: clave Honcho. En self-hosted sin auth puedes usar un valor dummy como `local-dev-no-auth`.
- `Workspace ID`: workspace Honcho para esta instancia de ST.
- `Your peer name`: override opcional. Si vacío, usa persona activa de SillyTavern.
- `Peer Mode`: `Separate peer per persona` recomendado.
- `Session Naming`: sesión por chat, por personaje, o personalizada.
- `Context token budget`: presupuesto de contexto recuperado desde Honcho.
- `Honcho output token budget`: límite de texto devuelto por reasoning/tools de Honcho.
- `Enrichment Mode`: `Context only`, `Reasoning`, o `Tool call`.

La configuración se guarda en `extension_settings.honcho` dentro de SillyTavern.

## Modos

### Context only

Recupera contexto de Honcho y lo inyecta en el prompt de SillyTavern.

### Reasoning

Además del contexto base, ejecuta queries periódicas contra Honcho dialectic chat. Las queries se configuran en el panel y pueden usar `{{message}}` para insertar el último mensaje del usuario.

### Tool call

Registra herramientas para modelos/backends compatibles con function calling:

- `honcho_query_memory`
- `honcho_save_conclusion`
- `honcho_search_history`

`honcho_search_history` requiere que Honcho tenga búsqueda/embeddings configurados.

## Datos que guarda en Honcho

- Mensajes del usuario.
- Respuestas del personaje o grupo.
- Peers por persona/personaje.
- Sesión por chat/personaje/custom según configuración.
- Conclusiones explícitas guardadas por tool call.

## Sincronización con edición, borrado y regeneración

SillyTavern permite editar, borrar y regenerar mensajes. Honcho API actual no borra ni edita contenido de mensajes por API pública; sólo permite actualizar metadata.

La extensión usa el chat actual de SillyTavern como fuente de verdad:

- mantiene un mapa `mensaje ST -> mensaje(s) Honcho` en `chat_metadata.honcho.messageMap`,
- detecta mensajes editados o borrados con eventos de SillyTavern,
- localiza el primer índice cambiado,
- marca como `deleted` o `superseded` las versiones antiguas desde ese índice hacia adelante,
- reinserta desde ese índice hasta el final del chat para preservar orden cronológico,
- construye contexto limpio filtrando mensajes marcados como borrados/sustituidos.

Esto evita que el prompt inyectado por la extensión use mensajes borrados o editados.

Ejemplo: si el chat era `A -> B -> C -> D` y editas `B`, la extensión marca como antiguas `B,C,D` y reinserta `B editado,C,D`. El historial vivo queda `A -> B editado -> C -> D`, no `A -> C -> D -> B editado`.

Limitación: si activas embeddings/deriver/representations en Honcho, un mensaje viejo ya derivado puede seguir influyendo internamente hasta que Honcho core soporte update/delete/rebuild real. Ver `HONCHO_CORE_SYNC_REQUIREMENTS.md`.

## Seguridad

Esta versión es browser-only. La API key se guarda en settings de SillyTavern y se usa desde el navegador. Para un Honcho privado en Internet, usa HTTPS y una clave con permisos mínimos.

Si necesitas ocultar claves server-side, eso requiere un server plugin o proxy externo. Eso ya no sería una extensión ST pura instalable sólo pegando URL.

## Notas técnicas

La extensión llama directamente a Honcho API v3:

- `GET /health`
- `POST /v3/workspaces`
- `POST /v3/workspaces/{workspace}/peers`
- `POST /v3/workspaces/{workspace}/sessions`
- `POST /v3/workspaces/{workspace}/sessions/{session}/peers`
- `POST /v3/workspaces/{workspace}/sessions/{session}/messages`
- `POST /v3/workspaces/{workspace}/sessions/{session}/messages/list`
- `GET /v3/workspaces/{workspace}/sessions/{session}/context`
- `POST /v3/workspaces/{workspace}/peers/{peer}/chat`
- `POST /v3/workspaces/{workspace}/conclusions`
- `POST /v3/workspaces/{workspace}/search`

## Créditos

Basada en la idea de integración `plastic-labs/sillytavern-honcho`, reestructurada como extensión UI-only instalable por URL de repositorio.
