import { existsSync } from "node:fs";
import { resolve } from "node:path";
import type { XhsCookies } from "./cookies.js";

export interface BrowserPostOptions {
  title: string;
  body: string;
  images: string[];
  isPrivate?: boolean;
  submit?: boolean;
  headless?: boolean;
  chromePath?: string;
}

export interface BrowserPostResult {
  success: boolean;
  currentUrl: string;
  title: string;
  usedProfile: string;
  headless: boolean;
  noteId?: string;
  noteUrl?: string;
  requiresManualAction?: boolean;
  message: string;
}

interface LaunchTarget {
  executablePath: string;
  args: string[];
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type PuppeteerModule = any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type PuppeteerPage = any;

const MAIN_SITE_URL = "https://www.xiaohongshu.com/explore";
const PUBLISH_LINK_SELECTOR = 'a[href*="creator.xiaohongshu.com/publish/publish"]';
const DEFAULT_PROFILE = "Default";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function importPuppeteer(): Promise<PuppeteerModule> {
  try {
    return await import("puppeteer-core");
  } catch {
    throw new Error(
      "Browser posting requires puppeteer-core.\nInstall it with:\n  npm install"
    );
  }
}

function findChromeExecutable(override?: string): string {
  const candidates = [
    override,
    process.env.CHROME_PATH,
    process.platform === "linux" ? "/usr/bin/google-chrome" : undefined,
    process.platform === "linux" ? "/usr/bin/google-chrome-stable" : undefined,
    process.platform === "darwin"
      ? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
      : undefined,
  ].filter(Boolean) as string[];

  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }

  throw new Error(
    "Chrome not found. Set CHROME_PATH or install Google Chrome."
  );
}

function buildLaunchTarget(chromePath?: string): LaunchTarget {
  const executablePath = findChromeExecutable(chromePath);
  return {
    executablePath,
    args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-gpu"],
  };
}

async function openPublishPage(
  browser: PuppeteerModule,
  page: PuppeteerPage
): Promise<PuppeteerPage> {
  await page.goto(MAIN_SITE_URL, { waitUntil: "domcontentloaded", timeout: 30_000 });
  await page.waitForSelector(PUBLISH_LINK_SELECTOR, { timeout: 30_000 });

  const publishHref = await page.$eval(
    PUBLISH_LINK_SELECTOR,
    (el: Element) => (el as HTMLAnchorElement).href
  );
  const existingPages = new Set((await browser.pages()).map((p: PuppeteerPage) => p.target()));
  await page.evaluate((href: string) => {
    window.open(href, "_blank", "noopener,noreferrer");
  }, publishHref);

  const publishPage = await browser.waitForTarget(
    (target: { type: () => string }) =>
      target.type() === "page" && !existingPages.has(target),
    { timeout: 30_000 }
  );

  const resultPage = await publishPage.page();
  if (!resultPage) {
    throw new Error("Could not access creator publish page.");
  }

  await resultPage.bringToFront();
  await resultPage.waitForFunction(
    () => document.body.innerText.includes("上传图文"),
    { timeout: 30_000 }
  );
  return resultPage;
}

async function enterImageMode(page: PuppeteerPage): Promise<void> {
  const clicked = await page.evaluate(() => {
    const tab = Array.from(document.querySelectorAll("div.creator-tab"))
      .find((el) => el.textContent?.includes("上传图文")) as HTMLElement | undefined;
    if (!tab) return false;
    tab.click();
    return true;
  });

  if (!clicked) {
    throw new Error("Could not find the image-note tab on the publish page.");
  }

  await page.waitForFunction(
    () => document.body.innerText.includes("上传图片"),
    { timeout: 30_000 }
  );
}

