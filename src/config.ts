import dotenv from "dotenv";

dotenv.config();

export type BotConfig = {
  workflowUrl: string;
  workflowsFile: string;
  cdpUrl: string;
  keepOpen: boolean;
  slowMoMs: number;
  pauseBetweenSteps: boolean;
  workflowRenderWaitMs: number;
  clinicName: string;
  saveWorkflow: boolean;
  publishWorkflow: boolean;
  stopOnError: boolean;
  screenshotMode: string;
  errorTxtFile: string;
  maxRetriesPerWorkflow: number;
  refreshBeforeRetry: boolean;
  waitAfterBlockClickOnRetryMs: number;
  executionMode: string;
  targetTimePerClinicSeconds: number;
  delayAfterPageLoadMs: number;
  delayAfterBlockClickMs: number;
  delayAfterFieldClickMs: number;
  delayAfterTypingMs: number;
  delayAfterOptionSelectMs: number;
  delayAfterSaveChangesMs: number;
  delayAfterSaveWorkflowMs: number;
  waitForOptionsTimeoutMs: number;
  waitForFieldEnabledTimeoutMs: number;
  measureTiming: boolean;
  attemptNumber: number;
};

function parseBoolean(value: string | undefined, defaultValue: boolean): boolean {
  if (value === undefined || value.trim() === "") {
    return defaultValue;
  }

  return ["true", "1", "yes", "sim"].includes(value.trim().toLowerCase());
}

function parseNumber(value: string | undefined, defaultValue: number): number {
  if (value === undefined || value.trim() === "") {
    return defaultValue;
  }

  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : defaultValue;
}

export function loadConfig(): BotConfig {
  return {
    workflowUrl: process.env.BOT_WORKFLOW_URL?.trim() || "",
    workflowsFile: process.env.BOT_WORKFLOWS_FILE?.trim() || "config/workflows.txt",
    cdpUrl: process.env.BOT_CDP_URL?.trim() || "http://localhost:9222",
    keepOpen: parseBoolean(process.env.BOT_KEEP_OPEN, true),
    slowMoMs: parseNumber(process.env.BOT_SLOWMO_MS, 0),
    pauseBetweenSteps: parseBoolean(process.env.BOT_PAUSE_BETWEEN_STEPS, false),
    workflowRenderWaitMs: parseNumber(process.env.BOT_WORKFLOW_RENDER_WAIT_MS, 10000),
    clinicName: process.env.BOT_CLINIC_NAME?.trim() || "",
    saveWorkflow: parseBoolean(process.env.BOT_SAVE_WORKFLOW, true),
    publishWorkflow: parseBoolean(process.env.BOT_PUBLISH_WORKFLOW, false),
    stopOnError: parseBoolean(process.env.BOT_STOP_ON_ERROR, false),
    screenshotMode: process.env.BOT_SCREENSHOT_MODE?.trim() || "success-final-and-error",
    errorTxtFile: process.env.BOT_ERROR_TXT_FILE?.trim() || "screenshots/erros/clinicas-com-erro.txt",
    maxRetriesPerWorkflow: parseNumber(process.env.BOT_MAX_RETRIES_PER_WORKFLOW, 1),
    refreshBeforeRetry: parseBoolean(process.env.BOT_REFRESH_BEFORE_RETRY, true),
    waitAfterBlockClickOnRetryMs: parseNumber(process.env.BOT_WAIT_AFTER_BLOCK_CLICK_ON_RETRY_MS, 5000),
    executionMode: process.env.BOT_EXECUTION_MODE?.trim() || "safe",
    targetTimePerClinicSeconds: parseNumber(process.env.BOT_TARGET_TIME_PER_CLINIC_SECONDS, 180),
    delayAfterPageLoadMs: parseNumber(process.env.BOT_DELAY_AFTER_PAGE_LOAD_MS, 8000),
    delayAfterBlockClickMs: parseNumber(process.env.BOT_DELAY_AFTER_BLOCK_CLICK_MS, 2500),
    delayAfterFieldClickMs: parseNumber(process.env.BOT_DELAY_AFTER_FIELD_CLICK_MS, 2000),
    delayAfterTypingMs: parseNumber(process.env.BOT_DELAY_AFTER_TYPING_MS, 2500),
    delayAfterOptionSelectMs: parseNumber(process.env.BOT_DELAY_AFTER_OPTION_SELECT_MS, 1500),
    delayAfterSaveChangesMs: parseNumber(process.env.BOT_DELAY_AFTER_SAVE_CHANGES_MS, 3500),
    delayAfterSaveWorkflowMs: parseNumber(process.env.BOT_DELAY_AFTER_SAVE_WORKFLOW_MS, 5000),
    waitForOptionsTimeoutMs: parseNumber(process.env.BOT_WAIT_FOR_OPTIONS_TIMEOUT_MS, 15000),
    waitForFieldEnabledTimeoutMs: parseNumber(process.env.BOT_WAIT_FOR_FIELD_ENABLED_TIMEOUT_MS, 15000),
    measureTiming: parseBoolean(process.env.BOT_MEASURE_TIMING, true),
    attemptNumber: 1
  };
}
