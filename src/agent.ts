// agent.ts — Unsubscribe agent with improved logging, resilient CAPTCHA handling,
// and robust cookie-consent handling (CMP-aware, iframe-aware, with settle waits)

import { chromium, type Page, type Browser, type BrowserContext, type Frame } from "playwright";
import { generateText } from "ai";
import { groq } from "@ai-sdk/groq";
import { openai } from "@ai-sdk/openai";

// -------------------- Types --------------------

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
    startedAt?: string;
    finishedAt?: string;
    durationMs?: number;
}

type LogLevel =
    | "debug"
    | "info"
    | "success"
    | "warn"
    | "error"
    | "ai"
    | "cookie"
    | "captcha"
    | "network";

interface LogEntry {
    timestamp: string;
    level: LogLevel;
    message: string;
    context?: Record<string, unknown>;
    runId?: string;
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
    runId?: string;
    jsonlLogs?: string; // Optional JSONL export of logs for storage/telemetry
}

// -------------------- Tunables --------------------

const MAX_STEPS = 5;
const PLAN_PARSE_RETRIES = 2;

// CAPTCHA grace window: how long we’ll wait & recheck before giving up
const CAPTCHA_MAX_GRACE_MS = 45_000;
const CAPTCHA_RECHECK_INTERVAL_MS = 4_000;

// General timing jitter range (ms) to look less robotic
const MIN_JITTER_MS = 120;
const MAX_JITTER_MS = 450;

// Navigation and action timeouts (ms)
const NAV_TIMEOUT = 30_000;
const ACTION_TIMEOUT = 8_000;

// -------------------- Known phrases --------------------

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
    "thank you for unsubscribing",
    "unsubscribe successfully",
    "unsubscribed successfully",
    // extra variants
    "subscription updated",
    "opt-out confirmed",
    "preferences saved",
    "email preferences updated"
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
    "something went wrong",
    "access denied",
    "blocked due to unusual activity"
];

// -------------------- Logger --------------------

const colors = {
    reset: "\x1b[0m",
    blue: "\x1b[34m",
    green: "\x1b[32m",
    yellow: "\x1b[33m",
    red: "\x1b[31m",
    magenta: "\x1b[35m",
    cyan: "\x1b[36m",
    gray: "\x1b[90m"
};

class Logger {
    private logs: LogEntry[] = [];
    constructor(private runId: string) { }

    private colorFor(level: LogLevel) {
        switch (level) {
            case "error":
                return colors.red;
            case "warn":
                return colors.yellow;
            case "success":
                return colors.green;
            case "ai":
                return colors.magenta;
            case "cookie":
                return colors.cyan;
            case "captcha":
                return colors.yellow;
            case "network":
                return colors.gray;
            case "debug":
                return colors.gray;
            default:
                return colors.blue;
        }
    }

    log(level: LogLevel, message: string, context?: Record<string, unknown>) {
        const entry: LogEntry = {
            timestamp: new Date().toISOString(),
            level,
            message,
            context,
            runId: this.runId
        };
        this.logs.push(entry);

        const color = this.colorFor(level);
        const ctx =
            context && Object.keys(context).length
                ? ` ${colors.gray}${JSON.stringify(context)}${colors.reset}`
                : "";
        console.log(color, `[${level}]`, message, ctx, colors.reset);
    }

    getEntries() {
        return this.logs;
    }

    toJSONL(): string {
        return this.logs.map((l) => JSON.stringify(l)).join("\n");
    }
}

// -------------------- Helpers --------------------

function jitter(ms: number) {
    const extra = Math.floor(Math.random() * (MAX_JITTER_MS - MIN_JITTER_MS + 1)) + MIN_JITTER_MS;
    return ms + extra;
}

function sleep(ms: number) {
    return new Promise((res) => setTimeout(res, ms));
}

function randFrom<T>(arr: T[]) {
    return arr[Math.floor(Math.random() * arr.length)];
}

const userAgents = [
    // A few realistic UAs (desktop)
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15",
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
];

// -------------------- CAPTCHA detection & waiting --------------------

