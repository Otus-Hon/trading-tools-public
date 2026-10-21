# Open Server Instructions

When asked to "open server" for this project, do only this:

1. Start the app server from the project root:

   ```bash
   nvm use
   npm run dev
   ```

   The `predev` check automatically verifies or rebuilds `better-sqlite3` for the active Node runtime before the server starts. Do not bypass this check by invoking `next dev` directly.

   This starts the Next.js web app on `http://localhost:3000`. Image-search and image-processing services are not part of the open-source app.

2. Open only the main web app:

   ```bash
   open http://localhost:3000
   ```

Do not open API docs, health endpoints, upload pages, Swagger pages, network URLs, or multiple browser tabs unless the user explicitly asks for them.

If port `3000` is already serving the app, do not restart it. Just open `http://localhost:3000`.
