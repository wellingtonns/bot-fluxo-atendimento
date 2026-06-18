import fs from "node:fs/promises";
import path from "node:path";
import { Page } from "playwright";
import { BotConfig, loadConfig } from "./config.js";
import {
  AutomationError,
  clickStartCaseHandlingBlock,
  clickStartBlock,
  connectToExistingChrome,
  detectWorkflowAlreadyProcessed,
  ensureAuthenticated,
  finishBrowserConnection,
  hasWorkflowChanges,
  openTipoCasoField,
  openWorkflow,
  resetWorkflowChanged,
  saveChangesIfNeeded,
  saveWorkflowOnly,
  selectStartCaseHandlingAction,
  selectAllTipoCasoOptions,
  setCurrentRuleField,
  setBotConfig,
  waitStep,
  updateActionBlock,
  updateAllAguardandoAtendimentoBlocks,
  updateAllEmAtendimentoAtivoBlocks,
  updateAllFinalizadoBlocks,
  updateAllPresidenteAgendadoBlocks,
  updateAllPresidenteAguardandoRespostaPacienteBlocks,
  updateAllPresidenteConfirmacaoAguardandoAcaoBlocks,
  updateAllPresidenteContatoAtivoBlocks,
  updateAllPresidenteNavegacaoPesquisaBlocks,
  updateAllPresidentePendenteEmAtendimentoBlocks,
  updateAllTabulacaoCondutaBlocks,
  updateAllTabulacaoSubcategoriaBlocks,
  updateAllTransferToBotBlocks
} from "./bot.js";
import {
  ensureEvidenceFolders,
  errorLog,
  errorScreenshotsDir,
  info,
  isHttpUrl,
  logsDir,
  ok,
  successScreenshotsDir
} from "./utils.js";

type WorkflowTarget = {
  clinicName: string;
  url: string;
};

type WorkflowResult = {
  clinicName: string;
  clinica: string;
  url: string;
  status: "success" | "error" | "already_configured" | "skipped_already_done";
  errorBlock: string;
  errorField: string;
  expectedValue: string;
  availableOptions: string[];
  errorMessage: string;
  screenshotPath: string;
  savedWorkflow: boolean;
  publishedWorkflow: false;
  durationSeconds: number;
  attempts: number;
  message: string;
  etapaErro: string;
  mensagemErro: string;
  screenshotFinal: string;
  salvouWorkflow: boolean;
  publicouWorkflow: false;
};

type ClinicErrorInfo = {
  clinicName: string;
  url: string;
  step: string;
  fieldName: string;
  expectedValue: string;
  availableOptions: string[];
  errorMessage: string;
  screenshotPath: string;
};

type StepTiming = {
  name: string;
  startedAtMs: number;
  durationSeconds?: number;
};

type WorkflowTiming = {
  clinicName: string;
  status: "success" | "error" | "already_configured" | "skipped_already_done";
  startedAtMs: number;
  durationSeconds?: number;
  steps: Array<{
    name: string;
    durationSeconds: number;
  }>;
};

let baseConfig: BotConfig;
let sharedPage: Page;
const executionStartedAtMs = Date.now();
const workflowTimings: WorkflowTiming[] = [];
let activeWorkflowTiming: WorkflowTiming | null = null;
let activeStepTiming: StepTiming | null = null;

async function main(): Promise<void> {
  info("Iniciando bot local cVortex");

  baseConfig = loadConfig();
  setBotConfig(baseConfig);
  info(`Modo de execucao: ${baseConfig.executionMode}`);
  info(`Usando tempos padrao ${baseConfig.executionMode}`);
  info("Tempos rapidos para campo Acao habilitados");
  await ensureEvidenceFolders();

  const targets = await loadWorkflowTargets();
  ok(`Workflows carregados: ${targets.length}`);

  const { browser, page } = await connectToExistingChrome();
  sharedPage = page;

  const results: WorkflowResult[] = [];

  try {
    for (const [index, target] of targets.entries()) {
      console.log("");
      console.log(`[WORKFLOW ${index + 1}/${targets.length}] ${target.clinicName}`);

      const result = await runWorkflowTarget(target);
      results.push(result);

      if (result.status === "error" && baseConfig.stopOnError) {
        errorLog("Interrompendo fila porque BOT_STOP_ON_ERROR=true");
        break;
      }
    }

    await generateFinalReport(results);
    await generateTimingReport(results);
    printFinalReportSummary(results);
    printRunCompletionMessage(results, targets.length);
    logTimingSummary(results);
  } finally {
    await finishBrowserConnection(browser);
  }
}

