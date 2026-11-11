# Vale Studio Desktop — Windows x64

Esta pasta adiciona uma edição desktop ao Vale Studio web. Ela não substitui o app publicado no GitHub Pages: ambos usam a mesma interface React e o mesmo formato `.valestudio`.

## Usar VST3

- abre um seletor nativo de pastas de plug-ins;
- executa o scan em `vst3-host.exe`, fora do processo do app;
- carrega o módulo VST3 com as classes de hosting oficiais do SDK e lista apenas classes de efeito de áudio;
- retorna nome, fabricante, versão, class ID e caminho do bundle;
- encerra o scan após 25 segundos se ele travar.

Abra **Inserts** no cabeçalho da pista ou no mixer. Busque pelo nome do plug-in, insira e inicie a reprodução. Para instrumentos, use o primeiro slot de uma pista MIDI. Abra **Editor** durante a reprodução para escolher o timbre. Em **Sends**, ajuste o nível enviado aos retornos compartilhados de reverb e delay.

O controle **Buffer VST3** fica no transporte e ajusta o tamanho dos blocos com a reprodução parada. O padrão é 512 frames em sessões sem ajuste salvo. A estimativa ao lado mostra a espera da fila por insert. A entrada e a saída física continuam no WebView2, e esta versão ainda não conecta ao ASIO4ALL. O estado do componente fica no perfil local do Windows e ainda não acompanha backups entre computadores.

Para testar o retorno de áudio de um plug-in instalado, rode `node scripts/check-vst-stream.mjs "<caminho do módulo>" effect`. Para um instrumento que já inicia com um timbre carregado, troque `effect` por `instrument`.

## Ferramentas gratuitas necessárias

1. **Rust stable** — instale por [rustup](https://rustup.rs/).
2. **Visual Studio Build Tools** com a carga de trabalho **Desktop development with C++**. O script aceita os geradores Visual Studio 2022 e Visual Studio 2026 disponíveis no CMake.
3. **CMake 3.25 ou mais recente**.
4. Git, já usado pelo projeto.

Tauri depende de Rust, Microsoft C++ Build Tools e WebView2 no Windows. O SDK VST3 recomenda MSVC e CMake, e fornece os exemplos de hosting usados como referência por este host. [Pré-requisitos Tauri](https://v2.tauri.app/start/prerequisites/), [setup VST3](https://steinbergmedia.github.io/vst3_dev_portal/pages/Getting%2BStarted/How%2Bto%2Bsetup%2Bmy%2Bsystem.html)

## Preparar e gerar o instalador

```powershell
pnpm install --frozen-lockfile
pnpm desktop:doctor
pnpm desktop:build
```

`desktop:build` baixa o SDK oficial recursivamente em `work/vst3sdk` quando necessário, compila `native/vst3-host` e, por fim, chama Tauri. O SDK e os binários gerados são ignorados pelo Git. Os artefatos esperados ficam sob `src-tauri/target/release/bundle/nsis/` e `src-tauri/target/release/bundle/msi/`.

Também há uma ação **Build Vale Studio Desktop (Windows)**. Ela roda automaticamente quando os arquivos desktop mudam ou manualmente pela aba **Actions** do GitHub e anexa o `.exe`/`.msi` como artefato `vale-studio-desktop-windows-x64`. O pacote é funcionalmente instalável, mas não é assinado: o Windows pode pedir confirmação de reputação na primeira instalação.

Para desenvolver:

```powershell
pnpm desktop:dev
```

## Segurança e compatibilidade

- Só escolha pastas sob seu controle; os plug-ins pertencem ao usuário e não são redistribuídos pelo Vale Studio.
- Um VST3 pode falhar ou travar durante a inspeção. Por isso o scanner não roda no processo da interface, há timeout e erros por arquivo são retornados à tela.
- O host atual usa VST3 para Windows x64. VST2, AU e AAX seguem fora do host.
- Não há custo de licença para o SDK VST3 atual sob MIT ou para Tauri, mas assinatura de código, hardware de teste e distribuição macOS são decisões futuras separadas.
