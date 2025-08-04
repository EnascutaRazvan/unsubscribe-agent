import { chromium, type Page, type Browser } from "playwright";
import { generateText } from "ai";
import { groq } from "@ai-sdk/groq";
import { openai } from "@ai-sdk/openai";

interface UnsubscribeLink {
    url: string;
    text: string;
    method: "GET" | "POST" | "MAILTO";
}

interface ActionStep {
    action: string;
    selector: string;
    value?: string;
    description?: string;
    result?: string;
    error?: string;
}

type LogLevel = "info" | "success" | "warn" | "error" | "ai" | "cookie";
interface LogEntry {
    timestamp: string;
    message: string;
    level: LogLevel;
}

interface UnsubscribeResult {
    success: boolean;
    method: string;
    error?: string;
    details?: string;
    captchaBlocked?: boolean;
    steps?: ActionStep[];
    screenshot?: string;
    logs?: LogEntry[];
}

const MAX_STEPS = 10;

const knownSuccessPhrases = [
    "you have been unsubscribed",
    "successfully unsubscribed",
    "your preferences have been updated",
    "we're sorry to see you go",
    "we have removed your email",
    "you are now unsubscribed",
    "unsubscribed from future emails",
    "we've removed your address",
    "your email has been removed",
    "thank you for unsubscribing"
];

const knownFailurePhrases = [
    "captcha required",
    "please complete the captcha",
    "verify you are human",
    "please solve the captcha",
    "unsubscribe failed",
    "error occurred",
    "we could not unsubscribe you",
    "try again later",
    "something went wrong"
];

// ---- LOGGING ----
const colors = {
    reset: "\x1b[0m",
    blue: "\x1b[34m",
    green: "\x1b[32m",
    yellow: "\x1b[33m",
    red: "\x1b[31m",
    magenta: "\x1b[35m",
    cyan: "\x1b[36m"
};

function addLog(logs: LogEntry[], message: string, level: LogLevel = "info") {
    logs.push({ timestamp: new Date().toISOString(), message, level });
    // Print to console for backend debugging
    const color =
        level === "error"
            ? colors.red
            : level === "warn"
                ? colors.yellow
                : level === "success"
                    ? colors.green
                    : level === "ai"
                        ? colors.magenta
                        : level === "cookie"
                            ? colors.cyan
                            : colors.blue;
    console.log(color, `[${level}]`, message, colors.reset);
}

// ---- CAPTCHA DETECTION ----
async function hasCaptcha(page: Page, logs: LogEntry[]): Promise<boolean> {
    const html = await page.content();
    const bodyText = (await page.textContent('body'))?.toLowerCase() || "";

    // 1. Simple text heuristics
    if (
        bodyText.includes("verify you are human") ||
        (bodyText.includes("cloudflare") && bodyText.includes("security of your connection")) ||
        bodyText.includes("needs to review the security") ||
        bodyText.includes("complete the action below")
    ) {
        addLog(logs, "Detected CAPTCHA by body text.", "error");
        return true;
    }

    // 2. Look for known Cloudflare/CAPTCHA containers
    const challenge = await page.$('[id*="cf-challenge"], [class*="cf-challenge"], [id*="captcha"], [class*="captcha"], [class*="cloudflare"], [id*="cloudflare"]');
    if (challenge) {
        addLog(logs, "Detected CAPTCHA by challenge container.", "error");
        return true;
    }

    // 3. Look for CAPTCHA iframes (Cloudflare, Google, hCaptcha)
    const iframes = await page.$$('iframe');
    for (const iframe of iframes) {
        const src = await iframe.getAttribute('src');
        if (src && (
            src.includes('cloudflare') ||
            src.includes('captcha') ||
            src.includes('hcaptcha') ||
            src.includes('recaptcha')
        )) {
            addLog(logs, "Detected CAPTCHA by iframe src: " + src, "error");
            return true;
        }
    }

    // 4. Look for Cloudflare widget by branding
    const widget = await page.$('div:has-text("Cloudflare")');
    if (widget) {
        addLog(logs, "Detected CAPTCHA by Cloudflare branding.", "error");
        return true;
    }

    return false;
}

