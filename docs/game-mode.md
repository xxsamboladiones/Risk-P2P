# Modo Jogo — primeira entrega

O anfitrião compartilha a tela e ativa **Modo Jogo** no rodapé. Isso autoriza a entrada automática de participantes autenticados da chamada. O botão **Jogar Junto** aparece na transmissão remota. Um jogador por vez pode usar teclado/mouse; até quatro podem usar controles, quando o backend do anfitrião oferece controles virtuais.

O painel do anfitrião identifica os jogadores e oferece **Revogar**. Quem foi revogado não pode voltar na mesma sessão. Desligar e ligar o modo cria uma sessão nova. Em tela cheia, as sobreposições somem após 3 segundos. **Esc** mostra os controles; outra pressão de **Esc** em até 2 segundos sai do Modo Jogo. No teclado/mouse, o primeiro Esc também solta as teclas e pausa a captura; **Continuar com teclado e mouse** retoma a mesma sessão. O controle físico continua funcionando enquanto as sobreposições aparecem. Perder o foco, ocultar a chamada ou desconectar encerra o acesso. **Ctrl + Alt + Shift + F12** encerra todas as sessões de jogo pelo processo Electron, inclusive quando outra janela está em foco (sujeito à disponibilidade do atalho global no sistema).

Teclado/mouse atua no computador e na janela que estiver em foco, não fica restrito à janela capturada. O anfitrião deve deixar o jogo em foco. Não há acesso persistente, execução de comandos, transferência de arquivos nem instalação automática de drivers por este recurso.

## Plataformas

| Função | Windows | Linux |
|---|---|---|
| Hospedar teclado/mouse | SendInput, usando scan codes | uinput |
| Participar com teclado/mouse | Pointer Lock e KeyboardEvent.code | Pointer Lock e KeyboardEvent.code |
| Capturar controle do participante | Gamepad API, mapeamento standard | Gamepad API, mapeamento standard |
| Controle virtual no anfitrião | Xbox 360 virtual via ViGEmBus, até quatro | Um dispositivo uinput por jogador, até quatro |

No Windows, o backend usa ViGEmBus para criar controles Xbox 360 virtuais. O Risk verifica se o bus está disponível ao iniciar o Modo Jogo: quando o driver está acessível, anuncia suporte a gamepad; quando não está, mantém teclado/mouse disponível e informa o motivo ao participante. O aplicativo não instala nem eleva silenciosamente o driver. Os controles virtuais são neutralizados quando a entrada pausa e removidos quando a concessão é encerrada.

No Linux, `/dev/uinput` precisa existir e ser gravável pelo usuário que executa o Risk. O aplicativo verifica isso e mostra uma mensagem se estiver indisponível; não altera permissões nem solicita execução como root. Dispositivos virtuais são destruídos ao encerrar a concessão. É necessário validar o reconhecimento do controle pelo jogo/distribuição utilizados.

No Windows, SendInput respeita o nível de integridade do processo. Jogos elevados ou que recusam input sintético podem não aceitar os comandos. Esta implementação não contorna essas restrições. Referências: [Microsoft SendInput](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-sendinput), [ViGEmBus](https://vigem.org/), [Linux uinput](https://docs.kernel.org/input/uinput.html).

## Fluxo e limites

- Controle confiável: `risk.game` versão 1 no canal existente, incluindo início/fim, sincronização para quem entra depois, pedido/aceite/rejeição e revogação.
- Input: `risk.game-input.v1`, não ordenado, `maxRetransmits: 0`, até 4 KiB por pacote. Se o canal ainda tem dados pendentes, o snapshot é descartado e o próximo frame tenta enviar o estado atual, evitando uma fila de comandos antigos.
- Toda concessão tem `sessionId`, `grantId`, peer autenticado e dispositivo. Cada snapshot leva uma sequência crescente. Pacotes repetidos, antigos ou de outra concessão são descartados no cliente e no backend.
- Teclado/botões são snapshots completos; mudanças de tecla são enviadas imediatamente e repetidas a cada frame. Mouse/scroll usam contadores acumulados para que o próximo snapshot compense um pacote perdido. O backend limita o deslocamento aplicado por atualização.
- Gamepad envia quatro eixos e 17 botões normalizados, aproximadamente 60 vezes por segundo. No Windows, esse estado é convertido para um relatório Xbox 360/XInput; no Linux, é convertido para eventos uinput. Teclas fora da tabela compartilhada não são injetadas; Esc fica reservado para as sobreposições e a saída.
- No caminho HTTP local, há no máximo uma requisição de input em andamento por jogador e um snapshot pendente, sempre o mais recente. Rotas exigem o token local do Electron e sessão de usuário; o encerramento de emergência exige apenas o token local e não aceita input.
- Após 250 ms sem input, o watchdog neutraliza teclas, botões e eixos, mas preserva a concessão e o dispositivo virtual por até 10 s para permitir retomada após uma oscilação breve. O primeiro frame após a pausa não aplica movimento acumulado do mouse. Sem heartbeat do anfitrião por 5 s, o backend encerra a sessão. O watchdog roda a cada 100 ms. Uma falha fatal do próprio processo nativo não oferece essa garantia.
- Falhas HTTP transitórias não revogam imediatamente o jogador. O token expirado é renovado; falta persistente de autenticação ou uma revogação real continuam encerrando o acesso.
- Enquanto joga, o receptor solicita `jitterBufferTarget = 0` para áudio e vídeo do anfitrião e restaura os valores anteriores ao sair. É uma preferência de baixa latência, limitada pelo navegador e pela rede, conforme a [especificação WebRTC](https://www.w3.org/TR/webrtc/#dom-rtcrtpreceiver-jitterbuffertarget).
- O modo começa em 1080p60 e prioriza framerate. RTT acima de 90 ms, perda acima de 2% ou jitter acima de 25 ms selecionam 720p60. Mudanças de qualidade têm intervalo mínimo de 10 s. Ao desligar, volta a preferência anterior. Esses limiares são uma política inicial, não uma garantia de latência semelhante ao Parsec.

## Validação e empacotamento

Há testes de protocolo, canal dedicado, autorização, coalescência, sessão antiga, concessão atrasada, revogação, recuperação de keyup e watchdog nativo. Os testes nativos de segurança usam um backend falso e não enviam teclas ao sistema. O backend Windows inclui testes puros do mapeamento Gamepad API → relatório Xbox 360, sem depender de um ViGEmBus instalado no runner.

Há verificações de abertura dos pacotes em Windows e em Linux com monitor virtual. A UI, a entrada automática, snapshots e revogação foram exercitados com dois peers WebRTC reais no Chromium e a fronteira nativa simulada. A implementação Linux/uinput precisa de validação em uma máquina Linux com o dispositivo disponível. O caminho ViGEm do Windows também deve ser validado em uma máquina com o driver instalado e em jogos reais/Steam. Em um teste local com frames neutros no Electron 43, o HTTP de input levou 2,6 ms de mediana e 4,6 ms no percentil 95; sob requisições concorrentes, 3,4 ms e 6,3 ms. Isso não mede o atraso total entre controle e imagem na internet nem a compatibilidade com jogos comerciais ou controles físicos.

É necessário recompilar **web, Electron e desktop-backend** para distribuir a função. O backend antigo não possui as novas rotas. A preparação normal do projeto está em `scripts/prepare-desktop-backend.mjs`; a etapa de compilação Rust incorpora o mapa `packages/protocol/src/game-keys.json`, que deve acompanhar os fontes.
