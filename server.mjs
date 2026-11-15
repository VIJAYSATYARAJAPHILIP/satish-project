import {
  createHmac,
  randomBytes,
  scryptSync,
  timingSafeEqual,
} from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { extname, join, normalize, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import nodemailer from "nodemailer";

const ROOT = fileURLToPath(new URL(".", import.meta.url));
try {
  process.loadEnvFile(join(ROOT, ".env"));
} catch (error) {
  if (error.code !== "ENOENT") throw error;
}

const PUBLIC_DIR = join(ROOT, "public");
const DATA_DIR = resolve(ROOT, process.env.DATA_DIR || "data");
const UPLOADS_DIR = resolve(ROOT, process.env.UPLOADS_DIR || "uploads");
const DB_PATH = join(DATA_DIR, "plots.sqlite");
const PORT = Number(process.env.PORT || 3000);
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const RESET_CODE_TTL_MS = 10 * 60 * 1000;
const RESET_CODE_COOLDOWN_MS = 60 * 1000;
const RESET_CODE_MAX_ATTEMPTS = 5;
const MAX_JSON_BYTES = 80 * 1024 * 1024;
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const MAX_VIDEO_BYTES = 20 * 1024 * 1024;
const MAX_MEDIA_FILES = 8;
const OWNER_EMAIL = (process.env.OWNER_EMAIL || "vjvijay2025@gmail.com")
  .trim()
  .toLowerCase();

const ownerPassword = process.env.OWNER_PASSWORD;
if (
  !ownerPassword ||
  ownerPassword.length < 10 ||
  ownerPassword.startsWith("replace-")
) {
  console.error(
    "Set OWNER_PASSWORD in .env (use at least 10 characters) before starting the server.",
  );
  process.exit(1);
}
if (
  !process.env.SESSION_SECRET ||
  process.env.SESSION_SECRET.length < 32 ||
  process.env.SESSION_SECRET.startsWith("replace-")
) {
  console.error(
    "Set SESSION_SECRET in site/.env to a random value of at least 32 characters.",
  );
  process.exit(1);
}
await mkdir(DATA_DIR, { recursive: true });
await mkdir(UPLOADS_DIR, { recursive: true });

const db = new DatabaseSync(DB_PATH);
db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;
  CREATE TABLE IF NOT EXISTS listings (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    area TEXT NOT NULL,
    price REAL NOT NULL CHECK (price > 0),
    size REAL NOT NULL CHECK (size > 0),
    type TEXT NOT NULL,
    description TEXT NOT NULL,
    image TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'available' CHECK (status IN ('available', 'reserved', 'sold')),
    archived INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS bookings (
    id TEXT PRIMARY KEY,
    listing_id TEXT NOT NULL REFERENCES listings(id),
    customer_name TEXT NOT NULL,
    phone TEXT NOT NULL,
    message TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'accepted', 'declined')),
    created_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS bookings_status_created ON bookings(status, created_at DESC);
  CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT PRIMARY KEY,
    expires_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS owner_credentials (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    password_salt TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS password_reset_codes (
    email TEXT PRIMARY KEY,
    code_hash TEXT NOT NULL,
    expires_at INTEGER NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 0,
    sent_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS listing_media (
    id TEXT PRIMARY KEY,
    listing_id TEXT NOT NULL REFERENCES listings(id) ON DELETE CASCADE,
    url TEXT NOT NULL,
    media_type TEXT NOT NULL CHECK (media_type IN ('image','video')),
    position INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL
  );
`);

if (
  !db
    .prepare("PRAGMA table_info(listings)")
    .all()
    .some((column) => column.name === "archived")
) {
  db.exec(
    "ALTER TABLE listings ADD COLUMN archived INTEGER NOT NULL DEFAULT 0",
  );
}

if (!db.prepare("SELECT id FROM owner_credentials WHERE id = 1").get()) {
  const salt = randomBytes(32).toString("hex");
  const passwordHash = scryptSync(ownerPassword, salt, 64).toString("hex");
  db.prepare(
    "INSERT INTO owner_credentials (id,password_salt,password_hash,updated_at) VALUES (1,?,?,?)",
  ).run(salt, passwordHash, Date.now());
}

const starterListings = [
  [
    "sample-1",
    "Palm Grove Plots",
    "Sarpavaram",
    8,
    150,
    "Residential",
    "A sample starter plot in the Sarpavaram area of Kakinada.",
    "https://images.unsplash.com/photo-1500382017468-9049fed747ef?auto=format&fit=crop&w=1000&q=85",
  ],
  [
    "sample-2",
    "Lakeview Enclave",
    "Ramanayyapeta",
    14,
    180,
    "Residential",
    "An illustrative plot option in the Ramanayyapeta locality.",
    "https://images.unsplash.com/photo-1470770841072-f978cf4d019e?auto=format&fit=crop&w=1000&q=85",
  ],
  [
    "sample-3",
    "Coastal Garden Sites",
    "Vakalapudi",
    22,
    200,
    "Residential",
    "A demo listing for buyers exploring the Vakalapudi side.",
    "https://images.unsplash.com/photo-1448375240586-882707db888b?auto=format&fit=crop&w=1000&q=85",
  ],
  [
    "sample-4",
    "Sunrise County",
    "Turangi",
    38,
    240,
    "Residential",
    "A sample larger-format site in the Turangi area.",
    "https://images.unsplash.com/photo-1500530855697-b586d89ba3ee?auto=format&fit=crop&w=1000&q=85",
  ],
  [
    "sample-5",
    "Harbour View Layout",
    "Kakinada Rural",
    55,
    300,
    "Residential",
    "An illustrative plot for a higher-budget Kakinada search.",
    "https://images.unsplash.com/photo-1511497584788-876760111969?auto=format&fit=crop&w=1000&q=85",
  ],
  [
    "sample-6",
    "Green Acres Estate",
    "Samalkot",
    70,
    400,
    "Residential",
    "A demo premium-size plot option near Samalkot.",
    "https://images.unsplash.com/photo-1500382017468-9049fed747ef?auto=format&fit=crop&w=1000&q=85&sat=-18",
  ],
];
if (db.prepare("SELECT COUNT(*) AS count FROM listings").get().count === 0) {
  const insert = db.prepare(
    "INSERT INTO listings (id,title,area,price,size,type,description,image,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
  );
  const now = Date.now();
  for (const listing of starterListings)
    insert.run(...listing, "available", now, now);
}
db.prepare("DELETE FROM sessions WHERE expires_at <= ?").run(Date.now());

const loginAttempts = new Map();
const resetRequestAttempts = new Map();
const mimeTypes = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".mov": "video/quicktime",
  ".ico": "image/x-icon",
};

function json(response, status, body, extraHeaders = {}) {
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    ...extraHeaders,
  });
  response.end(JSON.stringify(body));
}

async function readJson(request) {
  const chunks = [];
  let length = 0;
  for await (const chunk of request) {
    length += chunk.length;
    if (length > MAX_JSON_BYTES)
      throw Object.assign(new Error("Request is too large."), { status: 413 });
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw Object.assign(new Error("Request body must be valid JSON."), {
      status: 400,
    });
  }
}

function cookieValue(request, name) {
  const cookies = request.headers.cookie || "";
  const part = cookies
    .split(";")
    .map((item) => item.trim())
    .find((item) => item.startsWith(`${name}=`));
  return part ? decodeURIComponent(part.slice(name.length + 1)) : "";
}

function sessionHash(request) {
  const token = cookieValue(request, "satish_session");
  return token
    ? createHmac("sha256", process.env.SESSION_SECRET)
        .update(token)
        .digest("hex")
    : "";
}

function isAuthenticated(request) {
  const hash = sessionHash(request);
  if (!hash) return false;
  const session = db
    .prepare("SELECT expires_at FROM sessions WHERE token_hash = ?")
    .get(hash);
  if (!session) return false;
  if (session.expires_at <= Date.now()) {
    db.prepare("DELETE FROM sessions WHERE token_hash = ?").run(hash);
    return false;
  }
  return true;
}

function requireOwner(request, response) {
  if (!isAuthenticated(request)) {
    json(response, 401, { error: "Owner sign-in required." });
    return false;
  }
  return true;
}

function checkSameOrigin(request) {
  const origin = request.headers.origin;
  if (!origin) return true;
  const host = request.headers["x-forwarded-host"] || request.headers.host;
  const protocol =
    request.headers["x-forwarded-proto"] === "https" || request.socket.encrypted
      ? "https"
      : "http";
  return origin === `${protocol}://${host}`;
}

function cookieHeader(value, maxAge) {
  const secure = process.env.NODE_ENV === "production" ? "; Secure" : "";
  return `satish_session=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${secure}`;
}

function resetCodeHash(email, code) {
  return createHmac("sha256", process.env.SESSION_SECRET)
    .update(`owner-password-reset:${email}:${code}`)
    .digest("hex");
}

function emailConfigured() {
  return Boolean(
    process.env.SMTP_HOST &&
    process.env.SMTP_PORT &&
    process.env.SMTP_USER &&
    process.env.SMTP_PASSWORD &&
    (process.env.MAIL_FROM || process.env.SMTP_USER),
  );
}

async function sendPasswordResetEmail(email, code) {
  if (!emailConfigured()) throw new Error("SMTP email settings are missing.");
  const port = Number(process.env.SMTP_PORT);
  const transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port,
    secure: process.env.SMTP_SECURE === "true" || port === 465,
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASSWORD },
    connectionTimeout: 10000,
    greetingTimeout: 10000,
    socketTimeout: 15000,
  });
  try {
    await transporter.sendMail({
      from: process.env.MAIL_FROM || process.env.SMTP_USER,
      to: email,
      subject: "Your Kakinada Plots password reset code",
      text: `Your owner password reset code is ${code}. It expires in 10 minutes. If you did not request this, ignore this email.`,
      html: `<p>Your owner password reset code is:</p><p style="font-size:28px;font-weight:700;letter-spacing:6px">${code}</p><p>This code expires in 10 minutes. If you did not request it, ignore this email.</p>`,
    });
  } finally {
    transporter.close();
  }
}