// ---- COOKIE CONSENT HANDLER ----
async function clickCookieConsent(page: Page, logs: LogEntry[]): Promise<boolean> {
    const selectors = [
        '[id*="cookie"] button',
        '[class*="cookie"] button',
        '[id*="consent"] button',
        '[class*="consent"] button',
        'button',
        'input[type="button"]',
        'input[type="submit"]'
    ];
    const positiveWords = [
        'accept', 'agree', 'allow', 'confirm', 'understand', 'ok', 'yes', 'continue', 'got it'
    ];

    for (const sel of selectors) {
        const buttons = await page.$$(sel);
        for (const btn of buttons) {
            // Prefer visible
            const visible = await btn.isVisible();
            if (!visible) continue;
            const text = ((await btn.textContent()) || '').toLowerCase().trim();
            if (positiveWords.some(word => text.includes(word))) {
                addLog(logs, `[cookie] Clicking cookie/consent button: "${text}" via selector "${sel}"`, "cookie");
                await btn.click();
                return true;
            }
        }
    }
    return false;
}

// ---- MAIN AGENT ----
export class UnsubscribeAgent {
    private model = openai("gpt-4.1-mini");
    private modelText = groq("llama-3.1-8b-instant");

    async extractUnsubscribeLinks(html: string): Promise<UnsubscribeLink[]> {
        const logs: LogEntry[] = [];
        try {
            const snippet = html.length > 5999 ? html.slice(-5999) : html;
            const prompt = `You are an AI that, given an arbitrary HTML email body as a string, identifies all links (href URLs) that allow a user to unsubscribe from further emails. The email may be in any language or format. Return a JSON array of objects with keys {url, text, method} where 'method' is GET, POST, or MAILTO. If none are found, return an empty array. Only output valid JSON, without backticks or any formatting. Just the valid JSON as it is`;
            addLog(logs, "[extractUnsubscribeLinks] Sending to AI...", "ai");
            const { text } = await generateText({
                model: this.model,
                prompt: `${prompt}\n\nHTML_SNIPPET_LAST_5999_CHARS:\n${snippet}`
            });
            addLog(logs, "[extractUnsubscribeLinks] AI Response: " + text, "ai");
            const parsed = JSON.parse(text);
            addLog(logs, `[extractUnsubscribeLinks] Extracted ${Array.isArray(parsed) ? parsed.length : 0} links`, "success");
            return Array.isArray(parsed) ? parsed : [];
        } catch (err) {
            addLog(logs, "AI extraction failed: " + (err as any).message, "error");
            return [];
        }
    }

