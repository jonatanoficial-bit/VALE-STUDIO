# Situação do Vale Studio — 25/11/2026

O aplicativo é utilizável em cenários já testados, mas não está completo em relação às especificações profissionais. Uma função presente não implica compatibilidade com todo hardware ou plugin.

| Área | Disponível | Falta ou é parcial |
| --- | --- | --- |
| Windows e projeto | MSI/NSIS x64, projetos locais, salvamento, backup/restauração, cinco modelos iniciais | Templates personalizados, histórico de versões, navegador/relink de mídia, preferências e layouts completos |
| Áudio | WASAPI Shared, dispositivos de entrada/saída, períodos de buffer suportados, captura mono/estéreo, duas entradas mono simultâneas, base preparada e retorno seco condicionado à taxa | Grafo nativo inteiramente interativo, ASIO estável, WASAPI Exclusive, matriz I/O, mais de duas entradas mono, medição/compensação completa da latência e deriva |
| Gravação | Arm, medidores, ondas ao gravar, takes, contagem, metrônomo, punch programado, loop de áudio e comping básico, checkpoints e recuperação | QuickPunch durante reprodução, loop MIDI, playlists completas, monitoramento antes de gravar/auto-input, pós-roll, BWF e escolha completa da pasta/formato |
| Edição | Arrastar, trim, dividir, duplicar, ganho, fades/crossfades, undo/redo, cores, zoom, réguas, marcadores, bloqueio, consolidação, transientes e separação de silêncio | Smart Tool, Shuffle, Scrubber, grupos, grade relativa, overview e refinamento de ergonomia/DPI |
| Mixer | Volume, pan, mute/solo/Solo Safe, master, auxiliares, sends pré/pós, medidores e picos | VCA, grupos de mix, múltiplos masters, inserts externos e I/O avançada |
| Efeitos internos | EQ/filtro, compressor, reverb, delay, gate e limiter de pico por amostra | Processamento avançado; limiter não é uma garantia de true peak |
| Automação | Volume/pan Off/Read/Write/Touch/Latch; curvas por pontos de sends Reverb/Delay na 0.1.16 | Gravação gestual dos sends, auxiliares personalizados e plugins; lanes simultâneas |
| MIDI | Entrada externa, pista MIDI/instrumento, gravação e edição de notas/velocidade/canal, filtro de canal por pista, quantização, transposição, sustain, importar/exportar MIDI básico | Demais CC, pitch bend, aftertouch, program change, loop, step input, mapas de tempo/compasso, partitura e sincronismo |
| VST3 | Scan isolado, catálogo/cache/favoritos, inserts, efeitos/instrumentos, processamento em tempo real e offline, editor nativo quando disponível, bypass, estado local | Compatibilidade ampla comprovada, PDC completa, sidechain/múltiplas saídas, automação de parâmetros, estado/presets portáveis e quarentena persistente |
| Exportação | WAV/MP3, stems ZIP, intervalo, clipe WAV, renderizar pista em áudio | Freeze reversível no mesmo canal, dither/opções avançadas, AAF/OMF/MXF |
| Pós-produção | Régua visual de timecode fixo | Vídeo e sincronismo profissional, superfícies de controle, colaboração/chat, elasticidade e correção de afinação |

VST2 está fora do escopo. O Vale Studio usa exclusivamente VST3 para plugins de terceiros.

Testes de referência: houve captura de duas pistas por 610,49 s na 0.1.12 com cabo virtual. Isso não valida toda interface/driver físico nem todas as versões seguintes. EZdrummer 3 produziu áudio em teste do host; Kontakt e Reason não têm compatibilidade completa comprovada. Não há fundamento para declarar 90% de confiabilidade global.

Prioridade recomendada: consolidar motor/latência e I/O; ampliar compatibilidade e estado VST3; completar gravação/MIDI; depois edição e pós-produção avançadas.

Os itens pendentes foram agrupados em dois blocos de entrega em [LOTES-DE-ENTREGA.md](LOTES-DE-ENTREGA.md). O Lote 1 foi iniciado com o filtro de canal MIDI por pista da versão 0.1.17.
