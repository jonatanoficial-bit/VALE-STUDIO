# Matriz de aceitação v1.1

Status permitido: **PASS** (evidência anexada), **FAIL** (defeito reproduzível), **SKIP JUSTIFICADO** (sem plataforma ou pré-requisito), **PENDENTE** (ainda não avaliado). Teste não executado não é aprovado.

| Grupo | Critérios | Resultado atual da fundação | Evidência exigida para PASS |
| --- | --- | --- | --- |
| Projeto e importação | A01–A04, A39, A41, A44–A45, A68 | PENDENTE | Manifest persistido, decode/waveform reais, backup/restore e cenários inválidos. |
| Transporte, pistas e edição | A05–A09, A16–A20, A46–A47 | PENDENTE | Playback sem fontes duplicadas, mixer audível, edição/undo e orientação. |
| Gravação, overdub e takes | A10–A15, A40, A48, A53–A58, A66–A67, A70 | PENDENTE | Captura PCM, take salvo/reaberto, interrupção, takes independentes e monitor seguro. |
| Efeitos e mix | A21–A25, A29 | PENDENTE | Medição de mudança DSP e equivalência de render/prévia. |
| Exportações | A26–A30, A63–A64 | PENDENTE | Parser RIFF, decoder/ffprobe MP3, energia/duração/canais e stems alinhados. |
| Latência e dispositivos | A31–A38, A59–A61, A69 | PENDENTE | Fixtures de offset/drift, repetição, capability runtime e QA físico. |
| PWA, compatibilidade e UX | A42–A43, A49–A52, A62, A65 | PENDENTE | Offline instalado, subpath Pages, acessibilidade, licenças e dispositivos reais. |

## Bloqueadores de release

Falhas em A01, A03, A05, A09, A11, A13, A15, A26, A27, A31, A39, A41 ou A50 bloqueiam uma declaração de RC, assim como qualquer perda de gravação. A53–A70 são requisitos P0 do adendo v1.1 e recebem o mesmo tratamento de bloqueio quando aplicáveis.
