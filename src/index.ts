import express from "express"
import cors from "cors"
import { UnsubscribeAgent } from "./agent.js"
import dotenv from "dotenv"


const app = express()
const agent = new UnsubscribeAgent()
dotenv.config()

app.use(cors())
app.use(express.json())

app.post("/unsubscribe", async (req, res) => {
    const { emailContent } = req.body

    if (!emailContent) {
        return res.status(400).json({ error: "Missing email content" })
    }

    try {
        const result = await agent.unsubscribeFromEmail(emailContent)
        res.json(result)
    } catch (error) {
        console.error(error)
        res.status(500).json({ error: "Internal error" })
    }
})

const PORT = process.env.PORT || 3001
app.listen(PORT, () => {
    console.log(`🚀 Server ready at http://localhost:${PORT}`)
})