async function uploadImages(page: PuppeteerPage, images: string[]): Promise<void> {
  const imagePaths = images.map((p) => resolve(p));
  for (const p of imagePaths) {
    if (!existsSync(p)) {
      throw new Error(`Image file not found: ${p}`);
    }
  }

  const input = await page.evaluateHandle(() => {
    const inputs = Array.from(document.querySelectorAll('input[type="file"]'));
    return (
      inputs.find((el) => {
        const accept = el.getAttribute("accept") ?? "";
        return accept.includes(".jpg") && el.hasAttribute("multiple");
      }) ?? null
    );
  });

  const element = input.asElement();
  if (!element) {
    throw new Error("Image upload input not found.");
  }

  await element.uploadFile(...imagePaths);
  await page.waitForFunction(
    () => {
      const titleInput = Array.from(document.querySelectorAll("input"))
        .find((el) => (el.getAttribute("placeholder") ?? "").includes("标题"));
      const editor = document.querySelector('[contenteditable="true"]');
      return Boolean(titleInput && editor);
    },
    { timeout: 30_000 }
  );
}

async function fillTitle(page: PuppeteerPage, title: string): Promise<void> {
  const titleHandle = await page.evaluateHandle(() => {
    return Array.from(document.querySelectorAll("input"))
      .find((el) => {
        const placeholder = el.getAttribute("placeholder") ?? "";
        return placeholder.includes("标题");
      }) ?? null;
  });

  const titleInput = titleHandle.asElement();
  if (!titleInput) {
    throw new Error("Title input not found.");
  }

  await titleInput.click();
  await page.evaluate((value: string) => {
    const input = Array.from(document.querySelectorAll("input"))
      .find((el) => (el.getAttribute("placeholder") ?? "").includes("标题")) as HTMLInputElement | undefined;
    if (!input) return;
    input.focus();
    input.value = value;
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
  }, title);
}

async function fillBody(page: PuppeteerPage, body: string): Promise<void> {
  const bodyHandle = await page.evaluateHandle(() => {
    const textarea = Array.from(document.querySelectorAll("textarea"))
      .find((el) => {
        const placeholder = el.getAttribute("placeholder") ?? "";
        return placeholder.includes("分享") || placeholder.includes("输入正文");
      });
    if (textarea) return textarea;

    return Array.from(document.querySelectorAll('[contenteditable="true"]'))
      .find((el) => (el as HTMLElement).innerText !== undefined) ?? null;
  });

  const bodyInput = bodyHandle.asElement();
  if (!bodyInput) {
    throw new Error("Body editor not found.");
  }

  await bodyInput.click();
  const modifier = process.platform === "darwin" ? "Meta" : "Control";
  await page.keyboard.down(modifier);
  await page.keyboard.press("KeyA");
  await page.keyboard.up(modifier);
  await page.keyboard.press("Backspace");
  await bodyInput.type(body, { delay: 10 });
}

async function setPrivacy(page: PuppeteerPage, isPrivate: boolean): Promise<void> {
  if (!isPrivate) return;

  const opened = await page.evaluate(() => {
    const trigger = Array.from(document.querySelectorAll("div,span,button"))
      .find((el) => el.textContent?.trim() === "公开") as HTMLElement | undefined;
    if (!trigger) return false;
    trigger.click();
    return true;
  });

  if (!opened) return;

  await page.waitForFunction(
    () => document.body.innerText.includes("仅自己可见"),
    { timeout: 10_000 }
  );

  await page.evaluate(() => {
    const option = Array.from(document.querySelectorAll("div,span,button"))
      .find((el) => el.textContent?.trim() === "仅自己可见") as HTMLElement | undefined;
    option?.click();
  });
  await page.waitForFunction(
    () => document.body.innerText.includes("仅自己可见"),
    { timeout: 10_000 }
  );
}

async function clickPublish(page: PuppeteerPage): Promise<void> {
  const clicked = await page.evaluate(() => {
    const button = Array.from(document.querySelectorAll("button"))
      .find((el) => el.textContent?.trim() === "发布") as HTMLButtonElement | undefined;
    if (!button || button.disabled) return false;
    button.click();
    return true;
  });

  if (!clicked) {
    throw new Error("Publish button not found or not clickable.");
  }
}