function validText(value, maxLength) {
  return (
    typeof value === "string" &&
    value.trim().length > 0 &&
    value.trim().length <= maxLength
  );
}

async function saveMediaFile(file) {
  if (!file || typeof file.dataUrl !== "string")
    throw Object.assign(new Error("Invalid uploaded media."), { status: 400 });
  const match = file.dataUrl.match(
    /^data:(image\/(?:jpeg|png|webp)|video\/(?:mp4|webm|quicktime));base64,([A-Za-z0-9+/=]+)$/,
  );
  if (!match)
    throw Object.assign(
      new Error("Use JPG, PNG, WebP, MP4, WebM, or MOV files."),
      { status: 400 },
    );
  const mimeType = match[1];
  const bytes = Buffer.from(match[2], "base64");
  const mediaType = mimeType.startsWith("video/") ? "video" : "image";
  const maxBytes = mediaType === "video" ? MAX_VIDEO_BYTES : MAX_IMAGE_BYTES;
  if (!bytes.length || bytes.length > maxBytes) {
    throw Object.assign(
      new Error(
        mediaType === "video"
          ? "Videos must be smaller than 20 MB each."
          : "Images must be smaller than 5 MB each.",
      ),
      { status: 413 },
    );
  }
  const validSignature =
    mimeType === "image/png"
      ? bytes
          .subarray(0, 8)
          .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
      : mimeType === "image/jpeg"
        ? bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff
        : mimeType === "image/webp"
          ? bytes.toString("ascii", 0, 4) === "RIFF" &&
            bytes.toString("ascii", 8, 12) === "WEBP"
          : mimeType === "video/webm"
            ? bytes.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]))
            : bytes.toString("ascii", 4, 8) === "ftyp";
  if (!validSignature)
    throw Object.assign(
      new Error("The uploaded file content does not match its file type."),
      { status: 400 },
    );
  const extension =
    mimeType === "image/jpeg"
      ? ".jpg"
      : mimeType === "image/png"
        ? ".png"
        : mimeType === "image/webp"
          ? ".webp"
          : mimeType === "video/mp4"
            ? ".mp4"
            : mimeType === "video/webm"
              ? ".webm"
              : ".mov";
  const filename = `${randomBytes(16).toString("hex")}${extension}`;
  await writeFile(join(UPLOADS_DIR, filename), bytes, { flag: "wx" });
  return { url: `/uploads/${filename}`, mediaType };
}

