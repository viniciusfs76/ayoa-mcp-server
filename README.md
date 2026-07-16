# Ayoa MCP Server

Standalone Node.js MCP server exposing Ayoa mindmapping services as tools.

Repository: `https://github.com/viniciusfs76/ayoa-mcp-server`

## DevOps pipeline

GitHub Actions is configured in `.github/workflows/ci.yml`.

On every push or pull request to `main`, it runs:

1. Node.js 22 and 24 test matrix;
2. `npm ci` reproducible installation;
3. Node.js tests;
4. JavaScript syntax checks;
5. MCP Inspector `tools/list` contract verification;
6. high-severity production dependency audit;
7. package integrity check after tests pass.

The pipeline does not invoke Ayoa operations and does not require cookies. This avoids creating maps or artifacts in a real account.

Run the same checks locally:

```bash
npm ci
npm test
npm run verify:mcp
node --check server.js
node --check tools.js
node --check ayoa-client.js
npm audit --omit=dev --audit-level=high
```

## Tools

- `create_mindmap`
- `list_mindmaps`
- `get_mindmap`
- `import_opml`
- `list_presenter_slides`
- `prepare_presenter`
- `capture_slides`
- `make_video`

## Installation

```bash
npm install
```

Termux prerequisites:

```bash
command -v node
command -v ffmpeg
ls "$PREFIX/lib/chromium/headless_shell"
```

The server uses Node.js ESM, `@modelcontextprotocol/sdk`, `zod`, and `puppeteer-core`.

## Authentication

Ayoa operations use a local EditThisCookie JSON file. Never put cookie contents in MCP arguments, GitHub, or chat.

```bash
export AYOA_COOKIES_FILE="$HOME/.cookiesAyoa-domain.json"
chmod 600 "$AYOA_COOKIES_FILE"
```

The browser login sequence is:

```text
www.ayoa.com → inject cookies → app.ayoa.com → operation
```

If the session redirects to `auth.ayoa.com/login`, the tool returns a clear authentication error.

## Run locally

```bash
node server.js
```

Example MCP client configuration:

```json
{
  "mcpServers": {
    "ayoa": {
      "command": "node",
      "args": ["/absolute/path/to/ayoa-mcp-server/server.js"],
      "env": {
        "AYOA_COOKIES_FILE": "/absolute/path/to/ayoa-cookies.json"
      }
    }
  }
}
```

## Inspector

Interactive Inspector:

```bash
npm run inspector
```

Headless tools-list verification:

```bash
npx @modelcontextprotocol/inspector --cli node server.js --method tools/list
```

Or:

```bash
npm run verify:mcp
```

## Ayoa operation contracts

`create_mindmap` uses the authenticated Ayoa UI at `/mindmaps/new`.

`list_mindmaps` reads mind-map links from the authenticated dashboard. No undocumented REST list endpoint is invented.

`import_opml` uses the known Ayoa v2 sequence:

```text
POST /v2/uploads
upload to presigned URL
POST /v2/import/text
poll GET /v2/import-jobs
paperIds[0] → mindmapId
```

`list_presenter_slides`, `prepare_presenter`, and `capture_slides` use the Presenter DOM and wait for the selected slide to settle before capturing.

`make_video` encodes `slide-*.png` files to H.264 MP4 with FFmpeg.

## Design boundaries

- Standalone Node project;
- no dependency on NotebookLM MCP;
- no NotebookLM tools or `nlm_*` names;
- no destructive delete tool exposed;
- CI uses no Ayoa credentials;
- real account operations remain opt-in through MCP tool calls.
