# botcvortex

Bot local para automatizar o cVortex WorkFlow Studio usando Node.js, TypeScript, Playwright e uma sessao ja autenticada do Chrome via Chrome DevTools Protocol.

Esta versao nao faz login. Ela conecta em um Chrome aberto com `--remote-debugging-port=9222`, abre o workflow, clica no bloco **Iniciar**, abre **Tipo de Caso**, seleciona todas as opcoes e salva as alteracoes.

## Instalar dependencias

```bash
npm install
```

## Instalar Playwright

```bash
npx playwright install
```

## Criar o `.env`

```bash
cp .env.example .env
```

No Windows PowerShell:

```powershell
Copy-Item .env.example .env
```

## Configurar `.env`

```env
BOT_WORKFLOW_URL=https://amorsaude.cvortex.com/wos/service-flow/6a2dadc9e678af7c400b3228
BOT_CDP_URL=http://127.0.0.1:9222
BOT_KEEP_OPEN=true
BOT_SLOWMO_MS=0
BOT_PAUSE_BETWEEN_STEPS=false
BOT_WORKFLOW_RENDER_WAIT_MS=10000
```

- `BOT_WORKFLOW_URL`: URL do workflow que sera aberto.
- `BOT_CDP_URL`: endereco do Chrome aberto com remote debugging.
- `BOT_KEEP_OPEN`: mantem o navegador aberto ao final.
- `BOT_SLOWMO_MS`: deixa as acoes mais lentas para acompanhamento visual.
- `BOT_PAUSE_BETWEEN_STEPS`: se `true`, pede Enter antes das etapas importantes.
- `BOT_WORKFLOW_RENDER_WAIT_MS`: aguarda o editor do workflow renderizar antes de procurar o bloco.

## Modo seguro/lento

Para rodar mais devagar e estavel, use:

```env
BOT_EXECUTION_MODE=fast-safe
BOT_TARGET_TIME_PER_CLINIC_SECONDS=180
BOT_ACTION_DELAY_AFTER_BLOCK_CLICK_MS=300
BOT_ACTION_DELAY_AFTER_FIELD_CLICK_MS=250
BOT_ACTION_DELAY_AFTER_OPTION_SELECT_MS=100
BOT_ACTION_DELAY_AFTER_SAVE_CHANGES_MS=200
BOT_ACTION_WAIT_FOR_OPTIONS_TIMEOUT_MS=3500
BOT_OPTION_POLL_INTERVAL_MS=80
BOT_OPTION_MAX_WAIT_MS=2000
BOT_ACTION_OPTION_MAX_WAIT_MS=1000
BOT_ACTION_OPTION_POLL_INTERVAL_MS=50
BOT_SAVE_BUTTON_MAX_WAIT_MS=1000
BOT_SAVE_BUTTON_POLL_INTERVAL_MS=100
BOT_BOTFLOW_COLLECT_OPTIONS_STABLE_MS=300
```

O modo `fast-safe` e mais rapido que `half-safe` e e o recomendado agora. Campos sensiveis como **Tipo de Caso**, **Status** e **Fluxo de bot** usam o timing padrao do modo. Campos **Acao** usam tempos mais rapidos, porque costumam carregar com mais estabilidade.

Depois de digitar em autocompletes, o bot procura a opcao por polling e clica assim que encontra. Campos **Acao** usam polling mais curto para selecionar sem aguardar delays fixos. No **Fluxo de bot**, o bot aguarda apenas `BOT_BOTFLOW_COLLECT_OPTIONS_STABLE_MS` apos a primeira candidata aparecer para escolher a melhor Pesquisa de Satisfacao da clinica por prioridade.

Deixe `BOT_DELAY_AFTER_*` e `BOT_WAIT_FOR_*` vazios para usar os padroes do modo escolhido. Preencha apenas quando quiser sobrescrever um tempo especifico. O bot tambem mede o tempo por clinica e por etapa quando `BOT_MEASURE_TIMING=true`, gerando `logs/timing-report.json`.

Se ainda estiver falhando por carregamento lento, aumente:

```env
BOT_DELAY_AFTER_BLOCK_CLICK_MS=4000
BOT_DELAY_AFTER_TYPING_MS=4000
BOT_WAIT_FOR_OPTIONS_TIMEOUT_MS=25000
```

O bot continua sem publicar workflows. `BOT_PUBLISH_WORKFLOW=false` bloqueia publicacao, e `BOT_STOP_ON_ERROR=false` mantem a fila seguindo para a proxima clinica quando houver erro.

O retry por workflow e configurado por:

```env
BOT_MAX_RETRIES_PER_WORKFLOW=1
BOT_REFRESH_BEFORE_RETRY=true
BOT_WAIT_AFTER_BLOCK_CLICK_ON_RETRY_MS=5000
```

Quando uma opcao obrigatoria nao existe, o bot nao escolhe uma opcao parecida. Ele registra a opcao esperada e as opcoes disponiveis no TXT de erro para ajuste manual no cVortex.

Se o botao **Salvar Alteracoes** nao aparecer, mas o campo ja estiver correto, o bot registra um aviso e segue para o proximo bloco. Se o campo estiver vazio ou incorreto, a clinica entra como erro e o workflow nao e salvo.

## Abrir o Chrome para automacao no Windows

Feche outras janelas desse perfil e execute:

```powershell
& "C:\Program Files\Google\Chrome\Application\chrome.exe" --remote-debugging-port=9222 --user-data-dir="C:\cvortex-chrome-profile"
```

Esse perfil em `C:\cvortex-chrome-profile` deve ser usado so para o bot.

## Fazer login manualmente

No Chrome aberto pelo comando acima, acesse o cVortex e faca login uma vez manualmente.

Depois disso, o bot reaproveita essa sessao.

## Rodar o bot

```bash
npm run dev
```

O bot vai conectar no Chrome ja aberto, criar uma nova aba, abrir a URL do workflow e executar a automacao.

## Importante

O bot nao funciona com uma janela normal do Chrome aberta sem `--remote-debugging-port`.

Ele tambem nao conecta automaticamente em uma aba anonima ja aberta, porque precisa do Chrome iniciado com o perfil e a porta de debug configurados.

Se a URL do workflow cair em tela de login, o bot para e mostra:

```text
Sessao nao autenticada. Abra o Chrome com remote debugging, faca login no cVortex e rode o bot novamente.
```

## Evidencias

- Screenshot final: `./screenshots/tipo-caso-salvo.png`
- Screenshot em erro: `./screenshots/erro.png`
- Logs no terminal