async function waitForPublishResult(page: PuppeteerPage): Promise<{
  success: boolean;
  noteId?: string;
  noteUrl?: string;
  message: string;
}> {
  const started = Date.now();

  while (Date.now() - started < 45_000) {
    const text = await page.evaluate(() => document.body.innerText.slice(0, 5000));
    const url = page.url();

    const published = await extractPublishedNote(page);
    if (published.noteId) {
      return {
        success: true,
        noteId: published.noteId,
        noteUrl: published.noteUrl,
        message: "Note published via browser automation.",
      };
    }

    if (url.includes("/publish/success")) {
      return {
        success: true,
        message: "Note published via browser automation and reached the success page.",
      };
    }

    if (
      text.includes("验证码") ||
      text.includes("安全验证") ||
      text.includes("请完成验证") ||
      text.includes("验证")
    ) {
      return {
        success: false,
        message: "Publish requires captcha or manual verification in the browser.",
      };
    }

    if (!url.includes("/publish/publish")) {
      return {
        success: false,
        message: `Browser navigated away after publish attempt: ${url}`,
      };
    }

    await sleep(1500);
  }

  return {
    success: false,
    message: "Publish attempt timed out while waiting for success or verification UI.",
  };
}

async function extractPublishedNote(page: PuppeteerPage): Promise<{
  noteId?: string;
  noteUrl?: string;
}> {
  const url = page.url();
  const match = url.match(/explore\/([a-zA-Z0-9]+)/);
  if (!match) return {};
  const noteId = match[1];
  return {
    noteId,
    noteUrl: `https://www.xiaohongshu.com/explore/${noteId}`,
  };
}

export async function postViaBrowser(
  cookies: XhsCookies,
  options: BrowserPostOptions
): Promise<BrowserPostResult> {
  if (options.images.length === 0) {
    throw new Error("At least one image is required for browser posting.");
  }

  const puppeteer = await importPuppeteer();
  const target = buildLaunchTarget(options.chromePath);
  const launch = puppeteer.default?.launch ?? puppeteer.launch;
  const browser = await launch.call(puppeteer.default ?? puppeteer, {
    executablePath: target.executablePath,
    headless: options.headless ?? false,
    args: target.args,
    defaultViewport: { width: 1440, height: 1200, deviceScaleFactor: 1 },
  });

  const page = await browser.newPage();

  try {
    await page.setCookie(
      { name: "a1", value: cookies.a1, domain: ".xiaohongshu.com", path: "/" },
      { name: "web_session", value: cookies.web_session, domain: ".xiaohongshu.com", path: "/" },
      { name: "webId", value: cookies.webId ?? "", domain: ".xiaohongshu.com", path: "/" }
    );

    const publishPage = await openPublishPage(browser, page);
    await enterImageMode(publishPage);
    await uploadImages(publishPage, options.images);
    await fillTitle(publishPage, options.title);
    await fillBody(publishPage, options.body);
    await setPrivacy(publishPage, options.isPrivate ?? false);

    if (options.submit) {
      await clickPublish(publishPage);
      const submitted = await waitForPublishResult(publishPage);
      const result = {
        success: submitted.success,
        currentUrl: publishPage.url(),
        title: options.title,
        usedProfile: DEFAULT_PROFILE,
        headless: options.headless ?? false,
        noteId: submitted.noteId,
        noteUrl: submitted.noteUrl,
        requiresManualAction: !submitted.success,
        message: submitted.message,
      };
      await browser.close();
      return result;
    }

    const result = {
      success: false,
      currentUrl: publishPage.url(),
      title: options.title,
      usedProfile: DEFAULT_PROFILE,
      headless: options.headless ?? false,
      requiresManualAction: true,
      message:
        "Browser editor opened and fields were filled. Final publish click is left for manual confirmation because Xiaohongshu may require captcha or additional review.",
    };
    if (options.headless ?? false) {
      await browser.close();
    }
    return result;
  } catch (err) {
    await browser.close();
    throw err;
  }
}
