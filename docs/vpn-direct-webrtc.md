# WebRTC direto por VPN overlay

O Risk desktop permite que o ICE do WebRTC considere interfaces locais, inclusive
ZeroTier e outras VPNs overlay. Não existe integração com conta, API ou SDK da VPN:
o usuário conecta a VPN no sistema operacional e o Risk trata o adaptador como uma
interface de rede normal.

O fluxo de signaling e a autenticação de identidade do Risk não mudam. Áudio,
vídeo, compartilhamento de tela, chat e transferência de arquivos continuam no
mesmo `RTCPeerConnection`, protegidos por WebRTC e pelas verificações de identidade
existentes.

## Diagnóstico

No aplicativo desktop, o processo principal lê `os.networkInterfaces()`, remove
loopback, entradas internas e endereços inválidos e entrega ao renderer somente a
lista sanitizada necessária à classificação local. A lista não é enviada ao
backend ou ao Supabase e os endereços não entram no relatório copiável da UI.

O painel **Rede** mostra separadamente a disponibilidade do TURN e a rota que o
ICE realmente selecionou:

- `VPN direta (ZeroTier)` para um candidate local `host` cujo endereço corresponde
  ao adaptador ZeroTier;
- `LAN direta` para um pair `host`–`host` correspondente a uma interface local não VPN;
- `P2P direto` para candidates `srflx`/`prflx` sem relay;
- `TURN Relay` quando qualquer candidate selecionado é `relay`;
- `Rota desconhecida` quando os stats não permitem uma conclusão segura.

A rota é recalculada a cada coleta de `getStats()`. Assim, um ICE restart pode
trocar VPN por STUN/TURN (ou o inverso) e o painel acompanha o novo candidate pair.

## Teste manual em dois computadores

### Mesma rede ZeroTier

1. Conecte os dois computadores à mesma rede ZeroTier.
2. Confirme conectividade nos dois sentidos com `ping <IP-ZeroTier-remoto>`.
3. Abra a mesma chamada no Risk desktop nos dois computadores.
4. Abra **Rede** e confirme `VPN direta (ZeroTier)`, candidates `host → host` e,
   normalmente, transporte `UDP`.
5. Teste áudio, câmera, compartilhamento de tela, chat e transferência de arquivo.

### Sem VPN

1. Desconecte o ZeroTier nos dois computadores.
2. Entre novamente na chamada.
3. Confirme que a chamada conecta por `P2P direto`, `LAN direta` ou `TURN Relay`,
   conforme a topologia disponível.

### Queda da VPN durante a chamada

1. Inicie uma chamada mostrando `VPN direta (ZeroTier)`.
2. Desconecte o ZeroTier em um computador.
3. Aguarde a detecção de desconexão e o ICE restart existente.
4. Confirme que a chamada tenta migrar para `P2P direto` ou `TURN Relay` e que o
   painel deixa de mostrar ZeroTier quando o novo pair é selecionado.

### Mesma LAN e TURN

- Na mesma LAN, sem VPN, espere `LAN direta` quando um pair `host`–`host` vencer.
- Em redes que bloqueiem caminhos diretos, confirme `TURN Relay`; a presença de
  um adaptador VPN por si só nunca classifica uma conexão como VPN.

O comportamento de descoberta de candidates depende do Chromium/Electron e da
configuração do sistema. O Risk usa a API oficial
`setWebRTCIPHandlingPolicy("default")` e não desabilita mDNS nem reescreve SDP ou
candidates.
