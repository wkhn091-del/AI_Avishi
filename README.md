# Stash

A personal dashboard for the things you make and collect: project archives, GitHub repositories, links and files, with an AI workspace and a media studio. The interface is in Hebrew and laid out right-to-left.

- **Projects.** Add a project as a ZIP. Stash reads it without extracting it (README, manifests, file tree), writes a title, a short description and tags, and draws a *fingerprint* of the codebase. AI models write the summary in Hebrew; with several providers configured, they all answer at once and one of them merges the answers (a mixture of experts). Without AI, Stash writes it itself. Each project opens as a workspace with an overview, a file explorer with a code viewer and Hebrew AI explanations of single files, and a live preview of its website.
- **GitHub.** Connect a personal access token and your repositories appear as cards. Opening one analyzes it with the same pipeline (Hebrew title, description and tags, and a fingerprint) and opens the same workspace: files and Hebrew explanations straight from GitHub, and the repository's website (its homepage or GitHub Pages) as the preview, or else its README.
- **AI workspace.** Two environments behind one switch. **Free** runs on Groq, OpenRouter, Cohere and Hugging Face: choose a model, let Auto-Free pick a suitable free model for each message, or Brainstorm, where every free model answers at once and one merges the answers. **Premium** runs on Anthropic, OpenAI, Gemini, DeepSeek and Kimi: an auto-router rates each request and picks the cheapest model that fits (Opus only for the hardest requests, DeepSeek for large amounts of code), or you choose any of its 16 models from one sheet that lists every provider's models at once, and an emergency switch sends everything to Fable 5.1. After the first answer, fixes and follow-ups hand off to a cheap model, answers cut off by the length limit continue by themselves on the same stream, and images and videos can be attached. The effort, from Low to Max, adds self-reflection or a mixture of experts; the model pill in the floating message box shows both (for example מקסימלי Opus 5.5). Long conversations are compacted into a `project_state.md` memory, code answers with several files come with a ZIP, and `@owner/repo` brings a GitHub repository into the conversation. Conversations are listed by date in a sidebar (a drawer on phones), each with a menu to share it as Markdown, rename it or delete it, and the microphone dictates in Hebrew.
- **Media studio.** Create images, speech, music and video with Pollinations, preview them and download them.
- **Links.** Paste a URL and get a card with the page's title, description, preview image and icon.
- **Files.** Upload anything. Images get thumbnails, and every file downloads with its original name.
- **Accounts.** Everyone signs in (Supabase Auth). Each person's conversations, long-term memory, attachments and media are theirs alone, in PostgreSQL; projects, GitHub, links and files are for admins.

![Projects, light theme](docs/screenshots/projects.png)

## Quick start