async function saveMediaFiles(body) {
  const files = Array.isArray(body.mediaFiles) ? [...body.mediaFiles] : [];
  if (body.imageData) files.unshift({ dataUrl: body.imageData });
  if (files.length > MAX_MEDIA_FILES) {
    throw Object.assign(
      new Error(`Upload up to ${MAX_MEDIA_FILES} photos/videos per listing.`),
      { status: 400 },
    );
  }
  const encodedBytes = files.reduce((total, file) => {
    const dataUrl = typeof file?.dataUrl === "string" ? file.dataUrl : "";
    const comma = dataUrl.indexOf(",");
    return (
      total + (comma >= 0 ? Math.ceil((dataUrl.length - comma - 1) * 0.75) : 0)
    );
  }, 0);
  if (encodedBytes > 55 * 1024 * 1024) {
    throw Object.assign(
      new Error("The combined photo/video upload must be under 55 MB."),
      { status: 413 },
    );
  }
  return Promise.all(files.map(saveMediaFile));
}

function saveListingMedia(listingId, mediaFiles, imageUrl, firstImageUrl = "") {
  const items = [...mediaFiles];
  if (imageUrl && !items.some((item) => item.url === imageUrl))
    items.unshift({ url: imageUrl, mediaType: "image" });
  if (firstImageUrl && !items.some((item) => item.url === firstImageUrl))
    items.unshift({ url: firstImageUrl, mediaType: "image" });
  const existingUrls = new Set(
    db
      .prepare("SELECT url FROM listing_media WHERE listing_id=?")
      .all(listingId)
      .map((item) => item.url),
  );
  const insert = db.prepare(
    "INSERT INTO listing_media (id,listing_id,url,media_type,position,created_at) VALUES (?,?,?,?,?,?)",
  );
  const now = Date.now();
  items
    .filter((item) => !existingUrls.has(item.url))
    .forEach((item, index) =>
      insert.run(
        randomBytes(12).toString("hex"),
        listingId,
        item.url,
        item.mediaType,
        index,
        now,
      ),
    );
}

