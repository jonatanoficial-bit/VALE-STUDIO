# Roadmap VST3 — Vale Studio Desktop

## Decisão de produto

O Vale Studio publicado no GitHub Pages continuará como DAW web local-first com efeitos nativos Web Audio. Ele **não tentará abrir arquivos `.vst3` no navegador**: plug-ins VST3 são módulos nativos executados por um host C++ e o navegador não pode descobrir diretórios de plug-ins, carregar bibliotecas nativas ou hospedar suas janelas de editor com segurança.

O suporte VST3 é viável como uma edição **Vale Studio Desktop** para Windows e macOS, mantendo a mesma interface React e o formato de projeto. A primeira entrega VST3 será renderização offline de um insert por pista; monitoramento VST em tempo real virá apenas depois de o motor de áudio nativo passar em medições de latência e estabilidade.

## Caminhos sem custo de licença

| Caminho | Custo de licença | Preserva o que já existe? | Indicação |
| --- | --- | --- | --- |
| **Recomendado: Tauri + host C++ próprio + VST3 SDK** | Nenhum para desenvolver e distribuir sem assinatura de código. Tauri é MIT/Apache-2.0 e o VST3 SDK atual é MIT. | **Sim.** React, a interface, o projeto `.valestudio`, backups e o motor Web Audio continuam; somente a edição Desktop acrescenta um processo nativo de plug-ins. | Melhor equilíbrio entre independência, segurança e continuidade. Começar por render offline. |
| **App desktop open source com JUCE sob AGPL** | Sem custo financeiro, mas todo o aplicativo distribuído precisa cumprir AGPL. | Parcialmente; o frontend pode continuar, porém a licença do produto muda. | Só faz sentido se o Vale Studio for publicado como software livre sob AGPL. |
| **Web/PWA atual** | Zero. | Já é o produto atual. | Mantém efeitos nativos Web Audio; não hospeda arquivos `.vst3`. |

O caminho recomendado não obriga apagar ou reescrever a versão web: o host recebe comandos de projeto por uma bridge estreita, executa scan/render VST3 fora da interface e devolve áudio renderizado, níveis e parâmetros. Para a primeira entrega gratuita, limite a compatibilidade a **Windows x64**, escolha uma pasta de plug-ins explicitamente, rode o scanner em processo isolado, tenha bypass/blacklist e ofereça controles genéricos de parâmetros. Só depois acrescente editor gráfico e áudio VST em tempo real.

Distribuir executáveis sem custo continua possível, mas pode gerar alertas de reputação do sistema sem assinatura de código. Para macOS, assinatura/notarização e ferramentas/plataformas de teste podem impor custos ou contas próprias; por isso “sem custo” é mais realista para desenvolvimento e uso no Windows do que para uma distribuição macOS polida.

## Arquitetura proposta

```text
Vale Studio Web / React       Vale Studio Desktop (Tauri shell)
        │                                 │
  projeto .valestudio ─────────────► Host nativo de áudio C++
                                          │
                             VST3 SDK → scan isolado → plug-ins do usuário
                                          │
                         parâmetros / preset / estado binário por instância
                                          │
                     render offline primeiro → I/O em tempo real depois
```

O host C++ usará o VST3 SDK oficial. A camada Tauri só oferece janela, instalação e bridge de comandos; não processa áudio no loop de UI. Para o caminho em tempo real, a decisão será entre um motor nativo próprio e um ring buffer de memória compartilhada com `AudioWorklet`, precedida de protótipo e medição. O browser puro mantém a cadeia Web Audio atual.

## Etapas

| Marco | Entrega | Critério de saída |
| --- | --- | --- |
| V0 — contrato de projeto | `PluginSlot` serializável: formato, fabricante, class ID, versão, parâmetros, preset e estado binário empacotado. | Projeto abre sem plug-in instalado e marca o insert como ausente sem perder automação. |
| V1 — desktop seguro | Tauri + serviço C++ separado, seleção explícita de pastas, scanner em processo isolado e catálogo local. | Um plug-in com falha não derruba o estúdio; ele entra em blacklist até o usuário liberar. |
| V2 — offline | Insert VST3 em uma pista e render offline de WAV/stems. | Comparação de duração/canais, reabertura do projeto e teste com plug-ins sem editor gráfico. |
| V3 — controles | UI genérica de parâmetros, presets e automação; editor nativo opcional em janela separada. | Fallback funciona quando o plug-in não possui editor ou não aceita a escala da janela. |
| V4 — tempo real | Cadeia nativa de I/O, bypass sem glitch, compensação de latência e recuperação de crash. | Medição em hardware, teste de dropout e sessão longa antes de liberar beta. |

## Segurança, compatibilidade e licenças

- O usuário instala e escolhe os próprios plug-ins; o Vale Studio não redistribui VST3 de terceiros.
- O scanner só lê os locais selecionados pelo usuário e executa cada inspeção fora do processo principal.
- Estado de plug-in é opaco: o projeto conserva ID/versão/estado mesmo se o plug-in estiver ausente; ao reabrir, o host tenta a compatibilidade indicada pelo fabricante e oferece bypass.
- Editor gráfico de plug-in é opcional. O host precisa funcionar com interface genérica de parâmetros, pois nem todo VST3 fornece uma janela embutível.
- O VST3 SDK é MIT, mas o uso do nome e da marca VST deve seguir as diretrizes de marca da Steinberg. A licença de cada plug-in continua independente.

## Fora do escopo inicial

VST2, AU/AUv3, AAX, instrumentos MIDI, sandbox de processamento por plug-in, bridge em rede e suporte VST3 no GitHub Pages não fazem parte da primeira entrega.

## Referências técnicas

- Steinberg — [VST3 SDK e host](https://steinbergmedia.github.io/vst3_dev_portal/pages/What%2Bis%2Bthe%2BVST%2B3%2BSDK/Index.html)
- Steinberg — [considerações de hosting](https://steinbergmedia.github.io/vst3_dev_portal/pages/FAQ/Hosting.html)
- MDN — [Web Audio API](https://developer.mozilla.org/en-US/docs/Web/API/Web_Audio_API)
