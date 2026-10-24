# Plano de implementação em cinco etapas

O plano respeita a ordem de risco da Bíblia Mestre: primeiro o áudio preservado, depois a precisão musical, a portabilidade e, por último, a validação em dispositivos reais. Nenhuma etapa posterior transforma um requisito ainda pendente em aprovado.

| Etapa | Foco | Situação |
| --- | --- | --- |
| 1. Fundação local-first | Projeto, importação, Web Audio, AudioWorklet, mixer/efeitos, render, PWA e base de testes. | Concluída na fundação publicada. |
| 2. Integridade de gravação | Journal PCM durante a captura, recuperação de rascunho e commit atômico de projeto/asset/take. | Concluída em código; falta validação em hardware e crash real. |
| 3. Precisão de sessão | Transporte por frames, overdub, edição e fades robustos, calibração por loopback e tratamento de drift. | Em andamento: offset, fades, takes alternativos e coerência de timeline iniciados; loopback e drift pendentes. |
| 4. Portabilidade e continuidade | Backup/restauração `.valestudio`, exports/stems validados, PWA offline/upgrade e limites de armazenamento. | Em andamento: backup local autocontido e restauração como cópia independente implementados; stems, validação de upgrade e limites permanecem pendentes. |
| 5. Aceite de release | Execução documentada de A01–A70, múltiplos navegadores/dispositivos, permissões, interrupções e auditoria de licenças. | Pendente; é a única etapa que pode declarar RC. |

## Limite de cada etapa

O journal reduz a janela de perda a um trecho ainda não confirmado pelo IndexedDB; ele não substitui os testes A53–A58 de queda, encerramento forçado, reinício e recuperação em hardware. Por isso a etapa 2 não declara A10–A15 ou A53–A58 como **PASS**.
