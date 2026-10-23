# Auditoria de requisitos - Vale Studio v1.1

## Fonte e método

Esta análise cobre integralmente a **Bíblia Mestre de Criação e Engenharia DAW Multipista Profissional v1.1**, recebida em 23 de outubro de 2026. O documento é uma especificação normativa, não uma evidência de que recursos já funcionam. Referências visuais anexadas complementam apenas a direção de interface; não substituem requisitos de áudio, persistência ou QA.

## Decisão de produto

O produto é uma DAW web local-first, gratuita, mobile-first (Android como prioridade), instalável quando o navegador suportar PWA e utilizável no desktop. O lançamento não pode ser chamado de “v1.0 RC” enquanto o fluxo completo importação -> overdub real -> edição -> efeitos audíveis -> WAV/MP3 válido -> reabertura/backup não tiver evidência de execução.

## Leitura capítulo a capítulo

| Capítulo | Requisito que fica congelado | Implicação de implementação |
| --- | --- | --- |
| 00 | Áudio real, sincronismo mensurável, arquivos preservados, exportação autêntica; nenhuma simulação apresentada como concluída. | Engine, estado e interface precisam declarar capacidades reais. |
| 01 | Público: cantores, compositores, igrejas, músicos, professores e produtores; uso simples, adulto e sem conta, anúncios ou upload compulsório. | Fluxo curto e dados apenas locais. |
| 02 | Home com novo projeto, abrir, importar, recentes, espaço/backup; assistentes de projeto e primeira gravação; navegação Pistas/Mixer/Efeitos/Projeto. | App shell responsivo, orientação de fones e permissão por gesto. |
| 03 | Visual premium grafite/azul-petróleo, seleção azul/ciano, REC exclusivamente vermelho, meters com cores próprias; acessibilidade AA. | Tokens de cor, controles >=44 px, rótulos, teclado e reduced motion. |
| 04 | P0 de projetos, pistas, transport, edição não destrutiva, mixer, efeitos verdadeiros, WAV/MP3, importação e exportação. | Nenhum controle entra na UI sem contrato funcional associado. |
| 05 | Captura PCM seca via AudioWorklet; clock em frames; cadeia separada de monitoramento; máquina de estados de transport. | AudioEngine isolado da UI, recorder worklet, operações atômicas e sem ScriptProcessor. |
| 06 | Overdub toca base e captura somente microfone; metadados de take guardam início, perfil e calibração. | Regiões por frame e captura em pista armada, com recomendações contra vazamento acústico. |
| 07 | Calibração distingue estimativa, offset, jitter e latência de retorno; ajuste reversível por perfil. | Sem promessa “0 ms”; painel de calibração e offset manual/medido. |
| 08 | Metrônomo sample-accurate com BPM 40–240, compassos e pré-contagem, fora do PCM gravado. | Scheduler do AudioContext e mapa de tempo comum ao REC/PLAY. |
| 09 | getUserMedia após gesto, constraints verificadas em runtime, dispositivos e monitoramento seguro. | Detecção de capacidades, MON OFF e mensagens específicas para permissão/hardware. |
| 10 | Separação MediaAsset/Clip/Track, corte/trim/move sem reescrever original e undo/redo. | Manifest com IDs, offsets/durações em frames e histórico não destrutivo. |
| 11 | HPF/EQ, compressor, gate, reverb, delay e limiter devem processar o som de verdade; presets explícitos. | Web Audio/DSP no grafo, bypass honesto e parâmetros persistidos. |
| 12 | Mix, faixa, stems e backup; WAV correto e MP3 MPEG Layer III real, com progresso/cancelamento. | Render offline, writer WAV, encoder MP3 local e validação de arquivo. |
| 13 | OfflineAudioContext deve reproduzir a topologia do live e exportar snapshot imutável. | Render separado da saída física e proteção de memória. |
| 14 | IndexedDB para metadados e OPFS quando houver; chunks/journal/drafts para recuperação. | Commit apenas após flush, storage estimate e backup portátil validado. |
| 15 | GitHub Pages sob subpasta, PWA, Actions e nenhum backend obrigatório. | BASE_URL em worklet/assets/manifest, service worker e workflow de deploy. |
| 16 | Integridade da gravação prevalece sobre efeitos e animações; modo leve e tratamento de drop-out. | Workers/caches e não bloquear a thread de áudio. |
| 17 | ESM/TypeScript, UI separada do engine, scripts de build/test/audit/deploy e contratos centrais. | Estrutura por domínio, contratos testáveis e sem recriar AudioContext por render. |
| 18 | Matriz Android Chrome prioritária; desktop Chrome/Edge completo; Safari com limitações explícitas. | Feature detection e degradação do recurso, não do projeto inteiro. |
| 19 | Manifest canônico versionado e invariantes de IDs, frames, amostragem, assets e export snapshot. | Schema versionado, migrações e referência de asset verificável. |
| 20 | Uma entrega principal funcional e, se necessário, endurecimento; nunca telas isoladas como produto. | O repositório deve rotular fundação como fundação, não como RC. |
| 21 | A01–A52 são critérios de aceitação com PASS/FAIL/SKIP e evidência por plataforma. | Matriz de teste mantida em `docs/ACCEPTANCE.md`. |
| 22 | Fixtures sintéticas testam clock, offset, WAV, MP3, mixer e metrônomo sem confundir isso com hardware. | Testes determinísticos para frames, containers e DSP. |
| 23 | QA manual real em Android, desktop e Safari quando disponível, com roteiro de áudio e UX. | Nenhum emulador é apresentado como aprovação de hardware. |
| 24 | Privacidade local-first, sem telemetria/ads/upload de áudio; validação de arquivos e licenças. | Sem SDK remoto de áudio; sanitização e notices obrigatórios. |
| 25 | README, arquitetura, guia, QA e ajuda contextual devem explicar monitoramento, sincronia e latência. | Documentação acompanha cada capacidade entregue. |
| 26 | Referências técnicas guiam decisões, não comprovam suporte atual. | APIs são testadas por capability, não inferidas por user agent. |
| 27 | Prompt operacional reforça P0 completo, áudio real e auditoria antes de anunciar conclusão. | Política anti-mock aplicada a código e comunicação. |
| 28 | Sete telas obrigatórias: projetos, sessão mobile, mixer/FX, desktop, calibração, exportação e recuperação. | Navegação e estados de erro fazem parte do produto. |
| 29 | P0, P1 e P2 definidos; perda de take, sync e export inválido bloqueiam release. | Backlog só expõe P0 implementado; P1/P2 não aparecem como botão. |
| 30 | Checklist de aceite exige prova em telefone e PC, WAV/MP3 verificados e projeto reaberto. | A release requer evidência material, não apenas build verde. |
| 31 | Caminho de gravação rápido, templates reais e gerenciador de takes sem sobrescrita silenciosa. | Cada REC cria asset imutável; take principal é selecionável e reversível. |
| 32 | Meter pré-fader, clipping real, MON OFF, teste de microfone e resgate de chunks. | O app mostra limites de AGC/hardware e não promete ganho físico. |
| 33 | Offset, jitter, drift, rates e dropout são causas distintas; nova calibração não move take antigo sem consentimento. | Perfil por rota/dispositivo e teste sintético de 2400 frames. |
| 34 | Peaks em cache, workers, RAM limitada e modo leve; freeze/comping/MIDI são posteriores. | P1/P2 ficam fora da navegação até serem operacionais. |
| 35 | Stems WAV consolidados desde 00:00, duração idêntica e nomes seguros; masterização assistida é P1. | Exportador preserva alinhamento e não chama RMS de LUFS. |
| 36 | A53–A70 acrescentam teste de entrada, takes, clipping, recuperação, drift, stems e background. | Cobertura adicional no mesmo gate de QA; escopo 1.1 fica congelado. |