async function hasCaptcha(page: Page, log: Logger): Promise<boolean> {
    const bodyText = ((await page.textContent("body")) || "").toLowerCase();

    const textHit =
        bodyText.includes("verify you are human") ||
        (bodyText.includes("cloudflare") && bodyText.includes("security of your connection")) ||
        bodyText.includes("needs to review the security") ||
        bodyText.includes("complete the action below") ||
        bodyText.includes("please complete the captcha") ||
        bodyText.includes("press and hold") ||
        bodyText.includes("select all images");

    if (textHit) {
        log.log("captcha", "Detected CAPTCHA by body text.");
        return true;
    }

    const challenge = await page.$(
        [
            '[id*="cf-challenge"]',
            '[class*="cf-challenge"]',
            '[id*="captcha"]',
            '[class*="captcha"]',
            '[class*="cloudflare"]',
            '[id*="cloudflare"]',
            'iframe[src*="captcha"]',
            'iframe[src*="hcaptcha"]',
            'iframe[src*="recaptcha"]',
            'iframe[src*="turnstile"]'
        ].join(",")
    );
    if (challenge) {
        log.log("captcha", "Detected CAPTCHA by challenge/container/iframe.");
        return true;
    }

    const widget = await page.$('div:has-text("Cloudflare")');
    if (widget) {
        log.log("captcha", "Detected CAPTCHA by Cloudflare branding.");
        return true;
    }

    return false;
}

async function waitOutCaptchaIfPresent(page: Page, log: Logger): Promise<boolean> {
    // Returns true if CAPTCHA cleared during grace window; false if still present after waiting
    if (!(await hasCaptcha(page, log))) return true;

    log.log("captcha", "CAPTCHA detected. Waiting to see if it clears automatically.", {
        graceMs: CAPTCHA_MAX_GRACE_MS
    });

    const start = Date.now();
    let attempt = 0;

    while (Date.now() - start < CAPTCHA_MAX_GRACE_MS) {
        attempt++;

        // Light, human-like interactions (no DOM types)
        try {
            await page.mouse.move(
                10 + Math.random() * 300,
                10 + Math.random() * 200,
                { steps: 8 }
            );
            await page.keyboard.down("Shift");
            await sleep(30);
            await page.keyboard.up("Shift");

            // Gentle scroll nudge using Playwright mouse wheel (avoids window/ScrollBehavior)
            await page.mouse.wheel(0, 120 + Math.floor(Math.random() * 200));
        } catch {
            // ignore minor failures
        }

        await sleep(jitter(CAPTCHA_RECHECK_INTERVAL_MS));

        if (!(await hasCaptcha(page, log))) {
            log.log("captcha", "CAPTCHA no longer detected; proceeding.", { attempt });
            return true;
        }

        // On some sites, a reload helps after several seconds
        if (attempt % 3 === 0) {
            try {
                log.log("captcha", "Reloading page during CAPTCHA grace window.", { attempt });
                await page.reload({ waitUntil: "domcontentloaded" });
            } catch (e) {
                log.log("debug", "Reload during CAPTCHA wait failed (non-fatal).", {
                    error: (e as Error).message
                });
            }
        }
    }

    log.log("captcha", "CAPTCHA persisted after grace window.", { waitedMs: Date.now() - start });
    return false;
}

// -------------------- Page readiness helpers --------------------

async function waitForLoadSettled(page: Page, log: Logger, hardMs = 8000) {
    try {
        await Promise.race([
            page.waitForLoadState("load", { timeout: hardMs }).catch(() => undefined),
            page.waitForLoadState("domcontentloaded", { timeout: hardMs }).catch(() => undefined),
        ]);
        await page.waitForLoadState("networkidle", { timeout: 3500 }).catch(() => undefined);
    } catch { /* noop */ }
    await page.waitForTimeout(jitter(250));
}

async function frameHasCookieUi(frame: Frame): Promise<boolean> {
    const markers = [
        // Generic
        '[id*="cookie"]',
        '[class*="cookie"]',
        '[id*="consent"]',
        '[class*="consent"]',
        // CMPs
        "#onetrust-banner-sdk, .onetrust-pc-dark-filter, #onetrust-consent-sdk, #onetrust-accept-btn-handler",
        "#truste-consent-button, .truste_box_overlay, .trustarc-banner",
        "#CybotCookiebotDialog, #CybotCookiebotDialogBody",
        ".qc-cmp2-container, .qc-cmp2-summary",
        "[id^='sp_message_container_'], [id^='sp_message_iframe_'], #sp-cc, #sp-privacy-message",
        "[id^='didomi-'], .didomi-popup",
        "[data-testid='uc-accept-all-button'], #uc-center-container",
        "#cky-consent, #cookieyes-banner, #cookieyes-accept-all-btn",
        "#osano-cm, .osano-cm-window, #osano-accept-all",
        "[data-axeptio-component]"
    ];
    for (const sel of markers) {
        const loc = frame.locator(sel);
        if (await loc.first().isVisible().catch(() => false)) return true;
    }
    return false;
}

