# Estabilidade do áudio no Vale Studio Desktop

A prioridade da entrega Windows é reproduzir e gravar continuamente com pelo menos um backend validado em hardware. O ASIO4ALL fica disponível como opção secundária. Seu resultado de teste fica registrado, e a aprovação de outro backend permite avançar com o instalador.

## Estado do código

- **Interface e persistência.** React e TypeScript no WebView2, empacotados pelo Tauri. Sessões e checkpoints PCM ficam no armazenamento local. A captura atual usa Web Audio e AudioWorklet, com seleção de entrada e formato mono ou estéreo por pista.
- **Plugins.** O host VST3 em C++ opera em processo separado. O controle Buffer VST3 configura os blocos da ponte de plugins. O buffer do dispositivo físico é outro ajuste.
- **Áudio nativo.** O host WASAPI Shared em `native/wasapi-host` lista os endpoints e oferece captura PCM por entrada e reprodução da mixagem renderizada na saída escolhida. A sessão, os checkpoints e a reprodução normal pelo WebView2 continuam disponíveis. O protótipo ASIO4ALL permanece habilitável por `VALE_ASIO_HOST_PATH`. A mixagem interativa e o overdub no mesmo relógio nativo, WASAPI Exclusive e a seleção de ASIO do fabricante seguem pendentes.

## Seleção de driver e buffer

1. ASIO nativo do fabricante, quando a interface o oferecer.
2. WASAPI Exclusive, quando o dispositivo aceitar o formato e a configuração.
3. WASAPI Shared como alternativa de funcionamento.
4. ASIO4ALL como opção secundária.

A interface deve permitir escolher driver, entrada, saída, taxa e buffer. Priorizar 48 kHz e negociar um formato aceito pelo dispositivo. Oferecer 128, 256, 512 e 1024 frames conforme a capacidade reportada e exibir os valores efetivos. Se 128 frames provocar falhas recorrentes, oferecer 256 e depois 512. Durante a gravação, uma mudança de buffer exige encerrar ou recuperar o fluxo com aviso.

Manter a interface e os formatos de sessão atuais. Fazer o processamento de baixa latência na camada nativa existente ou em uma biblioteca compatível cuja integração e licença tenham sido verificadas. A escolha de biblioteca depende do código e dos testes. A referência ao JUCE no anexo é uma opção de avaliação.

## Processamento e recuperação

- Usar buffers pré-alocados e filas entre o callback e as threads de interface, disco e carregamento de plugins. O callback deve executar sem alocação dinâmica, I/O, espera bloqueante ou logs pesados. Preferir eventos e agendamento apropriado ao Windows, com MMCSS quando aplicável.
- Manter captura, retorno e reprodução da sessão alinhados ao relógio da interface. Se houver dispositivos com relógios independentes, tratar deriva e resampling antes de oferecer a combinação como configuração estável.
- Contabilizar underruns, overruns e perda de sincronização. Em caso de falha, registrar a ocorrência, fechar o fluxo com segurança, preservar a sessão e os checkpoints e tentar reinicializar fora da thread de áudio. Limitar as tentativas e oferecer outro backend compatível quando necessário, informando a interrupção.
- Preservar as configurações críticas do Windows e os arquivos internos dos drivers.

## Validação para o instalador

| Teste | Resultado exigido |
| --- | --- |
| A | Reproduzir um sinal ou arquivo conhecido. |
| B | Reproduzir por cinco minutos contínuos, com zero XRUNs na configuração aceita. |
| C | Gravar microfone enquanto outras pistas tocam e confirmar o take salvo. |
| D | Reproduzir várias pistas com os efeitos existentes e verificar a sincronia. |
| E | Parar, reiniciar e testar desconexão ou troca de dispositivo, preservando a sessão e a gravação já confirmada. |

Registrar por execução o Windows, driver, dispositivos, formato negociado, buffer efetivo, contadores de XRUN e erros. Conferir áudio sem cortes ou estalos, controles de driver, entrada, saída e buffer e reabertura de sessões existentes. Validar no app instalado em Windows x64. Testes com sinais simulados cobrem regressões do código. O aceite físico A–E ainda está pendente.

## Diagnóstico anterior do ASIO4ALL

O host detectou dois canais de entrada e saída do Bluetooth M10 em modo Hands-Free a 8 kHz. A consulta a 44,1 e 48 kHz recebeu `ASE_NoClock`. Em 8 kHz, o driver retornou sucesso ao iniciar, mas entregou zero callbacks com buffers de 256, 512 e 1024 frames. O autoteste sintético do host confirmou a cópia de amostras e o retorno mono e estéreo. Os testes localizam a falha antes da entrega de áudio pelo driver nessa configuração. A causa interna do driver permanece indeterminada.

O diagnóstico inicial fica encerrado com esse resultado. Para uma configuração de hardware diferente, limitar nova investigação do ASIO4ALL a duas tentativas fundamentadas e priorizar os outros backends após registrar o resultado.

## Primeira verificação do WASAPI Shared

A captura no TEYUN Q26 entregou 73.440 frames em mono e 71.040 em estéreo a 48 kHz, com período de 480 frames e buffer de 1.056 frames. Em loopback pelo cabo virtual, o host reproduziu um sinal estéreo de dois segundos a 48 kHz e capturou a 44,1 kHz. O RMS medido foi 0,0892 à esquerda e 0,0223 à direita, compatível com a razão de 4:1 do sinal enviado.

O diagnóstico de saída manteve o fluxo de silêncio por 300 segundos, a 48 kHz, com período de 480 e buffer de 1.056 frames. Foram observados 30.002 eventos e um evento com preenchimento zero. A reprodução de um sinal estéreo de cinco minutos no mesmo cabo virtual entregou 14.400.000 frames em 29.997 eventos, com um evento de preenchimento zero. Esse contador descreve o preenchimento do buffer. A medição completa de XRUNs, a avaliação audível em uma saída física e os testes de desconexão e overdub seguem pendentes.

No app, **Áudio nativo · WASAPI Shared** lista entradas e saídas com o formato do modo compartilhado. A captura funciona com o transporte parado. Ao armar exatamente duas pistas mono, é possível encaminhar dois canais consecutivos da mesma interface a dois takes sincronizados, com checkpoints e gravação final em transações conjuntas. A saída WASAPI toca a mixagem renderizada no dispositivo selecionado.
