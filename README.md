# VALE STUDIO

DAW web local-first, mobile-first e desktop, construída a partir da Bíblia Mestre v1.1. A identidade visual usa superfícies azul-grafite, ação em azul elétrico e REC em vermelho, conforme as referências recebidas.

## Estado desta entrega

Esta é a **fundação funcional de implementação**, não uma declaração de `v1.0 RC`. Ela já contém um app responsivo com criação/persistência local de projeto, importação e decode local de áudio, waveform calculada do buffer decodificado, transporte, AudioWorklet de captura PCM, journal local de chunks, recuperação explícita de take interrompido, commit atômico de take/asset/projeto, monitoramento selecionável, mixer/efeitos via Web Audio, edição não destrutiva básica, render WAV/MP3 local, stems WAV alinhados em ZIP, backup/restauração local `.valestudio`, layout de densidade adaptativa para mobile/desktop, PWA shell e CI para Pages.

O backup `.valestudio` guarda projeto e áudios em um único arquivo e restaura uma **nova cópia** da sessão; ele não substitui um projeto existente. O pacote ainda precisa de endurecimento antes de se declarar uma entrega P0 completa: validação de crash/kill em hardware, calibração por loopback e drift, interoperabilidade externa do backup, stems, automação, medição de hardware e a cobertura A01–A70. O estado de cada grupo está em [docs/ACCEPTANCE.md](docs/ACCEPTANCE.md).

## Rodar localmente

```bash
pnpm install --frozen-lockfile
pnpm dev
```

O microfone requer HTTPS ou `localhost` e sempre é solicitado depois de uma ação do usuário. Use fones: monitoramento via software está sujeito à latência física do dispositivo; o modo direto depende de uma interface de áudio que faça esse retorno fora do navegador.

## Verificar

```bash
pnpm lint
pnpm test
pnpm audit:audio
pnpm build
```

## Publicação

O workflow `.github/workflows/deploy-pages.yml` constrói a aplicação com caminhos relativos, adequados a `/VALE-STUDIO/`, e a publica em GitHub Pages após os gates locais. O service worker usa navegação network-first e não força takeover de uma sessão ativa. No repositório do GitHub, habilite **Settings → Pages → Build and deployment → GitHub Actions**.

## Privacidade

Não há login, analytics, upload compulsório ou dependência de backend. Áudios importados e takes são guardados pelo navegador do usuário. O usuário deve manter backups externos de qualquer sessão importante.

## Documentação

- [Análise integral da Bíblia Mestre](docs/ANALISE_BIBLIA_MESTRE.md)
- [Matriz de aceitação](docs/ACCEPTANCE.md)
- [Plano de cinco etapas](docs/PHASES.md)
- [Roadmap de suporte VST3 em desktop](docs/VST3-ROADMAP.md)