// -------------------- Cookie consent (CMP-aware, iframe-aware) --------------------

type CookieOptions = { timeoutMs?: number };

async function acceptCookieBanners(page: Page, log: Logger, options: CookieOptions = {}): Promise<boolean> {
    const timeoutMs = options.timeoutMs ?? 15_000;
    const start = Date.now();
    let clickedAny = false;

    // Known CMP accept button selectors (prioritized)
    const ACCEPT_SELECTORS = [
        // OneTrust
        "#onetrust-accept-btn-handler, button#onetrust-accept-btn-handler, .ot-sdk-container button[aria-label*='Accept' i]",
        // TrustArc
        "#truste-consent-button, .truste_button_1, .truste-button1, #notice-ok",
        // Cookiebot
        "#CybotCookiebotDialogBodyLevelButtonAccept, #CybotCookiebotDialogBodyButtonAccept, #CybotCookiebotDialogBodyLevelButtonLevelOptinAllowAll",
        // Quantcast
        ".qc-cmp2-summary-buttons .qc-cmp2-summary-buttons-accept-all, .qc-cmp2-ui .qc-cmp2-summary-buttons .qc-cmp2-accept-all",
        // Didomi
        "#didomi-notice-agree-button, [data-didomi-translate='notice.agree_button']",
        // Sourcepoint
        "#sp-accept, button[aria-label*='Accept All' i], .sp_choice_type_11, .sp_accepted",
        // Usercentrics
        "button[data-testid='uc-accept-all-button'], #uc-accept-all, button:has-text('Accept all')",
        // CookieYes
        "#cookieyes-accept-all-btn, #cky-consent button.cky-btn-accept",
        // Osano
        "#osano-accept-all, .osano-cm-accept-all",
        // Axeptio (approx)
        "button:has-text('Accept all'), button[aria-label*='Accept' i]",
    ];

    // Generic fallbacks by role/text
    const GENERIC_BUTTON_TEXT = /(accept|agree|allow|continue|ok|okay|got it|yes|save & accept|accept all|i agree)/i;

    while (Date.now() - start < timeoutMs) {
        let didClickThisRound = false;

        const frames = page.frames();
        for (const frame of frames) {
            try {
                // 1) Known selectors first
                const known = frame.locator(ACCEPT_SELECTORS.join(", "));
                if (await known.first().isVisible({ timeout: 50 }).catch(() => false)) {
                    log.log("cookie", "Clicking known CMP accept button (selectors).");
                    await known.first().click({ timeout: ACTION_TIMEOUT });
                    didClickThisRound = true;
                } else {
                    // 2) Generic role/text fallback
                    const generic = frame.getByRole("button", { name: GENERIC_BUTTON_TEXT });
                    if (await generic.first().isVisible({ timeout: 50 }).catch(() => false)) {
                        const label = await generic.first().innerText().catch(() => "accept");
                        log.log("cookie", "Clicking generic cookie accept button.", { label });
                        await generic.first().click({ timeout: ACTION_TIMEOUT });
                        didClickThisRound = true;
                    }
                }

                // 3) After any click, wait for banner to disappear in this frame and page to settle
                if (didClickThisRound) {
                    clickedAny = true;
                    await waitForLoadSettled(page, log, 6000);

                    try {
                        const cookieSelectors = [
                            '[id*="cookie"]',
                            '[class*="cookie"]',
                            '[id*="consent"]',
                            '[class*="consent"]',
                            '#onetrust-banner-sdk',
                            '#CybotCookiebotDialog',
                            '.qc-cmp2-container',
                            "[id^='sp_message_container_']",
                            "[id^='didomi-']",
                            '#cky-consent',
                            '#osano-cm',
                        ];

                        await frame.waitForFunction(
                            (selectors) => {
                                const d = (globalThis as any).document; // avoid DOM typings requirement
                                if (!d) return true;
                                return !selectors.some((s) => d.querySelector(s));
                            },
                            cookieSelectors,
                            { timeout: 5000 }
                        ).catch(() => undefined);
                    } catch { /* ignore */ }
                }
            } catch { /* ignore frame-level errors */ }
        }

        if (!didClickThisRound) {
            const anyCookieUi = await Promise.all(page.frames().map((f) => frameHasCookieUi(f)));
            if (anyCookieUi.every((v) => v === false)) {
                await page.waitForTimeout(200);
                return clickedAny;
            }
        }

        if (didClickThisRound) continue;
        await page.waitForTimeout(200);
    }

    return clickedAny;
}

