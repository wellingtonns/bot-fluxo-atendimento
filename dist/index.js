"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.loadWorkflowTargets = loadWorkflowTargets;
exports.parseWorkflowTarget = parseWorkflowTarget;
exports.runWorkflowTarget = runWorkflowTarget;
exports.generateFinalReport = generateFinalReport;
exports.generateTimingReport = generateTimingReport;
exports.startWorkflowTimer = startWorkflowTimer;
exports.endWorkflowTimer = endWorkflowTimer;
exports.startStepTimer = startStepTimer;
exports.endStepTimer = endStepTimer;
exports.logTimingSummary = logTimingSummary;
exports.takeFinalSuccessScreenshot = takeFinalSuccessScreenshot;
exports.appendClinicErrorTxt = appendClinicErrorTxt;
exports.sanitizeFileName = sanitizeFileName;
const promises_1 = __importDefault(require("node:fs/promises"));
const node_path_1 = __importDefault(require("node:path"));
const config_js_1 = require("./config.js");
const bot_js_1 = require("./bot.js");
const utils_js_1 = require("./utils.js");
let baseConfig;
let sharedPage;
const executionStartedAtMs = Date.now();
const workflowTimings = [];
let activeWorkflowTiming = null;
let activeStepTiming = null;
async function main() {
    (0, utils_js_1.info)("Iniciando bot local cVortex");
    baseConfig = (0, config_js_1.loadConfig)();
    (0, bot_js_1.setBotConfig)(baseConfig);
    await (0, utils_js_1.ensureEvidenceFolders)();
    const targets = await loadWorkflowTargets();
    (0, utils_js_1.ok)(`Workflows carregados: ${targets.length}`);
    const { browser, page } = await (0, bot_js_1.connectToExistingChrome)();
    sharedPage = page;
    const results = [];
    try {
        for (const [index, target] of targets.entries()) {
            console.log("");
            console.log(`[WORKFLOW ${index + 1}/${targets.length}] ${target.clinicName}`);
            const result = await runWorkflowTarget(target);
            results.push(result);
            if (result.status === "error" && baseConfig.stopOnError) {
                (0, utils_js_1.errorLog)("Interrompendo fila porque BOT_STOP_ON_ERROR=true");
                break;
            }
        }
        await generateFinalReport(results);
        await generateTimingReport(results);
        printFinalReportSummary(results);
        logTimingSummary(results);
    }
    finally {
        await (0, bot_js_1.finishBrowserConnection)(browser);
    }
}
async function loadWorkflowTargets() {
    (0, utils_js_1.info)(`Carregando workflows de ${baseConfig.workflowsFile}`);
    const filePath = node_path_1.default.resolve(process.cwd(), baseConfig.workflowsFile);
    const content = await promises_1.default.readFile(filePath, "utf8");
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
function parseWorkflowTarget(line) {
    const [clinicNameRaw, ...urlParts] = line.split("|");
    const clinicName = clinicNameRaw?.trim();
    const url = cleanWorkflowUrl(urlParts.join("|").trim());
    if (!clinicName || !url) {
        throw new Error(`Linha invalida em workflows.txt: ${line}`);
    }
    if (!(0, utils_js_1.isHttpUrl)(url)) {
        throw new Error(`URL invalida em workflows.txt: ${url}`);
    }
    return { clinicName, url };
}
async function runWorkflowTarget(target) {
    const result = {
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
        etapaErro: "",
        mensagemErro: "",
        screenshotFinal: "",
        salvouWorkflow: false,
        publicouWorkflow: false
    };
    startWorkflowTimer(target.clinicName);
    try {
        const maxAttempts = baseConfig.maxRetriesPerWorkflow + 1;
        let lastError = null;
        for (let attemptNumber = 1; attemptNumber <= maxAttempts; attemptNumber += 1) {
            result.attempts = attemptNumber;
            (0, bot_js_1.setBotConfig)({
                ...baseConfig,
                workflowUrl: target.url,
                clinicName: target.clinicName,
                publishWorkflow: false,
                attemptNumber
            });
            (0, utils_js_1.info)(`Tentativa ${attemptNumber}/${maxAttempts}`);
            try {
                if (attemptNumber === 1) {
                    result.etapaErro = "Abrir workflow";
                    await (0, bot_js_1.openWorkflow)(sharedPage, target.url);
                }
                result.etapaErro = "Verificar sessao";
                await (0, bot_js_1.ensureAuthenticated)(sharedPage);
                (0, utils_js_1.info)(`Clinica usada: ${target.clinicName}`);
                (0, utils_js_1.info)("Executando alteracoes");
                result.etapaErro = "Executar alteracoes";
                await runConfiguredRules(sharedPage, result);
                result.etapaErro = "";
                (0, utils_js_1.ok)("Alteracoes concluidas");
                lastError = null;
                break;
            }
            catch (error) {
                lastError = error;
                const message = error instanceof Error ? error.message : String(error);
                result.status = "error";
                result.mensagemErro = message;
                result.errorMessage = message;
                result.etapaErro ||= "Etapa nao identificada";
                applyErrorDetails(result, error);
                if (attemptNumber < maxAttempts) {
                    (0, utils_js_1.errorLog)(`Falha na tentativa ${attemptNumber}/${maxAttempts}: ${result.etapaErro}`);
                    (0, utils_js_1.errorLog)(message);
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
        result.status = "success";
        result.mensagemErro = "";
        result.errorBlock = "";
        result.errorField = "";
        result.expectedValue = "";
        result.availableOptions = [];
        result.errorMessage = "";
        result.screenshotPath = "";
        if (baseConfig.saveWorkflow) {
            result.etapaErro = "Salvar Workflow";
            await (0, bot_js_1.saveWorkflowOnly)(sharedPage);
            result.salvouWorkflow = true;
            result.savedWorkflow = true;
        }
        result.etapaErro = "";
        result.screenshotFinal = await takeFinalSuccessScreenshot(sharedPage, target.clinicName);
        (0, utils_js_1.ok)(`Screenshot final salvo: ${result.screenshotFinal}`);
    }
    catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        result.status = "error";
        result.mensagemErro = message;
        result.errorMessage = message;
        result.etapaErro ||= "Etapa nao identificada";
        applyErrorDetails(result, error);
        (0, utils_js_1.errorLog)(`Falha na etapa: ${result.etapaErro}`);
        (0, utils_js_1.errorLog)(message);
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
        (0, utils_js_1.ok)(`Erro registrado em: ${baseConfig.errorTxtFile}`);
        (0, utils_js_1.info)("Pulando para o proximo workflow");
    }
    finally {
        if (activeWorkflowTiming) {
            result.durationSeconds = Math.round((Date.now() - activeWorkflowTiming.startedAtMs) / 1000);
        }
        endWorkflowTimer(target.clinicName, result.status);
    }
    return result;
}
function applyErrorDetails(result, error) {
    result.errorBlock = result.etapaErro;
    if (error instanceof bot_js_1.AutomationError) {
        result.errorBlock = error.details.blockName || result.errorBlock;
        result.errorField = error.details.fieldName || result.errorField;
        result.expectedValue = error.details.expectedValue || result.expectedValue;
        result.availableOptions = error.details.availableOptions || result.availableOptions;
    }
}
async function takeErrorScreenshot(page, clinicName, blockName) {
    const filename = `${sanitizeFileName(clinicName)}-${sanitizeFileName(blockName)}-erro.png`;
    const fullPath = node_path_1.default.join(utils_js_1.errorScreenshotsDir, filename);
    await page.screenshot({ path: fullPath, fullPage: true });
    const relativePath = node_path_1.default.relative(process.cwd(), fullPath).replace(/\\/g, "/");
    (0, utils_js_1.ok)(`Screenshot de erro salvo: ${relativePath}`);
    return relativePath;
}
async function refreshWorkflowAfterAttemptError(page) {
    (0, utils_js_1.info)("Recarregando pagina antes da segunda tentativa");
    await page.reload({ waitUntil: "domcontentloaded" });
    (0, utils_js_1.info)(`Aguardando ${Math.round(baseConfig.workflowRenderWaitMs / 1000)}s para o workflow carregar`);
    await page.waitForTimeout(baseConfig.workflowRenderWaitMs);
    await (0, bot_js_1.waitStep)("apos carregar workflow", baseConfig.delayAfterPageLoadMs);
    (0, utils_js_1.ok)("Workflow recarregado");
}
async function generateFinalReport(results) {
    const reportPath = node_path_1.default.join(utils_js_1.logsDir, "final-report.json");
    await promises_1.default.writeFile(reportPath, `${JSON.stringify(results, null, 2)}\n`, "utf8");
    (0, utils_js_1.ok)("Relatorio final salvo em logs/final-report.json");
}
async function generateTimingReport(results) {
    if (!baseConfig.measureTiming) {
        return;
    }
    const totalSeconds = Math.round((Date.now() - executionStartedAtMs) / 1000);
    const success = results.filter((result) => result.status === "success").length;
    const error = results.filter((result) => result.status === "error").length;
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
        averageSecondsPerWorkflow,
        totalSeconds,
        workflows: workflowTimings.map((workflow) => ({
            clinicName: workflow.clinicName,
            status: workflow.status,
            durationSeconds: workflow.durationSeconds ?? 0,
            steps: workflow.steps
        }))
    };
    const reportPath = node_path_1.default.join(utils_js_1.logsDir, "timing-report.json");
    await promises_1.default.writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
    (0, utils_js_1.ok)("Relatorio de tempo salvo em logs/timing-report.json");
}
function startWorkflowTimer(clinicName) {
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
function endWorkflowTimer(clinicName, status = "success") {
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
function startStepTimer(stepName) {
    if (!baseConfig.measureTiming || !activeWorkflowTiming) {
        return;
    }
    activeStepTiming = {
        name: stepName,
        startedAtMs: Date.now()
    };
}
function endStepTimer(stepName) {
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
function logTimingSummary(results) {
    if (!baseConfig.measureTiming) {
        return;
    }
    const totalSeconds = Math.round((Date.now() - executionStartedAtMs) / 1000);
    const success = results.filter((result) => result.status === "success").length;
    const error = results.filter((result) => result.status === "error").length;
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
    console.log(`Tempo medio por clinica: ${formatDuration(averageSecondsPerWorkflow)}`);
    console.log(`Tempo total: ${formatDuration(totalSeconds)}`);
}
async function runConfiguredRules(page, result) {
    await runStep(result, "Iniciar / Tipo de Caso", async () => {
        await (0, bot_js_1.clickStartBlock)(page);
        await (0, bot_js_1.openTipoCasoField)(page);
        await (0, bot_js_1.selectAllTipoCasoOptions)(page);
        await (0, bot_js_1.saveChangesIfNeeded)(page, {
            clinicName: result.clinica,
            url: result.url,
            blockName: "Iniciar / Tipo de Caso",
            fieldName: "Tipo de Caso",
            expectedValue: "Todas as opcoes",
            isFieldCorrect: true
        });
    });
    await runStep(result, "Aguardando Atendimento", () => (0, bot_js_1.updateAllAguardandoAtendimentoBlocks)(page));
    await runStep(result, "StartCaseHandling", async () => {
        await (0, bot_js_1.clickStartCaseHandlingBlock)(page);
        await (0, bot_js_1.selectStartCaseHandlingAction)(page);
        await (0, bot_js_1.saveChangesIfNeeded)(page, {
            clinicName: result.clinica,
            url: result.url,
            blockName: "StartCaseHandling",
            fieldName: "Acao",
            expectedValue: "StartCaseHandling",
            isFieldCorrect: true
        });
    });
    await runStep(result, "Em Atendimento Ativo", () => (0, bot_js_1.updateAllEmAtendimentoAtivoBlocks)(page));
    await runStep(result, "Presidente Prudente - Em Atendimento", () => (0, bot_js_1.updateAllPresidentePendenteEmAtendimentoBlocks)(page));
    await runStep(result, "2 - Iniciar Conversa WhatsApp", () => (0, bot_js_1.updateActionBlock)(page, { includes: ["2 - Iniciar Conversa WhatsApp"] }, "2 - Iniciar Conversa WhatsApp", "iniciar-conversa-whatsapp"));
    await runStep(result, "1 - Transferir Atendimento Chat", () => (0, bot_js_1.updateActionBlock)(page, { includes: ["1 - Transferir Atendimento Chat"] }, "1 - Transferir Atendimento Chat", "transferir-atendimento-chat"));
    await runStep(result, "5 - Confirmar Agendamento", () => (0, bot_js_1.updateActionBlock)(page, { includes: ["5 - Confirmar Agendamento"] }, "5 - Confirmar Agendamento", "confirmar-agendamento"));
    await runStep(result, "4 - Cancelar Agendamento", () => (0, bot_js_1.updateActionBlock)(page, { includes: ["4 - Cancelar Agendamento"] }, "4 - Cancelar Agendamento", "cancelar-agendamento"));
    await runStep(result, "Realizar Agendamento", () => (0, bot_js_1.updateActionBlock)(page, { includes: ["Realizar Agendamento"] }, "Realizar Agendamento", "realizar-agendamento"));
    await runStep(result, "Finalizar Atendimento", () => (0, bot_js_1.updateActionBlock)(page, { includes: ["Finalizar Atendimento"], excludes: ["Ativo"] }, "Finalizar Atendimento", "finalizar-atendimento"));
    await runStep(result, "6 - Finalizar Atendimento Ativo", () => (0, bot_js_1.updateActionBlock)(page, { includes: ["6 - Finalizar Atendimento Ativo"] }, "6 - Finalizar Atendimento Ativo", "finalizar-atendimento-ativo"));
    await runStep(result, "Transferir para Bot", () => (0, bot_js_1.updateAllTransferToBotBlocks)(page));
    await runStep(result, "Presidente Prudente - Navegacao Pesquisa", () => (0, bot_js_1.updateAllPresidenteNavegacaoPesquisaBlocks)(page));
    await runStep(result, "Finalizado", () => (0, bot_js_1.updateAllFinalizadoBlocks)(page));
    await runStep(result, "Tabulacao Subcategoria", () => (0, bot_js_1.updateAllTabulacaoSubcategoriaBlocks)(page));
    await runStep(result, "Subcategoria", () => (0, bot_js_1.updateActionBlock)(page, { includes: ["Subcategoria"] }, "Subcategoria", "subcategoria"));
    await runStep(result, "Tabulacao Conduta", () => (0, bot_js_1.updateAllTabulacaoCondutaBlocks)(page));
    await runStep(result, "Conduta Profissional", () => (0, bot_js_1.updateActionBlock)(page, { includes: ["Conduta Profissional"] }, "Conduta Profissional", "conduta-profissional"));
    await runStep(result, "Aguardando Resposta Paciente", () => (0, bot_js_1.updateAllPresidenteAguardandoRespostaPacienteBlocks)(page));
    await runStep(result, "Confirmacao Aguardando Acao", () => (0, bot_js_1.updateAllPresidenteConfirmacaoAguardandoAcaoBlocks)(page));
    await runStep(result, "Agendado", () => (0, bot_js_1.updateAllPresidenteAgendadoBlocks)(page));
    await runStep(result, "Contato Ativo", () => (0, bot_js_1.updateAllPresidenteContatoAtivoBlocks)(page));
    await runStep(result, "Voltar ao Menu Anterior", () => (0, bot_js_1.updateActionBlock)(page, { includes: ["Voltar ao Menu Anterior"] }, "Voltar ao Menu Anterior", "voltar-menu-anterior"));
    await runStep(result, "Contato Ativo Livre", () => (0, bot_js_1.updateActionBlock)(page, { includes: ["Contato Ativo Livre"] }, "Contato Ativo", "contato-ativo-livre"));
}
async function runStep(result, blockName, action) {
    startStepTimer(blockName);
    try {
        result.etapaErro = blockName;
        await action();
    }
    catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        result.etapaErro = blockName;
        result.mensagemErro = message;
        throw error;
    }
    finally {
        endStepTimer(blockName);
    }
}
async function takeFinalSuccessScreenshot(page, clinicName) {
    const filename = `${sanitizeFileName(clinicName)}-final.png`;
    const fullPath = node_path_1.default.join(utils_js_1.successScreenshotsDir, filename);
    await page.screenshot({ path: fullPath, fullPage: true });
    return node_path_1.default.relative(process.cwd(), fullPath).replace(/\\/g, "/");
}
function cleanWorkflowUrl(value) {
    const markdownMatch = value.match(/\((https?:\/\/[^)]+)\)/i);
    return (markdownMatch?.[1] ?? value)
        .replace(/^\[/, "")
        .replace(/\]$/, "")
        .trim();
}
async function appendClinicErrorTxt(errorInfo) {
    const errorFilePath = node_path_1.default.resolve(process.cwd(), baseConfig.errorTxtFile);
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
    await promises_1.default.mkdir(node_path_1.default.dirname(errorFilePath), { recursive: true });
    try {
        await promises_1.default.access(errorFilePath);
    }
    catch {
        await promises_1.default.writeFile(errorFilePath, "# CLÍNICAS COM ERRO\n\n", "utf8");
    }
    await promises_1.default.appendFile(errorFilePath, line, "utf8");
}
function printFinalReportSummary(results) {
    const success = results.filter((result) => result.status === "success").length;
    const errors = results.filter((result) => result.status === "error").length;
    console.log("");
    console.log("[RELATORIO FINAL]");
    console.log(`Total de workflows: ${results.length}`);
    console.log(`Sucesso: ${success}`);
    console.log(`Erro: ${errors}`);
    console.log("Publicados: 0");
}
function sanitizeFileName(value) {
    return value
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "")
        .replace(/\s+/g, "-")
        .replace(/[^a-z0-9-]+/gi, "")
        .replace(/(^-|-$)/g, "")
        || "workflow";
}
function formatDateTime(value) {
    const pad = (part) => String(part).padStart(2, "0");
    return `${value.getFullYear()}-${pad(value.getMonth() + 1)}-${pad(value.getDate())} ` +
        `${pad(value.getHours())}:${pad(value.getMinutes())}:${pad(value.getSeconds())}`;
}
function formatClock(value) {
    const pad = (part) => String(part).padStart(2, "0");
    return `${pad(value.getHours())}:${pad(value.getMinutes())}:${pad(value.getSeconds())}`;
}
function formatDuration(totalSeconds) {
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    return `${String(minutes).padStart(2, "0")}m${String(seconds).padStart(2, "0")}s`;
}
main().catch((error) => {
    (0, utils_js_1.errorLog)(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
});