## Confronto com as referências visuais

As nove imagens estabelecem uma linguagem visual consistente: superfícies escuras em camadas, azul elétrico para estado ativo, tipografia limpa, waveforms, rulers, faders, scopes e um único ponto vermelho dominante para REC. Elas também confirmam as telas centrais exigidas pela Bíblia: projetos, estúdio multipista em celular e desktop, gravação monitorada, mixer, edição, efeitos, metrônomo e takes. A implementação deve usar essa direção sem reproduzir literalmente dispositivos, marcas ou dados fictícios presentes nos concept arts.

## Sequência de construção aprovada pela análise

1. Fundação publicável: Vite, base path, PWA, CI, modelos canônicos, storage e matriz de aceitação.
2. Núcleo vertical real: gesto de áudio, importação/decode, transporte em frames, AudioWorklet PCM, take seco, persistência e playback.
3. Produção: metrônomo/contagem, monitoramento seguro, timeline/undo, mixer/FX reais, calibragem e takes.
4. Entrega de arquivo: offline render, WAV, MP3 local, stems e backup/restore.
5. Endurecimento: A01–A70 aplicáveis, QA em hardware real, acessibilidade, performance, PWA offline e publicação Pages.

## Regra de comunicação

Enquanto os gates de P0 não estiverem executados, o código será identificado como **fundação de implementação** e cada capacidade exibirá seu estado real. “v1.0 RC funcional” só pode ser usada após as provas listadas no capítulo 20 e no checklist do capítulo 30.
