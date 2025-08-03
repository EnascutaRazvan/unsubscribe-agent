// lib/server/unsubscribe-agent.ts

import { generateText } from "ai"
import { groq } from "@ai-sdk/groq"
import { chromium, type Browser } from "playwright" // ✔️ Playwright not puppeteer

interface UnsubscribeLink {
    url: string
    text: string
    method: "GET" | "POST"
}

interface UnsubscribeResult {
    success: boolean
    method: string
    error?: string
    details?: string
    screenshot?: string
}

export class UnsubscribeAgent {
    private model = groq("llama-3.3-70b-versatile")

    async extractUnsubscribeLinks(emailContent: string): Promise<UnsubscribeLink[]> {
        try {
            console.log("TREBUIE SA VAD COND", emailContent)
            const { text } = await generateText({
                model: this.model,
                prompt: `
You are an AI language model that helps identify unsubscribe links in emails written in any language.

First, detect the language of the email content.
Then, extract all unsubscribe-related links based on common patterns and language understanding.

Look for:
- Links with text or surrounding content indicating unsubscribe actions (e.g., "unsubscribe", "opt out", "stop emails", or their equivalents in other languages like "darse de baja", "désabonner", "dezabonare")
- "mailto:" links with unsubscribe intent
- Footer links or links placed at the end of the message

Email content:
${emailContent}

Return a strict JSON array of objects like:
[
  {
    "url": "full URL",
    "text": "link text or description",
    "method": "GET" or "POST"
  }
]

If no unsubscribe links are found, return an empty array [].
DO NOT return any explanation or formatting, only valid JSON.
`,

            })

            try {
                return Array.isArray(JSON.parse(text)) ? JSON.parse(text) : []
            } catch {
                return this.fallbackLinkExtraction(emailContent)
            }
        } catch {
            return this.fallbackLinkExtraction(emailContent)
        }
    }

    private fallbackLinkExtraction(emailContent: string): UnsubscribeLink[] {
        const links: UnsubscribeLink[] = []
        const patterns = [
            /https?:\/\/[^\s<>"]+unsubscribe[^\s<>"]*/gi,
            /https?:\/\/[^\s<>"]+opt-out[^\s<>"]*/gi,
            /https?:\/\/[^\s<>"]+remove[^\s<>"]*/gi,
            /mailto:[^\s<>"]+\?subject=[^\s<>"]*unsubscribe[^\s<>"]*/gi,
        ]

        for (const pattern of patterns) {
            const matches = emailContent.match(pattern)
            if (matches) {
                for (const url of matches) {
                    links.push({ url, text: "Unsubscribe", method: "GET" })
                }
            }
        }

        return links
    }

    async processUnsubscribe(link: UnsubscribeLink): Promise<UnsubscribeResult> {
        let browser: Browser | null = null

        try {
            if (link.url.startsWith("mailto:")) {
                return {
                    success: true,
                    method: "mailto",
                    details: `Unsubscribe email would be sent to: ${link.url}`,
                }
            }

            browser = await chromium.launch({ headless: true })
            const context = await browser.newContext()
            const page = await context.newPage()

            await page.goto(link.url, { waitUntil: "networkidle", timeout: 30000 })

            const screenshot = await page.screenshot({ type: "png", fullPage: true })
            const pageText = await page.content()

            const { text: analysisText } = await generateText({
                model: this.model,
                prompt: `
            You are an AI agent helping a user unsubscribe from an email list.

            This unsubscribe page may be in any language. First, detect the language and interpret the page accordingly.

            Page URL: ${link.url}

            Here is the rendered HTML content (partial):
            ${pageText.substring(pageText.length / 3)}

            Your goal:
            - Identify what needs to be done to complete the unsubscription.
            - Support multilingual pages.
            - Extract actionable elements (buttons, inputs, dropdowns).
            - Identify if the user is already unsubscribed.

            Return ONLY a single JSON object in this format, with no extra commentary or formatting:

            {
              "action": "CLICK_BUTTON|FILL_FORM|EMAIL_CONFIRMATION|CAPTCHA_REQUIRED|ALREADY_UNSUBSCRIBED|ERROR",
              "elements": [
                {
                  "type": "button|input|select|checkbox",
                  "selector": "CSS selector or description",
                  "action": "click|type|select",
                  "value": "value to use (optional)"
                }
              ],
              "confidence": 0.0-1.0,
              "message": "Short summary of what was found and what action is needed"
            }

            Make sure the JSON is syntactically correct. If you cannot determine what to do, return action "ERROR".
`,
            })

            console.log(analysisText);
            let analysis

            try {
                analysis = JSON.parse(analysisText)
            } catch {
                return { success: false, method: "ERROR", error: "Invalid AI response" }
            }

            let success = false
            let details = analysis.message

            if (analysis.action === "ALREADY_UNSUBSCRIBED") {
                success = true
            } else if (analysis.elements?.length) {
                for (const el of analysis.elements) {
                    try {
                        if (el.action === "click") {
                            await page.click(el.selector)
                        } else if (el.action === "type") {
                            await page.fill(el.selector, el.value)
                        } else if (el.action === "select") {
                            await page.selectOption(el.selector, el.value)
                        }
                    } catch (err) {
                        console.error("Action failed:", err)
                    }
                }

                success = true
                details = "Actions executed based on AI instructions"
            }

            return {
                success,
                method: analysis.action,
                details,
                screenshot: `data:image/png;base64,${screenshot.toString("base64")}`,
            }
        } catch (err) {
            return {
                success: false,
                method: "ERROR",
                error: (err as Error).message,
            }
        } finally {
            if (browser) await browser.close()
        }
    }

    async unsubscribeFromEmail(emailContent: string): Promise<{
        success: boolean
        results: Array<{ link: UnsubscribeLink; result: UnsubscribeResult }>
        summary: string
    }> {
        const links = await this.extractUnsubscribeLinks(emailContent)

        console.log("LINKKKKKK", links);
        const results = []
        let successCount = 0

        for (const link of links) {
            const result = await this.processUnsubscribe(link)
            results.push({ link, result })
            if (result.success) successCount++
        }

        return {
            success: successCount > 0,
            results,
            summary: `Processed ${links.length} unsubscribe links, ${successCount} successful`,
        }
    }
}
