import express from "express";
import cors from "cors";
import { UnsubscribeAgent } from "./agent.js";
import dotenv from "dotenv";

dotenv.config();
const app = express();
const agent = new UnsubscribeAgent();

app.use(cors());
// JSON body parsing
app.use(express.json({ limit: "2mb" }));
// URL-encoded form parsing
app.use(express.urlencoded({ extended: true, limit: "2mb" }));
// Plain text / HTML body parsing
app.use(express.text({ type: ["text/plain", "text/html"], limit: "2mb" }));

/**
 * POST /unsubscribe
 * Accepts either JSON { htmlBody: string } or { emailContent: string } or raw HTML/text body
 */
app.post("/unsubscribe", async (req, res) => {
    // Determine HTML content from various possible body fields
    let htmlBody: string;

    if (typeof req.body === "string") {
        // raw text or HTML
        htmlBody = req.body;
    } else if (req.body.htmlBody) {
        htmlBody = req.body.htmlBody;
    } else if (req.body.emailContent) {
        htmlBody = req.body.emailContent;
    } else {
        return res.status(400).json({ error: "Missing htmlBody or emailContent" });
    }

    try {
        const result = await agent.unsubscribeFromHtml(htmlBody);
        res.json(result);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: "Internal server error" });
    }
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`🚀 Listening on port ${PORT}`));