function listingInput(body) {
  const price = Number(body.price);
  const size = Number(body.size);
  if (
    !validText(body.title, 80) ||
    !validText(body.area, 80) ||
    !validText(body.type, 40) ||
    !validText(body.description, 180)
  ) {
    throw Object.assign(new Error("Fill in all listing fields."), {
      status: 400,
    });
  }
  if (
    !Number.isFinite(price) ||
    price < 1 ||
    price > 100000 ||
    !Number.isFinite(size) ||
    size <= 0 ||
    size > 100000
  ) {
    throw Object.assign(
      new Error("Enter a price of at least ₹1 lakh and a valid plot size."),
      {
        status: 400,
      },
    );
  }
  return {
    title: body.title.trim(),
    area: body.area.trim(),
    price,
    size,
    type: body.type.trim(),
    description: body.description.trim(),
  };
}

function publicListings() {
  const listings = db
    .prepare(
      "SELECT id,title,area,price,size,type,description,image,status FROM listings WHERE archived=0 ORDER BY created_at DESC",
    )
    .all();
  const media = db
    .prepare(
      "SELECT id,url,media_type AS mediaType,listing_id AS listingId FROM listing_media ORDER BY position,created_at",
    )
    .all();
  const byListing = new Map();
  for (const item of media) {
    const list = byListing.get(item.listingId) || [];
    list.push({ id: item.id, url: item.url, mediaType: item.mediaType });
    byListing.set(item.listingId, list);
  }
  return listings.map((listing) => {
    const gallery = byListing.get(listing.id) || [];
    if (listing.image && !gallery.some((item) => item.url === listing.image)) {
      gallery.unshift({ id: null, url: listing.image, mediaType: "image" });
    }
    return { ...listing, media: gallery };
  });
}

async function serveStatic(pathname, response) {
  let requested;
  try {
    requested = decodeURIComponent(pathname === "/" ? "/index.html" : pathname);
  } catch {
    json(response, 400, { error: "Invalid URL." });
    return;
  }
  const base = requested.startsWith("/uploads/") ? UPLOADS_DIR : PUBLIC_DIR;
  const relative = requested.startsWith("/uploads/")
    ? requested.slice("/uploads/".length)
    : requested.slice(1);
  const file = resolve(base, normalize(relative));
  if (file !== base && !file.startsWith(`${base}${sep}`)) {
    json(response, 403, { error: "Forbidden." });
    return;
  }
  try {
    const info = await readFile(file);
    response.writeHead(200, {
      "Content-Type":
        mimeTypes[extname(file).toLowerCase()] || "application/octet-stream",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "strict-origin-when-cross-origin",
      "Cache-Control": file.endsWith("index.html")
        ? "no-cache"
        : "public, max-age=3600",
    });
    response.end(info);
  } catch (error) {
    if (error.code === "ENOENT" || error.code === "EISDIR")
      json(response, 404, { error: "Not found." });
    else throw error;
  }
}

