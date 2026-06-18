"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.logsDir = exports.videosDir = exports.errorScreenshotsDir = exports.successScreenshotsDir = exports.screenshotsDir = void 0;
exports.info = info;
exports.ok = ok;
exports.errorLog = errorLog;
exports.ensureScreenshotsDir = ensureScreenshotsDir;
exports.ensureEvidenceFolders = ensureEvidenceFolders;
exports.ensureEvidenceDirs = ensureEvidenceDirs;
exports.isHttpUrl = isHttpUrl;
exports.firstVisible = firstVisible;
exports.clickFirstVisible = clickFirstVisible;
exports.fillFirstVisible = fillFirstVisible;
exports.waitForStablePage = waitForStablePage;
const promises_1 = __importDefault(require("node:fs/promises"));
const node_path_1 = __importDefault(require("node:path"));
exports.screenshotsDir = node_path_1.default.resolve(process.cwd(), "screenshots");
exports.successScreenshotsDir = node_path_1.default.resolve(exports.screenshotsDir, "sucesso");
exports.errorScreenshotsDir = node_path_1.default.resolve(exports.screenshotsDir, "erros");
exports.videosDir = node_path_1.default.resolve(process.cwd(), "videos");
exports.logsDir = node_path_1.default.resolve(process.cwd(), "logs");
function info(message) {
    console.log(`[INFO] ${message}`);
}
function ok(message) {
    console.log(`[OK] ${message}`);
}
function errorLog(message) {
    console.error(`[ERRO] ${message}`);
}
async function ensureScreenshotsDir() {
    await promises_1.default.mkdir(exports.screenshotsDir, { recursive: true });
}
async function ensureEvidenceFolders() {
    await Promise.all([
        promises_1.default.mkdir(exports.screenshotsDir, { recursive: true }),
        promises_1.default.mkdir(exports.successScreenshotsDir, { recursive: true }),
        promises_1.default.mkdir(exports.errorScreenshotsDir, { recursive: true }),
        promises_1.default.mkdir(exports.logsDir, { recursive: true })
    ]);
}
async function ensureEvidenceDirs() {
    await ensureEvidenceFolders();
}
function isHttpUrl(value) {
    return value.startsWith("http://") || value.startsWith("https://");
}
async function firstVisible(locator) {
    const count = await locator.count();
    for (let index = 0; index < count; index += 1) {
        const item = locator.nth(index);
        if (await item.isVisible().catch(() => false)) {
            return item;
        }
    }
    return null;
}
async function clickFirstVisible(locators, actionName) {
    for (const locator of locators) {
        const visible = await firstVisible(locator);
        if (visible) {
            await visible.click();
            return visible;
        }
    }
    throw new Error(`Nao foi possivel clicar em: ${actionName}`);
}
async function fillFirstVisible(locators, value, fieldName) {
    for (const locator of locators) {
        const visible = await firstVisible(locator);
        if (visible) {
            await visible.fill(value);
            return;
        }
    }
    throw new Error(`Nao foi possivel preencher o campo: ${fieldName}`);
}
async function waitForStablePage(page) {
    await page.waitForLoadState("domcontentloaded");
    await page.waitForLoadState("networkidle", { timeout: 15000 }).catch(() => undefined);
}