    async processUnsubscribe(link: UnsubscribeLink): Promise<UnsubscribeResult> {
        const logs: LogEntry[] = [];
        addLog(logs, `[processUnsubscribe] Starting on link: ${link.url}`, "info");
        if (link.method === "MAILTO") {
            addLog(logs, `[processUnsubscribe] MAILTO detected: ${link.url}`, "success");
            return { success: true, method: "MAILTO", details: `Send email to ${link.url}`, logs };
        }
        let browser: Browser | null = null;
        const steps: ActionStep[] = [];
        try {
            browser = await chromium.launch({ headless: true });
            const page = await browser.newPage();
            addLog(logs, `[processUnsubscribe] Navigating to: ${link.url}`, "info");
            await page.goto(link.url, { waitUntil: "domcontentloaded", timeout: 30000 });

            let stepCount = 0;
            let isDone = false;
            let lastHtml = await page.content();
            let lastResult = "";

            while (stepCount < MAX_STEPS && !isDone) {
                // Try to dismiss cookie/consent popup if present
                const cookieClicked = await clickCookieConsent(page, logs);
                if (cookieClicked) {
                    addLog(logs, "[cookie] Cookie/consent button clicked.", "success");
                    await page.waitForTimeout(800);
                    lastHtml = await page.content();
                }
                // CAPTCHA detection before each action
                if (await hasCaptcha(page, logs)) {
                    const screenshotBuf = await page.screenshot({ fullPage: true });
                    addLog(logs, `[processUnsubscribe] CAPTCHA detected before action, aborting.`, "error");
                    return {
                        success: false,
                        method: "AUTOMATED",
                        captchaBlocked: true,
                        details: "CAPTCHA challenge detected. Unsubscribe cannot be completed automatically. Manual intervention required.",
                        steps,
                        screenshot: `data:image/png;base64,${screenshotBuf.toString("base64")}`,
                        logs
                    };
                }

                addLog(logs, `[processUnsubscribe] Asking AI for next action (step ${stepCount + 1})...`, "ai");
                const planPrompt = `
You are an expert unsubscribe bot controlling a browser. 
Given this webpage HTML, suggest the next **single action** to advance the unsubscribe process, or say "finish" if unsubscribed.
Respond with a JSON like: 
{ action, selector, value, description, finish:boolean, successText: [..phrases..] }

HTML:\n${lastHtml}
LAST_RESULT: ${lastResult}
URL: ${link.url}
GOAL: Unsubscribe user from all emails.
`;
                const { text } = await generateText({
                    model: this.model,
                    prompt: planPrompt
                });

                addLog(logs, `[processUnsubscribe] AI Plan: ${text}`, "ai");
                let plan: any;
                try {
                    plan = JSON.parse(text);
                } catch {
                    addLog(logs, `[processUnsubscribe] LLM did not return valid JSON: ${text}`, "error");
                    throw new Error("LLM did not return valid JSON");
                }

                if (plan.finish) {
                    // Only finish if not CAPTCHA
                    if (await hasCaptcha(page, logs)) {
                        const screenshotBuf = await page.screenshot({ fullPage: true });
                        addLog(logs, `[processUnsubscribe] CAPTCHA detected at finish, aborting.`, "error");
                        return {
                            success: false,
                            method: "AUTOMATED",
                            details: "CAPTCHA detected at finish. Unsubscribe cannot be automated.",
                            captchaBlocked: true,
                            steps,
                            screenshot: `data:image/png;base64,${screenshotBuf.toString("base64")}`,
                            logs
                        };
                    }
                    addLog(logs, `[processUnsubscribe] AI signaled finish.`, "success");
                    isDone = true;
                    break;
                }

                // Try to execute step
                let step: ActionStep = { ...plan, error: undefined };
                try {
                    addLog(logs, `[processUnsubscribe] Executing action: ${plan.action} ${plan.selector} ${plan.value ? `(value: ${plan.value})` : ""}`, "info");
                    switch (plan.action) {
                        case "click":
                            await page.click(plan.selector, { timeout: 8000 });
                            break;
                        case "type":
                            await page.fill(plan.selector, plan.value || "", { timeout: 8000 });
                            break;
                        case "select":
                            await page.selectOption(plan.selector, plan.value || "");
                            break;
                        case "scroll":
                            await page.$eval(plan.selector, el => el.scrollIntoView());
                            break;
                        case "wait":
                            await page.waitForSelector(plan.selector, { timeout: 10000 });
                            break;
                        case "check":
                            await page.check(plan.selector);
                            break;
                        case "finish":
                            isDone = true;
                            break;
                        default:
                            addLog(logs, `[processUnsubscribe] Unknown action: ${plan.action}`, "warn");
                            throw new Error(`Unknown action: ${plan.action}`);
                    }
                    lastResult = "success";
                    addLog(logs, `[processUnsubscribe] Action succeeded: ${plan.action}`, "success");
                } catch (err: any) {
                    step.error = err.message;
                    lastResult = "error: " + err.message;
                    addLog(logs, `[processUnsubscribe] Action failed: ${plan.action} (${err.message})`, "error");
                }

                steps.push(step);
                lastHtml = await page.content();

                // CAPTCHA check again after action
                if (await hasCaptcha(page, logs)) {
                    const screenshotBuf = await page.screenshot({ fullPage: true });
                    addLog(logs, `[processUnsubscribe] CAPTCHA detected after action, aborting.`, "error");
                    return {
                        success: false,
                        method: "AUTOMATED",
                        details: "CAPTCHA detected after action. Unsubscribe cannot be automated.",
                        captchaBlocked: true,
                        steps,
                        screenshot: `data:image/png;base64,${screenshotBuf.toString("base64")}`,
                        logs
                    };
                }

                // Check for known success/failure phrases
                const pageText = (await page.textContent('body')) || "";
                if (
                    plan.successText &&
                    Array.isArray(plan.successText) &&
                    plan.successText.some((phrase: string) => pageText.toLowerCase().includes(phrase.toLowerCase()))
                ) {
                    addLog(logs, `[processUnsubscribe] Success phrase detected by AI.`, "success");
                    isDone = true;
                    break;
                }
                if (
                    knownSuccessPhrases.some(phrase => pageText.toLowerCase().includes(phrase)) &&
                    !(await hasCaptcha(page, logs))
                ) {
                    addLog(logs, `[processUnsubscribe] Known success phrase detected.`, "success");
                    isDone = true;
                    break;
                }
                if (knownFailurePhrases.some(phrase => pageText.toLowerCase().includes(phrase))) {
                    const screenshotBuf = await page.screenshot({ fullPage: true });
                    addLog(logs, `[processUnsubscribe] Failure phrase detected. Aborting.`, "error");
                    return {
                        success: false,
                        method: "AUTOMATED",
                        details: "Failure phrase detected. Unsubscribe not completed.",
                        steps,
                        screenshot: `data:image/png;base64,${screenshotBuf.toString("base64")}`,
                        logs
                    };
                }
                stepCount++;
            }

            // One last CAPTCHA check before reporting success
            if (await hasCaptcha(page, logs)) {
                const screenshotBuf = await page.screenshot({ fullPage: true });
                addLog(logs, `[processUnsubscribe] CAPTCHA detected at end. Aborting.`, "error");
                return {
                    success: false,
                    method: "AUTOMATED",
                    details: "CAPTCHA detected at end. Unsubscribe cannot be automated.",
                    captchaBlocked: true,
                    steps,
                    screenshot: `data:image/png;base64,${screenshotBuf.toString("base64")}`,
                    logs
                };
            }

            const screenshotBuf = await page.screenshot({ fullPage: true });
            if (isDone) {
                addLog(logs, `[processUnsubscribe] Unsubscribe process completed.`, "success");
            } else {
                addLog(logs, `[processUnsubscribe] Max steps reached; status unknown.`, "warn");
            }
            return {
                success: isDone,
                method: "AUTOMATED",
                details: isDone ? "Unsubscribe process completed" : "Max steps reached; status unknown",
                steps,
                screenshot: `data:image/png;base64,${screenshotBuf.toString("base64")}`,
                logs
            };
        } catch (err: any) {
            addLog(logs, `[processUnsubscribe] Error: ${(err as any).message}`, "error");
            return {
                success: false,
                method: "ERROR",
                error: err.message,
                steps,
                logs
            };
        } finally {
            if (browser) await browser.close();
        }
    }

    async unsubscribeFromHtml(html: string) {
        const links = await this.extractUnsubscribeLinks(html);
        const results: Array<{ link: UnsubscribeLink; result: UnsubscribeResult }> = [];
        let successCount = 0;

        for (const link of links) {
            const result = await this.processUnsubscribe(link);
            results.push({ link, result });
            if (result.success) successCount++;
        }

        return {
            success: successCount > 0,
            results,
            summary: `Processed ${links.length} links, ${successCount} successes`
        };
    }
}