async function handle(request, response) {
  const url = new URL(
    request.url,
    `http://${request.headers.host || "localhost"}`,
  );
  const path = url.pathname;
  const method = request.method;

  if (
    ["POST", "PUT", "PATCH", "DELETE"].includes(method) &&
    !checkSameOrigin(request)
  ) {
    json(response, 403, { error: "Cross-origin request rejected." });
    return;
  }

  if (method === "GET" && path === "/api/health") {
    json(response, 200, { ok: true });
    return;
  }
  if (method === "GET" && path === "/api/listings") {
    json(response, 200, { listings: publicListings() });
    return;
  }
  if (method === "POST" && path === "/api/bookings") {
    const body = await readJson(request);
    const listingId = String(body.listingId || "");
    const listing = db
      .prepare("SELECT id,status,archived FROM listings WHERE id = ?")
      .get(listingId);
    if (!listing || listing.archived || listing.status !== "available") {
      json(response, 409, { error: "This plot is no longer available." });
      return;
    }
    if (
      !validText(body.customerName, 80) ||
      !validText(body.phone, 24) ||
      (typeof body.message === "string" && body.message.length > 240)
    ) {
      json(response, 400, {
        error: "Enter your name and a valid phone number.",
      });
      return;
    }
    const id = randomBytes(16).toString("hex");
    db.prepare(
      "INSERT INTO bookings (id,listing_id,customer_name,phone,message,status,created_at) VALUES (?,?,?,?,?,'pending',?)",
    ).run(
      id,
      listingId,
      body.customerName.trim(),
      body.phone.trim(),
      (body.message || "").trim(),
      Date.now(),
    );
    json(response, 201, {
      ok: true,
      bookingId: id,
      message: "Your request was sent to Satish Kumar.",
    });
    return;
  }
  if (method === "POST" && path === "/api/owner/forgot-password") {
    const body = await readJson(request);
    const email =
      typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      json(response, 400, { error: "Enter a valid email address." });
      return;
    }
    const ip = request.socket.remoteAddress || "unknown";
    const now = Date.now();
    const attempts = resetRequestAttempts.get(ip) || {
      count: 0,
      resetAt: now + 60 * 60 * 1000,
    };
    if (attempts.resetAt <= now) {
      attempts.count = 0;
      attempts.resetAt = now + 60 * 60 * 1000;
    }
    if (attempts.count >= 5) {
      json(response, 429, {
        error: "Too many reset attempts. Try again later.",
      });
      return;
    }
    attempts.count += 1;
    resetRequestAttempts.set(ip, attempts);
    if (email !== OWNER_EMAIL) {
      json(response, 202, {
        message:
          "If the address matches the owner account, a verification code will be emailed.",
      });
      return;
    }
    if (!emailConfigured()) {
      json(response, 503, {
        error:
          "Email delivery is not configured. Set SMTP settings on the server before requesting a code.",
      });
      return;
    }
    const previous = db
      .prepare("SELECT sent_at FROM password_reset_codes WHERE email = ?")
      .get(email);
    if (previous && now - previous.sent_at < RESET_CODE_COOLDOWN_MS) {
      json(response, 202, {
        message:
          "If the address matches the owner account, a verification code will be emailed.",
      });
      return;
    }
    const code = String(randomBytes(4).readUInt32BE(0) % 1000000).padStart(
      6,
      "0",
    );
    try {
      await sendPasswordResetEmail(email, code);
    } catch (error) {
      console.error(
        "Password reset email delivery failed.",
        error.code || error.name || "SMTP error",
      );
      json(response, 502, {
        error:
          "Could not send the verification email. Check the server email settings and try again.",
      });
      return;
    }
    db.prepare(
      "INSERT INTO password_reset_codes (email,code_hash,expires_at,attempts,sent_at) VALUES (?,?,?,?,?) ON CONFLICT(email) DO UPDATE SET code_hash=excluded.code_hash,expires_at=excluded.expires_at,attempts=0,sent_at=excluded.sent_at",
    ).run(email, resetCodeHash(email, code), now + RESET_CODE_TTL_MS, 0, now);
    json(response, 202, {
      message:
        "If the address matches the owner account, a verification code will be emailed.",
    });
    return;
  }
  if (method === "POST" && path === "/api/owner/reset-password") {
    const body = await readJson(request);
    const email =
      typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
    const code = typeof body.code === "string" ? body.code.trim() : "";
    const newPassword =
      typeof body.newPassword === "string" ? body.newPassword : "";
    if (
      email !== OWNER_EMAIL ||
      !/^\d{6}$/.test(code) ||
      newPassword.length < 10 ||
      newPassword.length > 256
    ) {
      json(response, 400, {
        error:
          "Enter the emailed six-digit code and a new password of at least 10 characters.",
      });
      return;
    }
    const reset = db
      .prepare(
        "SELECT code_hash,expires_at,attempts FROM password_reset_codes WHERE email = ?",
      )
      .get(email);
    if (
      !reset ||
      reset.expires_at <= Date.now() ||
      reset.attempts >= RESET_CODE_MAX_ATTEMPTS
    ) {
      db.prepare("DELETE FROM password_reset_codes WHERE email = ?").run(email);
      json(response, 400, {
        error: "The code is missing or expired. Request a new code.",
      });
      return;
    }
    const expected = Buffer.from(reset.code_hash, "hex");
    const candidate = Buffer.from(resetCodeHash(email, code), "hex");
    if (
      expected.length !== candidate.length ||
      !timingSafeEqual(expected, candidate)
    ) {
      db.prepare(
        "UPDATE password_reset_codes SET attempts = attempts + 1 WHERE email = ?",
      ).run(email);
      json(response, 400, { error: "That verification code is incorrect." });
      return;
    }
    const salt = randomBytes(32).toString("hex");
    const passwordHash = scryptSync(newPassword, salt, 64).toString("hex");
    db.exec("BEGIN IMMEDIATE");
    try {
      db.prepare(
        "UPDATE owner_credentials SET password_salt=?,password_hash=?,updated_at=? WHERE id=1",
      ).run(salt, passwordHash, Date.now());
      db.prepare("DELETE FROM password_reset_codes WHERE email=?").run(email);
      db.prepare("DELETE FROM sessions").run();
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
    json(response, 200, {
      ok: true,
      message: "Password updated. Sign in with your new password.",
    });
    return;
  }
  if (method === "POST" && path === "/api/owner/login") {
    const ip = request.socket.remoteAddress || "unknown";
    const now = Date.now();
    const attempts = loginAttempts.get(ip) || {
      count: 0,
      resetAt: now + 15 * 60 * 1000,
    };
    if (attempts.resetAt <= now) {
      attempts.count = 0;
      attempts.resetAt = now + 15 * 60 * 1000;
    }
    if (attempts.count >= 8) {
      json(response, 429, {
        error: "Too many sign-in attempts. Try again in 15 minutes.",
      });
      return;
    }
    const body = await readJson(request);
    const candidate = typeof body.password === "string" ? body.password : "";
    const credentials = db
      .prepare(
        "SELECT password_salt,password_hash FROM owner_credentials WHERE id=1",
      )
      .get();
    const candidateHash = scryptSync(
      candidate.slice(0, 256),
      credentials.password_salt,
      64,
    );
    const storedHash = Buffer.from(credentials.password_hash, "hex");
    if (candidate.length > 256 || !timingSafeEqual(candidateHash, storedHash)) {
      attempts.count += 1;
      loginAttempts.set(ip, attempts);
      json(response, 401, { error: "Incorrect password." });
      return;
    }
    loginAttempts.delete(ip);
    const token = randomBytes(32).toString("base64url");
    const tokenHash = createHmac("sha256", process.env.SESSION_SECRET)
      .update(token)
      .digest("hex");
    const expires = now + SESSION_TTL_MS;
    db.prepare("INSERT INTO sessions (token_hash,expires_at) VALUES (?,?)").run(
      tokenHash,
      expires,
    );
    json(
      response,
      200,
      { ok: true },
      { "Set-Cookie": cookieHeader(token, SESSION_TTL_MS / 1000) },
    );
    return;
  }
  if (method === "GET" && path === "/api/owner/session") {
    json(response, isAuthenticated(request) ? 200 : 401, {
      authenticated: isAuthenticated(request),
    });
    return;
  }
  if (method === "POST" && path === "/api/owner/logout") {
    const hash = sessionHash(request);
    if (hash) db.prepare("DELETE FROM sessions WHERE token_hash = ?").run(hash);
    json(response, 200, { ok: true }, { "Set-Cookie": cookieHeader("", 0) });
    return;
  }
  if (path.startsWith("/api/owner/") && !requireOwner(request, response))
    return;

  if (method === "GET" && path === "/api/owner/listings") {
    json(response, 200, { listings: publicListings() });
    return;
  }
  if (method === "POST" && path === "/api/owner/listings") {
    const body = await readJson(request);
    const listing = listingInput(body);
    const uploadedMedia = await saveMediaFiles(body);
    const image =
      uploadedMedia.find((item) => item.mediaType === "image")?.url ||
      body.imageUrl;
    if (
      typeof image !== "string" ||
      !(image.startsWith("/uploads/") || /^https:\/\//i.test(image))
    ) {
      throw Object.assign(
        new Error(
          "Upload a JPG, PNG, or WebP photo, or enter an HTTPS image URL.",
        ),
        { status: 400 },
      );
    }
    const id = randomBytes(12).toString("hex");
    const now = Date.now();
    db.prepare(
      "INSERT INTO listings (id,title,area,price,size,type,description,image,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
    ).run(
      id,
      listing.title,
      listing.area,
      listing.price,
      listing.size,
      listing.type,
      listing.description,
      image,
      "available",
      now,
      now,
    );
    saveListingMedia(id, uploadedMedia, image);
    json(response, 201, {
      listing: publicListings().find((item) => item.id === id),
    });
    return;
  }
  const listingStatus = path.match(/^\/api\/owner\/listings\/([^/]+)\/status$/);
  if (method === "PATCH" && listingStatus) {
    const id = decodeURIComponent(listingStatus[1]);
    const body = await readJson(request);
    if (!["available", "sold"].includes(body.status)) {
      json(response, 400, { error: "Choose available or sold." });
      return;
    }
    const result = db
      .prepare(
        "UPDATE listings SET status = ?, updated_at = ? WHERE id = ? AND archived=0",
      )
      .run(body.status, Date.now(), id);
    if (!result.changes) json(response, 404, { error: "Plot not found." });
    else json(response, 200, { ok: true });
    return;
  }
  const listingRoute = path.match(/^\/api\/owner\/listings\/([^/]+)$/);
  if (method === "DELETE" && listingRoute) {
    const id = decodeURIComponent(listingRoute[1]);
    const result = db
      .prepare(
        "UPDATE listings SET archived=1,updated_at=? WHERE id=? AND archived=0",
      )
      .run(Date.now(), id);
    if (!result.changes) json(response, 404, { error: "Plot not found." });
    else
      json(response, 200, {
        ok: true,
        message: "Listing removed. Existing booking history is retained.",
      });
    return;
  }
  if (method === "PUT" && listingRoute) {
    const id = decodeURIComponent(listingRoute[1]);
    const body = await readJson(request);
    const listing = listingInput(body);
    const current = db
      .prepare("SELECT image FROM listings WHERE id = ? AND archived=0")
      .get(id);
    if (!current) {
      json(response, 404, { error: "Plot not found." });
      return;
    }
    const removeMediaIds = Array.isArray(body.removeMediaIds)
      ? [
          ...new Set(
            body.removeMediaIds.filter(
              (value) =>
                typeof value === "string" && /^[a-f0-9]{24}$/.test(value),
            ),
          ),
        ]
      : [];
    if (removeMediaIds.length > MAX_MEDIA_FILES) {
      json(response, 400, { error: "Invalid media removal request." });
      return;
    }
    const storedMediaCount = db
      .prepare("SELECT COUNT(*) AS count FROM listing_media WHERE listing_id=?")
      .get(id).count;
    const validRemovals = removeMediaIds.length
      ? db
          .prepare(
            `SELECT id FROM listing_media WHERE listing_id=? AND id IN (${removeMediaIds.map(() => "?").join(",")})`,
          )
          .all(id, ...removeMediaIds).length
      : 0;
    const existingMediaCount = storedMediaCount || (current.image ? 1 : 0);
    const incomingMediaCount =
      (Array.isArray(body.mediaFiles) ? body.mediaFiles.length : 0) +
      (body.imageData ? 1 : 0);
    const coverAddsMedia =
      body.imageUrl &&
      body.imageUrl !== current.image &&
      !db
        .prepare("SELECT id FROM listing_media WHERE listing_id=? AND url=?")
        .get(id, body.imageUrl)
        ? 1
        : 0;
    if (
      existingMediaCount - validRemovals + incomingMediaCount + coverAddsMedia >
      MAX_MEDIA_FILES
    ) {
      json(response, 400, {
        error: `A listing can have up to ${MAX_MEDIA_FILES} photos/videos. Remove some before adding more.`,
      });
      return;
    }
    const uploadedMedia = await saveMediaFiles(body);
    let image = current.image;
    if (body.imageUrl) image = body.imageUrl;
    else if (uploadedMedia.some((item) => item.mediaType === "image")) {
      image = uploadedMedia.find((item) => item.mediaType === "image").url;
    }
    if (
      typeof image !== "string" ||
      !(image.startsWith("/uploads/") || /^https:\/\//i.test(image))
    ) {
      json(response, 400, {
        error: "Use an uploaded photo or a public HTTPS image URL.",
      });
      return;
    }
    saveListingMedia(id, uploadedMedia, image);
    const excludeRemoved = removeMediaIds.length
      ? ` AND id NOT IN (${removeMediaIds.map(() => "?").join(",")})`
      : "";
    const coverStillExists = db
      .prepare(
        `SELECT id FROM listing_media WHERE listing_id=? AND url=? AND media_type='image'${excludeRemoved}`,
      )
      .get(id, image, ...removeMediaIds);
    if (!coverStillExists) {
      const nextCover = db
        .prepare(
          `SELECT url FROM listing_media WHERE listing_id=? AND media_type='image'${excludeRemoved} ORDER BY position,created_at LIMIT 1`,
        )
        .get(id, ...removeMediaIds);
      if (!nextCover) {
        json(response, 400, {
          error:
            "A listing needs at least one photo. Keep or upload a cover photo.",
        });
        return;
      }
      image = nextCover.url;
    }
    if (removeMediaIds.length) {
      db.prepare(
        `DELETE FROM listing_media WHERE listing_id=? AND id IN (${removeMediaIds.map(() => "?").join(",")})`,
      ).run(id, ...removeMediaIds);
    }
    db.prepare(
      "UPDATE listings SET title=?,area=?,price=?,size=?,type=?,description=?,image=?,updated_at=? WHERE id=?",
    ).run(
      listing.title,
      listing.area,
      listing.price,
      listing.size,
      listing.type,
      listing.description,
      image,
      Date.now(),
      id,
    );
    json(response, 200, {
      listing: publicListings().find((item) => item.id === id),
    });
    return;
  }
  if (method === "GET" && path === "/api/owner/bookings") {
    const bookings = db
      .prepare(
        `SELECT b.id,b.listing_id AS listingId,b.customer_name AS customerName,b.phone,b.message,b.status,b.created_at AS createdAt,l.title AS listingTitle,l.area AS listingArea,l.price AS listingPrice
      FROM bookings b JOIN listings l ON l.id=b.listing_id ORDER BY b.created_at DESC`,
      )
      .all();
    json(response, 200, { bookings });
    return;
  }
  const bookingResponse = path.match(
    /^\/api\/owner\/bookings\/([^/]+)\/response$/,
  );
  if (method === "PATCH" && bookingResponse) {
    const id = decodeURIComponent(bookingResponse[1]);
    const body = await readJson(request);
    if (!["accepted", "declined"].includes(body.status)) {
      json(response, 400, { error: "Choose accept or decline." });
      return;
    }
    db.exec("BEGIN IMMEDIATE");
    let result;
    try {
      const booking = db
        .prepare("SELECT id,listing_id,status FROM bookings WHERE id = ?")
        .get(id);
      if (!booking || booking.status !== "pending") {
        db.exec("ROLLBACK");
        json(response, 409, { error: "Booking request is not pending." });
        return;
      }
      if (body.status === "accepted") {
        const changed = db
          .prepare(
            "UPDATE listings SET status='reserved',updated_at=? WHERE id=? AND status='available' AND archived=0",
          )
          .run(Date.now(), booking.listing_id);
        if (!changed.changes) {
          db.exec("ROLLBACK");
          json(response, 409, { error: "This plot is no longer available." });
          return;
        }
        db.prepare(
          "UPDATE bookings SET status='declined' WHERE listing_id=? AND id<>? AND status='pending'",
        ).run(booking.listing_id, id);
      }
      db.prepare("UPDATE bookings SET status=? WHERE id=?").run(
        body.status,
        id,
      );
      db.exec("COMMIT");
      result = { ok: true };
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
    json(response, 200, result);
    return;
  }

  if (path.startsWith("/api/")) {
    json(response, 404, { error: "API route not found." });
    return;
  }
  if (method !== "GET") {
    json(response, 405, { error: "Method not allowed." });
    return;
  }
  await serveStatic(path, response);
}

const server = createServer(async (request, response) => {
  response.setHeader("X-Frame-Options", "DENY");
  response.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  response.setHeader(
    "Permissions-Policy",
    "camera=(), microphone=(), geolocation=()",
  );
  try {
    await handle(request, response);
  } catch (error) {
    console.error(error);
    if (!response.headersSent)
      json(response, error.status || 500, {
        error: error.status ? error.message : "Server error.",
      });
    else response.destroy();
  }
});

server.listen(PORT, () => {
  console.log(`Kakinada Plots backend listening on http://localhost:${PORT}`);
  console.log(`Database: ${DB_PATH}`);
});

function close() {
  server.close(() => {
    db.close();
    process.exit(0);
  });
}
process.on("SIGINT", close);
process.on("SIGTERM", close);
