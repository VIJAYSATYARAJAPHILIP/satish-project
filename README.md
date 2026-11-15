# Kakinada Plots — Full-stack demo

Node.js 22.5+ static site and API. Uses Node's built-in `node:sqlite`; no npm dependencies are required.

## Start the project

Open a terminal in this folder and run `npm run setup` on Windows. It asks for a new owner password privately and generates the session secret. Then run `npm start` and open the local URL printed by the server. Do not double-click `index.html`; API-backed bookings and owner tools need the server running.

## Local setup

1. On Windows, run `npm run setup`; on other systems, copy `.env.example` to `.env`.
2. Set `OWNER_PASSWORD` to the password you want to use (at least 10 characters). For a public production website, prefer a longer unique password.
3. Set `SESSION_SECRET` to a random secret of at least 32 characters. Generate one with `node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"`.
4. From the `site` directory, run `npm start` and open `http://localhost:3000`.

The SQLite database and uploaded images are written to `data` and `uploads` beside `server.mjs` by default. Keep these out of Git. Configure `DATA_DIR` and `UPLOADS_DIR` to persistent storage locations on your host; ephemeral server disks will lose data on restart/redeploy.

## Features

- Public customer listing page and booking request form.
- Private owner session using an HttpOnly, SameSite cookie; owner endpoints require that session and login attempts are rate limited.
- Listing editing, direct photo upload (JPG/PNG/WebP, 5 MB maximum), and public HTTPS image URLs.
- Booking requests stored in SQLite. Accepting one reserves the listing and declines other pending requests for that plot; owner can mark it sold or release it.
- CSRF origin check, parameterized SQL, validation, and server-side password hashing.

## Deployment

Deploy the application folder containing `server.mjs` to a Node.js host with Node 22.5 or later. Set `OWNER_PASSWORD`, `SESSION_SECRET`, `NODE_ENV=production`, `PORT` as required, and persistent `DATA_DIR` / `UPLOADS_DIR` volumes. Use HTTPS at the hosting provider or reverse proxy. The `.env` file is for local development and must not be committed.

A static-only host such as GitHub Pages cannot run this backend. The server serves the customer and owner interface from `public/`; do not deploy that folder alone if you need shared bookings and secured owner management.
