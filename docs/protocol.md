# Protocolo WebSocket

O cliente conecta em `/ws`, envia `authenticate` com access token e só então `join-room`. Mensagens direcionadas (`offer`, `answer`, `ice-candidate`) incluem `roomId`, `targetPeerId` e `payload`; o servidor adiciona `fromPeerId`. Estado efêmero usa `peer-state`. `heartbeat` recebe `pong`.

Fluxo: autenticar → entrar → peers existentes criam offers → answers retornam → candidatos ICE são trocados → mídia flui diretamente. Na saída, `peer-left` fecha a conexão correspondente.

Erros têm `{ "type": "error", "code": string, "message": string }`. O servidor rejeita payloads acima de 64 KiB e nunca aceita um identificador de origem declarado pelo cliente.
