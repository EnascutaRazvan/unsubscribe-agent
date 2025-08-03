# unsubscribe-agent

A Node.js service that automatically extracts and follows unsubscribe links from email HTML content using AI-driven analysis (OpenAI + GROQ) and browser automation (Playwright).

---

## Table of Contents

- [Features](#features)
- [Prerequisites](#prerequisites)
- [Installation](#installation)
- [Configuration](#configuration)
- [Usage](#usage)
  - [Development](#development)
  - [Building](#building)
  - [Running](#running)
- [API Endpoints](#api-endpoints)
- [Environment Variables](#environment-variables)
- [License](#license)

---

## Features

- Parses HTML email content to find unsubscribe links.
- Uses GPT to identify the most likely unsubscribe link via GROQ.
- Automates browser navigation to the unsubscribe page via Playwright.
- Logs success/failure and captures screenshots for reporting.

## Prerequisites

- Node.js v18+
- pnpm or npm
- A GitHub account for Playwright dependencies (optional)

## Installation

1. Clone the repository:
   ```bash
   git clone https://github.com/EnascutaRazvan/unsubscribe-agent.git
   cd unsubscribe-agent
   ```
2. Install dependencies:
   ```bash
   pnpm install
   ```

## Configuration

Create a `.env` file in the project root with the following variables:

```env
OPENAI_API_KEY=your_openai_api_key
GROQ_API_KEY=your_groq_api_key
PLAYWRIGHT_BROWSERS_PATH=0
```

## Usage

### Development

```bash
pnpm dev
```

### Building

```bash
pnpm build
```

### Running

```bash
pnpm start
```

## API Endpoints

- `POST /unsubscribe`
  - Request body:
    ```json
    {
      "emailId": "string",
      "htmlContent": "string"
    }
    ```
  - Response:
    ```json
    {
      "success": true,
      "unsubscribeUrl": "string",
      "screenshot": "base64-image"
    }
    ```

## Environment Variables

| Variable               | Description                          |
| ---------------------- | ------------------------------------ |
| `OPENAI_API_KEY`       | API key for OpenAI                   |
| `GROQ_API_KEY`         | API key for GROQ                     |
| `PLAYWRIGHT_BROWSERS_PATH` | Set to `0` to use bundled browsers |

