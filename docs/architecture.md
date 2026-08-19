# Arquitetura e operação

O servidor nunca retransmite mídia: ele autentica, autoriza a entrada e encaminha SDP/ICE somente entre peers que constam na mesma sala. O transporte atual é mesh e tem limite de seis pessoas; acima disso, uma implementação de `CallTransport` baseada em SFU deverá substituir `MeshWebRTCTransport`.

Tokens TURN são gerados por usuário com validade de uma hora e assinatura HMAC-SHA1 compatível com o mecanismo de segredo compartilhado do coturn. Credenciais permanentes não chegam ao cliente.

## Segurança

O backend limita cada mensagem/corpo a 64 KiB, ignora IDs de origem enviados pelo cliente e deriva `fromPeerId` da conexão autenticada. Produção deve acrescentar rate limiting distribuído no Redis, restrição de CORS, TLS no proxy e refresh token em cookie `HttpOnly`, `Secure`, `SameSite=Strict`.

No Electron, `contextIsolation`, sandbox e `nodeIntegration: false` estão ativos. O preload expõe somente a listagem serializada de fontes de tela.

## Linux

Electron/Chromium usa PipeWire e xdg-desktop-portal em Wayland e o capturador do Chromium em X11. A disponibilidade de áudio do sistema varia por portal, compositor e versão do Chromium; falha de áudio não deve interromper a track de vídeo. Valide GNOME, KDE e um compositor wlroots no pipeline de release.

## TURN em produção

Defina `external-ip`, um realm público, TLS e faixa de relay no coturn; publique 3478 UDP/TCP, 5349 TLS e a faixa UDP configurada. Teste relay forçado com `iceTransportPolicy: "relay"` numa build diagnóstica antes de cada release.