// -------------------- MAIN AGENT --------------------

export class UnsubscribeAgent {
    private model = openai("gpt-4.1-mini");
    private modelHtml = openai("o4-mini");
    private modelText = groq("llama-3.1-8b-instant");

    // ---------- Link extraction ----------

    async extractUnsubscribeLinks(html: string): Promise<UnsubscribeLink[]> {
        const logger = new Logger(`run_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`);
        try {
            const snippet = html.length > 5999 ? html.slice(-5999) : html;
            const prompt =
                `You are an AI that, given an arbitrary HTML email body as a string, ` +
                `identifies all links (href URLs) that allow a user to unsubscribe from further emails. ` +
                `Return a JSON array (no markdown/backticks) of objects: {url, text, method: GET|POST|MAILTO}.`;

            logger.log("ai", "[extractUnsubscribeLinks] Sending to AI...");
            const { text } = await generateText({
                model: this.model,
                prompt: `${prompt}\n\nHTML_SNIPPET:\n${snippet}`
            });
            logger.log("ai", "[extractUnsubscribeLinks] AI Response", { preview: text.slice(0, 240) });

            let parsed: any[] = [];
            try {
                parsed = JSON.parse(text);
            } catch (e) {
                logger.log("warn", "[extractUnsubscribeLinks] AI JSON parse failed; falling back to regex.", {
                    error: (e as Error).message
                });
                // Light fallback: scan hrefs containing 'unsubscribe'
                const matches = Array.from(
                    new Set(
                        Array.from(snippet.matchAll(/href\s*=\s*["']([^"']+)["']/gi))
                            .map((m) => m[1])
                            .filter((u) => /unsub|opt-?out|preferences/i.test(u))
                    )
                );
                parsed = matches.map((url) => ({
                    url,
                    text: "Unsubscribe",
                    method: url.startsWith("mailto:") ? "MAILTO" : "GET"
                }));
            }

            logger.log("success", `[extractUnsubscribeLinks] Extracted ${Array.isArray(parsed) ? parsed.length : 0} links`);
            return Array.isArray(parsed) ? (parsed as UnsubscribeLink[]) : [];
        } catch (err) {
            console.error(colors.red, "AI extraction failed:", (err as any).message, colors.reset);
            return [];
        }
    }

    // ---------- Core flow ----------

