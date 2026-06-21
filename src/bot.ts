import fs from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { Browser, chromium, Locator, Page } from "playwright";
import { BotConfig, RuleTiming } from "./config.js";
import {
  errorScreenshotsDir,
  firstVisible,
  info,
  ok,
  screenshotsDir
} from "./utils.js";

const notAuthenticatedMessage =
  "Sessao nao autenticada. Abra o Chrome com remote debugging, faca login no cVortex e rode o bot novamente.";

type WorkflowNodeKind = "any" | "status" | "action" | "transferToBot";

type TextMatcher = {
  includes: string[];
  excludes?: string[];
};

export type AutomationErrorDetails = {
  blockName?: string;
  fieldName?: string;
  expectedValue?: string;
  availableOptions?: string[];
};

export class AutomationError extends Error {
  details: AutomationErrorDetails;

  constructor(message: string, details: AutomationErrorDetails = {}) {
    super(message);
    this.name = "AutomationError";
    this.details = details;
  }
}

export class WhatsappAccountPendingError extends AutomationError {
  reason: string;

  constructor(reason: string, details: AutomationErrorDetails = {}) {
    super(reason, details);
    this.name = "WhatsappAccountPendingError";
    this.reason = reason;
  }
}

export type AlreadyConfiguredResult = {
  alreadyConfigured: boolean;
  reason: string;
};

type SaveChangesValidationInfo = {
  clinicName: string;
  url: string;
  blockName: string;
  fieldName: string;
  expectedValue: string;
  isFieldCorrect: boolean;
};

type OptionMatchMode = "exact" | "contains" | "containsIgnoringNumber" | "exactIgnoringNumber";

type VisibleOption = {
  text: string;
  locator: Locator;
};

type WhatsappAccountSelectionResult = {
  status: "selected" | "ambiguous" | "not_found";
  selected: VisibleOption | null;
  candidates: VisibleOption[];
  reason?: string;
};

type VisibleOptionLookupResult = {
  match: VisibleOption | null;
  options: VisibleOption[];
};

type FastOptionSelectParams = {
  fieldText: string;
  expectedValue: string;
  excludeValues?: string[];
  matchMode?: OptionMatchMode;
  maxWaitMs?: number;
  pollIntervalMs?: number;
  delayAfterSelectMs?: number;
};

let activeConfig: BotConfig | null = null;
let activeFieldText = "";
let activeWorkflowChanged = false;

export function setBotConfig(config: BotConfig): void {
  activeConfig = config;
}

export function resetWorkflowChanged(): void {
  activeWorkflowChanged = false;
}

export function hasWorkflowChanges(): boolean {
  return activeWorkflowChanged;
}

function markWorkflowChanged(): void {
  activeWorkflowChanged = true;
}

function getConfig(): BotConfig {
  if (!activeConfig) {
    throw new Error("Configuracao do bot nao inicializada.");
  }

  return activeConfig;
}

export function setCurrentRuleField(fieldText = ""): void {
  activeFieldText = fieldText;

  if (!fieldText) {
    return;
  }

  const timing = getTimingForRule({ fieldText });
  info(`Campo atual: ${fieldText}`);

  if (normalizeText(fieldText) === "acao") {
    info("Usando timing rapido para Acao");
  } else {
    info(`Usando timing padrao ${getConfig().executionMode} para campo sensivel`);
  }
}

export function getTimingForRule(rule: { fieldText?: string }): RuleTiming {
  const config = getConfig();
  const field = normalizeText(rule.fieldText || "");
  const defaultTiming: RuleTiming = {
    delayAfterPageLoadMs: config.delayAfterPageLoadMs,
    delayAfterBlockClickMs: config.delayAfterBlockClickMs,
    delayAfterFieldClickMs: config.delayAfterFieldClickMs,
    delayAfterTypingMs: config.delayAfterTypingMs,
    delayAfterOptionSelectMs: config.delayAfterOptionSelectMs,
    delayAfterSaveChangesMs: config.delayAfterSaveChangesMs,
    delayAfterSaveWorkflowMs: config.delayAfterSaveWorkflowMs,
    waitForOptionsTimeoutMs: config.waitForOptionsTimeoutMs,
    waitForFieldEnabledTimeoutMs: config.waitForFieldEnabledTimeoutMs,
    waitAfterBlockClickOnRetryMs: config.waitAfterBlockClickOnRetryMs
  };

  if (field === "acao") {
    return {
      ...defaultTiming,
      delayAfterBlockClickMs: config.actionDelayAfterBlockClickMs,
      delayAfterFieldClickMs: config.actionDelayAfterFieldClickMs,
      delayAfterOptionSelectMs: config.actionDelayAfterOptionSelectMs,
      delayAfterSaveChangesMs: config.actionDelayAfterSaveChangesMs,
      waitForOptionsTimeoutMs: config.actionWaitForOptionsTimeoutMs
    };
  }

  return defaultTiming;
}

function getCurrentTiming(): RuleTiming {
  return getTimingForRule({ fieldText: activeFieldText });
}

export async function waitStep(reason: string, ms: number): Promise<void> {
  if (ms <= 0) {
    return;
  }

  console.log(`[WAIT] Aguardando ${ms}ms ${reason}`);
  await new Promise((resolve) => setTimeout(resolve, ms));
}