You need **Node.js 22.13 or newer**, and a free [Supabase](https://supabase.com) project for accounts and the database: [Accounts and the cloud database](#accounts-and-the-cloud-database) walks through it.

```bash
npm install                          # also generates the Prisma client
cp server/.env.example server/.env   # fill in SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, DATABASE_URL, DIRECT_URL, ADMIN_EMAILS
npm run db:migrate -w server         # creates the tables
npm run dev
```

Open <http://localhost:5173> and create your account. The API runs on port 4000 behind Vite's proxy, and both restart when you change the code.

To run it as a single app on one port, with the production build of the UI:

```bash
npm start        # builds the UI, then serves UI + API at http://127.0.0.1:4000
```

`npm test` runs the server test suite, and `npm run build` builds the UI only.

### Optional: AI

```bash
cp server/.env.example server/.env        # Windows: copy server\.env.example server\.env
```

The file opens with the port, `AI_PROVIDERS` and one key per provider. Fill in the keys you have and leave the rest: values that still look like the examples (`your_groq_key`) are ignored, and the server lists them at startup.

```ini
PORT=4000
NODE_ENV=development
AI_PROVIDERS=gemini,groq,openrouter,cohere,huggingface,anthropic,openai,deepseek,moonshot

GROQ_API_KEY=gsk_…
ANTHROPIC_API_KEY=sk-ant-…
GITHUB_TOKEN=github_pat_…
```

- **Free workspace:** Groq, OpenRouter (its `:free` models) and Cohere (a trial key) have free tiers without a credit card, and Hugging Face gives about $0.10 of credit a month (as of September 2026).
- **Premium workspace:** Anthropic, OpenAI, DeepSeek and Kimi (Moonshot) are paid. Gemini has a free tier but belongs to the premium workspace here; Gemini Flash also rates requests for the auto-router.
- `AI_PROVIDERS` lists the providers the server may use. Remove one to switch it off without deleting its key.

Restart the server. The status at the top of the page shows what is active, and **הגדרות** (Settings) lists every provider with its model and role. If AI fails, a project is still added with the built-in summary, and its overview says why. The original `AI_PROVIDER` and `AI_API_KEY` settings still work. See [AI engine](#ai-engine) and [AI workspace](#ai-workspace).

### Optional: media studio

Create a free key (no card) at [enter.pollinations.ai](https://enter.pollinations.ai/keys) and set `POLLINATIONS_API_KEY` in `server/.env`. [Media studio](#media-studio) explains what the free allowance covers.

### Optional: GitHub

Open **הגדרות** (Settings, the gear at the top) and paste a personal access token, or set `GITHUB_TOKEN` in `server/.env`. A [fine-grained token](https://github.com/settings/personal-access-tokens/new) with read-only **Contents** and **Metadata** access to the repositories you want is enough; a classic token needs the `repo` scope to include private repositories. The token is checked with GitHub before it is saved.

## Accounts and the cloud database

Everyone signs in, and each person's conversations, memories, attachments, ZIPs and media are theirs alone. Accounts are Supabase Auth; conversations and memories are kept in PostgreSQL (Supabase's database) through Prisma.

1. **Create a project** at supabase.com. Under **Authentication → URL Configuration**, set the Site URL to where Stash runs (`http://localhost:5173` in development) and add it to the redirect URLs: the confirmation and password-reset emails link there. Email confirmation is on by default, and the sign-up screen then says to check the inbox.
2. **Keys.** From **Project Settings → API Keys**, copy the project URL and the publishable key into `SUPABASE_URL` and `SUPABASE_PUBLISHABLE_KEY` (the legacy anon key works too). Both are public: the browser signs in with them. New projects sign tokens with asymmetric keys, which the server checks against the project's public keys (`/auth/v1/.well-known/jwks.json`, kept for at most 10 minutes, as long as Supabase itself caches them). A project still on the legacy shared secret can set `SUPABASE_JWT_SECRET` to check tokens locally; without it, the server asks Supabase Auth about each new token and keeps the answer for a minute.
3. **Database.** From **Connect**, copy the session pooler's connection string (port 5432) into `DATABASE_URL`, and the direct connection (or the session pooler again) into `DIRECT_URL`. On serverless hosting use the transaction pooler (port 6543) for `DATABASE_URL`, never for `DIRECT_URL`: migrations don't work through it.
4. **Tables.** `npm run db:migrate -w server` applies `server/prisma/migrations` (`prisma migrate deploy`). The schema, `server/prisma/schema.prisma`, has three tables: `users` (the Supabase user id, email, name, avatar and plan; a row is made the first time someone uses the chat or the memory), `chat_sessions` (a conversation: title, workspace, its messages and summary as JSON, and the counts the list shows) and `memories` (kind, text, project, source, a float32 vector and the model that made it). Deleting a user deletes their rows. Row level security is on for every table, with no policies, so Supabase's Data API (which anyone with the publishable key can call) sees nothing; the server connects with the database's own credentials.
5. **Admins.** `ADMIN_EMAILS` lists who may also use projects, GitHub, links and files. Those tools keep one shared store (and GitHub works with the server's token), so they stay single-person; every other account gets the chat and the media studio.
6. **From an earlier Stash.** Sign in once, stop the server, then run `npm run db:import -w server -- --email you@example.com`. It moves the conversations in `server/storage/db.json` and the memories in `server/storage/memory.db` into your account, and makes you the owner of the attachments, ZIPs and media made before accounts. Ids are kept, what was imported before is skipped, and `--dry-run` only counts.

**How a request is checked.** The browser gets a session from Supabase and sends its access token as `Authorization: Bearer …` with every API call. The server verifies the signature, the issuer (`<SUPABASE_URL>/auth/v1`), the audience (`authenticated`) and the expiry, and refuses anonymous sign-ins. Images, videos and downloads load from plain URLs, which can't carry that header, so after signing in and after every token refresh the app asks the server for an httpOnly cookie, `stash_session`, limited to `/api` and `SameSite=Lax`, which the server accepts only for GET and HEAD. Nothing that changes data works with the cookie alone.

**Hosting.** Put the server behind HTTPS (the cookie is marked `Secure` there), set `HOST=0.0.0.0`, and add your domain to `ALLOWED_HOSTS`. Attachments, generated media and ZIPs are still files in `server/storage/`, so run one server instance, or move those files to shared storage (Supabase Storage or S3) first.

### Deploying on Render

Stash runs on Render as one web service, with the UI and the API on one port. Its tables come from the migrations in `server/prisma/migrations`, applied on every deploy by the Prisma CLI the project pins (7.10), with `server/prisma.config.mjs`:

| Setting | Value |
|---|---|
| Build Command | `npm ci --include=dev && npm run render:build` |
| Start Command | `npm run start -w server` |
| Health Check Path | `/api/health` |

`npm run render:build` runs `npm run db:migrate -w server` (`prisma migrate deploy`, which applies what's pending and does nothing otherwise), then builds the client. A migration that fails fails the build, and the running version stays up. Render's pre-deploy command would be the natural place for it, but free instances don't have one. The build needs the dev dependencies (the Prisma CLI and Vite), hence `--include=dev`.

Environment: `HOST=0.0.0.0` (Stash listens on 127.0.0.1 otherwise), `ALLOWED_HOSTS=<your-service>.onrender.com`, `SUPABASE_URL`, `SUPABASE_PUBLISHABLE_KEY` (and `SUPABASE_JWT_SECRET` if the project still uses the legacy secret), `ADMIN_EMAILS`, your AI keys, and for the database Supabase's **session pooler** string in both `DATABASE_URL` and `DIRECT_URL`: copy it from the dashboard's Connect dialog (Session pooler) as it is, and replace only the password. Don't compose it: the host's `aws-N` prefix is a pooler cluster number that can't be worked out from the region, and a wrong one, or a user without the project ref (`postgres.<project-ref>`), makes the pooler answer `tenant/user … not found`. Render has no IPv6, and Supabase's direct host, `db.<project-ref>.supabase.co`, is IPv6-only without the IPv4 add-on. URL-encode characters like `@`, `#` or `/` in the password.

**The app elsewhere, the API on Render.** The browser app can also be hosted on its own (on Vercel, say), with Render serving the API: build the client with `VITE_API_URL=https://<your-service>.onrender.com`, and on Render set `CORS_ORIGINS` to the app's origin and `RESOURCE_TOKEN_SECRET` to a long random string (see Configuration). The app then sends the session in the Authorization header, and images, downloads and the team dashboard's live updates carry 12-hour read-only link tokens, because browsers block the API's cookie on another site as a third-party cookie.

`Cannot GET /` at the service's address means Render runs a version older than this README: this version answers `/` itself, with the app, or with a JSON note when it serves only the API (the app elsewhere, or not built: the startup log says `[client] client/dist is missing`). After pushing new code, check in Render's Events that the deploy built that commit.

To run the migrations by hand (once, say, before the first deploy): `npm ci` at the repository's root, then `npm run db:migrate -w server` with `DIRECT_URL` set in `server/.env` or in the shell. Not a bare `npx prisma …`: from the root it doesn't find `server/prisma.config.mjs`, and without the project's dependencies installed it downloads the newest Prisma, whose settings may differ from 7.10's.

At startup the server says whether the tables are up to date (`Database → PostgreSQL (Prisma), tables up to date`), or which migrations aren't applied and what to run; `/api/health` reports it as `database`; and a request that needs a missing table answers 503 `DATABASE_NOT_MIGRATED` with the command, instead of a stack trace per request. A database that can't be used at all gets the same treatment, by cause: `DATABASE_AUTH_FAILED` (the user or password; through Supabase's pooler the user is `postgres.<project-ref>`), `DATABASE_TLS_FAILED`, `DATABASE_UNREACHABLE` (the direct host from Render, or a paused project), `DATABASE_NOT_FOUND`, `DATABASE_URL_INVALID` (an unencoded `@` or `#` in the password) and `DATABASE_BUSY`, each with a log line saying what to change.

## Using it

- **Add projects:** click **הוספת ZIP** (Add ZIP), or drop `.zip` files anywhere on the Projects page. Several archives are queued and processed one at a time. Each card shows what is really happening (queued, uploading with progress, analyzing) and turns into the finished card in the same spot.
- **Project workspace:** click a card to open it. Three tabs:
  - **סקירה** (Overview): languages, detected stack, entry points, the files the summary was based on, the weight of each top-level folder, and the README.
  - **קבצים** (Files): browse the archive's folders, filter by name, and open any file in a syntax-highlighted viewer. **הסבר קובץ זה** (Explain this file) asks the AI model for a short Hebrew explanation of the file. Markdown files can be shown rendered or as source.
  - **תצוגה מקדימה** (Preview): the project's website running live, with phone and tablet widths. Projects without a ready site get an explanation, the commands that run them locally, and their rendered README.

  From the footer you can edit the title, description and tags, re-analyze the archive, download the original ZIP, or delete the project. **שתף** (Share) copies a direct link to the project (`#projects/<id>`); opening that link opens the project, and the browser's Back button closes it.
- **GitHub:** the **גיטהאב** tab lists your repositories (owned, collaborating and your organizations', up to 300, most recently pushed first) with GitHub's language, stars and last push. Opening a repository that hasn't been analyzed starts its analysis, and the result is saved. The dialog is the same workspace: **סקירה** shows the Hebrew summary and the repository's details, **קבצים** browses the default branch with the same viewer and **הסבר קובץ זה**, and **תצוגה מקדימה** shows the repository's website (its **Website** field, or its GitHub Pages site). A site that refuses to be shown in a frame gets a button that opens it in a new tab, with the README below; a repository without a website shows its README and run commands. **שתף** copies `#github/<owner>/<repo>`. The footer opens the repository on GitHub, analyzes it again or edits the summary; repositories aren't deleted from Stash.
- **AI workspace:** the **צ'אט AI** tab, laid out like a chat app. The conversation history runs down the right side, grouped by date (**היום**, **אתמול**, the last 7 and 30 days, then month by month). On a wide screen the panel button hides it (the choice is remembered); on a phone it opens as a drawer from the right edge. Each conversation's **⋯** menu offers **שיתוף** (Share: through the device's share sheet, as Markdown on the clipboard, or as a `.md` file), **שינוי שם** (Rename) and **מחיקה** (Delete, after a confirmation); the open conversation has the same menu in the chat's header. The switch in the header chooses **חינמי** (Free) or **פרימיום** (Premium). In the floating message box, **+** attaches an image, a video or a GitHub repository (images and videos can also be pasted or dropped), the model pill shows the effort and the model (for example **מקסימלי Opus 5.5**) and opens the model and effort sheet, and the microphone dictates in Hebrew where the browser can recognize speech. On a phone the sheets slide up from the bottom, and dragging the handle down closes them.
  - **Premium:** **אוטומטי** (the default) lets the router choose. The sheet lists every model at once, grouped by provider: Anthropic (Fable 5.1, Opus 5.5, Sonnet 5, Haiku 4.5), OpenAI (GPT-6 Astra, GPT-6 Sol, GPT-5.6 Sol, GPT-5.6 Terra, GPT-5.6 Luna, GPT-5.5, GPT-4o, GPT-5.4 mini, GPT-4o mini), Gemini (Pro, Flash, Flash-Lite), DeepSeek (V4.1 Flash, V4 Pro) and Kimi (K3, K2.7 Code, K2.6). Retired models such as Claude 3.5 and Gemini 1.5 aren't offered, because their APIs no longer answer. Every model shows its relative price, from **זול מאוד** (very cheap) to **יקר מאוד** (very expensive), and the Gemini models a **וידאו** (video) tag; a model whose key is missing is greyed out and names the key. **העברה חסכונית** (Cost-saving handoff), the first switch at the bottom of the sheet, is on by default: the chosen model writes the first answer and handles planning, and later fixes and small follow-ups go to a cheap model. **צוות פיתוח** (Development team), the second switch, is also on by default: it names the team (for example "GPT-6 Sol מתכנן, Sonnet 5 בונה את הממשק, DeepSeek V4.1 Flash כותב את השרת, GPT-5.4 mini בודק"), and turning it off sends every request to one model. **חיפוש ברשת** (Web research) and **זיכרון לטווח ארוך** (Long-term memory) follow, both on by default (web research needs a Tavily key), and **מה למדתי עליך** (What I learned about you) opens the memory itself: every memory by kind, to add, edit or delete, or to clear. These three rows are in the free workspace's sheet too. **מצב חירום** (Emergency mode), the last switch, turns the panel red and sends every message to Fable 5.1 until it's turned off, in the sheet or on the red banner; choosing a model in the sheet also turns it off.
  - **Free:** **אוטומטי-חינמי** (Auto-Free), **סיעור מוחות (כולם)** (Brainstorm), or any model of a free provider, with search.
  - **Effort:** at the top of the same sheet, **מאמץ** opens the five levels: **נמוך**, **בינוני** (the default), **גבוה**, **גבוה במיוחד** and **מקסימלי** (5.5 times the usage or more). [AI workspace](#ai-workspace) explains each.

  Each answer says how it was made: the model, the effort, the router's rating (for example "מורכבות 8/10, קוד. נבחר Sonnet 5"), a handoff ("העברה חסכונית (תיקון): DeepSeek V4.1 Flash במקום Opus 5.5"), an automatic continuation ("המשך אוטומטי ב-DeepSeek V4.1 Flash"), the development team's live dashboard (its four phases as they happen: the plan, the files written in parallel, the checks and the files that corrected themselves, the ZIP and what it cost), the web sources it was given (folded under **מקורות מהרשת**, with links), the memories it was given ("נעזר ב-2 דברים שלמדתי עליך", folded), and folded sections for the model's thinking and the experts' answers. While a search runs, the answer says so ("מחפש ברשת: React 20 new features"). While the team works, a line under the text being written says who is working now ("Sonnet 5 בונה את הממשק… שלב 2 מתוך 4"). The conversation's cost, at the top of the chat, goes up after every model call while the answer is written; tap it for **שימוש ועלות** (Usage and cost). A code answer with several files gets a card with a ZIP of them. Attached images and videos appear above your message. **זיכרון** (Memory) shows the conversation's `project_state.md`, when it was updated and when it will be next; it can be downloaded or updated at once. Answers stream as they are written, the square button stops one and keeps what was written, and any answer can be copied or regenerated. Conversations are saved and listed at the side (on a phone, in the menu at the top), and `#chat/<id>` links to one.
- **Media studio:** the **סטודיו מדיה** tab has three kinds: **תמונות** (images, with aspect ratio, seed and a content filter), **אודיו ומוזיקה** (speech in a choice of voices, or music) and **וידאו** (length, aspect ratio, soundtrack). Each result appears with a preview or player, a download button and **שימוש בתיאור** to start again from the same prompt; earlier results are listed below it.
- **Links:** paste into the bar, or press Ctrl+V (⌘V on a Mac) anywhere on the Links page. Saving a link you already have highlights the existing card, and **רענון התצוגה המקדימה** (Refresh preview) fetches a preview again.
- **Files:** use **העלאת קבצים** (Upload files) or drop files anywhere on the Files page. Switch between grid and list; the choice is remembered.
- **Keyboard:** `/` focuses search, `Esc` clears it or closes a dialog, and the arrow keys move between tabs in right-to-left order (`←` goes to the next tab). The current tab is part of the URL (`#projects`, `#github`, `#links`, `#files`).

The light and dark themes follow your system setting, and animations are reduced when your system asks for reduced motion.

## Hebrew and right-to-left

- **Interface.** Every label, button, tooltip, dialog, toast and error message is in Hebrew, and `client/index.html` sets `lang="he" dir="rtl"`. The layout uses logical Tailwind classes only (`ms-`/`me-`, `ps-`/`pe-`, `start-`/`end-`, `text-start`/`text-end`), so nothing is pinned to a physical side. Tab arrow keys, page transitions and the codebase fingerprint are mirrored as well.
- **Mixed content.** Project titles, descriptions, READMEs and link titles use `dir="auto"`, so English text keeps its own direction inside the right-to-left page. File names, URLs, paths and technology names are isolated (`<bdi>` or Unicode isolates), so names like `C#` or `report (2).pdf` display correctly inside Hebrew sentences.
- **Chat text.** Each paragraph of an answer takes the direction of most of its letters, not of its first one, so a Hebrew sentence that opens with an English word ("REST ו-GraphQL…") still reads right-to-left. Repository mentions (`@owner/repo`) and links stay left-to-right inside Hebrew messages.
- **Messages.** Error messages are Hebrew only. When a provider's own English text helps (for example Gemini's "The model is overloaded"), it is shown on its own left-to-right line in a monospace font, never inside a Hebrew sentence. Message containers use `dir="auto"` and `unicode-bidi: plaintext` (the `bidi-plain` utility), so each paragraph takes the direction of its first letter.
- **Code, commands and paths.** Code blocks, run commands and file paths are always left-to-right (`dir="ltr"`), and code blocks and commands are left-aligned like a terminal. Sizes are isolated as left-to-right units, so they read "5.2 KB", and tag chips keep their color dot at the start.
- **Typefaces.** Heebo sets the Hebrew text. Archivo is kept for Latin names (expanded) and for figures such as sizes and counts (condensed).
- **Server messages.** Every error and preview note the server sends to the page is in Hebrew. Terminal logs stay in English, because most terminals can't display right-to-left text.
- **AI summaries.** The system prompt states: *"You must generate the project title, tags, and description entirely in Hebrew."* The instruction is repeated at the end of every request. If the title or description of an answer isn't in Hebrew, the answer is rejected: the project gets the built-in summary, and its details dialog says why. Tags without Hebrew letters are dropped; technology tags such as React come from detection.
- **File explanations.** The prompt states: *"You must write the explanation entirely in Hebrew."* An explanation that isn't in Hebrew is rejected with a Hebrew error, and points without Hebrew letters are dropped.
- **Built-in summaries.** Without AI, generated descriptions are written in Hebrew, for example "אפליקציית ווב שנבנתה עם React ו-Vite, ונכתבה בעיקר ב-TypeScript." Text taken from a README stays in the README's language, since translating it needs an AI model.

## Project structure

```
stash-dashboard/
├── package.json               npm workspaces: dev, build, start, test
├── server/                    Express 5 API
│   ├── .env.example           every setting, documented; starts with one key per provider
│   ├── src/
│   │   ├── index.js           startup and graceful shutdown
│   │   ├── app.js             middleware and routes; serves the built UI with --serve-client
│   │   ├── config.js          all environment settings in one place (example values ignored, AI_PROVIDERS)
│   │   ├── lib/               JSON store, the database client (Prisma), settings file (GitHub token), retries with backoff, HTTP errors, ids, file names, content types
│   │   ├── middleware/        auth (Supabase tokens, the session cookie, admins), uploads (multer), host and cross-site guard, live-preview origin, errors, request log
│   │   ├── routes/            auth, projects, project files (tree, code, explain, preview, serve), github, chat, memory, media, links, files, health
│   │   └── services/
│   │       ├── users.js       the signed-in person's row in the users table
│   │       ├── projects/      archiveScanner → insights → summarizer, joined by analyzeArchive;
│   │       │                  archiveReader, previewPlanner and fileExplainer for the workspace
│   │       ├── github/        githubClient (token, ETag cache, Hebrew errors), repoService, repoAnalyzer, framing,
│   │       │                  chatContext (repositories mentioned in the chat)
│   │       ├── links/         linkPreview (Open Graph, icons) and urlSafety (SSRF guard)
│   │       ├── media/         pollinations: images, speech, music and video
│   │       ├── chat/          chatSessions (each person's conversations, changed under a row lock), codeBundles (a code answer's
│   │       │                  files as a ZIP), attachments (chat images and videos)
│   │       ├── memory/        the long-term memory: memoryStore (PostgreSQL, one person's rows at a time), embeddings,
│   │       │                  recall (before an answer), learner (after it)
│   │       ├── research/      webSearch (Tavily: search, page text, cache, the block for the prompt)
│   │       └── ai/            providers (10), llmClient (JSON, text, streaming, model lists, retries), ensemble, geminiFiles (large videos);
│   │                          catalog (workspaces, premium models, efforts, the team), router, orchestrator (routes, continuations,
│   │                          strategies), compaction, pricing and usageMeter (the cost meter); swarm/: the development team
│   │                          (blueprint: the architect's JSON plan; agents: the file writers and the reviewer; checks: the QA
│   │                          compiler's parser checks; verify and sandbox/: the build, tests and start in Docker or
│   │                          E2B; index: the parallel build and the fix rounds; runs: the live runs the dashboard listens to;
│   │                          preview: the live previews of generated projects and their proxy; patch: edits planned as
│   │                          patches); chat/artifacts.js: a project's versions; credits.js: what each person may spend
│   ├── prisma/                schema.prisma (users, chat_sessions, memories) and migrations/; prisma.config.mjs beside it
│   ├── scripts/smoke.js       npm run smoke: the AI features, accounts and the database, against the real services
│   ├── scripts/import-local.js npm run db:import: an earlier Stash's conversations and memories into an account
│   ├── tests/                 node:test suites: analysis, links, workspace, explanations, GitHub, AI retries, ensemble,
│   │                          chat workspaces, the AI gateway, the swarm and its QA compiler, live previews and edits, the cost meter, chat memory and code,
│   │                          configuration, media, HTTP API, accounts and privacy (on PGlite: Postgres in WebAssembly)
│   └── storage/               created on first run: the database, archives/, files/, media/, bundles/, settings.json
└── client/                    React 19, Vite, Tailwind CSS 4, Framer Motion
    └── src/
        ├── components/layout/ Dashboard (tabs, page transitions; members get the chat and media), TopBar, SectionHeader
        ├── features/auth/     AuthProvider (Supabase session, the API token, the cookie), AuthGate, AuthScreen (sign in,
        │                      sign up, reset, new password), UserMenu
        ├── components/ui/     Button, Modal, BottomSheet, Drawer, Toaster, ConfirmButton, SearchField, empty/error states
        ├── components/settings/ SettingsModal: GitHub token, AI providers, media studio
        ├── features/projects/ AddZipButton, ProjectCard, Fingerprint, useProjects;
        │                      details/ is the workspace: overview, file explorer, code viewer, preview
        ├── features/github/   GithubSection, RepoCard, useGithub (repositories open the projects workspace)
        ├── features/chat/     ChatSection (layout, header, messages), HistoryPanel and ConversationMenu (history;
        │                      share, rename, delete), Composer (floating message box, model pill, dictation),
        │                      sheets (model and effort, share, memory, repositories), messages, useChat
        ├── features/chat/swarm/ SwarmDashboard (the development team's live dashboard: the plan, parallel writing, checks
        │                        and self-correction, the project and its credits), ArtifactPanel (the project, live: its
        │                        preview, its code and edits), useSwarmPipeline (Server-Sent Events), pipelineState
        ├── features/media/    MediaSection (images, audio, video), useMedia
        ├── features/links/    paste bar, LinkCard, useLinks
        ├── features/files/    tiles and rows, file-type glyphs, useFiles
        ├── hooks/             page-wide file drop, server health
        └── lib/               API client with upload progress, formatting, task queue, text direction, an animated number (the credits)
```

## Configuration

Every setting is optional. Put them in `server/.env`; `server/.env.example` lists them all.

| Variable | Default | What it does |
|---|---|---|
| `PORT` | `4000` | API port, and the whole app's port with `npm start`. |
| `NODE_ENV` | `development` | `production` also serves the built UI, like `npm start` does. |
| `SUPABASE_URL` | | Your Supabase project's URL. Without it and the publishable key, the API refuses every request. |
| `SUPABASE_PUBLISHABLE_KEY` | | The project's publishable key (or legacy anon key). Public: the browser signs in with it. |
| `SUPABASE_JWT_SECRET` | | Only for projects on the legacy shared secret: tokens are then checked locally instead of by Supabase Auth. |
| `ADMIN_EMAILS` | | Comma-separated emails that may also use projects, GitHub, links and files. |
| `DATABASE_URL` | | PostgreSQL for conversations and memories: Supabase's session pooler, or its transaction pooler on serverless hosting. |
| `DIRECT_URL` | | The connection migrations use (`npm run db:migrate -w server`): the direct connection or the session pooler. |
| `DATABASE_POOL_SIZE` | `5` | Connections the server keeps open. |
| `DATABASE_CA_CERT` | | A CA certificate to verify the database server with (path relative to `server/`); without it the connection is encrypted but not verified. An `sslmode` in `DATABASE_URL` keeps its libpq meaning: `require` encrypts (node-postgres alone would read it as `verify-full` and refuse Supabase's certificate), `verify-full` needs this certificate, `disable` turns encryption off. |
| `HOST` | `127.0.0.1` | Interface to listen on. Every API request needs a signed-in account; when hosting, use `0.0.0.0` behind HTTPS and add your domain to `ALLOWED_HOSTS`. |
| `ALLOWED_HOSTS` | (none) | Extra host names allowed to reach the server, comma-separated, e.g. `my-pc.local`. `localhost` and IP addresses are always allowed. |
| `CORS_ORIGINS` | (none) | The browser app's origins when it's hosted apart from this server (the app on Vercel, the API on Render), comma-separated, like `https://my-stash.vercel.app`. `*` may stand only inside one part of the host name (`https://stash-*-me.vercel.app`, for preview deployments); `https://*.vercel.app` is refused, since anyone can deploy there. Build that app with `VITE_API_URL` set to this server's address. |
| `RESOURCE_TOKEN_SECRET` | (random per run) | Signs the read-only links (12 hours) such an app uses for images, downloads and live updates, which the browser loads without the session header. Set it to a long random string: without it, those links stop working at every restart until the page is reloaded. |
| `STORAGE_DIR` | `storage` | Where the database, archives and files are kept, relative to `server/`. |
| `MAX_ZIP_MB` | `250` | Largest project archive. |
| `MAX_FILE_MB` | `500` | Largest single file (up to 20 files per upload). |
| `AI_PROVIDERS` | every provider with a key | The providers the server may use, comma-separated (`gemini,groq,openrouter,cohere,huggingface,anthropic,openai,deepseek,moonshot`, and `pollinations`). An unknown name stops the server with a clear message. |
| `GEMINI_API_KEY`, `GROQ_API_KEY`, `OPENROUTER_API_KEY`, `COHERE_API_KEY`, `HF_API_KEY`, `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `DEEPSEEK_API_KEY`, `MOONSHOT_API_KEY` | (none) | A key for each AI provider you want to use. |
| `GEMINI_MODEL`, `GROQ_MODEL`, `OPENROUTER_MODEL`, `COHERE_MODEL`, `HF_MODEL`, `ANTHROPIC_MODEL`, `OPENAI_MODEL`, `DEEPSEEK_MODEL`, `MOONSHOT_MODEL` | see [AI engine](#ai-engine) | Each provider's default model, for summaries, file explanations and the free workspace. The premium model sheet uses its own models. |
| `ROUTER_MODEL` | `gemini-flash-latest` | The Gemini model that rates premium requests for the auto-router. |
| `CHAT_COMPACT_EVERY` | `10` | Turns between updates of a conversation's `project_state.md`. |
| `CHAT_KEEP_RECENT` | `3` | Messages the models still get word for word after an update. |
| `AUTO_CONTINUE_MAX` | `4` | How many times an answer cut off by the length limit is continued automatically; `0` turns it off. |
| `CHAT_HANDOFF` | `on` | `off` turns the cost-saving handoff off for everyone: follow-ups and continuations stay on the chosen model. |
| `PIPELINE` | `on` | `off` turns the development team off for everyone. |
| `PIPELINE_MIN_COMPLEXITY` | `7` | The router's rating (1 to 10) from which a code request goes to the team. |
| `PIPELINE_ARCHITECT`, `PIPELINE_ARCHITECT_FALLBACK` | `gpt-6-sol`, `opus-5.5` | The team's architect, who writes the JSON blueprint, and the model that plans when the architect fails or its blueprint is still invalid after one repair. Catalog ids, as in `server/src/services/ai/catalog.js`; `gpt-5.6-sol` brings back the previous flagship. |
| `PIPELINE_BUILDER`, `PIPELINE_REVIEWER` | `deepseek-flash`, `sonnet-5` | The micro-agents that write the files (they alternate with the next builder model on another provider, Gemini Flash by default) and the QA reviewer. Each role falls back to the next model with a key. |
| `PIPELINE_CONCURRENCY` | `8` | How many files are written at the same time (up to 32). |
| `PIPELINE_MAX_FILES` | `60` | The most files one blueprint may have (up to 200). |
| `PIPELINE_FILE_TOKENS` | `8192` | Each file's output limit, in tokens; a file cut off there is continued, up to twice. |
| `PIPELINE_QA_ROUNDS` | `3` | How many times the QA compiler sends broken files back before the answer is final (0 to 5). |
| `SANDBOX` | `off` | `docker` or `e2b`: install, build, test and start every project the development team writes, in isolation, and send the real errors back (see the development team). |
| `SANDBOX_ACCESS` | `admins` | Who gets the sandbox: the admins (`ADMIN_EMAILS`), or `everyone` signed in. |
| `SANDBOX_ROUNDS`, `SANDBOX_MAX_RUNS` | `2`, `2` | Fix rounds driven by the sandbox's errors (0 to 3), and projects in the sandbox at once (the next one waits up to two minutes). |
| `SANDBOX_STEP_SECONDS`, `SANDBOX_START_SECONDS` | `300`, `8` | Each step's time limit, and how long a server must stay up to count as started. |
| `SANDBOX_DOCKER_CLI`, `SANDBOX_DOCKER_IMAGE` | `docker`, `node:22-bookworm` | The CLI (`podman` works too; `DOCKER_HOST` points it at another machine) and the image: Node with build tools. |
| `SANDBOX_MEMORY_MB`, `SANDBOX_CPUS` | `2048`, `2` | The container's limits (it also gets at most 512 processes, no capabilities, and no root). |
| `SANDBOX_DOCKER_NETWORK`, `SANDBOX_DOCKER_RUNTIME` | `bridge`, | The network npm install uses (disconnected before the project's code runs), and a runtime such as `runsc` (gVisor). |
| `SANDBOX_PREVIEW` | on | `off`: no live previews of generated projects, and the sandbox ends with the run. |
| `SANDBOX_PREVIEW_MINUTES`, `SANDBOX_PREVIEW_MAX_MINUTES` | `15`, `60` | How long a live preview stays up after it was made, edited or last used, and at most in all. |
| `SANDBOX_MAX_PREVIEWS` | `4` | Live previews at once, each keeping its sandbox; the one unused longest makes room. |
| `SANDBOX_PREVIEW_PORT`, `SANDBOX_PREVIEW_READY_SECONDS` | `5173`, `90` | The dev server's port inside the sandbox, and how long it has to answer. |
| `E2B_API_KEY`, `SANDBOX_E2B_TEMPLATE` | | E2B's key, and a template with Node 20 or newer (empty: E2B's default). |
| `CREDITS` | `on` | `off` turns credits off: nobody is charged. |
| `CREDITS_PER_ANSWER`, `CREDITS_PER_FILE`, `CREDITS_PER_MEDIA` | `1`, `1`, `1` | A premium answer; the development team, per file of its blueprint (instead of the answer's price); each media studio item. |
| `CREDITS_UPGRADE_URL` | | Where the upgrade dialog's button leads (a pricing or checkout page); without it, the dialog says to ask the admin. |
| `MODEL_PRICES` | | Cost-meter prices to override or add, as JSON in USD per million tokens, for example `{"gpt-5.6-sol":{"input":5,"output":30,"cached":0.5}}`. |
| `COST_FREE_PROVIDERS` | | Providers whose use costs you nothing, comma-separated (for example `gemini` with a free-tier key, or `tavily` on its free plan). |
| `WEB_RESEARCH` | `on` | `off` turns web research off for everyone. |
| `TAVILY_API_KEY` | | Tavily's key for web research ([tavily.com](https://tavily.com); the free plan has 1,000 searches a month). |
| `WEB_RESEARCH_DEPTH`, `WEB_RESEARCH_RESULTS`, `WEB_RESEARCH_CACHE_MINUTES` | `basic`, `5`, `60` | Search depth (`basic` 1 credit, `advanced` 2), results per search (up to 10), and how long a search is reused. |
| `LONG_TERM_MEMORY` | `on` | `off` turns the long-term memory off for everyone: nothing is recalled or learned. |
| `MEMORY_EMBEDDINGS` | `auto` | Semantic search: `auto` (Gemini, then OpenAI), `gemini`, `openai`, or `off` (matching words). `GEMINI_EMBEDDING_MODEL` and `OPENAI_EMBEDDING_MODEL` choose the models (`gemini-embedding-001`, `text-embedding-3-small`). |
| `MEMORY_LEARNER` | `gpt-4o-mini` | The cheap model that writes down what an answer taught (a catalog id). |
| `BUNDLE_TTL_HOURS` | `24` | How long a code ZIP is kept. An expired one is rebuilt from its answer when downloaded. |
| `CHAT_IMAGE_MAX_MB`, `CHAT_VIDEO_MAX_MB` | `5`, `100` | Attachment limits. 5 MB is Anthropic's limit per image. |
| `GEMINI_INLINE_MAX_MB` | `14` | Videos up to this size go to Gemini inline (Base64, under its 20 MB request limit); larger ones through Gemini's Files API. |
| `AI_PROVIDER` | `auto` | The primary provider (file explanations, and the fallback for summaries): `auto` takes the first configured one; `none` turns AI off. |
| `AI_ENSEMBLE` | `free` | Project summaries: `free` asks every configured provider with a free tier at once, `all` includes paid ones, `off` asks only the primary; or a list such as `gemini,groq,cohere`. |
| `AI_SYNTHESIZER` | the primary | The provider that merges the ensemble's answers. |
| `AI_API_KEY`, `AI_MODEL` | (none) | The original single-provider settings, applied to the `AI_PROVIDER` provider. |
| `AI_TIMEOUT_MS` | `30000` | Time limit for one attempt (in the chat, until the answer starts). Timeouts aren't retried. |
| `AI_MAX_RETRIES` | `3` | Retries for temporary failures (HTTP 429/500/502/503/504, dropped connections). `0` turns them off. |
| `AI_RETRY_BASE_MS` | `2000` | The first wait before a retry; it doubles each time (2 s, 4 s, 8 s). |
| `POLLINATIONS_API_KEY` | (none) | Secret key (`sk_…`) for the media studio. |
| `POLLINATIONS_TEXT_MODEL` | `openai/gpt-5.4-nano` | Pollinations' text model, used only when Pollinations takes part in project summaries (`AI_ENSEMBLE=all` or a list); the chat doesn't use it. |
| `MEDIA_TIMEOUT_MS` | `300000` | Time limit for one video or music generation. |
| `LINK_FETCH_TIMEOUT_MS` | `8000` | Time limit for fetching a link preview. |
| `ALLOW_PRIVATE_NETWORK_URLS` | `false` | Also fetch previews for localhost and LAN links (see Security). |
| `LOG_REQUESTS` | `true` | One log line per API request. |
| `GITHUB_TOKEN` | (none) | Personal access token for the GitHub tab and for repositories mentioned in the chat. A token saved in Settings takes its place. |

Values that still look like the examples in `.env.example` (`your_…`, `<…>`, `changeme`) count as unset, and the server lists them at startup.

In development, Vite proxies `/api` to `http://127.0.0.1:4000`. Start it with `API_URL` set to use another address.

## How project analysis works

1. **Scan** (`archiveScanner.js`). The archive is read in memory and never extracted, so no entry can write outside a folder. Entry names that try to escape the archive (`../`) are dropped. Dependency, build and system folders are skipped, such as `node_modules`, `.git`, `dist`, `build`, `__pycache__`, `.venv`, Unity's `Library` and `Temp`, `__MACOSX` and `.DS_Store`. A single wrapper folder like `project-main/` is unwrapped. Only small key files (512 KB at most) are decompressed: the README, `package.json`, `index.html`, `pyproject.toml`, `requirements.txt`, `Cargo.toml`, `go.mod`, `pubspec.yaml`, `composer.json`, `manifest.json`, `app.json`, `project.godot`, Unity's `ProjectVersion.txt` and `*.csproj`. Reading stops after 50,000 entries.
2. **Insights** (`insights.js`). Languages by size; the stack from the manifests (frameworks, engines, notable libraries); the kind of project (web app, backend service, mobile app, desktop app, game, browser extension, chat bot, machine learning, command-line tool, library); likely entry points; and the fingerprint.
3. **Summary** (`summarizer.js`). With an AI provider, the model receives the README (up to 6,000 characters), the manifests (up to 5,000 characters in total), the first 200 file paths and the detected facts, and must reply with JSON holding a Hebrew title, a short Hebrew description and Hebrew tags. The reply is validated (it must be in Hebrew), and its tags are merged with the detected ones. Without a provider, or when the request fails, Stash uses the README's heading and first paragraph (template READMEs, like the one Vite generates, are recognised and skipped), then manifest names and descriptions, the page `<title>` and meta description, and finally a readable form of the archive name.

**The fingerprint** has one bar per slice of files, in path order. A bar's colour is the main language of its slice (with neutral greys for docs, data and assets) and its height is the slice's size on a log scale. There are at most 64 bars of a fixed width, so a small project draws a short strip and its length tells you the size at a glance.

## Live preview

The preview tab looks for a website that can run as is:

- A build folder with an `index.html` (`dist`, `build`, `out`, `www`, `_site`, `public`, `docs`…), or an `index.html` anywhere else, as long as every script and stylesheet it loads is in the archive.
- An `index.html` that loads source files (`/src/main.tsx`), is a template (`%PUBLIC_URL%`) or is empty doesn't count. It needs a build step first.

The site runs on its own origin, `http://p-<project id>.localhost:4000/`, with the build folder at "/". So builds with absolute asset paths (the Vite default) and client-side routing work as on a real host, and the site keeps its own storage. Browsers resolve every `*.localhost` name to your own computer (Chrome, Edge and Firefox do this). If a browser doesn't, the preview falls back to `/api/projects/:id/serve/…`, where sites with relative paths still work.

Without a ready site, the tab explains why (a Next.js server app, an unbuilt Vite project, a Python bot, a Unity game…). It also lists the commands that run the project locally: detected from `package.json` scripts and the lockfile, `requirements.txt`, `go.mod`, `Cargo.toml`, `pubspec.yaml` and similar. Below that it shows the README. To get a live preview of a web app, run its build and add the build folder to the ZIP.

The projects the development team writes in the chat have live previews of their own, with their dev server running in the sandbox: see *The project, live* under AI workspace.

## GitHub integration

- **Token.** A token saved in Settings is stored in `server/storage/settings.json`, readable only by your user (mode 600), and takes precedence over `GITHUB_TOKEN` in `server/.env`; removing it falls back to the `.env` token. The browser never receives the token, only its last four characters.
- **Analysis.** Stash reads the repository's file tree, skips dependency and build folders exactly as it does in ZIPs, downloads only the key files (README, manifests, `index.html`, a few entry points; each up to 512 KB, four at a time) and runs the same analysis and summarizer as for a ZIP. Analyses are saved in the database, keyed by `owner/repo`.
- **Files and explanations.** Files come from the default branch through the contents API. Explanations are cached per file version (the file's blob SHA), so a changed file gets a fresh explanation.
- **Preview.** The repository's Website field comes first, then GitHub Pages. Before a site is put in the frame, the server checks its `X-Frame-Options` and `Content-Security-Policy: frame-ancestors` headers through the same SSRF-safe fetch as link previews, because many sites refuse to be framed.
- **Rate limits.** With a token, GitHub allows 5,000 requests an hour. Responses are cached with their ETags, and GitHub doesn't count a `304 Not Modified` against the limit; the file tree is also kept for a minute. When the limit runs out, the Hebrew error says when to try again.

## AI engine

Providers and their default models, checked in September 2026 (each can be changed in `server/.env`; the free workspace lists what each free provider currently offers):

| Provider | Default model | Chat workspace | Free tier without a card |
| --- | --- | --- | --- |
| Gemini | `gemini-flash-latest` (Google's alias for its current Flash model) | premium | yes, with daily limits |
| Groq | `openai/gpt-oss-120b` | free | yes, rate-limited |
| OpenRouter | `openrouter/free` (routes to a free model that fits the request) | free | yes, 50 requests a day |
| Cohere | `command-a-plus-05-2026` | free | trial key, 1,000 calls a month |
| Hugging Face | `openai/gpt-oss-120b:cheapest` | free | about $0.10 of credit a month |
| Anthropic | `claude-haiku-4-5-20251001` | premium | no |
| OpenAI | `gpt-5.4-mini` | premium | no |
| DeepSeek | `deepseek-flash` | premium | no |
| Kimi (Moonshot) | `kimi-k2.6` | premium | no |
| Pollinations | `openai/gpt-5.4-nano` | none (media studio) | a small daily Pollen grant |

- **Mixture of experts.** For project summaries (ZIP and GitHub), the same facts go to every ensemble provider at once (`Promise.allSettled`). The answers that pass validation (a Hebrew title and description) go to the synthesizer, which merges them into one Hebrew title, description and tags, keeping what the candidates agree on. If the synthesizer fails, another provider that answered merges; if none can, the best single answer is kept. The overview shows which models answered, which one merged and why any failed. Only when every provider fails does the project fall back to the built-in summary.
- **Retries and fallbacks.** Every call retries temporary failures (HTTP 429, 500, 502, 503, 504, dropped connections) after 2, 4 and 8 seconds with jitter, or after the wait the provider asks for (`Retry-After`, OpenRouter's reset header, Gemini's `RetryInfo`); a quota that won't reset within 30 seconds fails at once, saying when to try again. File explanations try the primary provider and then the other configured ones. A provider that rejects an optional parameter (JSON mode, temperature, reasoning) gets the request again without it.
- **Chat.** Answers stream from the provider to the browser as they are written (server-sent events in, JSON lines out), with retries before the first word; stopping an answer stops the provider too. A stream that ends without any text is reported as an error, not saved as an empty answer. Reasoning settings map to each provider's own parameter: `reasoning_effort` (OpenAI, DeepSeek, Groq's gpt-oss, Hugging Face), `reasoning.effort` (OpenRouter), Gemini's `thinkingLevel`, or an Anthropic thinking budget of 1K, 4K or 12K tokens. How the chat chooses and combines models is described in [AI workspace](#ai-workspace).
- **Messages.** Errors are in Hebrew. The provider's own English text is kept apart (`details.detail`) and shown on its own left-to-right line.

## AI workspace

**Workspaces.** The free workspace uses Groq, OpenRouter, Cohere and Hugging Face; the premium workspace uses Anthropic, OpenAI, Gemini, DeepSeek and Kimi. Answers in each workspace come only from its own providers, and the model sheets show which key each model needs. The premium models, checked in September 2026 (they are listed in `server/src/services/ai/catalog.js`):

| In the sheet | API model | Price | Accepts |
| --- | --- | --- | --- |
| Fable 5.1 (requires usage credits) | `claude-fable-5-1` | very expensive | text, images |
| Opus 5.5 | `claude-opus-5-5` | expensive | text, images |
| Sonnet 5 | `claude-sonnet-5` | medium | text, images |
| Haiku 4.5 | `claude-haiku-4-5-20251001` | cheap | text, images |
| GPT-6 Astra | `gpt-6-astra` (September 3, 2026) | very expensive | text, images |
| GPT-6 Sol | `gpt-6-sol` (September 22, 2026) | medium | text, images |
| GPT-5.6 Sol | `gpt-5.6-sol` (the `gpt-5.6` alias points to it; a 1.05M-token context and up to 128K output tokens, like the whole GPT-5.6 and GPT-6 family) | expensive | text, images |
| GPT-5.6 Terra | `gpt-5.6-terra` | medium | text, images |
| GPT-5.6 Luna | `gpt-5.6-luna` | very cheap | text, images |
| GPT-5.5 | `gpt-5.5` | expensive | text, images |
| GPT-4o | `gpt-4o` | medium | text, images |
| GPT-5.4 mini | `gpt-5.4-mini` | cheap | text, images |
| GPT-4o mini | `gpt-4o-mini` | very cheap | text, images |
| Gemini Pro | `gemini-pro-latest` | medium | text, images, video |
| Gemini Flash | `gemini-flash-latest` | cheap | text, images, video |
| Gemini Flash-Lite | `gemini-flash-lite-latest` | very cheap | text, images, video |
| DeepSeek V4.1 Flash | `deepseek-flash` (V4.1 Flash since September 10, 2026: a 1M-token context and up to 384K output tokens) | very cheap | text, images |
| DeepSeek V4 Pro | `deepseek-v4-pro` (the previous generation, still served; `deepseek-chat` and `deepseek-reasoner` were retired in July 2026) | cheap | text |
| Kimi K3 | `kimi-k3` | medium | text |
| Kimi K2.7 Code | `kimi-k2.7-code` | cheap | text |
| Kimi K2.6 | `kimi-k2.6` (Kimi K2.5 and the moonshot-v1 models were retired in August 2026) | cheap | text |

Prices are relative tiers, not live prices. `gpt-4o` and `gpt-4o-mini` are still served by OpenAI's API (only the `gpt-4o-2024-05-13` snapshot shuts down, on October 23, 2026); GPT-6 Sol is newer than GPT-5.6 Sol and costs half as much ($2 and $10 per million input and output tokens, against GPT-5.6 Sol's $4 and $20, which OpenAI calls a promotional price), which is why it is the development team's architect. GPT-6 Astra, OpenAI's most capable model ($10 and $50), has safety monitoring that can stop an API task it flags, so no automatic choice uses it. GPT-6 Luna isn't listed because its price couldn't be confirmed. Claude 3.5 Sonnet and Gemini 1.5 Pro, often named as vision models, are retired; every Claude, GPT and Gemini model above accepts images.

**Auto-router (premium): cheapest first.** Gemini Flash (`ROUTER_MODEL`) rates each request: its complexity from 1 to 10, its category (code, reasoning, math, writing, translation, quick question, general), its kind (planning, implementation, fix, question) and the expected output (short, medium, long, massive). The router then takes the first model in the matching list whose provider has a key and that accepts the attachments:

| Rating | Models, in order |
| --- | --- |
| 1 to 6 (standard) | Haiku 4.5, GPT-4o mini, Gemini Flash, GPT-5.4 mini, DeepSeek V4.1 Flash, GPT-5.6 Luna, … |
| 7 to 8 | Sonnet 5, GPT-6 Sol, Gemini Pro, GPT-4o, DeepSeek V4.1 Flash, …; code: the development team (below), or with it off Sonnet 5, GPT-6 Sol, DeepSeek V4.1 Flash, Kimi K2.7 Code, …; math and reasoning: DeepSeek V4.1 Flash, Gemini Pro, Sonnet 5, … |
| 9 to 10 | Opus 5.5, GPT-5.6 Sol, GPT-5.5, Gemini Pro, …; code: the development team |
| A lot of code (a full page, an app, many files) | DeepSeek V4.1 Flash with room for a 32K-token answer, then Gemini Flash, GPT-5.4 mini, Sonnet 5, … (planning requests are rated by complexity instead, so a plan never goes here) |
| A video is attached | Gemini Flash (Gemini Pro from 7), then Gemini Flash-Lite |

Fable 5.1 is never picked automatically. Without a Gemini key, or when the rating takes longer than 8 seconds, a built-in rating (length, code, keywords in Hebrew and English) is used instead, and the answer says so.

**Development team (the swarm).** A code request rated `PIPELINE_MIN_COMPLEXITY` (7) or more doesn't go to one model: the router acts as a project manager and hands it to a team that plans the whole project first and then builds every file at once. The code is in `server/src/services/ai/swarm/`.

| Step | First choice | If it has no key or fails | What it does |
| --- | --- | --- | --- |
| תוכנית (Blueprint) | GPT-6 Sol | Opus 5.5, GPT-5.6 Sol, Gemini Pro, Sonnet 5 | Plans the project as strict JSON and writes no code: the file tree, the package.json files, the shared contracts (endpoints, data models, class names, environment variables) and, for every file, its exports, its imports and an exhaustive spec (up to 32K tokens). |
| כתיבת הקבצים (the micro-agents) | DeepSeek V4.1 Flash and Gemini Flash, alternating | GPT-5.4 mini, Kimi K2.7 Code, Haiku 4.5 | One call per file, all in parallel (`PIPELINE_CONCURRENCY` at a time), each told to output only the complete file, with zero placeholders, within `PIPELINE_FILE_TOKENS` (8,192). |
| בדיקת QA (the QA compiler) | Sonnet 5, with parser checks | DeepSeek V4.1 Flash, Kimi K2.7 Code, GPT-5.4 mini, Gemini Pro | Checks the whole codebase and sends every broken file back to a micro-agent with its error log, up to `PIPELINE_QA_ROUNDS` (3) times. |
| בנייה והרצה (the sandbox, when it's on) | Docker or E2B | | Installs, builds, type-checks, tests and starts the project in isolation, and sends the real errors back, up to `SANDBOX_ROUNDS` (2) times. |

*The blueprint* is validated before anything is built: every path is one the ZIP accepts (letters, digits, `- _ . @ +` and an extension; no binary files, which the architect is told to replace with procedural textures, Web Audio and inline SVG), every planned import points at a planned file or at a package in a package.json above it (no aliases, no URLs), every code file has a real spec, and there are no more than `PIPELINE_MAX_FILES` (60) files. A blueprint that fails goes back to the architect once, with the problems listed; if it still fails, or the architect fails, the next model plans, and the dashboard says so ("GPT-6 Sol נכשל, ולכן Opus 5.5 תכנן"). With no valid blueprint at all, the turn fails with a clear message and no file is written. The package.json files are written by the server from the blueprint, so they are always valid JSON.

*The micro-agents* each see only the blueprint: the project, the architecture, the contracts, the file tree, the packages the file may import, the exact exports (names and signatures) of the files it imports and which files import it, and its own spec. That is what keeps files written in parallel consistent with each other. The files alternate between two lanes on different providers, so one provider's rate limit doesn't hold up the rest, and a failed call moves to the next model. A file cut off at its limit is continued, up to twice, and a fence an agent put around its code is removed.

*The QA compiler* has two halves. The deterministic one reads every JavaScript and TypeScript file with Babel's parser, so its findings are facts, not opinions: syntax errors with their line; relative imports that resolve to no file; named imports the target doesn't export (reported on the file that must change: the target when the blueprint promised that export, the importer otherwise); packages a file imports that no package.json lists (added to the package.json as `latest` instead of sending the file back, and the answer says so); names used but never defined or imported (in JavaScript and JSX: TypeScript's types would need its compiler); placeholder comments (`TODO`, "add logic here", "rest of the code") and "not implemented" errors; exports the blueprint promised; JSON that doesn't parse, CSS with unbalanced braces, HTML that loads a missing file, and empty or missing files. The other half is Sonnet 5, which reads the code (in batches, for a large codebase) for what a parser can't see: contract mismatches between files, unfinished features, a library used wrongly. Every issue it reports must quote the code it's about, and a quote that isn't in the file is dropped, so a file is never sent back for something the reviewer imagined. Files with problems go back to a micro-agent, on the other lane each round, with their current code and the error log; a fix is kept unless it adds syntax errors or cuts a working file down to an excerpt. In every round the parser checks run on everything, and the reviewer reads what changed and the files that import it.

*The sandbox* (`SANDBOX=docker` or `e2b`; off by default, and for admins only unless `SANDBOX_ACCESS=everyone`) runs the project for real after the static checks, because some errors only real tools find: a top-level await the build target rejects, a type error, a failing test, a server that crashes at startup. The steps come from the project's package.json files: `npm install` with the network, then, offline, `npm run build` where there's a build script, `tsc --noEmit` where there's a tsconfig.json and TypeScript (or a typecheck script), `npm test` where there's a real test script, and a server's `npm start` for `SANDBOX_START_SECONDS` (8): it must come up and stay up. A failed step becomes issues on the files that must change, read from the tools' own messages (Stash's tests use what Vite, esbuild, tsc, Node, node:test and npm really print): the importer or the exporter for a missing export (the blueprint's promise decides), the importer for an import that doesn't resolve, every file `tsc` names, the file in a crash's stack trace. When a test fails or the log names no file, the reviewer decides which file must change, since a failing test names the test, not the bug. Those files go back to the micro-agents with the log, and the next run reinstalls only if a package.json changed. Some install failures are repaired on the spot: a version that doesn't exist becomes `latest`, a peer conflict is retried with `--legacy-peer-deps`, and a package that doesn't exist on npm is removed (the files that import it are rewritten). After a good install, the packages added as `latest` are pinned to the versions that were installed. A server that stops for a missing setting (a database URL, a key) is a note in the answer, not something to fix. Docker runs one container per project: not root, no capabilities, limited memory, CPUs and processes, removing itself after 30 minutes even if Stash stops, and disconnected from the network before any of the project's code runs. E2B runs a Firecracker microVM that nothing outside can reach, with its internet switched off after the install. No mode runs generated code on Stash's own server. `npm run smoke -- --sandbox` checks the setup with a tiny project, including that the project can't reach the internet after the install.

*The answer* has the project's name and summary, the QA result ("✓ כל הבדיקות עברו…", or what's left after the last round), the sandbox's result when it ran (each step and how it went) or why it couldn't, how to run it, and every file in its own code block, so the ZIP, follow-up questions and rebuilding an expired ZIP work as for any other answer. What the rounds couldn't fix is listed at the end and in `QA_REPORT.md` in the ZIP, with a notice on the answer: it is never hidden. Above the answer, the live dashboard shows the work as it happens (see below), and the line at the bottom follows the step at work.

The team works on the first answer of a conversation and when a later message asks for a new plan; fixes and follow-ups go to one model, and to the cost-saving handoff, as before. Simpler code, long but simple code (DeepSeek V4.1 Flash) and hard questions without code (Opus 5.5) keep their usual models, and so does a video. The effort level sets the architect's reasoning effort. The switch in the model sheet turns the team off in your browser, `PIPELINE=off` turns it off for everyone, and the `PIPELINE_*` settings choose its models and limits (see [Configuration](#configuration)). With keys for fewer than two different models, there is no team. The cost meter shows the cost growing with every call; a team answer's cost grows with the number of files and the fix rounds.

*The live dashboard.* While the team works, the answer shows a dashboard instead of a waiting line, with four phases in the colors of the work: blue for planning, yellow and pulsing for writing, orange for self-correction and green for what passed. **תוכנית** draws the file tree while the architect's JSON is still arriving, then each file with what it's for. **כתיבה במקביל** has a card per file (a spinner while it's written, a check when it's done, the model that wrote it and its length) and the slots of `PIPELINE_CONCURRENCY`, filled by the files at work. **בדיקה ותיקון** shows the code check, the sandbox's steps as each one finishes, and every file sent back for a fix, with an orange badge (**מתקן את עצמו · ניסיון 2/3**, attempts counted per file against `PIPELINE_QA_ROUNDS` or `SANDBOX_ROUNDS`), the line and the first line of its error. The last phase, **אריזה** (**תצוגה חיה** when the project runs in the sandbox), ends with the project itself (below) and the credits it cost: the balance in the top bar counts down to what's left, with the charge rising above it. With reduced motion there's no pulsing, sliding or counting.

How it's fed: the swarm keeps each run's state in `swarm/runs.js` and changes it only by patches (fields merged into the object at a path, or an item upserted into a list by its key), and the chat route adds the ZIP and the credits. The chat stream announces the run (`{ "type": "pipeline", "runId" }`), and the client's `useSwarmPipeline` hook opens `GET /api/chat/runs/:id/events` with `EventSource`: Server-Sent Events that start with the whole state (`snapshot`), so a page that joins late or reconnects is complete, then every change (`patch`), then `end`, with a comment every 15 seconds so proxies keep the connection open. `EventSource` can't send headers, so this route signs in with the session cookie, and only the run's owner gets it (anyone else gets 404). The final state is saved with the answer (`message.pipeline`), so a reloaded conversation shows the same dashboard; answers from before it keep their timeline.

*The project, live.* The dashboard's last phase is the project itself, in two tabs. **תצוגה חיה**: when the project ran in the sandbox, the sandbox isn't thrown away. The project's dev server starts in it (Vite's or Next's `npm run dev` on `SANDBOX_PREVIEW_PORT`, 5173, or else a server's `npm start` with `PORT` set, with the project's other servers beside it), and the page shows in a frame, served through Stash on an origin of its own (see Security). The frame renders the app at a desktop (1280 px), tablet (768 px) or phone (390 px) width, so its layout and media queries are that device's, shrunk to fit the column; the toolbar also reloads it, opens it in a new tab and says when it ends. A preview stays up `SANDBOX_PREVIEW_MINUTES` (15) after it was made, edited or last used, and `SANDBOX_PREVIEW_MAX_MINUTES` (60) at most; `SANDBOX_MAX_PREVIEWS` (4) run at once, and the one unused longest makes room. One that ended comes back with **הפעלה מחדש**: a new sandbox, `npm install` and the dev server, from the latest version. **קוד** shows this version's files as a tree, highlighted, each with **העתקה** and **הורדה**, and the ZIP of the whole project is a button beside the tabs. Without the sandbox (a member's run, or `SANDBOX=off`), the panel opens on the code.

*Edits.* Under the panel, **מה תרצו לשנות?** sends a follow-up that changes this project instead of starting a new one. The architect gets the current blueprint and code and plans a patch (`swarm/patch.js`): the files to modify, create or delete, each with its exports and imports after the change, and any package.json that changes. Applied to a copy of the blueprint, the patch must pass the blueprint's own checks (every import resolves, every contract holds) before a file is written; one that doesn't gets a repair round, then the next model. Only the patch's files are rewritten, each by an agent that sees its current version and the architect's instructions, at a credit each. The reviewer reads what changed and the files that import it, the QA compiler checks the whole project, and the sandbox is the preview's own: the new files go into it, the install is skipped unless a package.json changed, and the dev server restarts, so the frame shows the new version at the same address. The answer lists the files that changed, and its ZIP holds the whole project at that version. Every edit is a version kept in the conversation (`services/chat/artifacts.js` rebuilds any version from the answers); the newest has the panel, and an older one's dashboard says it was updated later.

**Web research.** Before any model writes, the router (Gemini Flash) also decides whether the request needs the live web: news, the newest version of a library, framework or API, or other facts that may have changed since the models were trained; it knows today's date, and it writes the search query (in English for technical subjects). Without a rating (a model chosen by hand, emergency mode, no Gemini key), words such as "latest", "news", "עדכני" or "החדשה ביותר" decide. Then Tavily, a search API built for AI agents, runs one search (`WEB_RESEARCH_DEPTH=basic`, one credit, set explicitly so Tavily's automatic settings can't double it) and returns the top `WEB_RESEARCH_RESULTS` (5) pages with their text already extracted: nothing is scraped. Each page is cleaned (no images, headings or link targets) and cut to 2,500 characters, 12,000 in all (about 3,000 tokens), and the results join the instructions of every model in the turn, the team's architect included, between `<web_results>` markers, with the date and the rule that they are data from the web, not instructions: a page that tells the model to do something is ignored. Models cite the sources they use as [1], [2]. News searches only the last week. The same search within `WEB_RESEARCH_CACHE_MINUTES` (60) is reused, so a regenerated answer costs no second credit. A failed search never fails the answer: it is written without the web, and says so. The sources (titles, links, domains, never their text) are saved with the answer, and the search's credit is part of the cost meter. It needs `TAVILY_API_KEY` (the free plan has 1,000 searches a month); the switch in the model sheet turns it off in your browser, and `WEB_RESEARCH=off` for everyone. google-this and duck-duck-scrape were not used: they scrape search pages, which the engines block and their terms forbid.

**Long-term memory.** What the chat learns about how you work, across conversations, kept per account in PostgreSQL: the `memories` table of `server/prisma/schema.prisma` (kind, text, project, where it came from, a vector as float32 bytes and the model that made it, how often it was learned again and used, and when). Every query filters by the signed-in person's id, down to single-row updates and deletes, so recall, the learner and the memory sheet only ever see that person's memories. Vectors are compared in the server (a person has at most a few hundred memories), so the database needs no vector extension.
- *Before an answer (retrieval):* the memories that apply join the instructions of every model in the turn, with the rule to follow them silently. Preferences and code style that apply everywhere always come (the most confirmed first, up to 10); project rules and other facts come when they relate to the request (up to 6): by meaning, with Gemini's embedding model (`gemini-embedding-001`, 768 dimensions; OpenAI's `text-embedding-3-small` without a Gemini key), or by shared words, and always when the request names their project. The free workspace matches words only, so it never pays for embeddings.
- *After an answer (learning):* when a premium answer succeeds, GPT-4o mini (`MEMORY_LEARNER`; then other cheap models with a key) reads the message, a shortened answer and the closest memories already kept, in the background, and writes down up to three lasting facts: code style, tools and setup, how you want answers, a named project's rules, and corrections. Only what you said or accepted: never the task itself, guesses, personal details or secrets (anything that looks like a key, token, password or a URL with credentials is dropped, and refused when added by hand). A fact learned again confirms the old one instead of repeating it (the same text, or a vector at least 0.9 similar with Gemini), and a changed preference replaces the old one. The learning's calls count toward the conversation's cost, about a tenth of a cent per answer. It runs after every successful premium answer, not only the team's, because preferences show up in any conversation.

Every memory can be seen, edited and deleted under **מה למדתי עליך**, where you can also add rules yourself. The switch in the model sheet turns the memory (both recall and learning) off in your browser, and `LONG_TERM_MEMORY=off` for everyone. This is separate from a conversation's `project_state.md` (below), which summarizes one conversation.

**Auto-Free.** Groq's small `llama-3.1-8b-instant` rates the request the same way (or the built-in rating does). Quick questions go to Groq's `openai/gpt-oss-20b`, code and reasoning to Groq's `openai/gpt-oss-120b`, writing and translation to Cohere, each falling back to the other free providers. A provider that hit its rate limit is skipped for 5 minutes.

**Effort.** Every level also sets the provider's own reasoning effort (low, medium or high) and the answer length (2K to 8K tokens):

| Level | What happens | Calls |
| --- | --- | --- |
| Low | One call. | 1 |
| Medium (the default) | One call. | 1 |
| High | The model first writes private notes (the real goal, pitfalls, a plan and a critique of it), then answers with them. The notes appear under **תהליך החשיבה**. | 2 |
| Extra | A first draft, a self-critique of it, then an improved answer. | 3 |
| Max (5.5 times the usage or more) | A mixture of experts: the selected model, GPT-5.5 and Gemini Pro answer at once (`Promise.allSettled`), then the selected model merges their answers into one answer in Hebrew. | 4 |

Experts that fail are skipped; if the selected model can't merge, another expert does, and if none can, the first answer stands. Max needs at least two premium providers; with one, it runs as Extra and the answer says so. In the free workspace, Max and Brainstorm ask every configured free provider, and Brainstorm answers in the user's language.

**Emergency mode.** Every message goes to Fable 5.1, with no routing and no other model: at Max effort Fable writes a draft and critiques it instead of consulting experts. It needs `ANTHROPIC_API_KEY`.

**Cost-saving handoff.** The first answer in a conversation comes from the chosen model (or the router's choice). After that, when that model's price is above "cheap", each message is rated, and unless it asks for planning (architecture, a new system or feature) or is rated 9 or 10, it goes to a cheap model with a large output: DeepSeek V4.1 Flash, then Gemini Flash, GPT-5.4 mini, GPT-4o mini, Haiku 4.5 and Kimi K2.6, whichever has a key and accepts the attachments. It gets the same history and `project_state.md`, and the answer says what happened ("העברה חסכונית (תיקון): DeepSeek V4.1 Flash במקום Opus 5.5"). The switch in the model sheet turns the handoff off in your browser, and `CHAT_HANDOFF=off` turns it off for everyone. Emergency mode never hands off.

**Automatic continuation.** When the final answer stops at the model's length limit (`finish_reason: length` from OpenAI-style APIs, `stop_reason: max_tokens` from Anthropic, `finishReason: MAX_TOKENS` from Gemini), the server adds the partial answer to the history, asks "Continue exactly where you left off" and streams the continuation on the same connection, up to `AUTO_CONTINUE_MAX` times (4). With the handoff on, continuations go to the cheap model above; otherwise, in emergency mode and in the free workspace, to the same model. The first 640 characters of each continuation are held back to clean the seam: a code fence reopened inside an open block, and text that repeats the end of the previous part (16 characters or more, a restart of the unfinished last line, even on a new line, or two or more whole lines), are dropped. One repeated short line after a clean line end is kept, since code can repeat a line legitimately. The reader sees one answer, the ZIP gets whole files, and the footer says the answer was continued ("המשך אוטומטי ב-DeepSeek V4.1 Flash"). Continuations don't send the attachments again.

**Thinking budget.** Reasoning models count their thinking against the same output limit as the answer, so long thinking could leave no room for the answer. With Anthropic's extended thinking, `max_tokens` is the answer length plus the thinking budget (1K, 4K or 12K tokens by effort). OpenAI's reasoning models (`max_completion_tokens`), Gemini's thinking (`maxOutputTokens`) and the other reasoning models get a reserve on top of the answer length (2K, 8K or 16K tokens by effort), within the model's maximum; a model without reasoning gets none. Providers charge for the tokens actually written, so the higher limit costs nothing unless it's used. The router's rating runs with low thinking, so it answers well within its 8 seconds.

**Images and video.** Attachments work in the premium workspace. Images (PNG, JPEG, WebP or GIF, up to 5 MB, 5 per message) are sent as Base64: Anthropic `image` blocks, OpenAI-style `image_url` data URLs (OpenAI and DeepSeek V4.1 Flash) and Gemini `inlineData`. A video (MP4, WebM, MOV, MPEG, AVI or 3GP, up to 100 MB, one per message) goes to Gemini: inline up to `GEMINI_INLINE_MAX_MB` (14 MB), and larger videos through Gemini's Files API (a resumable upload, then waiting until Gemini has processed the file). The router only picks models that accept what is attached, a hand-picked model that doesn't (Kimi, DeepSeek V4 Pro, or Fable 5.1 with a video) is refused in Hebrew before the answer starts, and Max effort's experts are chosen the same way. Later turns don't get the files again, only a note with their names. Uploads that are never sent are removed after a day; the rest are deleted with their conversation.

**Memory (`project_state.md`).** Every `CHAT_COMPACT_EVERY` turns (10), right after the answer, a fast model (Gemini Flash, then Groq, then any configured provider) rewrites the conversation's `project_state.md` from the current file and the new messages: goals, decisions, architecture, code structure, current status, open questions and next steps. From then on, every model in both workspaces gets the instructions, `project_state.md` and only the messages from the last `CHAT_KEEP_RECENT` (3) onwards. Nothing is deleted: the conversation still shows the older messages, above a line saying they were summarized. A message sent during an update waits for it.

**Code packaging.** Models are asked to put each file's path on its code fence (```` ```jsx src/App.jsx ````). Stash also recognizes a path on the line above a block (bold, code, a heading, `File:`) or in its first-line comment. An answer with two or more files gets a ZIP of them, built with `adm-zip` (the library that already reads project archives) rather than JSZip or archiver. The ZIP is named after the `name` in its `package.json`, or `stash-code`. It is a temporary file in `server/storage/bundles`: after `BUNDLE_TTL_HOURS` (24) it is deleted, and downloading it again builds it anew from the answer, so the button keeps working. The files are read from the whole answer, so a file split by an automatic continuation arrives whole. A later block with the same path replaces the earlier one (as when an answer corrects a file it already showed), unless it's an excerpt: a block with a `...` placeholder line or a comment such as `// rest unchanged` or `// existing code` leaves the complete file in place (spread syntax such as `...args` isn't a placeholder).

**Cost meter.** Every model call of a turn is recorded with its tokens (input, output including thinking, cached input) and what it was for: the answer, a continuation, the router's rating, a team member, an expert, a web search (Tavily credits, $0.008 each pay-as-you-go), the long-term memory's embeddings and learning, or a memory update. Calls whose provider didn't report tokens are estimated from the text (about 4 characters per token, 2 for Hebrew), and the breakdown says so. Calls are priced from the providers' price lists (`server/src/services/ai/pricing.js`, checked September 26, 2026) at the time of each call, including DeepSeek's off-peak discount and the long-prompt prices of Gemini Pro (above 200K input tokens) and OpenAI's GPT-5.6 and GPT-6 (above 272K). Each answer shows its tokens and cost, and what a handoff saved; the conversation's cost is shown at the top of the chat and in the conversation list, and it goes up after every model call while the answer is being written. **שימוש ועלות** (Usage and cost) breaks the conversation down by model and by step, and shows this month's total and all conversations'. The free workspace costs nothing, `COST_FREE_PROVIDERS` marks other providers whose use is free for you (a free-tier key), and `MODEL_PRICES` overrides or adds prices.

**Credits.** What each person may spend, kept on their account in PostgreSQL (50 for a new account). A premium answer costs `CREDITS_PER_ANSWER` (1); a development-team project costs `CREDITS_PER_FILE` (1) for each file of its blueprint instead, taken once the plan is ready (without enough, the team stops before writing a file and says what it needs); each media studio item costs `CREDITS_PER_MEDIA` (1). The free workspace costs nothing but, like everything that calls a model, needs a balance above zero. Credits are reserved when the work starts and given back when it fails, and each reservation is one conditional update, so two requests at once can't spend the same credit and a balance never goes below zero. With nothing left, a request gets 402 with a Hebrew message before any model is called, and the upgrade dialog opens (its button leads to `CREDITS_UPGRADE_URL`, or it says to ask the admin). `GET /api/auth/me` includes the balance. Admins (`ADMIN_EMAILS`) aren't charged, and `CREDITS=off` turns credits off. `npm run credits -w server -- --email someone@example.com` shows an account's balance; `--add 100` (or a negative number) and `--set 50` change it.

**GitHub in the chat.** A message that mentions `@owner/repo`, `@owner/repo:path/to/file` or a github.com link (including a `/blob/…` file link) gets that repository's file tree (the first 300 paths), its README and the files it names, read with the GitHub token (so private repositories work), for that turn only. At most 3 repositories, 20,000 characters per file and 60,000 in total are sent. The message shows a chip with what was read.

## Media studio

The studio uses [Pollinations](https://pollinations.ai) (`gen.pollinations.ai`), one API for images, speech, music and video, with a secret key from [enter.pollinations.ai](https://enter.pollinations.ai/keys). Signing up needs no credit card, and registered accounts get a small daily Pollen grant. What that covers, as of September 2026:

- **Images:** plenty. Cheap models such as Flux Schnell (`black-forest-labs/flux.1-schnell`, the default) and Z-Image Turbo cost a tiny fraction of a Pollen per image; models marked **בתשלום** cost more.
- **Speech:** short texts are cheap. The default, ElevenLabs v3, speaks Hebrew.
- **Music and video:** premium models (ElevenLabs Music, Lyria, Stable Audio; Wan, Seedance, Veo) that a free daily grant may not cover even once. When the Pollen runs out, Pollinations answers 402 and the studio says so in Hebrew.

Model lists come from Pollinations' live catalogue. Pollinations renamed its models in September 2026 (`flux` became `black-forest-labs/flux.1-schnell`); the old names still work, and there is no model called `lsr`. Hugging Face's serverless musicgen, bark and video endpoints no longer exist (its free tier is now about $0.10 of credit a month, spent at partner providers), so the studio doesn't use them. Generated files are saved in `server/storage/media`, served with a restrictive Content-Security-Policy, and videos can be seeked.

## Link previews

You can type `example.com`, `localhost:3000` or a full URL. Stash adds `https://` (or `http://` for local addresses), removes any `user:password@` part, and refuses anything that isn't a web address. It then fetches the page and reads the Open Graph and Twitter tags, falling back to `<title>` and the meta description. The icon is the Apple touch icon, the largest declared icon, or `/favicon.ico`. Site names repeated in titles, as in "GitHub - …", are removed.

At most 2 MB of each page is read (it stops at `</head>`), up to 5 redirects are followed, and the page's character set is respected. When a preview can't be fetched (the site blocks it, the page is gone, the request times out, the domain doesn't exist), the link is saved anyway and its card says why. **Refresh preview** tries again.

## API

Every response is JSON. Errors have the shape `{ "error": { "message": "…", "code": "…", "details": {} } }`, and the messages are written to be shown to people. Failed AI calls also carry the provider's own text in `details.detail`, and the explain routes answer 503 (`AI_BUSY` or `AI_RATE_LIMITED`) when the model stayed busy after the retries.

Every route except `/api/health` and `/api/auth/config` needs a signed-in account: `Authorization: Bearer <Supabase access token>`, or for GET and HEAD the session cookie; otherwise 401 (`UNAUTHENTICATED`, or `SESSION_EXPIRED`). Projects, GitHub, links and files are for admins (`ADMIN_EMAILS`); other accounts get 403 `ADMIN_ONLY`. Conversations, attachments, ZIPs, media and memories belong to whoever made them, and someone else's answer 404.

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/health` | Status, AI provider and model, upload limits |
| GET | `/api/auth/config` | Public: the Supabase project URL and publishable key the app signs in with |
| GET | `/api/auth/me` | The signed-in account: id, email, name, admin or not, plan |
| POST | `/api/auth/session` | Sets the session cookie from the bearer token (after signing in and every refresh) |
| DELETE | `/api/auth/session` | Removes the session cookie (signing out) |
| GET | `/api/projects` | All projects, newest first |
| POST | `/api/projects` | Upload a ZIP (`multipart/form-data`, field `archive`) and analyze it |
| GET | `/api/projects/:id` | One project |
| PATCH | `/api/projects/:id` | Edit `title` (≤ 120 characters), `description` (≤ 600), `tags` (≤ 12, each ≤ 30) |
| POST | `/api/projects/:id/reanalyze` | Analyze the archive again (replaces edits) |
| GET | `/api/projects/:id/download` | The original ZIP |
| DELETE | `/api/projects/:id` | Delete the project, its archive and its file explanations |
| GET | `/api/projects/:id/files` | Folder tree of the archive (dependency folders are counted, not listed) |
| GET | `/api/projects/:id/files/content?path=` | One text file, raw (`text/plain; charset=utf-8`), up to 1 MB |
| POST | `/api/projects/:id/files/explain` | `{ "path": "…", "refresh": false }` → Hebrew AI explanation of the file; cached, `refresh` asks again |
| GET | `/api/projects/:id/preview` | How the project can be previewed: the live site, or a reason, run commands and the README |
| GET | `/api/projects/:id/serve/*` | Any file of the archive, as a static server; `?download=1` downloads it |
| GET | `/api/github/status` | GitHub connection: user, token source, last four characters of the token, rate limit |
| PUT | `/api/github/token` | `{ "token": "…" }`: check it with GitHub, then save it |
| DELETE | `/api/github/token` | Remove the saved token |
| GET | `/api/github/repos` | Your repositories, with saved analyses merged in |
| POST | `/api/github/analyze/:repo` | Analyze one of your repositories (Hebrew title, description and tags); `/api/github/analyze/:owner/:repo` for any repository the token can read |
| PATCH | `/api/github/repos/:owner/:repo` | Edit an analysis (same fields as projects) |
| GET | `/api/github/repos/:owner/:repo/files` | Folder tree of the default branch |
| GET | `/api/github/repos/:owner/:repo/files/content?path=` | One text file, raw, up to 1 MB |
| POST | `/api/github/repos/:owner/:repo/files/explain` | `{ "path": "…", "refresh": false }` → Hebrew AI explanation, cached per file version |
| GET | `/api/github/repos/:owner/:repo/preview` | The website (homepage or Pages, with the framing check), or a reason, run commands and the README |
| GET | `/api/github/repos/:owner/:repo/raw/*` | One file's bytes (images, downloads), sandboxed; `?download=1` downloads it |
| GET | `/api/chat/catalog` | Both workspaces: the configured free providers with their live models, the premium models (with provider, relative price, what they accept, availability and the key each needs), the handoff default and its cheap model, the development team (its architect and fallback, the two builder lanes, the reviewer, and whether it's on), whether web research and the long-term memory are available, the attachment limits, the continuation limit, the effort levels and the memory settings |
| GET | `/api/chat/conversations` | Conversations, most recent first |
| POST | `/api/chat/conversations` | Start a conversation |
| GET | `/api/chat/conversations/:id` | One conversation with its messages and memory status |
| PATCH | `/api/chat/conversations/:id` | Rename: `{ "title": "…" }` |
| DELETE | `/api/chat/conversations/:id` | Delete a conversation, its ZIPs and its attachments |
| GET | `/api/chat/conversations/:id/usage` | The conversation's tokens and cost by model and by step, this month's and all conversations' totals, and when the prices were checked |
| GET | `/api/memory` | Your long-term memories (kept in PostgreSQL) and how they are searched |
| POST | `/api/memory` | Add one by hand: `{ "content": "…", "kind": "preference \| style \| rule \| fact", "project": "…" }` |
| PATCH | `/api/memory/:id` | Edit one: `{ content, kind, project }` |
| DELETE | `/api/memory/:id` | Forget one |
| DELETE | `/api/memory` | Forget everything |
| POST | `/api/chat/conversations/:id/messages` | `{ content \| regenerate, workspace: free \| premium, effort: low \| medium \| high \| extra \| max, premiumModel: auto \| <id>, emergency, handoff, pipeline, research, memory, attachments: [<id>], freeMode: auto \| brainstorm \| manual, provider, model }` → JSON lines: `start`, `context`, `route`, `research`, `recall`, `stage`, `team`, `retry`, `reasoning`, `expert`, `continue`, `text`, `usage`, `bundle`, then `done` or `error`, then `memory` when the conversation was compacted; `artifact: { id }` asks the development team to edit that generated project |
| GET | `/api/chat/conversations/:id/memory` | `project_state.md` and its status; `?download=1` downloads the file |
| POST | `/api/chat/conversations/:id/memory/compact` | Update `project_state.md` now |
| GET | `/api/chat/bundles/:id` | A packaged code answer (ZIP), rebuilt from the answer if it expired |
| GET | `/api/chat/runs/:id/events` | A development-team run, live, for its dashboard: Server-Sent Events (`snapshot`, then `patch` events, then `end`). Signed in by the session cookie; the run's owner only, 404 for anyone else or a run that ended more than ten minutes ago |
| GET | `/api/chat/conversations/:id/artifacts/:artifactId` | A generated project: its files at a version (`?version=N`, the latest by default) with what each is for, and its live preview |
| GET | `/api/chat/conversations/:id/artifacts/:artifactId/preview` | Its live preview: `live`, `starting`, `updating`, `failed`, `unavailable` or `expired`, its address and when it ends, and whether it can be brought back |
| POST | `/api/chat/conversations/:id/artifacts/:artifactId/preview` | Bring a preview that ended back from the latest version (a new sandbox, `npm install`, the dev server), in the background |
| POST | `/api/chat/attachments` | Upload an image (up to 5 MB) or a video (up to 100 MB) for the next message: `multipart/form-data` with the field `file` → `{ attachment: { id, name, mime, kind, size, url } }`. Other types get 415 |
| GET | `/api/chat/attachments/:id` | The attachment, served with `Content-Security-Policy: sandbox` and `nosniff` |
| DELETE | `/api/chat/attachments/:id` | Remove an attachment that hasn't been sent |
| GET | `/api/media/options` | Whether Pollinations is configured; models per kind, voices, aspect ratios, video lengths |
| GET | `/api/media` | Generated media, newest first |
| POST | `/api/media/generate` | `{ kind: image \| speech \| music \| video, prompt, model?, aspect?, seed?, safe?, voice?, duration?, audio? }` |
| GET | `/api/media/:id/file` | The file, inline; `?download=1` downloads it |
| DELETE | `/api/media/:id` | Delete a generated file |
| GET | `/api/links` | All links |
| POST | `/api/links` | Save `{ "url": "…" }` and fetch its preview; `409 DUPLICATE` if it's already saved |
| POST | `/api/links/:id/refresh` | Fetch the preview again |
| DELETE | `/api/links/:id` | Delete a link |
| GET | `/api/files` | All files |
| POST | `/api/files` | Upload files (field `files`, up to 20 per request) |
| GET | `/api/files/:id/download` | Download with the original name |
| GET | `/api/files/:id/preview` | Inline preview of a raster image |
| DELETE | `/api/files/:id` | Delete a file |

## Security

Every API request except health and the sign-in settings needs a Supabase account:

- **Accounts.** Tokens are verified on every request: the signature (the project's public keys, or the legacy secret), the issuer, the audience and the expiry; anonymous sign-ins are refused. Passwords never reach Stash: signing up, in, out and resetting happen between the browser and Supabase.
- **Each person's data.** Conversations and memories are rows carrying their owner's user id, and every query filters by it, down to single-row updates and deletes. Attachments, ZIPs and media records carry an owner id, checked before a file is served or used. Someone else's item answers 404, so an id reveals nothing. The tests check this through the API, in the database rows, and in what the answering model and the memory learner are shown.
- **The session cookie** is httpOnly, `SameSite=Lax`, limited to `/api`, `Secure` over HTTPS, and accepted only for GET and HEAD: it can load an image or a download, but can't change anything.
- **Admins only.** Projects, GitHub (which works with the server's token), links and files keep one shared store, so only `ADMIN_EMAILS` can reach them.
- **The database.** Row level security is on for every table, with no policies: Supabase's Data API, which anyone with the publishable key can call, sees no rows. The server's own credentials stay in `server/.env`.
- **Hosts and other sites.** The server listens on `127.0.0.1` unless `HOST` says otherwise. Requests whose `Host` header isn't `localhost`, an IP address or an `ALLOWED_HOSTS` entry are refused, which stops websites you visit from reaching it through DNS rebinding. Changes coming from other websites (`Sec-Fetch-Site: cross-site`) are refused too.
- **Uploads.** ZIPs are never extracted and sizes are capped. Files are stored under random names and always downloaded as attachments. Previews exist only for raster images and are sent with `Content-Security-Policy: default-src 'none'` and `X-Content-Type-Options: nosniff`. SVGs are download-only, because they can contain scripts.
- **Live previews.** A previewed site runs on its own origin (`p-<id>.localhost`), so it can't read the dashboard, its storage or its API. That origin only ever serves files from the archive, never the API, and it answers only GET and HEAD. The dashboard's writes require same-origin requests, so a site in the preview can't trigger them. Files served through `/api/projects/:id/serve/…` share the dashboard's origin, so documents there get a CSP sandbox (an opaque origin, no access to the dashboard). CORS is open on that route so a sandboxed page's module scripts and fonts still load; project ids are random UUIDs, and the server only listens on this computer.
- **Generated projects.** Their code only ever runs in the sandbox. A live preview is served on its own origin, `http://s-<token>.localhost:<port>/`, where the token is 128 random bits given only to the project's owner and dead with the preview: the app can't read the dashboard's storage, cookies or API, and only Stash may frame it (the proxy replaces the app's `frame-ancestors`, drops `X-Frame-Options` and keeps the rest of its policy). The proxy reaches the dev server through `docker exec` into the container, or through E2B's private endpoint with an access token that stays on the server, so nothing in the sandbox is opened to the network.
- **Code and README views.** File content is shown as text, never run. Markdown is rendered without its raw HTML, and highlighted code is escaped. Explanations only ever send the one file you asked about, cut to 16,000 characters.
- **Link fetching (SSRF).** Before a page is fetched, its host name is resolved and every address must be public: loopback, private, link-local (including the cloud metadata address `169.254.169.254`), carrier-grade NAT and similar ranges are refused, and the check is repeated for every redirect. In theory a DNS answer could change between the check and the connection; for a local single-user app the risk is small, and `ALLOW_PRIVATE_NETWORK_URLS` stays off unless you want previews of LAN pages.
- **GitHub token.** The token is only ever sent to `api.github.com`, is stored readable by your user only, and never reaches the browser. Saving or removing it is a write, so like every change it must come from the dashboard itself. Stash only reads from GitHub; it never writes to your repositories.
- **AI privacy.** With AI enabled, the README, manifests and file list of each project or repository you analyze go to every ensemble provider, each file you ask to have explained goes to the primary provider (or a fallback), and chat messages go to the models that answer them (several providers at once in Brainstorm and at Max effort; the router also sends premium messages to Gemini Flash to be rated). Every 10 turns, a conversation goes to a fast model to update its memory, and the files of GitHub repositories you mention are sent with that message. Studio prompts go to Pollinations. Nothing is sent with `AI_PROVIDER=none` and no media key.
- **Generated media.** Files from the studio are served with `Content-Security-Policy: default-src 'none'; sandbox` and `nosniff`, so a generated SVG or any other file can't run scripts.
- **Chat attachments.** Only images and videos of known types are accepted. They are stored under random names, served back with `Content-Security-Policy: sandbox` and `nosniff`, and sent to the model that answers: images to that model's provider, videos to Google's Gemini API (large ones as Gemini files, which Google deletes after 48 hours).

## Tests

```bash
npm test
```

204 tests using Node's built-in test runner. The suites that need the database run on PGlite (PostgreSQL compiled to WebAssembly) with the real migrations, a fresh one per test file, so no database server is needed; every request is signed in with a test token. They cover accounts and privacy (tokens checked with the project's public keys, fetched once; legacy tokens confirmed by Supabase Auth once a minute; expired, forged, foreign and anonymous tokens refused; the cookie that reads but never writes; the admin gate; and one person's conversations, attachments, ZIPs, usage totals and memories invisible to another, in the API, in the database rows, and in what the answering model and the memory learner are shown), archive scanning (wrapper folders, skipped folders, zip-slip entries, damaged and empty archives, Hebrew text), title fallbacks, project kinds, the fingerprint, URL normalisation, the SSRF address checks, preview text cleanup, the Hebrew rule in the AI prompt and the checks on the model's answer, the workspace (file tree, code content, the serve route, preview planning and the preview origin), Hebrew file explanations with Gemini's API stubbed (success, cache, refresh, rejecting English answers), the GitHub tab with GitHub's API stubbed (token checks and private storage, repositories and ETags, analysis in Hebrew, edits, files, the framing check, rate-limit and not-found errors), the AI client's retries (a 503 until the model answers, giving up with a Hebrew message, Gemini's `RetryInfo` and `Retry-After`, quotas that fail at once, dropped connections, no retries for client errors, and `GEMINI_MODEL`), the AI ensemble (concurrent answers, skipped failures, synthesis and its fallback, parameter relaxing), the AI workspace with every provider stubbed (the catalog, a chosen premium model, the auto-router's rating and tiers, emergency mode forcing Fable 5.1, High effort's reflection, Max effort's experts and Hebrew synthesis, the free workspace's chosen model, Brainstorm and Auto-Free, retries before the first word, broken and empty streams, regenerate, refusals in Hebrew), the AI gateway (an answer cut off at the length limit continued on DeepSeek on the same stream, with a clean seam and whole files in the ZIP; the seam's rules for restarted and repeated lines; the continuation limit; cost-aware routing to Haiku, Sonnet, Opus and DeepSeek; the handoff after the first answer and when it is skipped; each provider's cheaper models; images as Base64 for Anthropic and OpenAI; video inline and through Gemini's Files API; refusals in Hebrew; an expired ZIP rebuilt), the per-chat token and cost meter (prices, every model call of a turn, conversation totals), the swarm (the architect's JSON blueprint and what its validation refuses, one repair and then Opus 5.5, no file written without a plan; one micro-agent per file on two providers, never more than the concurrency at once, a cut-off file continued and a stray fence removed, each agent seeing the interfaces it imports; the QA compiler's parser checks one by one, with no false alarms on a to-do app, an HTML placeholder attribute or a typeof guard; the reviewer's imagined issue dropped; one fix round with the error log, and a file three rounds can't fix reported in QA_REPORT.md; the ZIP, the added package, the timeline, the cost by role, and when the team isn't used; the live dashboard's run over Server-Sent Events: its whole state, then patches that rebuild exactly the state saved with the answer, never more files at once than the concurrency, the file tree while it's planned, a file seen writing, flagged and correcting itself with its attempt and error line, the owner only, a late listener, and a member's charge with the balance before and after), the sandbox (the steps planned from the package.json files; the real messages of Vite, esbuild, tsc, Node, node:test and npm, captured from the tools, read back into the files that must change; install repairs and version pins; the triage of a failing test; the network cut before the project runs; the Docker provider through a stand-in CLI and E2B through a stand-in SDK; admins only, and at most `SANDBOX_MAX_RUNS` at once; and through the chat, one fix round from real errors, a member's static-only answer and a Docker that isn't running), live previews and edits (the dev server a project runs; a patch checked against the blueprint and applied to it, including a deletion that breaks an import; a project's versions rebuilt from its answers; and through the chat, a project left running on its own origin, its page, requests and WebSockets passed through the proxy with only Stash allowed to frame it, its files for its owner only, an edit that rewrites one file in the same sandbox without reinstalling and shows it at the same address with a ZIP of the whole project, and a preview that ended brought back), credits (50 for a new account and the balance in `/me`, a credit an answer and none in the free workspace, 402 before anything runs, the team's credit per file taken once its plan is ready and nothing charged when the balance is short, failed work free, two answers at once never spending the same credit, admins free, the media studio's credit an item, and the credits script), the thinking reserve for OpenAI and Gemini, web research (when the router asks for it, what Tavily is sent, the cleaned pages as data in the answer's instructions, the saved sources and their cost, the cache, searches that are off, unneeded or failed, a hand-picked model searching by its words, the architect getting the results), the long-term memory (its API with Hebrew errors and refused secrets, recall by meaning, by words at no cost in the free workspace and by project name, learning with confirmations, replacements and no secrets, the learner's cost, and vectors kept as float32 bytes in PostgreSQL), memory and code (`project_state.md` every N turns and the smaller context after it, downloading and updating it, finding file paths in code blocks, the ZIP and its name, GitHub context from a private repository), configuration (example values ignored, `AI_PROVIDERS`), the media studio (catalogue, image, speech, music and video requests, file serving with ranges, Pollen and busy errors), and a run through the real HTTP app: upload, edit, download and delete a project, file previews, duplicate links, Hebrew error messages, and the Host and cross-site guards.

### Checking the AI features with your own keys

`npm run smoke` runs the AI gateway against the real providers, with the keys in `server/.env`. Every check uses short prompts, capped answers and each provider's cheapest model: a few thousand tokens in all (the optional team check uses the team's own models, and web research costs one Tavily credit).

1. **Model ids.** Every premium model in the catalog is listed by its provider. An id that isn't listed is a warning, since an alias can still work.
2. **Length limit.** Each provider reports that it stopped at the limit, which is what starts an automatic continuation.
3. **Auto-continue.** A 500-line answer is cut off on purpose at 600 tokens and continued (on the cheap model when the handoff is on). The check confirms that the streamed text is the saved answer, no code block is left open, both files are found, and the numbers 1 to 500 have no gaps or repeats at the seams.
4. **Images.** Each provider's cheapest vision model sees a generated red image and must name the color.
5. **Router.** What the auto-router picks for four sample Hebrew requests, and the model that the handoff and continuations go to.
6. **Video.** With `npm run smoke -- --video path/to/clip.mp4`, Gemini Flash describes the video: inline, or through Gemini's Files API when the file is large or with `--files-api`.
7. **The development team.** With `npm run smoke -- --team`, one small project (a click counter with an Express server) goes through the real swarm: each step's model and note (the files planned and written, the QA result, the fix rounds), a fallback architect that took over (⚠), problems left after the fix rounds (⚠), the files found and the cost, a few cents.
8. **Web research.** One Tavily search: how many results came back, how many with the page's text, and the credits used.
9. **Accounts and the database.** Supabase answers with the project's public keys (or the legacy secret is set), the publishable key works (and whether sign-up and email confirmation are on), and who the admins are; PostgreSQL's version, every migration applied, how many users, conversations and memories there are, and row level security on every table.
10. **Long-term memory.** The embedding model scores two related sentences above its threshold and an unrelated one below them; and which model learns.
11. **The sandbox.** With `npm run smoke -- --sandbox` and `SANDBOX` set, a tiny project (a server and a test) is installed, tested and started in the sandbox, and a request from the project after the install must fail, since its internet is off.

Each check prints ✓, ⚠ (worth a look), ✗ or – (skipped), and the command exits with 1 when a check failed. Keys are never printed.

## Limitations and ideas

- Conversations and memories are in PostgreSQL, but projects, links, files and the records of attachments, ZIPs and media are still one JSON file, and their files are on the server's disk. That assumes one server process: before running several, move those records into the database and the files into shared storage.
- Projects, GitHub, links and files are single-person tools, for admins. Making them per-account means moving their store into the database too.
- `adm-zip` loads the whole archive into memory, which is why archives are capped at 250 MB by default. A streaming reader such as `yauzl` would use less memory for very large archives.
- Signing in is by email and password. Google, GitHub or magic-link sign-in would be a switch in Supabase and a button in `AuthScreen.jsx`.
- An uploaded project's live preview is static: server code (Node, Python, PHP) doesn't run, and the isolated preview needs a browser that resolves `*.localhost`. (A generated project's preview runs its dev server in the sandbox.)
- GitHub: only the default branch is shown, up to 300 repositories are listed, and for very large repositories (GitHub truncates trees above 100,000 files) the analysis uses the part GitHub returns. Sites that refuse to be framed open in a new tab.
- AI keys are read from `server/.env` when the server starts, so restart it after changing them. Free tiers change often: OpenRouter's free models rotate and Gemini's model names change, hence the `latest` and `free` defaults. The premium sheet's model ids are fixed in `server/src/services/ai/catalog.js`, so a retired model needs an edit there.
- The chat was tested against stand-ins for every provider, not the live services, so expect differences in how real models format their answers. That includes the development team, the sandbox (a stand-in Docker CLI and E2B SDK), the handoff, the continuation seam and the upload to Gemini's Files API: run `npm run smoke` (and `npm run smoke -- --team --sandbox`) to check them with your own keys and your own Docker or E2B (see [Checking the AI features with your own keys](#checking-the-ai-features-with-your-own-keys)).
- The import script reads the previous version's `memory.db` with Node's built-in SQLite, which Node still labels experimental (it prints a one-line warning).
- The long-term memory belongs to one person (every memory's owner is `local`, and the column is ready for accounts). The learner can miss a preference or misread one: check **מה למדתי עליך** now and then. How similar a memory must be to count is a threshold per embedding provider, checked by `npm run smoke`.
- Web research needs a Tavily key, and its results are only as current and correct as the pages Tavily finds; the sources are listed under each answer so they can be checked.
- Without the sandbox, the development team's QA is static: the parser and the reviewer read the code but don't run it. With it, the project is installed, built, tested and started, but only what its package.json files make runnable, and only on a server: what happens in a browser (a React screen, a WebGL scene) isn't run, and a server that needs a database or keys can't start without them. No model pipeline can promise zero errors: what the fix rounds can't fix is reported, not hidden. A package a file uses that the blueprint forgot is added as `latest`, and pinned only when the sandbox installs it. Access to Docker is root on its host, so give Stash a separate sandbox host (or use E2B); the sandbox adds minutes to a team answer. A team answer takes longer and costs more than one model's, growing with the number of files and the fix rounds (`PIPELINE_MAX_FILES`, `PIPELINE_QA_ROUNDS` and the switch in the model sheet keep that in check). GPT-5.6 Sol's price is promotional: when it changes, `MODEL_PRICES` updates the meter.
- The live dashboard's runs are kept in the server's memory, which assumes one server process (as the JSON store does) and loses a run in progress if the server restarts; the saved answer keeps its final state. A finished run can still be listened to for ten minutes. A run belongs to the request that started it, so leaving or reloading the page in the middle stops it, as before.
- Live previews of generated projects are kept in the server's memory too: a restart ends them (**הפעלה מחדש** brings one back), and they assume one server process. Their frame needs a browser that resolves `*.localhost` (Chromium-based browsers do). A project with nothing to serve (no Vite or Next dev script and no server to start) has no preview, only its code. The E2B side of previews (a background process, its port's endpoint, a longer timeout) follows E2B's SDK documentation but hasn't run against E2B, not even through the stand-in SDK the other E2B tests use.
- Dictation uses the browser's own speech recognition (the Web Speech API). It works in Chrome, Edge and Safari but not in Firefox, where the microphone button is hidden; Chrome sends the audio to Google to recognize it, and it needs HTTPS or localhost.
- **שיתוף** (Share) exports a conversation as Markdown. A public share link would need accounts on the server, which Stash doesn't have yet.
- Attachments work only in the premium workspace, and video only with Gemini: the chat APIs of OpenAI, Anthropic and DeepSeek don't take video. Kimi's models are treated as text-only.
- The prices in the model sheet are relative tiers based on public price lists (September 2026), not live prices. A handed-off or continued answer may differ in style from the chosen model's.
- `project_state.md` is written by a small, fast model, so details can be lost in the summary; open **זיכרון** to check it, and the older messages are still in the conversation.
- The interface is a responsive web app that works in a phone's browser; there is no native (Expo) app.
- Media: music and video need more Pollen than a free daily grant gives; the studio can't make them free. Pollinations' MP4 videos use H.264, which Chrome, Edge, Safari and Firefox play (open-source Chromium builds don't).
- Ideas: attaching a ZIP project or an uploaded file to a chat, choosing a branch for repositories mentioned in the chat, saving studio results to Files, filter by tag or kind, sorting options, choosing a branch for GitHub repositories, PDF and video thumbnails, bulk actions.

## Screenshots

![Signing in: accounts with Supabase Auth](docs/screenshots/auth-signin.png)

<img src="docs/screenshots/auth-signin-phone.png" alt="Signing in on a phone" width="390">

![A member's view: the chat and the media studio, with the account menu at the bottom of the conversation list](docs/screenshots/account-menu.png)

![The AI workspace: history grouped by date, and the floating message box with its model pill](docs/screenshots/chat.png)

<img src="docs/screenshots/chat-sheets.png" alt="The model and effort sheet on a phone: every provider's models with their relative price" width="390">

![A code answer with its files in a ZIP](docs/screenshots/chat-code.png)

![The development team's live dashboard while it plans: the file tree drawn as the architect's JSON arrives, in blue](docs/screenshots/chat-team-plan.png)

![Writing in parallel: a card per file, six at work at once in the eight slots of PIPELINE_CONCURRENCY, in yellow](docs/screenshots/chat-team.png)

![Self-correction: a file sent back by the code check, in orange, with its attempt (1/3), the line and the error](docs/screenshots/chat-team-fix.png)

![Done: every phase checked, and the planned tree with what each file is for](docs/screenshots/chat-team-done.png)

![A member's run: without the sandbox the project's panel opens on its code; 7 credits for the 7 files of the plan, and the balance counted down from 50 to 43](docs/screenshots/chat-team-credits.png)

![With the sandbox on: the code check, then Docker's install, build and start, each with its result, the file that corrected itself, and the last phase, the project running live](docs/screenshots/chat-team-sandbox.png)

![The project, live: what the team built, running in its sandbox and shown at a desktop's width shrunk to fit, with the code tab, the ZIP and the edit box](docs/screenshots/chat-team-preview.png)

![The same preview at a phone's width: the app sees 390 pixels](docs/screenshots/chat-team-preview-phone.png)

![The code tab: this version's files as a tree, highlighted, with copy and download](docs/screenshots/chat-team-code.png)

![An edit: the architect's patch changes one file, the team rewrites it in the same sandbox, and the preview shows version 2 at the same address](docs/screenshots/chat-team-edit.png)

![Web research: the sources an answer was given, with links](docs/screenshots/chat-sources.png)

![The long-term memory: what was learned, grouped by kind, to add, edit or delete](docs/screenshots/chat-memory.png)

![Emergency mode: every message goes to Fable 5.1](docs/screenshots/chat-emergency.png)

<img src="docs/screenshots/chat-history-phone.png" alt="Conversation history on a phone, with a conversation's Share, Rename and Delete menu" width="390">

![The media studio](docs/screenshots/media.png)

![GitHub repositories](docs/screenshots/github.png)

![A GitHub repository in the workspace](docs/screenshots/github-repo.png)

![Project files with an AI explanation](docs/screenshots/workspace-files.png)

![Live preview, dark theme](docs/screenshots/workspace-preview-dark.png)

![Files, dark theme](docs/screenshots/files-dark.png)