    async processUnsubscribe(link: UnsubscribeLink): Promise<UnsubscribeResult> {
        const runId = `run_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
        const log = new Logger(runId);
        const steps: ActionStep[] = [];
        let browser: Browser | null = null;
        let context: BrowserContext | null = null;

        log.log("info", `[processUnsubscribe] Starting on link`, { url: link.url, method: link.method });

        if (link.method === "MAILTO") {
            log.log("success", `[processUnsubscribe] MAILTO detected`, { url: link.url });
            return {
                success: true,
                method: "MAILTO",
                details: `Send email to ${link.url}`,
                logs: log.getEntries(),
                jsonlLogs: log.toJSONL(),
                runId
            };
        }

        try {
            const userAgent = randFrom(userAgents);
            const viewport = { width: 1200 + Math.floor(Math.random() * 240), height: 800 + Math.floor(Math.random() * 200) };

            browser = await chromium.launch({ headless: true });
            context = await browser.newContext({
                userAgent,
                viewport,
                javaScriptEnabled: true,
                acceptDownloads: false
            });

            // Observe page events
            context.on("page", (p) => {
                p.on("console", (msg) => {
                    try {
                        log.log("debug", `browser console: ${msg.type()}`, { text: msg.text().slice(0, 300) });
                    } catch { }
                });
                p.on("response", (resp) => {
                    const status = resp.status();
                    if (status >= 400) {
                        log.log("network", "HTTP error response", { url: resp.url(), status });
                    }
                });
            });

            const page = await context.newPage();

            log.log("info", `[processUnsubscribe] Navigating`, { url: link.url });
            await page.goto(link.url, { waitUntil: "domcontentloaded", timeout: NAV_TIMEOUT });

            // --- Improved cookie handling on load ---
            const cookieAccepted = await acceptCookieBanners(page, log, { timeoutMs: 15000 });
            if (cookieAccepted) {
                log.log("cookie", "Cookie banner handled on load; waiting for page to settle.");
                await waitForLoadSettled(page, log);
            }

            // CAPTCHA grace handling (do NOT fail immediately)
            const captchaCleared = await waitOutCaptchaIfPresent(page, log);
            if (!captchaCleared) {
                const screenshot = await page.screenshot({ fullPage: true });
                return {
                    success: false,
                    method: "AUTOMATED",
                    captchaBlocked: true,
                    details: "CAPTCHA persisted after grace window. Manual intervention likely required.",
                    steps,
                    screenshot: `data:image/png;base64,${screenshot.toString("base64")}`,
                    logs: log.getEntries(),
                    jsonlLogs: log.toJSONL(),
                    runId
                };
            }

            // Helper: perform an action; if intercepted by cookie overlay, clear & retry once
            const performActionWithCookieRetry = async (act: ActionStep): Promise<{ ok: boolean; err?: string }> => {
                const performOnce = async () => {
                    switch (act.action) {
                        case "click":
                            await Promise.race([
                                page.waitForNavigation({ timeout: jitter(5000) }).catch(() => undefined),
                                page.click(act.selector, { timeout: ACTION_TIMEOUT })
                            ]);
                            break;
                        case "type":
                            await page.fill(act.selector, act.value ?? "", { timeout: ACTION_TIMEOUT });
                            break;
                        case "select":
                            await page.selectOption(act.selector, act.value ?? "");
                            break;
                        case "check":
                            await page.check(act.selector, { timeout: ACTION_TIMEOUT });
                            break;
                        case "scroll": {
                            const el = await page.$(act.selector);
                            if (el) await el.scrollIntoViewIfNeeded();
                            break;
                        }
                        case "wait":
                            await page.waitForSelector(act.selector, { timeout: Math.max(ACTION_TIMEOUT, 10_000) });
                            break;
                        default:
                            throw new Error("Unknown action: " + act.action);
                    }
                };

                try {
                    await performOnce();
                    await page.waitForTimeout(jitter(420));
                    return { ok: true };
                } catch (e: any) {
                    const msg = (e?.message || "").toLowerCase();
                    const looksOverlay =
                        msg.includes("not visible") ||
                        msg.includes("not receiv") ||
                        msg.includes("intercepted") ||
                        msg.includes("timeout") ||
                        msg.includes("element is outside") ||
                        msg.includes("detached from dom");
                    if (looksOverlay) {
                        log.log("cookie", "Action failed; attempting to clear cookie banner and retry once.", { action: act.action });
                        const cleared = await acceptCookieBanners(page, log, { timeoutMs: 7000 });
                        if (cleared) {
                            await waitForLoadSettled(page, log, 4000);
                            try {
                                await performOnce();
                                await page.waitForTimeout(jitter(420));
                                log.log("success", `[processUnsubscribe] Step success after cookie retry`, { action: act.action });
                                return { ok: true };
                            } catch (e2: any) {
                                return { ok: false, err: e2?.message || String(e2) };
                            }
                        }
                    }
                    return { ok: false, err: e?.message || String(e) };
                }
            };

            // Main step loop
            let stepCount = 0;
            let isDone = false;
            let lastHtml = await page.content();
            let lastResult = "";

            while (stepCount < MAX_STEPS && !isDone) {
                log.log("ai", `[processUnsubscribe] Asking AI for next actions`, { step: stepCount + 1 });

                const planPrompt = `
You are an expert unsubscribe bot controlling a browser.
Given the HTML below, propose multiple next actions to unsubscribe.
JSON format only (no markdown or any backticks or any format, just a valid JSON format):
{ actions: [{ action, selector, value?, description? }], finish: boolean }

HTML:
${lastHtml}
URL: ${link.url}
RESULT: ${lastResult}
`;

                // Parse with small retries
                let plan: { actions?: any[]; finish?: boolean } | null = null;
                for (let r = 0; r <= PLAN_PARSE_RETRIES; r++) {
                    try {
                        const { text } = await generateText({ model: this.modelHtml, prompt: planPrompt });
                        log.log("ai", `[processUnsubscribe] AI Plan`, { preview: text.slice(0, 260) });
                        plan = JSON.parse(text);
                        break;
                    } catch (e) {
                        if (r < PLAN_PARSE_RETRIES) {
                            log.log("warn", "AI plan JSON parse failed; retrying.", {
                                attempt: r + 1,
                                error: (e as Error).message
                            });
                            await sleep(jitter(400));
                        } else {
                            log.log("error", "AI plan JSON parse failed; no more retries.", {
                                error: (e as Error).message
                            });
                            throw new Error("Invalid AI plan JSON");
                        }
                    }
                }

                for (const act of plan?.actions || []) {
                    const step: ActionStep = {
                        ...act,
                        startedAt: new Date().toISOString()
                    };
                    const t0 = Date.now();

                    try {
                        log.log("info", `[processUnsubscribe] Executing`, { action: act.action, selector: act.selector });

                        const result = await performActionWithCookieRetry(act);

                        if (result.ok) {
                            step.result = "success";
                            log.log("success", `[processUnsubscribe] Step success`, { action: act.action });
                            lastResult = "success";
                        } else {
                            step.error = result.err || "unknown error";
                            lastResult = "error: " + step.error;
                            log.log("error", `[processUnsubscribe] Step failed`, {
                                action: act.action,
                                error: step.error
                            });
                        }
                    } finally {
                        step.finishedAt = new Date().toISOString();
                        step.durationMs = Date.now() - t0;
                        steps.push(step);
                    }
                }

                await page.waitForTimeout(jitter(800));
                lastHtml = await page.content();

                // Re-check cookie banners that might reappear
                const cookieAcceptedAgain = await acceptCookieBanners(page, log, { timeoutMs: 7000 });
                if (cookieAcceptedAgain) {
                    log.log("cookie", "Cookie banner reappeared mid-flow; handled and letting page settle.");
                    await waitForLoadSettled(page, log, 5000);
                }

                // Re-check CAPTCHA; wait briefly if it pops mid-flow
                const clearedAgain = await waitOutCaptchaIfPresent(page, log);
                if (!clearedAgain) {
                    const screenshot = await page.screenshot({ fullPage: true });
                    return {
                        success: false,
                        method: "AUTOMATED",
                        captchaBlocked: true,
                        details: "CAPTCHA appeared mid-flow and persisted after grace window.",
                        steps,
                        screenshot: `data:image/png;base64,${screenshot.toString("base64")}`,
                        logs: log.getEntries(),
                        jsonlLogs: log.toJSONL(),
                        runId
                    };
                }

                // Success / failure phrase heuristic
                const pageText = ((await page.textContent("body")) || "").toLowerCase();
                const hasSuccess = knownSuccessPhrases.some((p) => pageText.includes(p));
                const hasFailure = knownFailurePhrases.some((p) => pageText.includes(p));

                if (plan?.finish || hasSuccess) {
                    log.log("success", `[processUnsubscribe] Finish triggered`, {
                        by: plan?.finish ? "AI plan" : "success phrase"
                    });
                    isDone = true;
                    break;
                }

                if (hasFailure && !hasSuccess) {
                    const screenshot = await page.screenshot({ fullPage: true });
                    log.log("warn", `[processUnsubscribe] Failure phrase detected without success; stopping.`);
                    return {
                        success: false,
                        method: "AUTOMATED",
                        details: "Failure phrase detected and no success confirmation.",
                        steps,
                        screenshot: `data:image/png;base64,${screenshot.toString("base64")}`,
                        logs: log.getEntries(),
                        jsonlLogs: log.toJSONL(),
                        runId
                    };
                }

                stepCount++;
            }

            const screenshot = await page.screenshot({ fullPage: true });
            return {
                success: true,
                method: "AUTOMATED",
                details: "Unsubscribe completed",
                steps,
                screenshot: `data:image/png;base64,${screenshot.toString("base64")}`,
                logs: log.getEntries(),
                jsonlLogs: log.toJSONL(),
                runId
            };
        } catch (err: any) {
            const screenshot = (await (async () => {
                try {
                    if (context) {
                        const pages = context.pages();
                        if (pages[0]) {
                            const buf = await pages[0].screenshot({ fullPage: true });
                            return `data:image/png;base64,${buf.toString("base64")}`;
                        }
                    }
                } catch { }
                return undefined;
            })()) as string | undefined;

            log.log("error", `[processUnsubscribe] Error`, { error: err.message });
            return {
                success: false,
                method: "ERROR",
                error: err.message,
                steps,
                screenshot,
                logs: log.getEntries(),
                jsonlLogs: log.toJSONL(),
                runId
            };
        } finally {
            try {
                if (context) await context.close();
            } catch { }
            try {
                if (browser) await browser.close();
            } catch { }
        }
    }

    // ---------- Orchestrator ----------

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