export async function loadWorkflowTargets(): Promise<WorkflowTarget[]> {
  info(`Carregando workflows de ${baseConfig.workflowsFile}`);

  const filePath = path.resolve(process.cwd(), baseConfig.workflowsFile);
  const content = await fs.readFile(filePath, "utf8");
  const targets = content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"))
    .map(parseWorkflowTarget);

  if (!targets.length) {
    throw new Error(`Nenhum workflow valido encontrado em ${baseConfig.workflowsFile}`);
  }

  return targets;
}

export function parseWorkflowTarget(line: string): WorkflowTarget {
  const [clinicNameRaw, ...urlParts] = line.split("|");
  const clinicName = clinicNameRaw?.trim();
  const url = cleanWorkflowUrl(urlParts.join("|").trim());

  if (!clinicName || !url) {
    throw new Error(`Linha invalida em workflows.txt: ${line}`);
  }

  if (!isHttpUrl(url)) {
    throw new Error(`URL invalida em workflows.txt: ${url}`);
  }

  return { clinicName, url };
}

export async function runWorkflowTarget(target: WorkflowTarget): Promise<WorkflowResult> {
  const result: WorkflowResult = {
    clinicName: target.clinicName,
    clinica: target.clinicName,
    url: target.url,
    status: "success",
    errorBlock: "",
    errorField: "",
    expectedValue: "",
    availableOptions: [],
    errorMessage: "",
    screenshotPath: "",
    savedWorkflow: false,
    publishedWorkflow: false,
    durationSeconds: 0,
    attempts: 0,
    message: "",
    etapaErro: "",
    mensagemErro: "",
    screenshotFinal: "",
    salvouWorkflow: false,
    publicouWorkflow: false
  };

  startWorkflowTimer(target.clinicName);

  try {
    const maxAttempts = baseConfig.maxRetriesPerWorkflow + 1;
    let lastError: unknown = null;

    for (let attemptNumber = 1; attemptNumber <= maxAttempts; attemptNumber += 1) {
      result.attempts = attemptNumber;
      setBotConfig({
        ...baseConfig,
        workflowUrl: target.url,
        clinicName: target.clinicName,
        publishWorkflow: false,
        attemptNumber
      });
      resetWorkflowChanged();

      info(`Tentativa ${attemptNumber}/${maxAttempts}`);

      try {
        if (attemptNumber === 1) {
          result.etapaErro = "Abrir workflow";
          await openWorkflow(sharedPage, target.url);
        }

        result.etapaErro = "Verificar sessao";
        await ensureAuthenticated(sharedPage);
        result.etapaErro = "Verificar workflow ja configurado";
        const alreadyProcessed = await detectWorkflowAlreadyProcessed(sharedPage, target.clinicName);
        if (alreadyProcessed.alreadyConfigured) {
          result.status = "already_configured";
          result.message = "Workflow ja estava configurado. Nenhuma alteracao realizada.";
          result.mensagemErro = "";
          result.errorMessage = "";
          ok(alreadyProcessed.reason);
          console.log(`[SKIP] Clinica ${target.clinicName} aparentemente ja configurada. Indo para a proxima clinica.`);
          lastError = null;
          break;
        }
        info(`Clinica usada: ${target.clinicName}`);
        info("Executando alteracoes");
        result.etapaErro = "Executar alteracoes";
        await runConfiguredRules(sharedPage, result);
        result.etapaErro = "";
        ok("Alteracoes concluidas");
        lastError = null;
        break;
      } catch (error) {
        lastError = error;
        const message = error instanceof Error ? error.message : String(error);
        result.status = "error";
        result.mensagemErro = message;
        result.errorMessage = message;
        result.etapaErro ||= "Etapa nao identificada";
        applyErrorDetails(result, error);

        if (attemptNumber < maxAttempts) {
          errorLog(`Falha na tentativa ${attemptNumber}/${maxAttempts}: ${result.etapaErro}`);
          errorLog(message);
          result.screenshotPath = await takeErrorScreenshot(sharedPage, target.clinicName, result.etapaErro);
          if (baseConfig.refreshBeforeRetry) {
            await refreshWorkflowAfterAttemptError(sharedPage);
          }
          continue;
        }
      }
    }

    if (lastError) {
      throw lastError;
    }

    if (result.status === "already_configured" || result.status === "skipped_already_done") {
      result.etapaErro = "";
      return result;
    }

    result.status = "success";
    result.mensagemErro = "";
    result.errorBlock = "";
    result.errorField = "";
    result.expectedValue = "";
    result.availableOptions = [];
    result.errorMessage = "";
    result.screenshotPath = "";

    if (baseConfig.saveWorkflow && hasWorkflowChanges()) {
      result.etapaErro = "Salvar Workflow";
      await saveWorkflowOnly(sharedPage);
      result.salvouWorkflow = true;
      result.savedWorkflow = true;
    } else if (baseConfig.saveWorkflow) {
      info("Nenhuma alteracao real detectada. Salvar Workflow nao sera clicado.");
    }

    result.etapaErro = "";
    result.screenshotFinal = await takeFinalSuccessScreenshot(sharedPage, target.clinicName);
    ok(`Screenshot final salvo: ${result.screenshotFinal}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    result.status = "error";
    result.mensagemErro = message;
    result.errorMessage = message;
    result.etapaErro ||= "Etapa nao identificada";
    applyErrorDetails(result, error);
    errorLog(`Falha na etapa: ${result.etapaErro}`);
    errorLog(message);
    result.screenshotPath = await takeErrorScreenshot(sharedPage, target.clinicName, result.etapaErro);
    await appendClinicErrorTxt({
      clinicName: target.clinicName,
      url: target.url,
      step: result.etapaErro,
      fieldName: result.errorField,
      expectedValue: result.expectedValue,
      availableOptions: result.availableOptions,
      errorMessage: message,
      screenshotPath: result.screenshotPath
    });
    ok(`Erro registrado em: ${baseConfig.errorTxtFile}`);
    info("Pulando para o proximo workflow");
  } finally {
    if (activeWorkflowTiming) {
      result.durationSeconds = Math.round((Date.now() - activeWorkflowTiming.startedAtMs) / 1000);
    }
    endWorkflowTimer(target.clinicName, result.status);
  }

  return result;
}

function applyErrorDetails(result: WorkflowResult, error: unknown): void {
  result.errorBlock = result.etapaErro;

  if (error instanceof AutomationError) {
    result.errorBlock = error.details.blockName || result.errorBlock;
    result.errorField = error.details.fieldName || result.errorField;
    result.expectedValue = error.details.expectedValue || result.expectedValue;
    result.availableOptions = error.details.availableOptions || result.availableOptions;
  }
}

async function takeErrorScreenshot(page: Page, clinicName: string, blockName: string): Promise<string> {
  const filename = `${sanitizeFileName(clinicName)}-${sanitizeFileName(blockName)}-erro.png`;
  const fullPath = path.join(errorScreenshotsDir, filename);
  await page.screenshot({ path: fullPath, fullPage: true });
  const relativePath = path.relative(process.cwd(), fullPath).replace(/\\/g, "/");
  ok(`Screenshot de erro salvo: ${relativePath}`);
  return relativePath;
}

async function refreshWorkflowAfterAttemptError(page: Page): Promise<void> {
  info("Recarregando pagina antes da segunda tentativa");
  await page.reload({ waitUntil: "domcontentloaded" });
  info(`Aguardando ${Math.round(baseConfig.workflowRenderWaitMs / 1000)}s para o workflow carregar`);
  await page.waitForTimeout(baseConfig.workflowRenderWaitMs);
  await waitStep("apos carregar workflow", baseConfig.delayAfterPageLoadMs);
  ok("Workflow recarregado");
}

export async function generateFinalReport(results: WorkflowResult[]): Promise<void> {
  const reportPath = path.join(logsDir, "final-report.json");
  await fs.writeFile(reportPath, `${JSON.stringify(results, null, 2)}\n`, "utf8");
  ok("Relatorio final salvo em logs/final-report.json");
}

export async function generateTimingReport(results: WorkflowResult[]): Promise<void> {
  if (!baseConfig.measureTiming) {
    return;
  }

  const totalSeconds = Math.round((Date.now() - executionStartedAtMs) / 1000);
  const success = results.filter((result) => result.status === "success").length;
  const error = results.filter((result) => result.status === "error").length;
  const alreadyConfigured = results.filter((result) =>
    result.status === "already_configured" || result.status === "skipped_already_done"
  ).length;
  const completedWorkflowDurations = workflowTimings
    .map((workflow) => workflow.durationSeconds ?? 0)
    .filter((duration) => duration > 0);
  const averageSecondsPerWorkflow = completedWorkflowDurations.length
    ? Math.round(completedWorkflowDurations.reduce((sum, duration) => sum + duration, 0) / completedWorkflowDurations.length)
    : 0;

  const report = {
    totalWorkflows: results.length,
    success,
    error,
    alreadyConfigured,
    averageSecondsPerWorkflow,
    totalSeconds,
    workflows: workflowTimings.map((workflow) => ({
      clinicName: workflow.clinicName,
      status: workflow.status,
      durationSeconds: workflow.durationSeconds ?? 0,
      steps: workflow.steps
    }))
  };

  const reportPath = path.join(logsDir, "timing-report.json");
  await fs.writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  ok("Relatorio de tempo salvo em logs/timing-report.json");
}

export function startWorkflowTimer(clinicName: string): void {
  if (!baseConfig.measureTiming) {
    return;
  }

  activeWorkflowTiming = {
    clinicName,
    status: "error",
    startedAtMs: Date.now(),
    steps: []
  };
  activeStepTiming = null;
  console.log(`[TIMER] Inicio: ${formatClock(new Date(activeWorkflowTiming.startedAtMs))}`);
}

export function endWorkflowTimer(
  clinicName: string,
  status: "success" | "error" | "already_configured" | "skipped_already_done" = "success"
): void {
  if (!baseConfig.measureTiming || !activeWorkflowTiming) {
    return;
  }

  activeWorkflowTiming.status = status;
  activeWorkflowTiming.durationSeconds = Math.round((Date.now() - activeWorkflowTiming.startedAtMs) / 1000);
  workflowTimings.push(activeWorkflowTiming);
  console.log(`[TIMER] Clinica ${clinicName} concluida em ${formatDuration(activeWorkflowTiming.durationSeconds)}`);
  activeWorkflowTiming = null;
  activeStepTiming = null;
}

export function startStepTimer(stepName: string): void {
  if (!baseConfig.measureTiming || !activeWorkflowTiming) {
    return;
  }

  activeStepTiming = {
    name: stepName,
    startedAtMs: Date.now()
  };
}

export function endStepTimer(stepName: string): void {
  if (!baseConfig.measureTiming || !activeWorkflowTiming || !activeStepTiming) {
    return;
  }

  const durationSeconds = Math.round((Date.now() - activeStepTiming.startedAtMs) / 1000);
  activeWorkflowTiming.steps.push({
    name: stepName,
    durationSeconds
  });
  console.log(`[STEP] ${stepName} levou ${durationSeconds}s`);
  activeStepTiming = null;
}

export function logTimingSummary(results: WorkflowResult[]): void {
  if (!baseConfig.measureTiming) {
    return;
  }

  const totalSeconds = Math.round((Date.now() - executionStartedAtMs) / 1000);
  const success = results.filter((result) => result.status === "success").length;
  const error = results.filter((result) => result.status === "error").length;
  const alreadyConfigured = results.filter((result) =>
    result.status === "already_configured" || result.status === "skipped_already_done"
  ).length;
  const completedWorkflowDurations = workflowTimings
    .map((workflow) => workflow.durationSeconds ?? 0)
    .filter((duration) => duration > 0);
  const averageSecondsPerWorkflow = completedWorkflowDurations.length
    ? Math.round(completedWorkflowDurations.reduce((sum, duration) => sum + duration, 0) / completedWorkflowDurations.length)
    : 0;

  console.log("");
  console.log("[RELATORIO DE TEMPO]");
  console.log(`Total de clinicas: ${results.length}`);
  console.log(`Sucesso: ${success}`);
  console.log(`Erro: ${error}`);
  console.log(`Ja configurado: ${alreadyConfigured}`);
  console.log(`Tempo medio por clinica: ${formatDuration(averageSecondsPerWorkflow)}`);
  console.log(`Tempo total: ${formatDuration(totalSeconds)}`);
}

async function runConfiguredRules(page: Page, result: WorkflowResult): Promise<void> {
  await runStep(result, "Iniciar / Tipo de Caso", async () => {
    setCurrentRuleField("Tipo de Caso");
    try {
      await clickStartBlock(page);
      await openTipoCasoField(page);
      await selectAllTipoCasoOptions(page);
      await saveChangesIfNeeded(page, {
        clinicName: result.clinica,
        url: result.url,
        blockName: "Iniciar / Tipo de Caso",
        fieldName: "Tipo de Caso",
        expectedValue: "Todas as opcoes",
        isFieldCorrect: true
      });
    } finally {
      setCurrentRuleField();
    }
  });
  await runStep(result, "Aguardando Atendimento", () => updateAllAguardandoAtendimentoBlocks(page));
  await runStep(result, "StartCaseHandling", async () => {
    setCurrentRuleField("Acao");
    try {
      await clickStartCaseHandlingBlock(page);
      await selectStartCaseHandlingAction(page);
      await saveChangesIfNeeded(page, {
        clinicName: result.clinica,
        url: result.url,
        blockName: "StartCaseHandling",
        fieldName: "Acao",
        expectedValue: "StartCaseHandling",
        isFieldCorrect: true
      });
    } finally {
      setCurrentRuleField();
    }
  });
  await runStep(result, "Em Atendimento Ativo", () => updateAllEmAtendimentoAtivoBlocks(page));
  await runStep(result, "Presidente Prudente - Em Atendimento", () => updateAllPresidentePendenteEmAtendimentoBlocks(page));
  await runStep(result, "2 - Iniciar Conversa WhatsApp", () => updateActionBlock(page, { includes: ["2 - Iniciar Conversa WhatsApp"] }, "2 - Iniciar Conversa WhatsApp", "iniciar-conversa-whatsapp"));
  await runStep(result, "1 - Transferir Atendimento Chat", () => updateActionBlock(page, { includes: ["1 - Transferir Atendimento Chat"] }, "1 - Transferir Atendimento Chat", "transferir-atendimento-chat"));
  await runStep(result, "5 - Confirmar Agendamento", () => updateActionBlock(page, { includes: ["5 - Confirmar Agendamento"] }, "5 - Confirmar Agendamento", "confirmar-agendamento"));
  await runStep(result, "4 - Cancelar Agendamento", () => updateActionBlock(page, { includes: ["4 - Cancelar Agendamento"] }, "4 - Cancelar Agendamento", "cancelar-agendamento"));
  await runStep(result, "Realizar Agendamento", () => updateActionBlock(page, { includes: ["Realizar Agendamento"] }, "Realizar Agendamento", "realizar-agendamento"));
  await runStep(result, "Finalizar Atendimento", () => updateActionBlock(page, { includes: ["Finalizar Atendimento"], excludes: ["Ativo"] }, "Finalizar Atendimento", "finalizar-atendimento"));
  await runStep(result, "Finalizar Atendimento Ativo", () => updateActionBlock(page, { includes: ["Finalizar Atendimento Ativo"] }, "Finalizar Atendimento Ativo", "finalizar-atendimento-ativo"));
  await runStep(result, "Transferir para Bot", () => updateAllTransferToBotBlocks(page));
  await runStep(result, "Presidente Prudente - Navegacao Pesquisa", () => updateAllPresidenteNavegacaoPesquisaBlocks(page));
  await runStep(result, "Finalizado", () => updateAllFinalizadoBlocks(page));
  await runStep(result, "Tabulacao Subcategoria", () => updateAllTabulacaoSubcategoriaBlocks(page));
  await runStep(result, "Subcategoria", () => updateActionBlock(page, { includes: ["Subcategoria"] }, "Subcategoria", "subcategoria"));
  await runStep(result, "Tabulacao Conduta", () => updateAllTabulacaoCondutaBlocks(page));
  await runStep(result, "Conduta Profissional", () => updateActionBlock(page, { includes: ["Conduta Profissional"] }, "Conduta Profissional", "conduta-profissional"));
  await runStep(result, "Aguardando Resposta Paciente", () => updateAllPresidenteAguardandoRespostaPacienteBlocks(page));
  await runStep(result, "Confirmacao Aguardando Acao", () => updateAllPresidenteConfirmacaoAguardandoAcaoBlocks(page));
  await runStep(result, "Agendado", () => updateAllPresidenteAgendadoBlocks(page));
  await runStep(result, "Contato Ativo", () => updateAllPresidenteContatoAtivoBlocks(page));
  await runStep(result, "Voltar ao Menu Anterior", () => updateActionBlock(page, { includes: ["Voltar ao Menu Anterior"] }, "Voltar ao Menu Anterior", "voltar-menu-anterior"));
  await runStep(result, "Contato Ativo Livre", () => updateActionBlock(page, { includes: ["Contato Ativo Livre"] }, "Contato Ativo Livre", "contato-ativo-livre"));
}

async function runStep(result: WorkflowResult, blockName: string, action: () => Promise<void>): Promise<void> {
  startStepTimer(blockName);

  try {
    result.etapaErro = blockName;
    await action();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    result.etapaErro = blockName;
    result.mensagemErro = message;
    throw error;
  } finally {
    endStepTimer(blockName);
  }
}

export async function takeFinalSuccessScreenshot(page: Page, clinicName: string): Promise<string> {
  const filename = `${sanitizeFileName(clinicName)}-final.png`;
  const fullPath = path.join(successScreenshotsDir, filename);
  await page.screenshot({ path: fullPath, fullPage: true });
  return path.relative(process.cwd(), fullPath).replace(/\\/g, "/");
}

function cleanWorkflowUrl(value: string): string {
  const markdownMatch = value.match(/\((https?:\/\/[^)]+)\)/i);
  return (markdownMatch?.[1] ?? value)
    .replace(/^\[/, "")
    .replace(/\]$/, "")
    .trim();
}

export async function appendClinicErrorTxt(errorInfo: ClinicErrorInfo): Promise<void> {
  const errorFilePath = path.resolve(process.cwd(), baseConfig.errorTxtFile);
  const line = [
    formatDateTime(new Date()),
    errorInfo.clinicName,
    errorInfo.url,
    errorInfo.step,
    errorInfo.fieldName || "",
    errorInfo.expectedValue || "",
    errorInfo.errorMessage,
    errorInfo.availableOptions.join("; "),
    errorInfo.screenshotPath
  ].join(" | ") + "\n";

  await fs.mkdir(path.dirname(errorFilePath), { recursive: true });

  try {
    await fs.access(errorFilePath);
  } catch {
    await fs.writeFile(errorFilePath, "# CLÍNICAS COM ERRO\n\n", "utf8");
  }

  await fs.appendFile(errorFilePath, line, "utf8");
}

function printFinalReportSummary(results: WorkflowResult[]): void {
  const success = results.filter((result) => result.status === "success").length;
  const errors = results.filter((result) => result.status === "error").length;
  const alreadyConfigured = results.filter((result) =>
    result.status === "already_configured" || result.status === "skipped_already_done"
  ).length;

  console.log("");
  console.log("[RELATORIO FINAL]");
  console.log(`Total de workflows: ${results.length}`);
  console.log(`Sucesso: ${success}`);
  console.log(`Erro: ${errors}`);
  console.log(`Ja configurado: ${alreadyConfigured}`);
  console.log("Publicados: 0");
}

function printRunCompletionMessage(results: WorkflowResult[], totalTargets: number): void {
  const success = results.filter((result) => result.status === "success").length;
  const errors = results.filter((result) => result.status === "error").length;
  const alreadyConfigured = results.filter((result) =>
    result.status === "already_configured" || result.status === "skipped_already_done"
  ).length;

  if (results.length >= totalTargets) {
    ok(
      `Bot rodou em todas as clinicas da lista. Processadas: ${results.length}/${totalTargets}. ` +
        `Sucesso: ${success}. Erro: ${errors}. Ja configuradas: ${alreadyConfigured}.`
    );
    return;
  }

  console.log(
    `[INFO] Bot encerrou antes de rodar todas as clinicas. Processadas: ${results.length}/${totalTargets}. ` +
      `Sucesso: ${success}. Erro: ${errors}. Ja configuradas: ${alreadyConfigured}.`
  );
}

export function sanitizeFileName(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\s+/g, "-")
    .replace(/[^a-z0-9-]+/gi, "")
    .replace(/(^-|-$)/g, "")
    || "workflow";
}

function formatDateTime(value: Date): string {
  const pad = (part: number) => String(part).padStart(2, "0");
  return `${value.getFullYear()}-${pad(value.getMonth() + 1)}-${pad(value.getDate())} ` +
    `${pad(value.getHours())}:${pad(value.getMinutes())}:${pad(value.getSeconds())}`;
}

function formatClock(value: Date): string {
  const pad = (part: number) => String(part).padStart(2, "0");
  return `${pad(value.getHours())}:${pad(value.getMinutes())}:${pad(value.getSeconds())}`;
}

function formatDuration(totalSeconds: number): string {
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${String(minutes).padStart(2, "0")}m${String(seconds).padStart(2, "0")}s`;
}

main().catch((error) => {
  errorLog(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
