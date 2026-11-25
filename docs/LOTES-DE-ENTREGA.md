# Lotes restantes — Vale Studio

VST2 foi retirado do escopo. O aplicativo usa **somente VST3** como formato de plugin de terceiros. Cada item será marcado como entregue apenas depois de teste compatível com o risco; hardware e plugins de terceiros exigem validação específica.

## Lote 1 — Núcleo profissional de sessão, áudio, MIDI e VST3

Objetivo: uma sessão deve gravar, monitorar, recuperar e tocar instrumentos/VST3 de forma previsível no Windows antes de expandir ferramentas de pós-produção.

- Motor Windows: perfis de dispositivo, entrada/saída/canais, buffers, estado de driver, diagnóstico de interrupções/XRUN, recuperação e medição de latência. Inclui ampliar o I/O além da captura atual de duas pistas mono, validação longa e, onde tecnicamente viável, WASAPI Exclusive e ASIO de fabricante. ASIO4ALL continua opcional.
- Gravação: auto-input/input-only, pré/pós-roll, QuickPunch, loop MIDI, playlists/takes, BWF e escolhas de destino/formato. Conserva checkpoints e recuperação existentes.
- MIDI: filtro por canal de pista (**iniciado nesta entrega**), depois CC, pitch bend, aftertouch, program change, step input, loop MIDI, editor de eventos e mapas de tempo/compasso/sincronismo.
- VST3: catálogo/quarentena persistente, qualificação de plugins, compatibilidade de efeitos e instrumentos, PDC, presets/estado portável, automação de parâmetros, sidechain, múltiplos buses/saídas e auditoria com plugins reais. Não inclui VST2.
- Sessão: preferências centrais do Playback Engine, perfis de dispositivo, histórico de recuperação e dados de diagnóstico para suporte.

## Lote 2 — Produção, edição avançada, mixagem e pós-produção

Objetivo: elevar a edição, organização e entrega da sessão depois que o núcleo do Lote 1 estiver estável.

- Timeline/edição: Smart Tool, Shuffle, Scrubber, seleção por comprimento, grade relativa, grupos, overview, formatos multicanal, ajustes de DPI, temas, atalhos configuráveis e persistência do layout.
- Mixagem: grupos Edit/Mix, VCA, múltiplos masters, inserts de hardware, I/O avançado, automação de auxiliares e plugins, lanes simultâneas, freeze reversível e processamento offline selecionado.
- Mídia e projeto: navegador de mídia, relink por identidade, modelos personalizados, histórico, dither/opções de canal e exportação de clip/intervalo ampliada.
- Áudio avançado: edição elástica, análise rítmica, correção de pitch e ferramentas adicionais de restauração/processamento.
- Pós e interoperabilidade: vídeo, sincronismo/timecode profissional, AAF/OMF/MXF, superfícies de controle, tags, colaboração e chat.

## Critério de passagem

O Lote 2 não transforma o motor em aprovado. Antes dele, o Lote 1 precisa manter uma gravação longa com reprodução, restaurar uma interrupção, testar dispositivos físicos selecionados e qualificar os plugins VST3 usados na sessão de referência.
