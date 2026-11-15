# Kakinada Plots — Full-stack demo

Node.js 22.5+ static site and API. Uses Node's built-in `node:sqlite` and Nodemailer for reset-code email.

## Start the project

Open a terminal in this folder and run `npm install`. On Windows run `npm run setup`; it asks for an owner password privately and generates the session secret. Configure SMTP as described below, then run `npm start` and open the local URL printed by the server. Do not double-click `index.html`; API-backed bookings and owner tools need the server running.

## Local setup

1. On Windows, run `npm run setup`; on other systems, copy `.env.example` to `.env`.
2. Set `OWNER_PASSWORD` to the password you want to use (at least 10 characters). For a public production website, prefer a longer unique password.
3. Set `SESSION_SECRET` to a random secret of at least 32 characters. Generate one with `node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"`.
4. From the `site` directory, run `npm start` and open `http://localhost:3000`.

The SQLite database and uploaded media are written to `data` and `uploads` beside `server.mjs` by default. Keep these out of Git. Configure `DATA_DIR` and `UPLOADS_DIR` to persistent storage locations on your host; ephemeral server disks will lose data on restart/redeploy.

## Email password reset

The owner recovery code is addressed to `OWNER_EMAIL` (default: `vjvijay2025@gmail.com`). To deliver it, configure the SMTP values in `.env` or your hosting provider’s secret settings. For Gmail, enable 2-Step Verification and create an App Password; set `SMTP_HOST=smtp.gmail.com`, `SMTP_PORT=465`, `SMTP_SECURE=true`, `SMTP_USER` to the sending Gmail account, `SMTP_PASSWORD` to its App Password (not the Gmail sign-in password), and `MAIL_FROM` to that account. Never commit SMTP credentials. The app stores only a hashed, expiring six-digit code, limits attempts, and invalidates owner sessions after a successful reset. Until SMTP credentials are configured, the recovery form reports that email delivery is unavailable.

## Features

- Public customer listing page and booking request form.
- Private owner session using an HttpOnly, SameSite cookie; owner endpoints require that session and login attempts are rate limited.
- Listing editing, up to 8 uploaded photos/videos per listing (JPG/PNG/WebP up to 5 MB each; MP4/WebM/MOV up to 20 MB each), and public HTTPS image URLs.
- Owner listing removal from customer pages while retaining existing booking history.
- Owner password recovery via a one-time email code when SMTP is configured.
- Booking requests stored in SQLite. Accepting one reserves the listing and declines other pending requests for that plot; owner can mark it sold or release it.
- CSRF origin check, parameterized SQL, validation, and server-side password hashing.

## Deployment

Deploy the application folder containing `server.mjs` to a Node.js host with Node 22.5 or later. Set `OWNER_PASSWORD`, `OWNER_EMAIL`, `SESSION_SECRET`, all required SMTP settings, `NODE_ENV=production`, `PORT` as required, and persistent `DATA_DIR` / `UPLOADS_DIR` volumes. Use HTTPS at the hosting provider or reverse proxy. The `.env` file is for local development and must not be committed.

A static-only host such as GitHub Pages cannot run this backend. The server serves the customer and owner interface from `public/`; do not deploy that folder alone if you need shared bookings and secured owner management.
