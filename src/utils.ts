import fs from "node:fs/promises";
import path from "node:path";
import { Locator, Page } from "playwright";

export const screenshotsDir = path.resolve(process.cwd(), "screenshots");
export const successScreenshotsDir = path.resolve(screenshotsDir, "sucesso");
export const errorScreenshotsDir = path.resolve(screenshotsDir, "erros");
export const videosDir = path.resolve(process.cwd(), "videos");
export const logsDir = path.resolve(process.cwd(), "logs");

export function info(message: string): void {
  console.log(`[INFO] ${message}`);
}

export function ok(message: string): void {
  console.log(`[OK] ${message}`);
}

export function errorLog(message: string): void {
  console.error(`[ERRO] ${message}`);
}

export async function ensureScreenshotsDir(): Promise<void> {
  await fs.mkdir(screenshotsDir, { recursive: true });
}

export async function ensureEvidenceFolders(): Promise<void> {
  await Promise.all([
    fs.mkdir(screenshotsDir, { recursive: true }),
    fs.mkdir(successScreenshotsDir, { recursive: true }),
    fs.mkdir(errorScreenshotsDir, { recursive: true }),
    fs.mkdir(logsDir, { recursive: true })
  ]);
}

export async function ensureEvidenceDirs(): Promise<void> {
  await ensureEvidenceFolders();
}

export function isHttpUrl(value: string): boolean {
  return value.startsWith("http://") || value.startsWith("https://");
}

export async function firstVisible(locator: Locator): Promise<Locator | null> {
  const count = await locator.count();

  for (let index = 0; index < count; index += 1) {
    const item = locator.nth(index);

    if (await item.isVisible().catch(() => false)) {
      return item;
    }
  }

  return null;
}

export async function clickFirstVisible(locators: Locator[], actionName: string): Promise<Locator> {
  for (const locator of locators) {
    const visible = await firstVisible(locator);

    if (visible) {
      await visible.click();
      return visible;
    }
  }

  throw new Error(`Nao foi possivel clicar em: ${actionName}`);
}

export async function fillFirstVisible(locators: Locator[], value: string, fieldName: string): Promise<void> {
  for (const locator of locators) {
    const visible = await firstVisible(locator);

    if (visible) {
      await visible.fill(value);
      return;
    }
  }

  throw new Error(`Nao foi possivel preencher o campo: ${fieldName}`);
}

export async function waitForStablePage(page: Page): Promise<void> {
  await page.waitForLoadState("domcontentloaded");
  await page.waitForLoadState("networkidle", { timeout: 15000 }).catch(() => undefined);
}
