import { generateText } from "ai";
import { groq } from "@ai-sdk/groq";
import { openai } from "@ai-sdk/openai";
import { chromium, type Browser } from "playwright";
import { parse as parseHtml } from "node-html-parser";

interface UnsubscribeLink {
    url: string;
    text: string;
    method: "GET" | "POST" | "MAILTO";
}

interface UnsubscribeResult {
    success: boolean;
    method: string;
    error?: string;
    details?: string;
    screenshot?: string;
}

export class UnsubscribeAgent {
    // Leverage LLaMA model for full HTML string analysis
    private model = openai("gpt-4.1-nano");
    private modelText = groq("llama-3.1-8b-instant");

    /**
     * Use AI to analyze raw HTML string and extract unsubscribe links
     */
    async extractUnsubscribeLinks(html: string): Promise<UnsubscribeLink[]> {
        try {
            // truncate to last 5999 chars
            const snippet = html.length > 5999 ? html.slice(-5999) : html;
            const prompt = `You are an AI that, given an arbitrary HTML email body as a string, identifies all links (href URLs) that allow a user to unsubscribe from further emails. The email may be in any language or format. Return a JSON array of objects with keys {url, text, method} where 'method' is GET, POST, or MAILTO. If none are found, return an empty array. Only output valid JSON, without backticks or any formatting. Just the valid JSON as it is`;
            const { text } = await generateText({
                model: this.modelText,
                prompt: `${prompt}\n\nHTML_SNIPPET_LAST_5999_CHARS:\n${snippet}`
            });
            console.log("AI extract response:", text);
            const parsed = JSON.parse(text);
            return Array.isArray(parsed) ? parsed : [];
        } catch (err) {
            console.error("AI extraction failed:", err);
            return [];
        }
    }

    /**
     * Automate the unsubscribe process via Playwright and AI guidance
     */
    async processUnsubscribe(link: UnsubscribeLink): Promise<UnsubscribeResult> {
        let browser: Browser | null = null;
        try {
            if (link.method === "MAILTO") {
                return { success: true, method: "MAILTO", details: `Send email to ${link.url}` };
            }
            browser = await chromium.launch({ headless: true });
            const page = await browser.newPage();
            await page.goto(link.url, { waitUntil: "networkidle", timeout: 30000 });
            const pageHtml = await page.content();

            const actionPrompt = `You are an AI that identifies steps to unsubscribe on a webpage. Given the following HTML snippet, return a JSON object: { action: string, elements: [{type, selector, action, value?}], confidence: number, message: string }. Only output valid JSON without backticks or any formatting. Just the valid JSON as it is.`;
            const { text: planText } = await generateText({
                model: this.model,
                prompt: `${actionPrompt}\n\nURL: ${link.url}\nHTML:\n${pageHtml}`
            });
            const plan = JSON.parse(planText);

            if (Array.isArray(plan.elements)) {
                for (const el of plan.elements) {
                    try {
                        if (el.action === "click") await page.click(el.selector);
                        if (el.action === "type") await page.fill(el.selector, el.value || "");
                        if (el.action === "select") await page.selectOption(el.selector, el.value || "");
                    } catch (__) { }
                }
            }

            const screenshotBuf = await page.screenshot({ fullPage: true });
            const screenshot = `data:image/png;base64,${screenshotBuf.toString("base64")}`;

            return { success: true, method: plan.action, details: plan.message, screenshot };
        } catch (err: any) {
            return { success: false, method: "ERROR", error: err.message };
        } finally {
            if (browser) await browser.close();
        }
    }

    /**
     * Main flow: extract via AI and execute
     */
    async unsubscribeFromHtml(html: string) {
        const links = await this.extractUnsubscribeLinks(html);
        const results: Array<{ link: UnsubscribeLink; result: UnsubscribeResult }> = [];
        let successCount = 0;

        for (const link of links) {
            const result = await this.processUnsubscribe(link);
            results.push({ link, result });
            if (result.success) successCount++;
        }

        return { success: successCount > 0, results, summary: `Processed ${links.length} links, ${successCount} successes` };
    }
}