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
  actionDelayAfterBlockClickMs: number;
  actionDelayAfterFieldClickMs: number;
  actionDelayAfterOptionSelectMs: number;
  actionDelayAfterSaveChangesMs: number;
  actionWaitForOptionsTimeoutMs: number;
  optionPollIntervalMs: number;
  optionMaxWaitMs: number;
  actionOptionMaxWaitMs: number;
  actionOptionPollIntervalMs: number;
  saveButtonMaxWaitMs: number;
  saveButtonPollIntervalMs: number;
  botFlowCollectOptionsStableMs: number;
  measureTiming: boolean;
  attemptNumber: number;
};

export type RuleTiming = {
  delayAfterPageLoadMs: number;
  delayAfterBlockClickMs: number;
  delayAfterFieldClickMs: number;
  delayAfterTypingMs: number;
  delayAfterOptionSelectMs: number;
  delayAfterSaveChangesMs: number;
  delayAfterSaveWorkflowMs: number;
  waitForOptionsTimeoutMs: number;
  waitForFieldEnabledTimeoutMs: number;
  waitAfterBlockClickOnRetryMs: number;
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

function getModeTiming(mode: string): RuleTiming {
  switch (mode.trim().toLowerCase()) {
    case "fast-safe":
      return {
        delayAfterPageLoadMs: 2500,
        delayAfterBlockClickMs: 600,
        delayAfterFieldClickMs: 400,
        delayAfterTypingMs: 700,
        delayAfterOptionSelectMs: 100,
        delayAfterSaveChangesMs: 300,
        delayAfterSaveWorkflowMs: 1500,
        waitForOptionsTimeoutMs: 5000,
        waitForFieldEnabledTimeoutMs: 5000,
        waitAfterBlockClickOnRetryMs: 2000
      };
    case "half-safe":
      return {
        delayAfterPageLoadMs: 4000,
        delayAfterBlockClickMs: 1200,
        delayAfterFieldClickMs: 1000,
        delayAfterTypingMs: 1200,
        delayAfterOptionSelectMs: 700,
        delayAfterSaveChangesMs: 1800,
        delayAfterSaveWorkflowMs: 2500,
        waitForOptionsTimeoutMs: 8000,
        waitForFieldEnabledTimeoutMs: 8000,
        waitAfterBlockClickOnRetryMs: 3000
      };
    case "fast":
      return {
        delayAfterPageLoadMs: 2500,
        delayAfterBlockClickMs: 700,
        delayAfterFieldClickMs: 500,
        delayAfterTypingMs: 700,
        delayAfterOptionSelectMs: 400,
        delayAfterSaveChangesMs: 1000,
        delayAfterSaveWorkflowMs: 1500,
        waitForOptionsTimeoutMs: 5000,
        waitForFieldEnabledTimeoutMs: 5000,
        waitAfterBlockClickOnRetryMs: 2000
      };
    case "balanced":
      return {
        delayAfterPageLoadMs: 6000,
        delayAfterBlockClickMs: 1800,
        delayAfterFieldClickMs: 1500,
        delayAfterTypingMs: 1800,
        delayAfterOptionSelectMs: 1000,
        delayAfterSaveChangesMs: 2500,
        delayAfterSaveWorkflowMs: 3500,
        waitForOptionsTimeoutMs: 10000,
        waitForFieldEnabledTimeoutMs: 10000,
        waitAfterBlockClickOnRetryMs: 4000
      };
    case "safe":
    default:
      return {
        delayAfterPageLoadMs: 8000,
        delayAfterBlockClickMs: 2500,
        delayAfterFieldClickMs: 2000,
        delayAfterTypingMs: 2500,
        delayAfterOptionSelectMs: 1500,
        delayAfterSaveChangesMs: 3500,
        delayAfterSaveWorkflowMs: 5000,
        waitForOptionsTimeoutMs: 15000,
        waitForFieldEnabledTimeoutMs: 15000,
        waitAfterBlockClickOnRetryMs: 5000
      };
  }
}

export function loadConfig(): BotConfig {
  const executionMode = process.env.BOT_EXECUTION_MODE?.trim() || "fast-safe";
  const modeTiming = getModeTiming(executionMode);

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
    waitAfterBlockClickOnRetryMs: parseNumber(process.env.BOT_WAIT_AFTER_BLOCK_CLICK_ON_RETRY_MS, modeTiming.waitAfterBlockClickOnRetryMs),
    executionMode,
    targetTimePerClinicSeconds: parseNumber(process.env.BOT_TARGET_TIME_PER_CLINIC_SECONDS, 180),
    delayAfterPageLoadMs: parseNumber(process.env.BOT_DELAY_AFTER_PAGE_LOAD_MS, modeTiming.delayAfterPageLoadMs),
    delayAfterBlockClickMs: parseNumber(process.env.BOT_DELAY_AFTER_BLOCK_CLICK_MS, modeTiming.delayAfterBlockClickMs),
    delayAfterFieldClickMs: parseNumber(process.env.BOT_DELAY_AFTER_FIELD_CLICK_MS, modeTiming.delayAfterFieldClickMs),
    delayAfterTypingMs: parseNumber(process.env.BOT_DELAY_AFTER_TYPING_MS, modeTiming.delayAfterTypingMs),
    delayAfterOptionSelectMs: parseNumber(process.env.BOT_DELAY_AFTER_OPTION_SELECT_MS, modeTiming.delayAfterOptionSelectMs),
    delayAfterSaveChangesMs: parseNumber(process.env.BOT_DELAY_AFTER_SAVE_CHANGES_MS, modeTiming.delayAfterSaveChangesMs),
    delayAfterSaveWorkflowMs: parseNumber(process.env.BOT_DELAY_AFTER_SAVE_WORKFLOW_MS, modeTiming.delayAfterSaveWorkflowMs),
    waitForOptionsTimeoutMs: parseNumber(process.env.BOT_WAIT_FOR_OPTIONS_TIMEOUT_MS, modeTiming.waitForOptionsTimeoutMs),
    waitForFieldEnabledTimeoutMs: parseNumber(process.env.BOT_WAIT_FOR_FIELD_ENABLED_TIMEOUT_MS, modeTiming.waitForFieldEnabledTimeoutMs),
    actionDelayAfterBlockClickMs: parseNumber(process.env.BOT_ACTION_DELAY_AFTER_BLOCK_CLICK_MS, 300),
    actionDelayAfterFieldClickMs: parseNumber(process.env.BOT_ACTION_DELAY_AFTER_FIELD_CLICK_MS, 250),
    actionDelayAfterOptionSelectMs: parseNumber(process.env.BOT_ACTION_DELAY_AFTER_OPTION_SELECT_MS, 100),
    actionDelayAfterSaveChangesMs: parseNumber(process.env.BOT_ACTION_DELAY_AFTER_SAVE_CHANGES_MS, 200),
    actionWaitForOptionsTimeoutMs: parseNumber(process.env.BOT_ACTION_WAIT_FOR_OPTIONS_TIMEOUT_MS, 3500),
    optionPollIntervalMs: parseNumber(process.env.BOT_OPTION_POLL_INTERVAL_MS, 80),
    optionMaxWaitMs: parseNumber(process.env.BOT_OPTION_MAX_WAIT_MS, 2000),
    actionOptionMaxWaitMs: parseNumber(process.env.BOT_ACTION_OPTION_MAX_WAIT_MS, 1000),
    actionOptionPollIntervalMs: parseNumber(process.env.BOT_ACTION_OPTION_POLL_INTERVAL_MS, 50),
    saveButtonMaxWaitMs: parseNumber(process.env.BOT_SAVE_BUTTON_MAX_WAIT_MS, 1000),
    saveButtonPollIntervalMs: parseNumber(process.env.BOT_SAVE_BUTTON_POLL_INTERVAL_MS, 100),
    botFlowCollectOptionsStableMs: parseNumber(process.env.BOT_BOTFLOW_COLLECT_OPTIONS_STABLE_MS, 300),
    measureTiming: parseBoolean(process.env.BOT_MEASURE_TIMING, true),
    attemptNumber: 1
  };
}