export async function connectToExistingChrome(): Promise<{ browser: Browser; page: Page }> {
  const config = getConfig();

  try {
    info(`Conectando ao Chrome existente em ${config.cdpUrl}`);
    const browser = await chromium.connectOverCDP(config.cdpUrl, {
      slowMo: config.slowMoMs
    });
    const context = browser.contexts()[0] ?? await browser.newContext();
    const page = await context.newPage();
    await page.bringToFront();

    ok("Conectado ao Chrome existente");
    return { browser, page };
  } catch (error) {
    throw new Error(
      `Nao foi possivel conectar ao Chrome em ${config.cdpUrl}. Abra o Chrome com --remote-debugging-port=9222 e rode novamente. Detalhe: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  }
}

export async function openWorkflow(page: Page, workflowUrl: string): Promise<void> {
  const config = getConfig();

  await pauseIfEnabled("abrir workflow");
  info(`Abrindo workflow: ${workflowUrl}`);
  await page.bringToFront();
  await page.goto(workflowUrl, { waitUntil: "domcontentloaded" });
  await page.bringToFront();
  info(`Aguardando ${Math.round(config.workflowRenderWaitMs / 1000)}s para o workflow renderizar`);
  await page.waitForTimeout(config.workflowRenderWaitMs);
  await waitStep("apos carregar workflow", getTimingForRule({}).delayAfterPageLoadMs);
  await page.bringToFront();
  ok("Workflow aberto");
}

export async function ensureAuthenticated(page: Page): Promise<void> {
  info("Verificando sessao autenticada");

  const loginSignals = [
    page.locator("input[type='password']"),
    page.locator("form").filter({ has: page.locator("input[type='password']") }),
    page.getByRole("button", { name: /^(Entrar|Login|Acessar)$/i }),
    page.getByRole("link", { name: /^(Entrar|Login|Acessar)$/i })
  ];

  for (const signal of loginSignals) {
    if (await signal.first().isVisible().catch(() => false)) {
      throw new Error(notAuthenticatedMessage);
    }
  }

  if (/\/(login|signin|auth)\b/i.test(page.url())) {
    throw new Error(notAuthenticatedMessage);
  }

  ok("Sessao autenticada");
}

export async function clickStartBlock(page: Page): Promise<void> {
  await pauseIfEnabled('clicar no bloco "Iniciar"');
  info("Procurando bloco Iniciar");

  const candidates = [
    page.getByText(/^Iniciar$/i),
    page.locator("text=Iniciar"),
    page.locator("[aria-label*='Iniciar' i], [title*='Iniciar' i]")
  ];

  const foundCount = await countVisibleInLocators(candidates);
  const startBlock = await findFirstVisibleInLocators(candidates);

  if (foundCount > 1) {
    info(`Foram encontrados ${foundCount} elementos visiveis com texto Iniciar. O primeiro sera usado.`);
  }

  if (!startBlock) {
    await takeScreenshot(page, "erro-bloco-iniciar.png");
    await dumpVisibleTextsForDebug(page);
    throw new Error('Bloco "Iniciar" nao encontrado.');
  }

  ok("Bloco Iniciar encontrado");
  await startBlock.click();
  ok("Bloco Iniciar clicado");
  await waitStep("apos clicar no bloco", getCurrentTiming().delayAfterBlockClickMs);

  await page.getByText(/Tipo de Caso/i).first().waitFor({ state: "visible", timeout: 20000 });
}

export async function openTipoCasoField(page: Page): Promise<void> {
  await pauseIfEnabled('abrir "Tipo de Caso"');
  info("Procurando campo Tipo de Caso");

  const label = page.getByText(/Tipo de Caso/i).first();
  await label.waitFor({ state: "visible", timeout: 20000 });

  const labelInput = page.getByLabel(/Tipo de Caso/i);
  if (await labelInput.first().isVisible().catch(() => false)) {
    await waitForFieldEnabled(page, "Tipo de Caso").catch(() => undefined);
    await labelInput.first().click();
    await waitStep("apos clicar no campo", getCurrentTiming().delayAfterFieldClickMs);
    ok("Campo Tipo de Caso aberto");
    return;
  }

  const nearFieldCandidates = [
    label.locator(
      "xpath=ancestor::*[self::label or self::div or self::section][1]//input | ancestor::*[self::label or self::div or self::section][1]//button | ancestor::*[self::label or self::div or self::section][1]//*[@role='combobox']"
    ),
    label.locator("xpath=following::*[self::input or self::button or @role='combobox' or @role='button'][1]"),
    page.locator("[role='combobox']").filter({ hasText: /Tipo de Caso/i }),
    page.locator("select").filter({ hasText: /Tipo de Caso/i })
  ];

  const field = await findFirstVisibleInLocators(nearFieldCandidates);

  if (!field) {
    throw new Error('Campo "Tipo de Caso" nao encontrado.');
  }

  await waitForFieldEnabled(page, "Tipo de Caso").catch(() => undefined);
  await field.click();
  await waitStep("apos clicar no campo", getCurrentTiming().delayAfterFieldClickMs);
  ok("Campo Tipo de Caso aberto");
}

export async function selectAllTipoCasoOptions(page: Page): Promise<void> {
  await pauseIfEnabled("selecionar todas as opcoes de Tipo de Caso");
  info("Selecionando todas as opcoes");
  await ensureTipoCasoDropdownOpen(page);

  const listbox = page.locator("[role='listbox']").last();
  if (await listbox.isVisible().catch(() => false)) {
    await selectAllOpenAutocompleteOptions(page, listbox);
    await waitStep("apos selecionar opcao", getCurrentTiming().delayAfterOptionSelectMs);
    return;
  }

  const select = await firstVisible(page.locator("select").filter({ hasText: /Tipo de Caso/i }));
  if (select) {
    await selectAllNativeSelectOptions(select);
    await waitStep("apos selecionar opcao", getCurrentTiming().delayAfterOptionSelectMs);
    return;
  }

  await tryClickSelectAllOption(page);

  const seen = new Set<string>();
  let alreadyChecked = 0;
  let checkedNow = 0;
  let unchangedIterations = 0;
  let previousSeenSize = -1;

  for (let iteration = 0; iteration < 30; iteration += 1) {
    const options = page.locator(
      "[role='option'], [role='menuitemcheckbox'], label:has(input[type='checkbox']), input[type='checkbox']"
    );
    const count = await options.count();

    for (let index = 0; index < count; index += 1) {
      const option = options.nth(index);

      if (!(await option.isVisible().catch(() => false))) {
        continue;
      }

      const text = normalizeText(await option.innerText().catch(() => ""));
      const key = text || `checkbox-${index}`;

      if (seen.has(key)) {
        continue;
      }

      seen.add(key);

      const selected = await isOptionSelected(option);
      if (selected) {
        alreadyChecked += 1;
        continue;
      }

      await option.click();
      checkedNow += 1;
    }

    await scrollDropdownOrPanel(page);

    if (seen.size === previousSeenSize) {
      unchangedIterations += 1;
    } else {
      unchangedIterations = 0;
      previousSeenSize = seen.size;
    }

    if (unchangedIterations >= 2) {
      break;
    }
  }

  await page.keyboard.press("Escape").catch(() => undefined);
  await waitStep("apos selecionar opcao", getCurrentTiming().delayAfterOptionSelectMs);

  ok(`Total de opcoes encontradas: ${seen.size}`);
  ok(`Opcoes ja marcadas: ${alreadyChecked}`);
  ok(`Opcoes marcadas agora: ${checkedNow}`);
}

async function ensureTipoCasoDropdownOpen(page: Page): Promise<void> {
  if (await page.locator("[role='listbox']").last().isVisible().catch(() => false)) {
    return;
  }

  const combo = page.locator(".properties [role='combobox']").filter({ hasText: /Tipo de Caso/i }).last();
  if (await combo.isVisible().catch(() => false)) {
    await combo.click();
    await page.waitForTimeout(200);
    if (await page.locator("[role='listbox']").last().isVisible().catch(() => false)) {
      return;
    }

    await page.keyboard.press("ArrowDown").catch(() => undefined);
    await page.waitForTimeout(200);
  }
}

export async function clickStartCaseHandlingBlock(page: Page): Promise<void> {
  await clickWorkflowNode(page, /StarCase|StartCaseHandling/i, "StarCase");
  await waitForPropertiesPanel(page, /Propriedades de A/i);
}

export async function selectStartCaseHandlingAction(page: Page): Promise<void> {
  await selectPropertiesOption(page, "StartCaseHandling", "acao");
}

export async function clickAguardandoAtendimentoStatusBlock(page: Page): Promise<void> {
  await clickStatusNode(page, /Aguardando Atendimento/i, "Aguardando Atendimento");
}

export async function selectAguardandoAtendimentoStatus(page: Page): Promise<void> {
  await selectPropertiesOption(page, "Aguardando Atendimento", "status");
}

export async function updateAllEmAtendimentoAtivoBlocks(page: Page): Promise<void> {
  await updateAllStatusBlocks(
    page,
    { includes: ["Em Atendimento Ativo"] },
    "Em Atendimento Ativo",
    "em-atendimento-ativo"
  );
}

export async function updateAllPresidentePendenteEmAtendimentoBlocks(page: Page): Promise<void> {
  await updateAllStatusBlocks(
    page,
    { includes: ["Presidente Prudente", "Em Atendimento"], excludes: ["Ativo"] },
    "Em Atendimento",
    "presidente-pendente-em-atendimento"
  );
}

export async function updateAllAguardandoAtendimentoBlocks(page: Page): Promise<void> {
  await updateAllStatusBlocks(
    page,
    { includes: ["Aguardando Atendimento"], excludes: ["CS Aguardando Atendimento"] },
    "Aguardando Atendimento",
    "aguardando-atendimento"
  );
}

export async function updateAllPresidenteAguardandoRespostaPacienteBlocks(page: Page): Promise<void> {
  await updateAllStatusBlocks(
    page,
    { includes: ["Presidente Prudente", "Aguardando Resposta Paciente"] },
    "Aguardando Resposta Paciente",
    "aguardando-resposta-paciente"
  );
}

export async function updateAllPresidenteConfirmacaoAguardandoAcaoBlocks(page: Page): Promise<void> {
  await updateAllStatusBlocks(
    page,
    { includes: ["Presidente Prudente", "Confirmacao Aguardando Acao"] },
    "Confirmacao Aguardando Acao",
    "confirmacao-aguardando-acao"
  );
}

export async function updateAllPresidenteAgendadoBlocks(page: Page): Promise<void> {
  await updateAllStatusBlocks(
    page,
    { includes: ["Presidente Prudente", "Agendado"] },
    "Agendado",
    "agendado"
  );
}

export async function updateAllPresidenteContatoAtivoBlocks(page: Page): Promise<void> {
  await updateAllStatusBlocks(
    page,
    { includes: ["Presidente Prudente", "Contato Ativo"] },
    "Contato Ativo Livre",
    "contato-ativo-livre-status"
  );
}

export async function updateAllFinalizadoBlocks(page: Page): Promise<void> {
  await updateAllStatusBlocks(page, { includes: ["Finalizado"] }, "Finalizado", "finalizado");
}

export async function updateAllPresidenteNavegacaoPesquisaBlocks(page: Page): Promise<void> {
  await updateAllStatusBlocks(
    page,
    { includes: ["Presidente Prudente", "Navegacao BOT Pesquisa de Satisfacao"] },
    "Navegacao Pesquisa de Satisfacao",
    "navegacao-pesquisa-satisfacao"
  );
}

export async function updateAllTabulacaoSubcategoriaBlocks(page: Page): Promise<void> {
  await updateAllStatusBlocks(
    page,
    { includes: ["Tabulacao Subcategoria"] },
    "Tabulacao Subcategoria",
    "tabulacao-subcategoria"
  );
}

export async function updateAllTabulacaoCondutaBlocks(page: Page): Promise<void> {
  await updateAllStatusBlocks(
    page,
    { includes: ["Tabulacao Conduta"] },
    "Tabulacao Conduta",
    "tabulacao-conduta"
  );
}

export async function updateActionBlock(page: Page, blockText: TextMatcher, optionName: string, screenshotPrefix: string): Promise<void> {
  await updateAllBlocks(page, "action", blockText, optionName, "acao", screenshotPrefix);
}

export async function updateAllEnviarWhatsappAccountBlocks(page: Page): Promise<void> {
  const config = getConfig();
  const nodeIds = await getWorkflowNodeIdsByText(page, "any", { includes: ["Enviar Whatsapp"] });
  const total = nodeIds.length;
  info(`Foram encontrados ${total} blocos Enviar Whatsapp para validar Conta`);

  if (!total) {
    info("Nenhum bloco Enviar Whatsapp encontrado. Seguindo.");
    return;
  }

  let changedCount = 0;
  let skippedCount = 0;

  for (const [index, nodeId] of nodeIds.entries()) {
    const step = index + 1;
    const debugName = `Enviar Whatsapp ${step}`;
    setCurrentRuleField("Conta");

    try {
      info(`Atualizando Conta do bloco Enviar Whatsapp ${step}/${total}`);
      info(`Clinica atual: ${config.clinicName}`);
      await clickWorkflowNodeById(page, "any", nodeId, debugName);
      await waitForPropertiesPanel(page, /Propriedades d/i);

      if (config.attemptNumber > 1) {
        const retryWaitMs = getCurrentTiming().waitAfterBlockClickOnRetryMs;
        info(`Segunda tentativa: aguardando ${retryWaitMs}ms para o painel carregar`);
        await page.waitForTimeout(retryWaitMs);
      }

      let savedThisBlock = false;

      for (let blockAttempt = 1; blockAttempt <= 2; blockAttempt += 1) {
        const currentAccount = await getCurrentWhatsappAccountValue(page);
        if (doesTextContainClinic(currentAccount, config.clinicName)) {
          ok(`Conta ja pertence a clinica ${config.clinicName}: ${currentAccount}`);
          const pendingSaveButton = await findSaveChangesButton(page);
          if (pendingSaveButton) {
            info(`Conta ja esta correta, mas existem alteracoes pendentes no bloco Enviar Whatsapp ${step}/${total}. Salvando.`);
            await saveChanges(page);
            changedCount += 1;
            ok(`Alteracoes pendentes salvas no bloco Enviar Whatsapp ${step}/${total}`);
            await takeScreenshot(page, `enviar-whatsapp-conta-${step}-salvo.png`);
          } else if (savedThisBlock) {
            changedCount += 1;
            ok(`Alteracoes da Conta salvas e confirmadas no bloco Enviar Whatsapp ${step}/${total}`);
            await takeScreenshot(page, `enviar-whatsapp-conta-${step}-salvo.png`);
          } else {
            info("[SKIP] Nenhuma alteracao necessaria neste bloco.");
            skippedCount += 1;
          }
          break;
        }

        info(`Conta atual nao pertence a clinica: ${currentAccount || "vazio"}`);
        info(`Tentativa ${blockAttempt}/2 para salvar Conta do bloco Enviar Whatsapp ${step}/${total}`);
        const selectedAccount = await selectWhatsappAccountInPanel(page, config.clinicName, currentAccount, debugName);
        const updatedAccount = await getCurrentWhatsappAccountValue(page);

        if (!doesTextContainClinic(updatedAccount || selectedAccount, config.clinicName)) {
          throw new AutomationError(`Campo Conta nao ficou preenchido com a clinica ${config.clinicName}. Valor atual: ${updatedAccount || "vazio"}`, {
            blockName: debugName,
            fieldName: "Conta",
            expectedValue: selectedAccount
          });
        }

        ok(`Campo Conta preenchido com: ${updatedAccount || selectedAccount}`);
        info(`Salvando alteracoes obrigatoriamente no bloco Enviar Whatsapp ${step}/${total}`);
        await saveChanges(page);
        savedThisBlock = true;

        const confirmedAccount = await getCurrentWhatsappAccountValue(page);
        if (doesTextContainClinic(confirmedAccount || updatedAccount || selectedAccount, config.clinicName)) {
          changedCount += 1;
          ok(`Alteracoes da Conta salvas e confirmadas no bloco Enviar Whatsapp ${step}/${total}`);
          await takeScreenshot(page, `enviar-whatsapp-conta-${step}-salvo.png`);
          break;
        }

        console.warn(`[WARN] Conta do bloco Enviar Whatsapp ${step}/${total} ainda nao confirmou apos salvar. Valor atual: ${confirmedAccount || "vazio"}`);

        if (blockAttempt === 2) {
          throw new AutomationError(`Conta do bloco Enviar Whatsapp ${step}/${total} nao confirmou apos salvar.`, {
            blockName: debugName,
            fieldName: "Conta",
            expectedValue: selectedAccount
          });
        }
      }
    } finally {
      setCurrentRuleField();
    }
  }

  ok(
    `Validacao de Conta concluida em todos os blocos Enviar Whatsapp. ` +
      `Alterados: ${changedCount}. Ja corretos: ${skippedCount}. Total: ${total}.`
  );
}

export async function updateAllTransferToBotBlocks(page: Page): Promise<void> {
  await updateAllBlocks(
    page,
    "transferToBot",
    { includes: ["Transferir para Bot"] },
    "Pesquisa de Satisfacao",
    "bot",
    "transferir-para-bot"
  );
}

export async function saveWorkflow(page: Page): Promise<void> {
  await saveWorkflowOnly(page);
}

export async function saveWorkflowOnly(page: Page): Promise<void> {
  info("Salvando workflow sem publicar");

  if (!getConfig().publishWorkflow) {
    await assertNoPublishClickTarget(page);
  }

  const buttons = page.getByRole("button", { name: /Salvar Workflow/i });
  const count = await buttons.count().catch(() => 0);
  let saveButton: Locator | null = null;

  for (let index = 0; index < count; index += 1) {
    const button = buttons.nth(index);

    if (!(await button.isVisible().catch(() => false))) {
      continue;
    }

    const text = normalizeVisibleText(await button.innerText().catch(() => ""));
    assertPublishIsDisabled(text);
    saveButton = button;
    break;
  }

  if (!saveButton) {
    throw new Error('Botao "Salvar Workflow" nao encontrado.');
  }

  await saveButton.click();
  ok("Salvar Workflow clicado");
  await page.waitForLoadState("networkidle", { timeout: 5000 }).catch(() => undefined);
  await waitStep("apos salvar workflow", getTimingForRule({}).delayAfterSaveWorkflowMs);
  ok("Workflow salvo sem publicar");
}

export function assertPublishIsDisabled(buttonText: string): void {
  if (!getConfig().publishWorkflow && hasPublishText(buttonText)) {
    console.log("[SEGURANCA] Publicacao bloqueada. BOT_PUBLISH_WORKFLOW=false");
    throw new Error(`Tentativa de clicar em publicacao bloqueada: ${buttonText}`);
  }
}

async function assertNoPublishClickTarget(page: Page): Promise<void> {
  const publishTarget = page.getByRole("button", { name: /Publicar|Publish|Publica[cç][aã]o|Publicacao/i });

  if (await publishTarget.first().isVisible().catch(() => false)) {
    console.log("[SEGURANCA] Publicacao bloqueada. BOT_PUBLISH_WORKFLOW=false");
  }
}

function hasPublishText(value: string): boolean {
  const normalized = normalizeText(value);
  return normalized.includes("publicar") ||
    normalized.includes("publish") ||
    normalized.includes("publicacao");
}

async function updateAllStatusBlocks(
  page: Page,
  blockText: TextMatcher,
  optionName: string,
  screenshotPrefix: string
): Promise<void> {
  await updateAllBlocks(page, "status", blockText, optionName, "status", screenshotPrefix);
}

async function updateAllBlocks(
  page: Page,
  kind: WorkflowNodeKind,
  blockText: TextMatcher,
  optionName: string,
  fieldName: string,
  screenshotPrefix: string
): Promise<void> {
  const nodeIds = await getWorkflowNodeIdsByText(page, kind, blockText);
  const total = nodeIds.length;
  info(`Foram encontrados ${total} blocos para selecionar "${optionName}"`);

  if (!total) {
    if (isPresidentPrudenteLegacyRule({ name: blockText.includes.join(" "), blockText: blockText.includes.join(" ") })) {
      const already = await isAlreadyConfigured(page, {
        name: blockText.includes.join(" "),
        blockText: blockText.includes.join(" "),
        value: optionName
      });

      if (already.alreadyConfigured) {
        console.log(`[SKIP] ${blockText.includes.join(" ")}: ${already.reason}`);
        return;
      }
    }

    throw new AutomationError(`Nenhum bloco encontrado para: ${blockText.includes.join(" ")}`, {
      blockName: blockText.includes.join(" ")
    });
  }

  for (const [index, nodeId] of nodeIds.entries()) {
    const step = index + 1;
    const config = getConfig();
    const debugName = kind === "transferToBot" ? blockText.includes.join(" ") : `${optionName} ${step}`;
    const fieldLabel = kind === "transferToBot" ? "Fluxo de bot" : getFieldLabel(fieldName);
    setCurrentRuleField(fieldLabel);

    try {
      info(`Atualizando bloco ${step}/${total}: ${optionName}`);
      await clickWorkflowNodeById(page, kind, nodeId, debugName);
      await waitForPropertiesPanel(page, kind === "status" ? /Propriedades de Status/i : /Propriedades d/i);
      if (config.attemptNumber > 1) {
        const retryWaitMs = getCurrentTiming().waitAfterBlockClickOnRetryMs;
        info(`Segunda tentativa: aguardando ${retryWaitMs}ms para o painel carregar`);
        await page.waitForTimeout(retryWaitMs);
      }
      if (kind === "transferToBot" && isPesquisaSatisfacaoSearch(optionName)) {
        const currentValue = await getCurrentBotFlowValue(page).catch(() => "");
        if (isBotFlowAlreadyCorrect(currentValue, config.clinicName)) {
          ok(`Campo Fluxo de bot ja esta preenchido com ${currentValue}. Nenhuma alteracao necessaria.`);
          info("[SKIP] Seguindo para o proximo bloco.");
          continue;
        }
        await selectBotFlowPesquisaSatisfacao(page, config.clinicName);
      } else {
        if (await isPropertiesSelectionCorrectForField(page, optionName, fieldName)) {
          ok(`Campo ${fieldLabel} ja esta preenchido com ${optionName}. Nenhuma alteracao necessaria.`);
          info("[SKIP] Seguindo para o proximo bloco.");
          continue;
        }
        await selectPropertiesOption(page, optionName, fieldName);
      }
      const isFieldCorrect = await isPropertiesSelectionCorrectForField(page, optionName, fieldName);
      await saveChangesIfNeeded(page, {
        clinicName: config.clinicName,
        url: config.workflowUrl,
        blockName: debugName,
        fieldName: fieldLabel,
        expectedValue: optionName,
        isFieldCorrect
      });
      await takeScreenshot(page, `${screenshotPrefix}-${step}-salvo.png`);
    } finally {
      setCurrentRuleField();
    }
  }
}

export async function detectWorkflowAlreadyProcessed(page: Page, clinicName: string): Promise<AlreadyConfiguredResult> {
  info("Verificando se workflow ja foi processado");
  const bodyText = normalizeText(await page.locator("body").innerText().catch(() => ""));

  if (bodyText.includes("presidente prudente")) {
    return {
      alreadyConfigured: false,
      reason: "Ainda existem blocos legados Presidente Prudente"
    };
  }

  ok("Nenhum bloco legado Presidente Prudente encontrado");

  const finalValues = [
    "Aguardando Atendimento",
    "Em Atendimento",
    "Aguardando Resposta Paciente",
    "Confirmacao Aguardando Acao",
    "Agendado",
    "Contato Ativo",
    "Contato Ativo Livre",
    "Finalizado",
    "Tabulacao Subcategoria",
    "Subcategoria",
    "Tabulacao Conduta",
    "Conduta Profissional"
  ];
  const foundValues = finalValues.filter((value) => bodyText.includes(normalizeText(value)));

  if (foundValues.length >= 6) {
    ok("Valores finais encontrados no canvas");
    return {
      alreadyConfigured: true,
      reason: "Workflow aparenta ja estar configurado. Nenhum bloco legado Presidente Prudente encontrado."
    };
  }

  return {
    alreadyConfigured: false,
    reason: `Valores finais insuficientes encontrados: ${foundValues.join(", ") || "nenhum"}`
  };
}

function isPresidentPrudenteLegacyRule(rule: { name?: string; blockText?: string }): boolean {
  const name = normalizeText(rule.name || "");
  const blockText = normalizeText(rule.blockText || "");

  return name.includes("presidente prudente") || blockText.includes("presidente prudente");
}

async function isAlreadyConfigured(
  page: Page,
  rule: { name?: string; blockText?: string; value: string }
): Promise<AlreadyConfiguredResult> {
  const bodyText = normalizeText(await page.locator("body").innerText().catch(() => ""));
  const expected = normalizeText(rule.value);
  const saveButton = await findSaveChangesButton(page);

  if (bodyText.includes(expected) && !saveButton) {
    return {
      alreadyConfigured: true,
      reason: "Bloco antigo nao encontrado, mas valor final ja esta presente"
    };
  }

  return {
    alreadyConfigured: false,
    reason: "Valor final esperado nao foi encontrado ou ha alteracoes pendentes"
  };
}

async function getWorkflowNodeIdsByText(page: Page, kind: WorkflowNodeKind, matcher: TextMatcher): Promise<string[]> {
  const locator = page.locator(nodeSelector(kind));
  const count = await locator.count().catch(() => 0);
  const ids: string[] = [];

  for (let index = 0; index < count; index += 1) {
    const node = locator.nth(index);
    const text = normalizeForMatch(await node.innerText().catch(() => ""));

    if (!matchesText(text, matcher)) {
      continue;
    }

    const id = await node.getAttribute("data-id").catch(() => null);
    if (id) {
      ids.push(id);
    }
  }

  return ids;
}

async function clickWorkflowNodeById(page: Page, kind: WorkflowNodeKind, nodeId: string, debugName: string): Promise<void> {
  await clickWorkflowNode(page, /.*/, debugName, page.locator(`${nodeSelector(kind)}[data-id="${nodeId}"]`));
}

export async function extractClinicNameFromWorkflowTitle(page: Page): Promise<string> {
  const titleCandidates = [
    await page.locator("body").innerText().catch(() => ""),
    await page.title().catch(() => "")
  ];

  for (const candidate of titleCandidates) {
    const match = candidate.match(/AmorSa[uú]de\s*-\s*([^\n\/]+?)(?:\s+V\d+|\s+Em Constru[cç][aã]o|$)/i);
    const clinicName = match?.[1]?.trim();

    if (clinicName) {
      return clinicName;
    }
  }

  return "";
}

export async function selectBotFlowPesquisaSatisfacao(page: Page, clinicName?: string): Promise<void> {
  info("Procurando campo Fluxo de bot");
  const input = await findEnabledBotFlowField(page);
  ok("Campo Fluxo de bot encontrado");

  const selectedClinicName = clinicName?.trim() || getConfig().clinicName || await extractClinicNameFromWorkflowTitle(page);
  const currentValue = await getCurrentBotFlowValue(page);
  info(`Valor atual do Fluxo de bot: ${currentValue || "vazio"}`);
  info(`Clinica usada para filtro: ${selectedClinicName || "(nao identificada)"}`);

  if (isBotFlowAlreadyCorrect(currentValue, selectedClinicName)) {
    ok(`Fluxo de bot ja esta correto: ${currentValue}`);
    return;
  }

  info("Preenchendo Fluxo de bot");
  await input.click();
  await waitStep("apos clicar no campo", getCurrentTiming().delayAfterFieldClickMs);
  await input.press("Control+A").catch(() => undefined);
  await input.press("Backspace").catch(() => undefined);
  info('Digitando "pesq"');
  await input.fill("pesq");
  const bestOption = await waitAndSelectBotFlowPesquisaSatisfacaoFast(page, selectedClinicName);
  ok(`Opcao selecionada: ${bestOption}`);
  await page.keyboard.press("Escape").catch(() => undefined);

  const updatedValue = await getCurrentBotFlowValue(page);
  if (!isBotFlowAlreadyCorrect(updatedValue, selectedClinicName)) {
    const availableOptions = await collectBotFlowOptions(page);
    throw new AutomationError(`Campo "Fluxo de bot" nao ficou preenchido corretamente. Valor atual: ${updatedValue || "vazio"}`, {
      fieldName: "Fluxo de bot",
      expectedValue: bestOption,
      availableOptions: availableOptions.map((option) => option.text)
    });
  }
}

export async function findEnabledBotFlowField(page: Page): Promise<Locator> {
  return waitUntilFieldEnabled(page, "Fluxo de bot", 3, 2000);
}

async function waitAndSelectBotFlowPesquisaSatisfacaoFast(page: Page, clinicName: string): Promise<string> {
  const config = getConfig();
  const maxWaitMs = config.optionMaxWaitMs;
  const pollIntervalMs = config.optionPollIntervalMs;
  const stableMs = config.botFlowCollectOptionsStableMs;
  const startedAt = Date.now();
  let lastOptions: Array<{ text: string; locator: Locator }> = [];
  const expectedValue = `${clinicName || "(clinica nao identificada)"} - Pesquisa de Satisfacao`;

  info(`Procurando opcao de Pesquisa de Satisfacao por ate ${maxWaitMs}ms`);

  while (Date.now() - startedAt < maxWaitMs) {
    const options = await collectBotFlowOptions(page);
    lastOptions = options;
    const candidates = getPesquisaSatisfacaoCandidates(options, clinicName);

    if (candidates.length) {
      info(`Primeira opcao valida encontrada. Coletando opcoes por mais ${stableMs}ms`);
      await page.waitForTimeout(stableMs);
      const stableOptions = await collectBotFlowOptions(page);
      lastOptions = stableOptions;
      const stableCandidates = getPesquisaSatisfacaoCandidates(stableOptions, clinicName);
      const selected = stableCandidates[0] ?? candidates[0];

      logPesquisaSatisfacaoCandidates(stableCandidates.length ? stableCandidates : candidates, clinicName);
      ok(`Melhor opcao escolhida: ${selected.option.text}`);
      await clickBotFlowOption(page, selected.option);
      return selected.option.text;
    }

    await page.waitForTimeout(pollIntervalMs);
  }

  await dumpVisiblePanelTexts(page);
  throw new AutomationError(
    `Nenhuma opcao de Pesquisa de Satisfacao encontrada para a clinica ${clinicName || "(nao identificada)"}. ` +
      `Opcoes encontradas: ${lastOptions.map((option) => option.text).join(" | ")}`,
    {
      fieldName: "Fluxo de bot",
      expectedValue,
      availableOptions: lastOptions.map((option) => option.text)
    }
  );
}

async function clickBotFlowOption(page: Page, option: { text: string; locator: Locator }): Promise<void> {
  const clickable = await getClickableOptionLocator(option.locator);

  await clickable.click({ timeout: 1000 }).catch(async () => {
    await clickable.click({ timeout: 1000, force: true }).catch(async () => {
      const optionByText = page.getByText(option.text, { exact: false }).last();
      await optionByText.click({ timeout: 1000, force: true });
    });
  });
}

async function getClickableOptionLocator(locator: Locator): Promise<Locator> {
  const roleOption = locator.locator("xpath=ancestor-or-self::*[@role='option'][1]");
  if (await roleOption.count().catch(() => 0)) {
    return roleOption.first();
  }

  const ngOption = locator.locator("xpath=ancestor-or-self::*[contains(@class,'ng-option')][1]");
  if (await ngOption.count().catch(() => 0)) {
    return ngOption.first();
  }

  const listItem = locator.locator("xpath=ancestor-or-self::*[self::li or self::div][1]");
  if (await listItem.count().catch(() => 0)) {
    return listItem.first();
  }

  return locator;
}

function getPesquisaSatisfacaoCandidates(
  options: Array<{ text: string; locator: Locator }>,
  clinicName: string
): Array<{ option: { text: string; locator: Locator }; score: number }> {
  return options
    .map((option) => ({
      option,
      score: scorePesquisaSatisfacaoOption(option.text, clinicName)
    }))
    .filter((candidate) => candidate.score >= 0)
    .sort((a, b) => b.score - a.score);
}

function logPesquisaSatisfacaoCandidates(
  candidates: Array<{ option: { text: string; locator: Locator }; score: number }>,
  clinicName: string
): void {
  info(`Candidatas de Pesquisa de Satisfacao para ${clinicName || "(clinica nao identificada)"}:`);

  for (const candidate of candidates) {
    console.log(` - ${candidate.option.text} | score=${candidate.score}`);
  }
}

export function scorePesquisaSatisfacaoOption(optionText: string, clinicName: string): number {
  const text = normalizeText(optionText);
  const clinic = normalizeText(clinicName);

  if (!clinic || !text.includes(clinic)) {
    return -1;
  }

  if (!text.includes("pesquisa")) {
    return -1;
  }

  if (!text.includes("satisfacao")) {
    return -1;
  }

  let score = 10;

  if (text.includes("amei") && text.includes("v2")) {
    score += 100;
  } else if (text.includes("amei") && /(^|\D)2(\D|$)/.test(text)) {
    score += 90;
  } else if (text.includes("v2")) {
    score += 50;
  } else if (/satisfacao\s*2\b/.test(text) || /2$/.test(text)) {
    score += 45;
  }

  return score;
}

async function findBotFlowInput(page: Page, screenshotOnError = true): Promise<Locator> {
  const properties = page.locator(".properties");
  const label = await findVisibleTextInProperties(page, /Fluxo de bot/i, screenshotOnError);

  const candidates = [
    label.locator("xpath=following::input[1]"),
    label.locator("xpath=ancestor::*[self::div or self::section][1]//input").last(),
    properties.locator("input[type='text']").last(),
    properties.locator("[role='combobox'] input").last()
  ];

  for (const candidate of candidates) {
    if (await candidate.isVisible().catch(() => false)) {
      return candidate;
    }
  }

  if (screenshotOnError) {
    await takeScreenshot(page, "erro-campo-fluxo-de-bot.png");
  }
  throw new Error('Campo "Fluxo de bot" nao encontrado.');
}

export async function waitUntilFieldEnabled(
  page: Page,
  fieldName: string,
  maxAttempts: number,
  waitMs: number
): Promise<Locator> {
  return waitForFieldEnabled(page, fieldName, maxAttempts * waitMs, waitMs);
}

export async function waitForFieldEnabled(
  page: Page,
  fieldName: string,
  timeoutMs = getCurrentTiming().waitForFieldEnabledTimeoutMs,
  intervalMs = 1000
): Promise<Locator> {
  const deadline = Date.now() + timeoutMs;
  let lastErrorMessage = "";
  let firstCheck = true;

  while (Date.now() <= deadline) {
    info(`${firstCheck ? "Verificando se" : "Verificando novamente"} campo ${fieldName} esta habilitado`);
    firstCheck = false;

    const input = await (fieldName.toLowerCase() === "fluxo de bot"
      ? findBotFlowInput(page, false)
      : findPropertiesInputByFieldName(page, fieldName)).catch((error) => {
        lastErrorMessage = error instanceof Error ? error.message : String(error);
        return null;
      });

    if (input && await input.isVisible().catch(() => false) && await input.isEnabled().catch(() => false)) {
      ok(`Campo ${fieldName} habilitado`);
      return input;
    }

    info(`Campo ${fieldName} ainda esta desabilitado, aguardando ${intervalMs}ms`);
    await page.waitForTimeout(intervalMs);
  }

  const message = lastErrorMessage
    ? `Campo ${fieldName} continua desabilitado apos aguardar carregamento. Detalhe: ${lastErrorMessage}`
    : `Campo ${fieldName} continua desabilitado apos aguardar carregamento`;
  console.log(`[ERRO] ${message}`);
  throw new AutomationError(message, { fieldName });
}

async function findPropertiesInputByFieldName(page: Page, fieldName: string): Promise<Locator> {
  const properties = page.locator(".properties");
  const label = await findVisibleNormalizedTextInProperties(page, fieldName);
  const candidates = [
    label.locator("xpath=following::input[1]"),
    label.locator("xpath=ancestor::*[self::div or self::section][1]//input").last(),
    properties.locator("input[type='text']").first(),
    properties.locator("[role='combobox'] input").first()
  ];

  for (const candidate of candidates) {
    if (await candidate.isVisible().catch(() => false)) {
      return candidate;
    }
  }

  throw new Error(`Campo "${fieldName}" nao encontrado.`);
}

async function findVisibleNormalizedTextInProperties(page: Page, text: string): Promise<Locator> {
  const expected = normalizeText(text);
  const locator = page.locator(".properties *");
  const count = await locator.count().catch(() => 0);
  let fallback: Locator | null = null;

  for (let index = 0; index < count; index += 1) {
    const item = locator.nth(index);

    if (!(await item.isVisible().catch(() => false))) {
      continue;
    }

    const visibleText = normalizeVisibleText(await item.innerText().catch(() => ""));
    if (!normalizeText(visibleText).includes(expected)) {
      continue;
    }

    if (visibleText.length <= 80) {
      return item;
    }

    fallback ??= item;
  }

  if (fallback) {
    return fallback;
  }

  throw new Error(`Label visivel "${text}" nao encontrado.`);
}

async function findVisibleTextInProperties(page: Page, text: RegExp, screenshotOnError = true): Promise<Locator> {
  const locator = page.locator(".properties *").filter({ hasText: text });
  const count = await locator.count().catch(() => 0);
  let fallback: Locator | null = null;

  for (let index = 0; index < count; index += 1) {
    const item = locator.nth(index);

    if (!(await item.isVisible().catch(() => false))) {
      continue;
    }

    const visibleText = normalizeVisibleText(await item.innerText().catch(() => ""));
    if (!text.test(visibleText)) {
      continue;
    }

    if (visibleText.length <= 80) {
      return item;
    }

    fallback ??= item;
  }

  if (fallback) {
    return fallback;
  }

  if (screenshotOnError) {
    await takeScreenshot(page, "erro-label-fluxo-de-bot.png");
  }
  throw new Error('Label visivel "Fluxo de bot" nao encontrado.');
}

export async function getCurrentBotFlowValue(page: Page): Promise<string> {
  const input = await findBotFlowInput(page);
  const inputValue = normalizeVisibleText(await input.inputValue().catch(() => ""));

  if (inputValue && !isBotFlowSearchTerm(inputValue)) {
    return inputValue;
  }

  const label = await findVisibleTextInProperties(page, /Fluxo de bot/i);
  const candidates = [
    label.locator("xpath=following::*[@role='combobox'][1]"),
    label.locator("xpath=ancestor::*[self::div or self::section][1]//*[@role='combobox']").last(),
    page.locator(".properties [role='combobox']").last()
  ];

  for (const candidate of candidates) {
    if (!(await candidate.isVisible().catch(() => false))) {
      continue;
    }

    const text = normalizeVisibleText(await candidate.innerText().catch(() => ""));
    const cleaned = text.replace(/Fluxo de bot:?/i, "").trim();

    if (cleaned) {
      return cleaned;
    }
  }

  return "";
}

export function isBotFlowAlreadyCorrect(currentValue: string, clinicName?: string): boolean {
  if (!currentValue || isBotFlowSearchTerm(currentValue)) {
    return false;
  }

  if (clinicName) {
    return scorePesquisaSatisfacaoOption(currentValue, clinicName) >= 0;
  }

  const normalizedValue = normalizeText(currentValue);
  return normalizedValue.includes("pesquisa") && normalizedValue.includes("satisfacao");
}

function isBotFlowSearchTerm(value: string): boolean {
  const normalized = normalizeText(value);
  return normalized === "pes" || normalized === "pesq" || normalized === "pesqui" || normalized === "pesquisa";
}

async function waitForBotFlowOptions(page: Page): Promise<Array<{ text: string; locator: Locator }>> {
  const timeoutMs = getCurrentTiming().waitForOptionsTimeoutMs;
  const deadline = Date.now() + timeoutMs;

  while (Date.now() <= deadline) {
    const options = await collectBotFlowOptions(page);
    if (options.length) {
      return options;
    }

    await page.waitForTimeout(250);
  }

  throw new Error(`Opcoes do campo "Fluxo de bot" nao carregaram em ate ${timeoutMs}ms.`);
}

export async function waitForOptionsToLoad(
  page: Page,
  expectedText?: string,
  containsIgnoringNumber = false
): Promise<Array<{ text: string; locator: Locator }>> {
  const timeoutMs = getCurrentTiming().waitForOptionsTimeoutMs;
  const deadline = Date.now() + timeoutMs;
  const expected = expectedText ? normalizeText(removeLeadingNumberPrefix(expectedText)) : "";

  while (Date.now() <= deadline) {
    const options = await collectVisibleOptions(page);
    const matchingOptions = expected
      ? options.filter((option) => {
        const optionText = containsIgnoringNumber ? removeLeadingNumberPrefix(option.text) : option.text;
        return normalizeText(optionText).includes(expected);
      })
      : options;

    if (matchingOptions.length) {
      return matchingOptions;
    }

    await page.waitForTimeout(250);
  }

  throw new Error(
    expectedText
      ? `Opcao contendo "${expectedText}" nao apareceu em ate ${timeoutMs}ms.`
      : `Nenhuma opcao carregou em ate ${timeoutMs}ms.`
  );
}

async function collectVisibleOptions(page: Page): Promise<Array<{ text: string; locator: Locator }>> {
  const selectors = [
    "[role='option']",
    "[role='listbox'] *",
    ".ng-option",
    ".ng-dropdown-panel *",
    "[class*='option']",
    "[class*='dropdown'] *",
    "[class*='select'] *"
  ];

  return collectVisibleOptionsFromSelectors(page, selectors, 200);
}

async function collectVisibleOptionsFast(page: Page): Promise<VisibleOption[]> {
  const directSelectors = [
    "[role='option']",
    ".ng-option",
    ".ng-dropdown-panel [role='option']",
    ".ng-dropdown-panel .ng-option",
    "[role='listbox'] [role='option']",
    "[role='listbox'] li",
    "[role='listbox'] div"
  ];
  const directOptions = await collectVisibleOptionsFromSelectors(page, directSelectors, 80);

  if (directOptions.length) {
    return directOptions;
  }

  const fallbackSelectors = [
    ".ng-dropdown-panel *",
    "[class*='option']",
    "[class*='dropdown'] *",
    "[class*='select'] *"
  ];

  return collectVisibleOptionsFromSelectors(page, fallbackSelectors, 120);
}

async function collectVisibleOptionsFromSelectors(
  page: Page,
  selectors: string[],
  maxPerSelector: number
): Promise<VisibleOption[]> {
  const found = new Map<string, VisibleOption>();

  for (const selector of selectors) {
    const locator = page.locator(selector);
    const count = await locator.count().catch(() => 0);

    for (let index = 0; index < Math.min(count, maxPerSelector); index += 1) {
      const item = locator.nth(index);

      if (!(await item.isVisible().catch(() => false))) {
        continue;
      }

      const text = normalizeVisibleText(await item.innerText().catch(() => ""));
      const normalized = normalizeText(text);

      if (!normalized || text.length > 180) {
        continue;
      }

      if (!found.has(normalized)) {
        found.set(normalized, { text, locator: item });
      }
    }
  }

  return Array.from(found.values());
}

async function collectBotFlowOptions(page: Page): Promise<Array<{ text: string; locator: Locator }>> {
  const directSelectors = [
    "[role='option']",
    ".ng-option",
    ".ng-dropdown-panel [role='option']",
    ".ng-dropdown-panel .ng-option",
    "[role='listbox'] [role='option']",
    "[role='listbox'] li",
    "[role='listbox'] div"
  ];
  const directOptions = await collectBotFlowOptionsFromSelectors(page, directSelectors, 80);

  if (directOptions.length) {
    return directOptions;
  }

  const selectors = [
    ".ng-dropdown-panel *",
    "[class*='option']",
    "[class*='dropdown'] *",
    "[class*='select'] *"
  ];
  const found = new Map<string, VisibleOption>();

  for (const selector of selectors) {
    const locator = page.locator(selector);
    const count = await locator.count().catch(() => 0);

    for (let index = 0; index < Math.min(count, 120); index += 1) {
      const item = locator.nth(index);

      if (!(await item.isVisible().catch(() => false))) {
        continue;
      }

      const text = normalizeVisibleText(await item.innerText().catch(() => ""));
      const normalized = normalizeText(text);

      if (!isReasonableBotFlowOptionText(text)) {
        continue;
      }

      if (!found.has(normalized)) {
        found.set(normalized, { text, locator: item });
      }
    }
  }

  const visibleTextCandidates = page.locator("body *").filter({ hasText: /Pesquisa|Satisfa[cç][aã]o|Satisfacao/i });
  const visibleTextCount = await visibleTextCandidates.count().catch(() => 0);

  for (let index = 0; index < Math.min(visibleTextCount, 120); index += 1) {
    const item = visibleTextCandidates.nth(index);

    if (!(await item.isVisible().catch(() => false))) {
      continue;
    }

    const text = normalizeVisibleText(await item.innerText().catch(() => ""));
    const normalized = normalizeText(text);

    if (!isReasonableBotFlowOptionText(text)) {
      continue;
    }

    if (!found.has(normalized)) {
      found.set(normalized, { text, locator: item });
    }
  }

  return Array.from(found.values());
}

async function collectBotFlowOptionsFromSelectors(
  page: Page,
  selectors: string[],
  maxPerSelector: number
): Promise<VisibleOption[]> {
  const found = new Map<string, VisibleOption>();

  for (const selector of selectors) {
    const locator = page.locator(selector);
    const count = await locator.count().catch(() => 0);

    for (let index = 0; index < Math.min(count, maxPerSelector); index += 1) {
      const item = locator.nth(index);

      if (!(await item.isVisible().catch(() => false))) {
        continue;
      }

      const text = normalizeVisibleText(await item.innerText().catch(() => ""));
      const normalized = normalizeText(text);

      if (!isReasonableBotFlowOptionText(text)) {
        continue;
      }

      if (!found.has(normalized)) {
        found.set(normalized, { text, locator: item });
      }
    }
  }

  return Array.from(found.values());
}

function isReasonableBotFlowOptionText(text: string): boolean {
  const normalized = normalizeText(text);

  if (!text || text.length > 180) {
    return false;
  }

  return normalized.includes("pesquisa") && normalized.includes("satisfacao");
}

async function getWorkflowNodeIds(locator: Locator): Promise<string[]> {
  const count = await locator.count().catch(() => 0);
  const ids: string[] = [];

  for (let index = 0; index < count; index += 1) {
    const id = await locator.nth(index).getAttribute("data-id").catch(() => null);

    if (id) {
      ids.push(id);
    }
  }

  return ids;
}

async function clickStatusNode(page: Page, text: RegExp, debugName: string, index = 0): Promise<void> {
  await clickWorkflowNode(page, text, debugName, page.locator(".react-flow__node-status_function"), index);
  await waitForPropertiesPanel(page, /Propriedades de Status/i);
}

async function clickStatusNodeById(page: Page, nodeId: string, debugName: string): Promise<void> {
  await clickWorkflowNode(page, /.*/, debugName, page.locator(`.react-flow__node-status_function[data-id="${nodeId}"]`));
  await waitForPropertiesPanel(page, /Propriedades de Status/i);
}

async function clickWorkflowNode(
  page: Page,
  text: RegExp,
  debugName: string,
  baseLocator: Locator = page.locator(".react-flow__node"),
  index = 0
): Promise<void> {
  await pauseIfEnabled(`clicar no bloco "${debugName}"`);
  info(`Procurando bloco ${debugName}`);
  await page.keyboard.press("Escape").catch(() => undefined);

  const locator = baseLocator.filter({ hasText: text });
  const count = await locator.count().catch(() => 0);

  if (count <= index) {
    throw new AutomationError(`Bloco "${debugName}" nao encontrado.`, {
      blockName: debugName
    });
  }

  const target = locator.nth(index);
  info(`Clicando bloco ${debugName}`);
  await target.click({ timeout: 5000 }).catch(async () => {
    await target.evaluate((element) => {
      const eventOptions = { bubbles: true, cancelable: true, view: window };
      element.dispatchEvent(new MouseEvent("mousedown", eventOptions));
      element.dispatchEvent(new MouseEvent("mouseup", eventOptions));
      element.dispatchEvent(new MouseEvent("click", eventOptions));
    });
  });
  ok(`Bloco ${debugName} clicado`);
  await waitStep("apos clicar no bloco", getCurrentTiming().delayAfterBlockClickMs);
}

async function waitForPropertiesPanel(page: Page, title: RegExp): Promise<void> {
  await page.getByText(title).first().waitFor({ state: "visible", timeout: 20000 });
}

async function getCurrentWhatsappAccountValue(page: Page): Promise<string> {
  const field = await findMuiAutocompleteInputByLegend(page, "Conta")
    .catch(() => findPropertiesControlByLabelPosition(page, "Conta"))
    .catch(() => null);

  if (field && await field.isVisible().catch(() => false)) {
    const value = normalizeVisibleText(await field.inputValue().catch(() => ""));
    if (value) {
      return value;
    }

    const text = normalizeVisibleText(await field.innerText().catch(() => ""));
    const cleaned = text.replace(/Conta:?/i, "").trim();
    if (cleaned) {
      return cleaned;
    }
  }

  return "";
}

async function selectWhatsappAccountInPanel(
  page: Page,
  clinicName: string,
  currentAccount: string,
  blockName: string
): Promise<string> {
  const accountInput = await findMuiAutocompleteInputByLegend(page, "Conta").catch(() => null);
  const field = accountInput ?? await waitForPropertiesControlByLabelPosition(page, "Conta");
  await field.waitFor({ state: "visible", timeout: 20000 });
  await field.click({ timeout: 1000 }).catch(async () => {
    const clicked = await clickPropertiesControlBelowLabelByCoordinates(page, "Conta");
    if (!clicked) {
      await field.click({ timeout: 1000, force: true });
    }
  });
  await waitStep("apos clicar no campo", getCurrentTiming().delayAfterFieldClickMs);
  const searchInput = accountInput ?? await findActiveDropdownInput(page, field);
  await searchInput.press("Control+A").catch(() => undefined);
  await searchInput.press("Backspace").catch(() => undefined);
  await searchInput.fill(clinicName).catch(async () => {
    await page.keyboard.type(clinicName);
  });

  const config = getConfig();
  const startedAt = Date.now();
  let lastOptions: VisibleOption[] = [];
  let firstCandidateSeen = false;

  info(`Procurando Conta contendo: ${clinicName}`);

  while (Date.now() - startedAt < config.optionMaxWaitMs) {
    const options = await collectVisibleOptionsFast(page);
    lastOptions = options;
    const preliminary = selectWhatsappAccountForClinic(options, clinicName);

    if (preliminary.candidates.length && !firstCandidateSeen) {
      firstCandidateSeen = true;
      await page.waitForTimeout(config.botFlowCollectOptionsStableMs);
      continue;
    }

    if (preliminary.status === "selected" && preliminary.selected) {
      logWhatsappAccountCandidates(preliminary.candidates);
      ok(getWhatsappAccountSelectedMessage(preliminary));
      const clickable = await getClickableOptionLocator(preliminary.selected.locator);
      await clickable.click({ timeout: 800 }).catch(async () => {
        await clickable.click({ timeout: 800, force: true });
      });
      await waitStep("apos selecionar opcao", getCurrentTiming().delayAfterOptionSelectMs);
      await page.keyboard.press("Escape").catch(() => undefined);
      return preliminary.selected.text;
    }

    if (preliminary.status === "ambiguous") {
      logWhatsappAccountCandidates(preliminary.candidates);
      console.warn("[WARN] Mais de uma conta diferente encontrada. Revisao manual necessaria.");
      await registerWhatsappAccountPending(page, {
        clinicName,
        url: config.workflowUrl,
        blockName,
        currentAccount,
        reason: preliminary.reason || "CONTA_TELEFONE_AMBIGUA",
        options: preliminary.candidates.map((option) => option.text)
      });
      info("Workflow nao sera salvo para esta clinica.");
      throw new WhatsappAccountPendingError(preliminary.reason || "CONTA_TELEFONE_AMBIGUA", {
        blockName,
        fieldName: "Conta",
        expectedValue: clinicName,
        availableOptions: preliminary.candidates.map((option) => option.text)
      });
    }

    await page.waitForTimeout(config.optionPollIntervalMs);
  }

  const finalResult = selectWhatsappAccountForClinic(lastOptions, clinicName);
  logWhatsappAccountCandidates(finalResult.candidates);
  console.warn("[WARN] Nenhuma conta da clinica encontrada. Revisao manual necessaria.");
  await registerWhatsappAccountPending(page, {
    clinicName,
    url: config.workflowUrl,
    blockName,
    currentAccount,
    reason: "CONTA_NAO_ENCONTRADA",
    options: lastOptions.map((option) => option.text)
  });
  info("Workflow nao sera salvo para esta clinica.");
  throw new WhatsappAccountPendingError("CONTA_NAO_ENCONTRADA", {
    blockName,
    fieldName: "Conta",
    expectedValue: clinicName,
    availableOptions: lastOptions.map((option) => option.text)
  });
}

async function waitForPropertiesControlByLabelPosition(page: Page, fieldName: string): Promise<Locator> {
  const deadline = Date.now() + getCurrentTiming().waitForFieldEnabledTimeoutMs;
  let lastErrorMessage = "";

  while (Date.now() <= deadline) {
    const control = await findPropertiesControlByLabelPosition(page, fieldName).catch((error) => {
      lastErrorMessage = error instanceof Error ? error.message : String(error);
      return null;
    });

    if (control && await control.isVisible().catch(() => false) && await control.isEnabled().catch(() => true)) {
      ok(`Campo ${fieldName} encontrado no painel`);
      return control;
    }

    info(`Campo ${fieldName} ainda nao esta pronto, aguardando 250ms`);
    await page.waitForTimeout(250);
  }

  throw new AutomationError(
    `Campo ${fieldName} nao encontrado no painel pelo label. ${lastErrorMessage}`,
    { fieldName }
  );
}

async function findMuiAutocompleteInputByLegend(page: Page, fieldName: string): Promise<Locator> {
  const expected = normalizeText(fieldName);
  const inputs = page.locator(
    "input.MuiAutocomplete-input, input[aria-autocomplete='list'], " +
      ".MuiAutocomplete-inputRoot input[type='text'], .MuiInputBase-root input[type='text']"
  );
  const inputCount = await inputs.count().catch(() => 0);

  for (let index = 0; index < Math.min(inputCount, 120); index += 1) {
    const input = inputs.nth(index);

    if (!(await input.isVisible().catch(() => false))) {
      continue;
    }

    const root = input.locator("xpath=ancestor::*[contains(@class,'MuiInputBase-root')][1]");
    if (!(await root.count().catch(() => 0))) {
      continue;
    }

    const legendText = await getMuiFieldLegendText(root);
    if (legendText !== expected && !legendText.startsWith(expected)) {
      continue;
    }

    ok(`Campo ${fieldName} encontrado pelo autocomplete MUI`);
    return input;
  }

  throw new Error(`Autocomplete MUI do campo "${fieldName}" nao encontrado.`);
}

async function getMuiFieldLegendText(root: Locator): Promise<string> {
  const legends = root.locator("fieldset legend");
  const count = await legends.count().catch(() => 0);

  for (let index = 0; index < count; index += 1) {
    const legend = legends.nth(index);
    const values = [
      await legend.innerText().catch(() => ""),
      await legend.textContent().catch(() => "") || ""
    ];

    for (const value of values) {
      const normalized = normalizeText(value);
      if (normalized) {
        return normalized;
      }
    }
  }

  return "";
}

async function clickPropertiesControlBelowLabelByCoordinates(page: Page, fieldName: string): Promise<boolean> {
  const label = await findExactFieldLabelInProperties(page, fieldName).catch(() => null);
  const labelBox = label ? await label.boundingBox().catch(() => null) : null;

  if (!labelBox) {
    return false;
  }

  const nextLabelBox = await findNextFieldLabelBox(page, labelBox.y, fieldName);
  const maxY = nextLabelBox ? nextLabelBox.y + 4 : labelBox.y + 95;
  const candidates = page.locator(".properties *");
  const count = await candidates.count().catch(() => 0);
  let best: { x: number; y: number; distance: number; area: number } | null = null;

  for (let index = 0; index < Math.min(count, 500); index += 1) {
    const item = candidates.nth(index);

    if (!(await item.isVisible().catch(() => false))) {
      continue;
    }

    const box = await item.boundingBox().catch(() => null);
    if (!box || box.width < 120 || box.height < 18) {
      continue;
    }

    if (
      box.y < labelBox.y + labelBox.height - 4 ||
      box.y + box.height > maxY ||
      box.x + box.width < labelBox.x ||
      box.x > labelBox.x + 340
    ) {
      continue;
    }

    const distance = Math.abs(box.y - (labelBox.y + labelBox.height));
    const area = box.width * box.height;

    if (!best || distance < best.distance || (distance === best.distance && area > best.area)) {
      best = {
        x: box.x + box.width - 24,
        y: box.y + box.height / 2,
        distance,
        area
      };
    }
  }

  if (!best) {
    return false;
  }

  await page.mouse.click(best.x, best.y);
  return true;
}

async function findPropertiesControlByLabelPosition(page: Page, fieldName: string): Promise<Locator> {
  const label = await findExactFieldLabelInProperties(page, fieldName);
  const labelBox = await label.boundingBox();

  if (!labelBox) {
    throw new Error(`Label "${fieldName}" sem posicao visivel.`);
  }

  const nextLabelBox = await findNextFieldLabelBox(page, labelBox.y, fieldName);
  const candidates = page.locator(
    ".properties input, .properties select, .properties [role='combobox'], " +
      ".properties button, .properties [class*='select'], .properties [class*='dropdown']"
  );
  const count = await candidates.count().catch(() => 0);
  let best: { locator: Locator; distance: number; area: number } | null = null;

  for (let index = 0; index < Math.min(count, 250); index += 1) {
    const candidate = candidates.nth(index);

    if (!(await candidate.isVisible().catch(() => false))) {
      continue;
    }

    const box = await candidate.boundingBox().catch(() => null);
    if (!box || box.width < 80 || box.height < 18) {
      continue;
    }

    const isBelowLabel = box.y >= labelBox.y + labelBox.height - 3;
    const isNearLabel = box.y <= labelBox.y + 80;
    const isBeforeNextLabel = !nextLabelBox || box.y + box.height <= nextLabelBox.y + 3;
    const overlapsHorizontally = box.x + box.width >= labelBox.x && box.x <= labelBox.x + Math.max(labelBox.width, 240);

    if (!isBelowLabel || !isNearLabel || !isBeforeNextLabel || !overlapsHorizontally) {
      continue;
    }

    const distance = Math.abs(box.y - (labelBox.y + labelBox.height));
    const area = box.width * box.height;

    if (!best || distance < best.distance || (distance === best.distance && area > best.area)) {
      best = { locator: candidate, distance, area };
    }
  }

  if (!best) {
    throw new Error(`Controle do campo "${fieldName}" nao encontrado abaixo do label.`);
  }

  return best.locator;
}

async function findExactFieldLabelInProperties(page: Page, fieldName: string): Promise<Locator> {
  const expected = normalizeText(fieldName);
  const locator = page.locator(".properties *");
  const count = await locator.count().catch(() => 0);
  let fallback: Locator | null = null;

  for (let index = 0; index < Math.min(count, 500); index += 1) {
    const item = locator.nth(index);

    if (!(await item.isVisible().catch(() => false))) {
      continue;
    }

    const visibleText = normalizeVisibleText(await item.innerText().catch(() => ""));
    const normalized = normalizeText(visibleText);

    if (normalized === expected) {
      return item;
    }

    if (!fallback && visibleText.length <= 20 && normalized.startsWith(expected)) {
      fallback = item;
    }
  }

  if (fallback) {
    return fallback;
  }

  throw new Error(`Label exato "${fieldName}" nao encontrado.`);
}

async function findNextFieldLabelBox(
  page: Page,
  currentLabelY: number,
  currentFieldName: string
): Promise<{ y: number } | null> {
  const current = normalizeText(currentFieldName);
  const labels = page.locator(".properties *");
  const count = await labels.count().catch(() => 0);
  let nextY: number | null = null;

  for (let index = 0; index < Math.min(count, 500); index += 1) {
    const item = labels.nth(index);

    if (!(await item.isVisible().catch(() => false))) {
      continue;
    }

    const visibleText = normalizeVisibleText(await item.innerText().catch(() => ""));
    const normalized = normalizeText(visibleText);

    if (!normalized || normalized === current || visibleText.length > 60) {
      continue;
    }

    const looksLikeFieldLabel =
      normalized === "provedor" ||
      normalized === "telefone de destino" ||
      normalized === "namespace do template de mensagem" ||
      normalized === "id do template de mensagem" ||
      normalized === "id do caso";

    if (!looksLikeFieldLabel) {
      continue;
    }

    const box = await item.boundingBox().catch(() => null);
    if (!box || box.y <= currentLabelY) {
      continue;
    }

    if (nextY === null || box.y < nextY) {
      nextY = box.y;
    }
  }

  return nextY === null ? null : { y: nextY };
}

async function findActiveDropdownInput(page: Page, field: Locator): Promise<Locator> {
  const candidates = [
    field.locator("input").first(),
    page.locator(".ng-dropdown-panel input").last(),
    page.locator("[role='listbox'] input").last(),
    page.locator(".properties input:focus").last(),
    page.locator("input:focus").last()
  ];

  for (const candidate of candidates) {
    if (await candidate.isVisible().catch(() => false)) {
      return candidate;
    }
  }

  return field;
}

export function selectWhatsappAccountForClinic(
  options: VisibleOption[],
  clinicName: string
): WhatsappAccountSelectionResult {
  const normalizedClinic = normalizeText(clinicName);
  const candidates = options.filter((item) => normalizeText(item.text).includes(normalizedClinic));

  if (candidates.length === 0) {
    return {
      status: "not_found",
      selected: null,
      candidates: [],
      reason: "CONTA_NAO_ENCONTRADA"
    };
  }

  if (candidates.length === 1) {
    return {
      status: "selected",
      selected: candidates[0],
      candidates
    };
  }

  if (candidates.length >= 3) {
    return {
      status: "ambiguous",
      selected: null,
      candidates,
      reason: "CONTA_TELEFONE_AMBIGUA"
    };
  }

  const nonOdonto = candidates.filter((item) => !normalizeText(item.text).includes("odonto"));
  const odonto = candidates.filter((item) => normalizeText(item.text).includes("odonto"));
  const families = new Set(candidates.map((item) => canonicalAccountFamily(item.text)));

  if (families.size === 1 && nonOdonto.length === 1 && odonto.length === 1) {
    return {
      status: "selected",
      selected: nonOdonto[0],
      candidates
    };
  }

  return {
    status: "ambiguous",
    selected: null,
    candidates,
    reason: "CONTA_TELEFONE_AMBIGUA"
  };
}

function canonicalAccountFamily(text: string): string {
  return normalizeText(text)
    .replace(/\bodonto\b/g, "")
    .replace(/\bwhatsapp\b/g, "")
    .replace(/\bwhats\b/g, "")
    .replace(/\bzap\b/g, "")
    .replace(/\b\d{6,}\b/g, "")
    .replace(/[^a-z0-9 ]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function doesTextContainClinic(text: string, clinicName: string): boolean {
  const normalizedClinic = normalizeText(clinicName);
  return Boolean(normalizedClinic) && normalizeText(text).includes(normalizedClinic);
}

function logWhatsappAccountCandidates(candidates: VisibleOption[]): void {
  info("Opcoes candidatas:");

  if (!candidates.length) {
    console.log(" - nenhuma");
    return;
  }

  for (const candidate of candidates) {
    console.log(` - ${candidate.text}`);
  }
}

function getWhatsappAccountSelectedMessage(result: WhatsappAccountSelectionResult): string {
  if (!result.selected) {
    return "Conta selecionada";
  }

  if (result.candidates.length === 1) {
    return `Apenas uma conta encontrada para a clinica. Selecionando: ${result.selected.text}`;
  }

  return `Conta normal e Odonto equivalentes encontradas. Selecionando sem Odonto: ${result.selected.text}`;
}

async function registerWhatsappAccountPending(
  page: Page,
  params: {
    clinicName: string;
    url: string;
    blockName: string;
    currentAccount: string;
    reason: string;
    options: string[];
  }
): Promise<void> {
  const pendingDir = path.join(errorScreenshotsDir, "contas-whatsapp-ambigua");
  await fs.mkdir(pendingDir, { recursive: true });

  const screenshotPath = path.join(
    pendingDir,
    `${slugify(params.clinicName)}-Enviar-Whatsapp-Conta-Ambigua.png`
  );
  await page.screenshot({ path: screenshotPath, fullPage: true });
  const relativeScreenshot = path.relative(process.cwd(), screenshotPath).replace(/\\/g, "/");
  ok(`Screenshot de conta pendente salvo: ${relativeScreenshot}`);

  const pendingFile = path.join(errorScreenshotsDir, "contas-whatsapp-pendentes.txt");
  await fs.mkdir(path.dirname(pendingFile), { recursive: true });

  try {
    await fs.access(pendingFile);
  } catch {
    await fs.writeFile(
      pendingFile,
      "Data/Hora | Clinica | URL | Bloco | Campo | Motivo | Conta Atual | Opcoes Encontradas | Screenshot\n",
      "utf8"
    );
  }

  const line = [
    formatBotDateTime(new Date()),
    params.clinicName,
    params.url,
    params.blockName,
    "Conta",
    params.reason,
    params.currentAccount || "",
    params.options.join("; "),
    relativeScreenshot
  ].join(" | ") + "\n";

  await fs.appendFile(pendingFile, line, "utf8");
  ok("Pendencia registrada em contas-whatsapp-pendentes.txt");
}

function formatBotDateTime(value: Date): string {
  const pad = (part: number) => String(part).padStart(2, "0");
  return `${value.getFullYear()}-${pad(value.getMonth() + 1)}-${pad(value.getDate())} ` +
    `${pad(value.getHours())}:${pad(value.getMinutes())}:${pad(value.getSeconds())}`;
}

async function selectPropertiesOption(page: Page, optionName: string, fieldName: string): Promise<void> {
  await pauseIfEnabled(`selecionar ${fieldName} "${optionName}"`);
  info(`Selecionando ${fieldName} ${optionName}`);

  await selectPropertiesAutocompleteOption(page, optionName, fieldName);
  if (!(await isPropertiesSelectionCorrectForField(page, optionName, fieldName))) {
    throw new AutomationError(`A opcao "${optionName}" nao ficou selecionada.`, {
      fieldName: getFieldLabel(fieldName),
      expectedValue: optionName
    });
  }
  ok(`${fieldName} ${optionName} selecionado`);
}

async function selectPropertiesAutocompleteOption(page: Page, optionName: string, fieldName: string): Promise<void> {
  const input = await waitForFieldEnabled(page, getFieldLabel(fieldName))
    .catch(() => page.locator(".properties input[type='text']").first());
  await input.waitFor({ state: "visible", timeout: 20000 });
  await input.click();
  await input.fill(optionName);

  const containsIgnoringNumber = shouldSelectContainsIgnoringNumber(optionName);
  const exactIgnoringNumber = shouldSelectExactIgnoringNumber(optionName);
  await waitAndSelectOptionFast(page, {
    fieldText: getFieldLabel(fieldName),
    expectedValue: optionName,
    excludeValues: getOptionExcludeValues(optionName),
    matchMode: exactIgnoringNumber ? "exactIgnoringNumber" : containsIgnoringNumber ? "containsIgnoringNumber" : "exact"
  });
  await page.keyboard.press("Escape").catch(() => undefined);
}

export async function waitAndSelectOptionFast(
  page: Page,
  params: FastOptionSelectParams
): Promise<string> {
  const config = getConfig();
  const isActionField = normalizeText(params.fieldText) === "acao";
  const maxWaitMs = params.maxWaitMs ?? (isActionField ? config.actionOptionMaxWaitMs : config.optionMaxWaitMs);
  const pollIntervalMs = params.pollIntervalMs ?? (isActionField ? config.actionOptionPollIntervalMs : config.optionPollIntervalMs);
  const delayAfterSelectMs = params.delayAfterSelectMs ?? (
    isActionField ? config.actionDelayAfterOptionSelectMs : config.delayAfterOptionSelectMs
  );
  const matchMode = params.matchMode ?? "exact";
  const startedAt = Date.now();
  let lastOptions: VisibleOption[] = [];

  info(`Procurando opcao "${params.expectedValue}" por ate ${maxWaitMs}ms`);

  while (Date.now() - startedAt < maxWaitMs) {
    const { match, options } = await findMatchingVisibleOptionFast(
      page,
      params.expectedValue,
      matchMode,
      params.excludeValues
    );
    lastOptions = options;

    if (match) {
      assertSelectedOptionAllowed(params.expectedValue, match.text, matchMode);
      ok(`Opcao encontrada: ${match.text}. Clicando imediatamente.`);
      const clickable = await getClickableOptionLocator(match.locator);
      await clickable.click({ timeout: 800 }).catch(async () => {
        await clickable.click({ timeout: 800, force: true });
      });
      await waitStep("apos selecionar opcao", delayAfterSelectMs);
      return match.text;
    }

    await page.waitForTimeout(pollIntervalMs);
  }

  console.log(`[ERRO] Opcao nao encontrada: ${params.expectedValue}`);
  info("Opcoes disponiveis:");
  for (const option of lastOptions) {
    console.log(`* ${option.text}`);
  }

  throw new AutomationError(`Opcao nao encontrada: ${params.expectedValue}`, {
    fieldName: params.fieldText,
    expectedValue: params.expectedValue,
    availableOptions: lastOptions.map((option) => option.text)
  });
}

async function findMatchingVisibleOptionFast(
  page: Page,
  expectedValue: string,
  matchMode: OptionMatchMode,
  excludeValues: string[] = []
): Promise<VisibleOptionLookupResult> {
  const options = await collectVisibleOptionsFast(page);
  return {
    match: findMatchingOption(options, expectedValue, matchMode, excludeValues),
    options
  };
}

function findMatchingOption(
  options: VisibleOption[],
  expectedValue: string,
  matchMode: OptionMatchMode,
  excludeValues: string[] = []
): VisibleOption | null {
  const expected = normalizeText(
    matchMode === "containsIgnoringNumber" || matchMode === "exactIgnoringNumber"
      ? removeLeadingNumberPrefix(expectedValue)
      : expectedValue
  );
  const normalizedExcludes = excludeValues.map((value) => normalizeText(removeLeadingNumberPrefix(value)));
  const candidates = options
    .map((option) => {
      const optionText = matchMode === "containsIgnoringNumber" || matchMode === "exactIgnoringNumber"
        ? removeLeadingNumberPrefix(option.text)
        : option.text;
      return {
        option,
        normalized: normalizeText(optionText)
      };
    })
    .filter((candidate) => {
      if (normalizedExcludes.some((excluded) => candidate.normalized.includes(excluded))) {
        info(`Ignorando opcao excluida: ${candidate.option.text}`);
        return false;
      }

      return true;
    });

  const exactCandidate = candidates.find((candidate) => candidate.normalized === expected);
  if (exactCandidate) {
    return exactCandidate.option;
  }

  if (matchMode === "contains" || matchMode === "containsIgnoringNumber") {
    const containsCandidate = candidates.find((candidate) => candidate.normalized.includes(expected));
    if (containsCandidate) {
      return containsCandidate.option;
    }
  }

  return null;
}

async function getVisibleOptions(page: Page): Promise<VisibleOption[]> {
  return collectVisibleOptions(page);
}

async function waitForAutocompleteOptions(
  page: Page,
  input: Locator,
  options: Locator,
  expectedText?: string,
  containsIgnoringNumber = false
): Promise<void> {
  if (await options.first().isVisible({ timeout: 3000 }).catch(() => false)) {
    if (expectedText) {
      await waitForOptionsToLoad(page, expectedText, containsIgnoringNumber);
    }
    return;
  }

  await input.click().catch(() => undefined);
  await page.keyboard.press("ArrowDown").catch(() => undefined);

  if (await options.first().isVisible({ timeout: 3000 }).catch(() => false)) {
    if (expectedText) {
      await waitForOptionsToLoad(page, expectedText, containsIgnoringNumber);
    }
    return;
  }

  const combo = page.locator(".properties [role='combobox']").first();
  await combo.click().catch(() => undefined);
  await page.keyboard.press("ArrowDown").catch(() => undefined);
  await waitForOptionsToLoad(page, expectedText, containsIgnoringNumber);
}

async function findOptionIndex(options: Locator, optionName: string): Promise<number> {
  const optionTexts = await listOptionTexts(options);
  const expected = normalizeForMatch(optionName);

  for (let index = 0; index < optionTexts.length; index += 1) {
    const text = normalizeText(optionTexts[index]);

    if (text === expected) {
      return index;
    }
  }

  return -1;
}

async function findOptionIndexContainsIgnoringNumber(options: Locator, expectedText: string): Promise<number> {
  const optionTexts = await listOptionTexts(options);
  const expected = normalizeText(removeLeadingNumberPrefix(expectedText));

  info(`Procurando opcao de Acao contendo: ${expectedText}`);

  for (let index = 0; index < optionTexts.length; index += 1) {
    const candidate = normalizeText(removeLeadingNumberPrefix(optionTexts[index]));

    if (candidate.includes(expected)) {
      return index;
    }
  }

  return -1;
}

async function listOptionTexts(options: Locator): Promise<string[]> {
  const count = await options.count().catch(() => 0);
  const texts: string[] = [];

  for (let index = 0; index < count; index += 1) {
    const option = options.nth(index);

    if (!(await option.isVisible().catch(() => false))) {
      continue;
    }

    const text = await option.innerText().catch(() => "");
    if (text.trim()) {
      texts.push(text);
    }
  }

  return texts;
}

function findBestPesquisaSatisfacaoOption(options: string[], clinicName?: string): string | null {
  const normalizedClinic = clinicName ? normalizeText(clinicName) : "";
  const matches = options
    .map((text, index) => ({ text, index, normalized: normalizeText(text) }))
    .filter((option) => option.normalized.includes("pesquisa") && option.normalized.includes("satisfacao"));

  if (!matches.length) {
    return null;
  }

  const clinicMatches = normalizedClinic
    ? matches.filter((option) => option.normalized.includes(normalizedClinic))
    : [];
  const scopedMatches = normalizedClinic ? clinicMatches : matches;

  if (!scopedMatches.length) {
    return null;
  }

  return scopedMatches.find((option) => option.normalized.includes("amei") && option.normalized.includes("v2"))?.text ??
    scopedMatches.find((option) => option.normalized.includes("v2"))?.text ??
    scopedMatches.find((option) => option.normalized.includes("pesquisa de satisfacao"))?.text ??
    scopedMatches[0].text;
}

function isPesquisaSatisfacaoSearch(value: string): boolean {
  const normalized = normalizeText(value);
  return normalized.includes("pesquisa") && normalized.includes("satisfacao");
}

async function assertPropertiesContainSelection(page: Page, expected: string, errorMessage: string): Promise<void> {
  if (!(await isPropertiesSelectionCorrect(page, expected))) {
    throw new Error(errorMessage);
  }
}

async function isPropertiesSelectionCorrect(page: Page, expected: string): Promise<boolean> {
  const propertiesText = normalizeText(await page.locator(".properties").innerText().catch(() => ""));
  const inputValues = await page.locator(".properties input").evaluateAll((inputs) =>
    inputs
      .map((input) => input instanceof HTMLInputElement ? input.value : "")
      .filter(Boolean)
      .join(" ")
  ).catch(() => "");

  return normalizeForMatch(`${propertiesText} ${inputValues}`).includes(normalizeForMatch(expected));
}

async function isPropertiesSelectionCorrectForField(page: Page, expected: string, fieldName: string): Promise<boolean> {
  const normalizedField = normalizeText(getFieldLabel(fieldName));
  const normalizedExpected = normalizeActionText(expected);

  if (normalizedField === "acao" && shouldValidateActionExactly(expected)) {
    const currentValue = await getPropertiesCurrentValue(page);
    const normalizedCurrent = normalizeActionText(currentValue);

    if (normalizedCurrent === normalizedExpected) {
      ok(`Campo Acao validado como: ${currentValue || expected}`);
      return true;
    }

    return false;
  }

  return isPropertiesSelectionCorrect(page, expected);
}

async function getPropertiesCurrentValue(page: Page): Promise<string> {
  const inputValues = await page.locator(".properties input").evaluateAll((inputs) =>
    inputs
      .map((input) => input instanceof HTMLInputElement ? input.value : "")
      .filter(Boolean)
      .join(" ")
  ).catch(() => "");

  if (normalizeVisibleText(inputValues)) {
    return normalizeVisibleText(inputValues);
  }

  return normalizeVisibleText(await page.locator(".properties").innerText().catch(() => ""));
}

async function selectAllOpenAutocompleteOptions(page: Page, listbox: Locator): Promise<void> {
  const seen = new Set<string>();
  let alreadyChecked = 0;
  let checkedNow = 0;
  let unchangedIterations = 0;
  let previousSeenSize = -1;
  let previousScrollTop = -1;

  for (let iteration = 0; iteration < 60; iteration += 1) {
    await listbox.waitFor({ state: "visible", timeout: 5000 });

    const options = listbox.locator("[role='option']");
    const count = await options.count();

    for (let index = 0; index < count; index += 1) {
      const option = options.nth(index);

      if (!(await option.isVisible().catch(() => false))) {
        continue;
      }

      const text = normalizeText(await option.innerText().catch(() => ""));

      if (!text) {
        continue;
      }

      const selected = await isOptionSelected(option);
      if (!seen.has(text)) {
        seen.add(text);

        if (selected) {
          alreadyChecked += 1;
        }
      }

      if (!selected) {
        await option.click();
        checkedNow += 1;
        await page.waitForTimeout(20);
      }
    }

    const scrollState = await listbox.evaluate((element) => {
      const before = element.scrollTop;
      element.scrollTop = Math.min(element.scrollTop + element.clientHeight - 24, element.scrollHeight);

      return {
        before,
        after: element.scrollTop,
        max: element.scrollHeight - element.clientHeight
      };
    });

    if (seen.size === previousSeenSize && scrollState.after === previousScrollTop) {
      unchangedIterations += 1;
    } else {
      unchangedIterations = 0;
      previousSeenSize = seen.size;
      previousScrollTop = scrollState.after;
    }

    if (scrollState.after >= scrollState.max && unchangedIterations >= 1) {
      break;
    }
  }

  await page.keyboard.press("Escape").catch(() => undefined);
  await assertTipoCasoHasSelection(page);

  ok(`Total de opcoes encontradas: ${seen.size}`);
  ok(`Opcoes ja marcadas: ${alreadyChecked}`);
  ok(`Opcoes marcadas agora: ${checkedNow}`);
}

async function assertTipoCasoHasSelection(page: Page): Promise<void> {
  const tipoCaso = page.locator("[role='combobox']").filter({ hasText: /Tipo de Caso/i }).first();
  const text = normalizeText(await tipoCaso.innerText().catch(() => ""));

  if (!text || /^Tipo de Caso$/i.test(text)) {
    await takeScreenshot(page, "erro-tipo-caso-sem-selecao.png");
    throw new Error('Nenhuma opcao ficou selecionada no campo "Tipo de Caso".');
  }
}

export async function saveChanges(page: Page): Promise<void> {
  await pauseIfEnabled('clicar em "Salvar Alteracoes"');
  info("Rolando painel direito ate o final");
  await scrollRightPanelToBottom(page);
  info("Salvando alteracoes");

  await clickSaveChangesAndWaitUntilGone(page);
  markWorkflowChanged();
  await waitStep("apos salvar alteracoes", getCurrentTiming().delayAfterSaveChangesMs);
}

export async function saveChangesIfNeeded(page: Page, validationInfo: SaveChangesValidationInfo): Promise<void> {
  info(`Validando campo ${validationInfo.fieldName}`);

  if (validationInfo.isFieldCorrect) {
    ok(`Campo ${validationInfo.fieldName} preenchido com: ${validationInfo.expectedValue}`);
  } else {
    console.log(`[ERRO] Campo ${validationInfo.fieldName} nao esta correto`);
  }

  info("Procurando botao Salvar Alteracoes");
  await scrollRightPanelToBottom(page);
  const config = getConfig();
  let saveButton = await waitForSaveChangesButton(page, config.saveButtonMaxWaitMs, config.saveButtonPollIntervalMs);

  if (!saveButton) {
    if (validationInfo.isFieldCorrect) {
      console.warn('[WARN] Botao "Salvar Alteracoes" nao apareceu, mas o campo ja esta correto. Seguindo para o proximo bloco.');
      return;
    }

    throw new AutomationError("Botao Salvar Alteracoes nao apareceu e campo nao esta correto", {
      blockName: validationInfo.blockName,
      fieldName: validationInfo.fieldName,
      expectedValue: validationInfo.expectedValue
    });
  }

  if (!(await saveButton.isEnabled().catch(() => false))) {
    info("Botao Salvar Alteracoes esta desabilitado, aguardando 5000ms");
    await page.waitForTimeout(5000);
    saveButton = await waitForSaveChangesButton(page, config.saveButtonMaxWaitMs, config.saveButtonPollIntervalMs);

    if (!saveButton || !(await saveButton.isEnabled().catch(() => false))) {
      if (validationInfo.isFieldCorrect) {
        console.warn('[WARN] Botao "Salvar Alteracoes" nao habilitou, mas o campo ja esta correto. Seguindo para o proximo bloco.');
        return;
      }

      throw new AutomationError("Botao Salvar Alteracoes desabilitado e campo nao esta correto", {
        blockName: validationInfo.blockName,
        fieldName: validationInfo.fieldName,
        expectedValue: validationInfo.expectedValue
      });
    }
  }

  await saveButton.click();
  markWorkflowChanged();
  ok("Salvar Alteracoes clicado");
  await Promise.race([
    page.getByText(/salvo|sucesso|alteracoes salvas|alteracoes salvas/i).first().waitFor({ state: "visible", timeout: 5000 }),
    page.waitForLoadState("networkidle", { timeout: 5000 })
  ]).catch(() => undefined);
  await waitStep("apos salvar alteracoes", getCurrentTiming().delayAfterSaveChangesMs);
}

async function waitForSaveChangesButton(page: Page, maxWaitMs: number, pollIntervalMs: number): Promise<Locator | null> {
  const startedAt = Date.now();
  info(`Procurando botao Salvar Alteracoes por ate ${maxWaitMs}ms`);

  while (Date.now() - startedAt < maxWaitMs) {
    const button = await findSaveChangesButton(page);

    if (button) {
      ok("Botao Salvar Alteracoes apareceu. Clicando imediatamente.");
      return button;
    }

    await page.waitForTimeout(pollIntervalMs);
  }

  return null;
}

async function clickSaveChangesAndWaitUntilGone(page: Page): Promise<void> {
  const config = getConfig();

  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const saveButton = await waitForSaveChangesButton(page, config.saveButtonMaxWaitMs, config.saveButtonPollIntervalMs);

    if (!saveButton) {
      throw new AutomationError('Botao "Salvar Alteracoes" nao encontrado.');
    }

    if (!(await saveButton.isEnabled().catch(() => false))) {
      info(`Botao Salvar Alteracoes desabilitado, aguardando tentativa ${attempt}/3`);
      await page.waitForTimeout(1000);
      continue;
    }

    await clickSaveChangesButton(saveButton, `tentativa ${attempt}/3`);
    ok(`Salvar Alteracoes clicado tentativa ${attempt}/3`);
    await page.waitForTimeout(500);

    const secondClickButton = await waitForSaveChangesButton(page, 1500, 150);
    if (secondClickButton) {
      await clickSaveChangesButton(secondClickButton, `segundo clique tentativa ${attempt}/3`);
      ok(`Salvar Alteracoes clicado novamente tentativa ${attempt}/3`);
    } else {
      ok("Salvar Alteracoes saiu da tela antes do segundo clique");
    }

    await Promise.race([
      page.getByText(/salvo|sucesso|alteracoes salvas|alteracoes salvas/i).first().waitFor({ state: "visible", timeout: 5000 }),
      page.waitForLoadState("networkidle", { timeout: 5000 })
    ]).catch(() => undefined);

    const disappeared = await waitForSaveChangesButtonToDisappear(page, 5000, 250);
    if (disappeared) {
      ok("Salvar Alteracoes confirmado: botao saiu da tela");
      return;
    }

    console.warn(`[WARN] Botao Salvar Alteracoes ainda aparece apos clicar. Tentando novamente (${attempt}/3).`);
  }

  throw new AutomationError('Salvar Alteracoes nao foi confirmado: botao continuou aparecendo apos 3 tentativas.');
}

async function clickSaveChangesButton(button: Locator, context: string): Promise<void> {
  await button.click({ timeout: 1500 }).catch(async () => {
    console.warn(`[WARN] Clique normal em Salvar Alteracoes falhou em ${context}. Tentando force.`);
    await button.click({ timeout: 1500, force: true });
  });
}

async function waitForSaveChangesButtonToDisappear(page: Page, maxWaitMs: number, pollIntervalMs: number): Promise<boolean> {
  const startedAt = Date.now();

  while (Date.now() - startedAt < maxWaitMs) {
    const button = await findSaveChangesButton(page);
    if (!button) {
      return true;
    }

    await page.waitForTimeout(pollIntervalMs);
  }

  return false;
}

async function findSaveChangesButton(page: Page): Promise<Locator | null> {
  const exactSaveChangesText = /^Salvar Alter(a|á)ç(õ|o)es$/i;
  const candidates = [
    page.getByRole("button", { name: exactSaveChangesText }),
    page.locator("button").filter({ hasText: exactSaveChangesText }),
    page.locator("[role='button']").filter({ hasText: exactSaveChangesText }),
    page.locator("span.MuiTypography-root").filter({ hasText: exactSaveChangesText }).locator("xpath=ancestor::button[1]"),
    page.locator("span").filter({ hasText: exactSaveChangesText }).locator("xpath=ancestor::*[@role='button'][1]")
  ];

  const visibleCandidates: Locator[] = [];

  for (const locator of candidates) {
    const count = await locator.count().catch(() => 0);

    for (let index = 0; index < count; index += 1) {
      const item = locator.nth(index);

      if (await item.isVisible().catch(() => false)) {
        visibleCandidates.push(item);
      }
    }
  }

  if (!visibleCandidates.length) {
    return null;
  }

  let selected = visibleCandidates[0];
  let selectedBox = await selected.boundingBox();

  for (const candidate of visibleCandidates.slice(1)) {
    const box = await candidate.boundingBox();

    if (box && (!selectedBox || box.y > selectedBox.y)) {
      selected = candidate;
      selectedBox = box;
    }
  }

  return selected;
}

export async function takeScreenshot(page: Page, filename: string): Promise<void> {
  const config = getConfig();

  if (filename.startsWith("erro-")) {
    return;
  }

  if (config.screenshotMode !== "all") {
    return;
  }

  const fullPath = path.join(screenshotsDir, filename);
  await page.screenshot({ path: fullPath, fullPage: true });
  ok(`Screenshot salvo em ./screenshots/${filename}`);
}

export async function dumpVisibleTextsForDebug(page: Page): Promise<void> {
  info("Textos visiveis encontrados na pagina para debug:");

  const texts = await page.locator("body *:visible").evaluateAll((elements) => {
    const values = elements
      .map((element) => element.textContent?.trim() ?? "")
      .filter(Boolean)
      .map((text) => text.replace(/\s+/g, " "));

    return Array.from(new Set(values)).slice(0, 120);
  });

  for (const text of texts) {
    console.log(`- ${text}`);
  }
}

async function dumpVisiblePanelTexts(page: Page): Promise<void> {
  info("Textos visiveis no painel direito:");

  const texts = await page.locator(".properties *:visible").evaluateAll((elements) => {
    const values = elements
      .map((element) => element.textContent?.trim() ?? "")
      .filter(Boolean)
      .map((text) => text.replace(/\s+/g, " "))
      .filter((text) => text.length <= 180);

    return Array.from(new Set(values)).slice(0, 120);
  }).catch(() => []);

  for (const text of texts) {
    console.log(`- ${text}`);
  }
}

export async function pauseIfEnabled(message: string): Promise<void> {
  const config = getConfig();

  if (!config.pauseBetweenSteps) {
    return;
  }

  const rl = createInterface({ input, output });

  try {
    await rl.question(`[PAUSA] ${message}. Aperte Enter para continuar...`);
  } finally {
    rl.close();
  }
}

export async function finishBrowserConnection(browser: Browser): Promise<void> {
  const config = getConfig();

  if (config.keepOpen) {
    info("Navegador mantido aberto para conferencia visual");
    return;
  }

  await browser.close();
}

async function findFirstVisibleInLocators(locators: Locator[]): Promise<Locator | null> {
  for (const locator of locators) {
    const item = await firstVisible(locator);

    if (item) {
      return item;
    }
  }

  return null;
}

async function countVisibleInLocators(locators: Locator[]): Promise<number> {
  let total = 0;

  for (const locator of locators) {
    const count = await locator.count().catch(() => 0);

    for (let index = 0; index < count; index += 1) {
      if (await locator.nth(index).isVisible().catch(() => false)) {
        total += 1;
      }
    }
  }

  return total;
}

async function selectAllNativeSelectOptions(select: Locator): Promise<void> {
  const options = select.locator("option");
  const count = await options.count();
  const values: string[] = [];
  let alreadyChecked = 0;

  for (let index = 0; index < count; index += 1) {
    const option = options.nth(index);
    const value = await option.getAttribute("value");

    if (!value) {
      continue;
    }

    values.push(value);

    const selected = await option.evaluate((element) => element instanceof HTMLOptionElement && element.selected);
    if (selected) {
      alreadyChecked += 1;
    }
  }

  await select.selectOption(values);

  ok(`Total de opcoes encontradas: ${values.length}`);
  ok(`Opcoes ja marcadas: ${alreadyChecked}`);
  ok(`Opcoes marcadas agora: ${Math.max(values.length - alreadyChecked, 0)}`);
}

async function tryClickSelectAllOption(page: Page): Promise<void> {
  const selectAll = await findFirstVisibleInLocators([
    page.getByRole("option", { name: /selecionar todos|todos/i }),
    page.getByText(/^(Selecionar todos|Todos)$/i),
    page.locator("label").filter({ hasText: /selecionar todos|todos/i })
  ]);

  if (!selectAll) {
    return;
  }

  const selected = await isOptionSelected(selectAll);
  if (!selected) {
    await selectAll.click();
  }
}

async function isOptionSelected(option: Locator): Promise<boolean> {
  const checkbox = option.locator("input[type='checkbox']").first();

  if (await checkbox.count()) {
    return await checkbox.isChecked().catch(() => false);
  }

  const ariaChecked = await option.getAttribute("aria-checked").catch(() => null);
  const ariaSelected = await option.getAttribute("aria-selected").catch(() => null);

  return ariaChecked === "true" || ariaSelected === "true";
}

async function scrollDropdownOrPanel(page: Page): Promise<void> {
  const containers = [
    page.locator("[role='listbox']").last(),
    page.locator("[role='menu']").last(),
    page.locator(".cdk-overlay-pane, .dropdown-menu, .select-menu, .multiselect, .ng-dropdown-panel").last(),
    page.locator("aside, [class*='panel'], [class*='drawer'], [class*='sidebar']").last()
  ];

  for (const container of containers) {
    if (await container.isVisible().catch(() => false)) {
      await container.evaluate((element) => {
        element.scrollTop = element.scrollHeight;
      }).catch(() => undefined);
      return;
    }
  }

  await page.mouse.wheel(0, 800);
}

async function scrollRightPanelToBottom(page: Page): Promise<void> {
  const panelCandidates = [
    page.locator("aside").last(),
    page.locator("[class*='drawer'], [class*='side'], [class*='panel']").last(),
    page.locator("body")
  ];

  for (const panel of panelCandidates) {
    if (await panel.isVisible().catch(() => false)) {
      await panel.evaluate((element) => {
        element.scrollTop = element.scrollHeight;
      }).catch(() => undefined);
      await page.mouse.wheel(0, 1200).catch(() => undefined);
      return;
    }
  }
}

function normalizeText(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeVisibleText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function normalizeForMatch(value: string): string {
  return normalizeText(value);
}

function matchesText(normalizedText: string, matcher: TextMatcher): boolean {
  const includes = matcher.includes.map(normalizeForMatch);
  const excludes = (matcher.excludes ?? []).map(normalizeForMatch);

  return includes.every((value) => normalizedText.includes(value)) &&
    excludes.every((value) => !normalizedText.includes(value));
}

function nodeSelector(kind: WorkflowNodeKind): string {
  switch (kind) {
    case "status":
      return ".react-flow__node-status_function";
    case "action":
      return ".react-flow__node-action_function";
    case "transferToBot":
      return ".react-flow__node-transfer_to_bot_function";
    default:
      return ".react-flow__node";
  }
}

function getFieldLabel(fieldName: string): string {
  const normalized = normalizeText(fieldName);

  if (normalized === "acao") {
    return "Acao";
  }

  if (normalized === "bot") {
    return "Fluxo de bot";
  }

  return fieldName;
}

export function removeLeadingNumberPrefix(text: string): string {
  return text.replace(/^\s*\d+\s*-\s*/, "").trim();
}

function normalizeActionText(text: string): string {
  return removeLeadingNumberPrefix(text)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

function shouldSelectExactIgnoringNumber(optionName: string): boolean {
  return normalizeActionText(optionName) === "contato ativo livre";
}

function shouldValidateActionExactly(optionName: string): boolean {
  return normalizeActionText(optionName) === "contato ativo livre";
}

function assertSelectedOptionAllowed(expectedValue: string, selectedText: string, matchMode: OptionMatchMode): void {
  if (matchMode !== "exactIgnoringNumber") {
    return;
  }

  const expected = normalizeActionText(expectedValue);
  const selected = normalizeActionText(selectedText);

  if (selected !== expected) {
    throw new AutomationError(
      `Protecao acionada: tentativa de selecionar opcao errada. Esperado: ${expectedValue} | Encontrado: ${selectedText}`,
      {
        fieldName: "Acao",
        expectedValue
      }
    );
  }
}

function shouldSelectContainsIgnoringNumber(optionName: string): boolean {
  const normalized = normalizeText(removeLeadingNumberPrefix(optionName));
  return normalized === "realizar agendamento" ||
    normalized === "finalizar atendimento" ||
    normalized === "finalizar atendimento ativo" ||
    normalized === "voltar ao menu anterior" ||
    normalized === "contato ativo";
}

function getOptionExcludeValues(optionName: string): string[] {
  const normalized = normalizeText(removeLeadingNumberPrefix(optionName));

  if (normalized === "finalizar atendimento") {
    return ["Finalizar Atendimento Ativo"];
  }

  if (normalized === "contato ativo") {
    return ["Contato Ativo Livre"];
  }

  return [];
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function slugify(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/gi, "-")
    .replace(/(^-|-$)/g, "")
    .toLowerCase();
}

// Coordenadas fixas ficam como ultima estrategia. Se o WorkFlow Studio tiver canvas
// sem texto acessivel, podemos adicionar um fallback controlado aqui depois de mapear a tela.
