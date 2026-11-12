# Vale Studio Desktop · critérios da próxima entrega

As imagens de referência guiam três áreas: Edição com cabeçalhos compactos e clipes coloridos, Gravação integrada ao transporte e Mixer com canais verticais. O checklist do usuário define o comportamento a validar. O formato atual de projetos, os takes, o host VST3 e os instaladores já publicados são a base da evolução.

A [matriz da especificação profissional](ESPECIFICACAO-DAW.md) registra o escopo atualizado de 12 de novembro de 2026, incluindo VST3 como formato exclusivo de terceiros.

## Marco 1 · entrada e saída no Windows

- Seguir a ordem de preferência, o gerenciamento de buffers e os testes descritos em [Estabilidade do áudio no Windows](ESTABILIDADE-AUDIO-WINDOWS.md). Exibir os frames efetivos e a latência de entrada e saída reportada após abrir o dispositivo.
- Usar o relógio do dispositivo para captura e reprodução. O retorno seco da pista armada deve passar pelo callback do driver, sem depender do processamento assíncrono do WebView2. Quando o driver oferecer monitoramento direto, apresentar essa opção à parte.
- Validar a captura e o retorno juntos com reprodução da sessão, dois tamanhos de buffer aceitos, alteração de dispositivo, parada e retomada. Manter monitoramento processado como opção distinta do retorno seco.
- Preservar os takes e projetos já salvos. Se o driver rejeitar a configuração, mostrar a causa sem marcar a sessão como conectada.

## Marco 2 · sessão de edição, gravação e mixagem

- **Edição**. Pistas de áudio, MIDI e instrumento, notas MIDI editáveis, ondas alinhadas, régua em tempo e compassos, tempo e fórmula de compasso, marcadores, playlists, seleção de intervalo, mover, trim, zoom, scrub, ferramentas de desenho, modos de edição, ganho de clipe, fades e crossfades. Validar edição de duração e ritmo, grupos e faixas de automação.
- **Gravação**. R e I por pista, entrada selecionável, gravação simultânea, contagem, metrônomo, pré e pós-roll, loop, punch, takes e comping. O punch deve preservar o material anterior para recuperação.
- **Mixagem**. Canais verticais com fader, pan, medidor e pico, solo e mute, slots de inserts e sends, seleção de entrada e saída, buses, retornos auxiliares, master, grupos, sidechain, compensação de atraso e controle VCA. Validar automação Off, Read, Write, Touch e Latch e a ação dos processadores e efeitos.
- **Atalhos**. Alternar Edição e Mixer, criar pistas, iniciar/parar, gravar, dividir, salvar, fades e loop, sem capturar teclas destinadas a campos de texto.
- **Aceitação final**. Abrir projeto salvo pela 0.1.6, gravar e ouvir uma pista armada pelo backend validado, mudar o buffer e medir o resultado, reproduzir áudio e MIDI com os VST3 validados, editar e exportar preservando o take original. Conferir a interface com as três referências e instalar o pacote em Windows x64.

A tela de edição já tem clipes coloridos com ondas preenchidas, grade por compasso ou subdivisão, editor de notas MIDI e lápis MIDI. O comping combina trechos de takes preservando as fontes e permite alternar entre o comp e o take inteiro. A gravação Web Audio oferece punch programado e loop de áudio com um take por passagem. A captura WASAPI suporta duas pistas mono da mesma interface. O mixer tem EQ de três bandas, saídas para auxiliares internos e até dez sends auxiliares por pista. A automação de volume e pan oferece Off, Read, Write, Touch e Latch. As passagens de automação são confirmadas ao pausar ou parar o transporte. EQ, curvas gravadas e roteamento são usados na reprodução e na exportação. A automação de parâmetros de plugins e o QuickPunch durante a reprodução continuam pendentes.

Um novo instalador completo depende da validação de um backend estável e das funções da entrega. O executável de diagnóstico em `native/asio-host` é compilado à parte, com um checkout local do SDK. Seu modo de verificação abre entrada e saída, mantém a saída muda e informa a quantidade de callbacks, sem gravar amostras em disco.

No desktop de desenvolvimento, `VALE_ASIO_HOST_PATH` habilita o painel ASIO4ALL na tela de gravação. O painel exige uma pista de áudio armada e o transporte parado. O retorno seco passa pelo callback ASIO. Desarmar a pista ou sair da tela fecha o retorno, e o painel só mostra o buffer efetivo depois de receber o primeiro bloco.

O **Formato de entrada** é salvo por pista. **Gravar via ASIO** abre um canal em mono ou dois canais consecutivos em estéreo, a partir da entrada escolhida, e usa o buffer físico. É possível habilitar o retorno seco durante a captura. A posição avança pelo número de frames recebidos. Os checkpoints e o WAV final preservam o formato de entrada. Se o driver interromper a captura ou a fila atingir o limite, a sessão mantém os checkpoints para recuperação. A reprodução da sessão pelo mesmo dispositivo e a captura simultânea em várias pistas seguem pendentes.

No PC de teste, o ASIO4ALL v2 inicializou com dois canais de entrada e dois de saída. Todos pertenciam ao Bluetooth M10 em modo Hands-Free. A taxa inicial era 8 kHz e o driver retornou `ASE_NoClock` ao consultar 44,1 e 48 kHz. A tentativa com a configuração preferida iniciou sem entregar callbacks. Esse resultado impede validar retorno audível ou latência física neste estado. O teste com amostras simuladas cobre a conversão do sinal de entrada e a cópia com ganho para os dois canais de saída.

```powershell
cmake -S native/asio-host -B work/asio-host-build -A x64 "-DASIO_SDK_ROOT=<checkout do SDK>"
cmake --build work/asio-host-build --config Release
& ./work/asio-host-build/Release/vale-asio-host.exe --probe 'ASIO4ALL v2'
& ./work/asio-host-build/Release/vale-asio-host.exe --verify 'ASIO4ALL v2' 256 48000
& ./work/asio-host-build/Release/vale-asio-host.exe --self-test
$env:VALE_ASIO_HOST_PATH = (Resolve-Path './work/asio-host-build/Release/vale-asio-host.exe').Path
pnpm desktop:dev
```
