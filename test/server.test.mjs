import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { createServer } from "node:net";

const tempDir = await mkdtemp(join(tmpdir(), "kakinada-plots-test-"));
const dataDir = join(tempDir, "data");
const uploadsDir = join(tempDir, "uploads");
const password = "test-password-for-kakinada";
const secret = "test-session-secret-0123456789-abcdefghijklmnopqrstuv";
const portServer = createServer();
portServer.listen(0, "127.0.0.1");
await once(portServer, "listening");
const port = portServer.address().port;
await new Promise((resolve) => portServer.close(resolve));
const baseUrl = `http://127.0.0.1:${port}`;
const server = spawn(process.execPath, ["server.mjs"], {
  cwd: new URL("..", import.meta.url),
  env: {
    ...process.env,
    OWNER_PASSWORD: password,
    SESSION_SECRET: secret,
    PORT: String(port),
    DATA_DIR: dataDir,
    UPLOADS_DIR: uploadsDir,
  },
  stdio: "ignore",
});

async function waitReady() {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${baseUrl}/api/health`);
      if (response.ok) return;
    } catch {
      /* Start-up is still in progress. */
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("Test server did not start in time.");
}

before(waitReady);
after(async () => {
  server.kill();
  await once(server, "exit").catch(() => {});
  await rm(tempDir, { recursive: true, force: true });
});

async function request(
  path,
  { method = "GET", body, cookie, origin = baseUrl } = {},
) {
  return fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      ...(cookie ? { Cookie: cookie } : {}),
      ...(origin ? { Origin: origin } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
}

async function ownerCookie() {
  const response = await request("/api/owner/login", {
    method: "POST",
    body: { password },
  });
  assert.equal(response.status, 200);
  return response.headers.get("set-cookie").split(";")[0];
}

test("public customer can submit request; owner accepts and marks listing sold", async () => {
  const publicResponse = await request("/api/listings");
  assert.equal(publicResponse.status, 200);
  const { listings } = await publicResponse.json();
  assert.equal(listings.length, 6);
  const listing = listings[0];

  const bookingResponse = await request("/api/bookings", {
    method: "POST",
    body: {
      listingId: listing.id,
      customerName: "Test Customer",
      phone: "9000000000",
      message: "Visit this week",
    },
  });
  assert.equal(bookingResponse.status, 201);

  assert.equal((await request("/api/owner/bookings")).status, 401);
  const cookie = await ownerCookie();
  const bookingList = await request("/api/owner/bookings", { cookie });
  assert.equal(bookingList.status, 200);
  const { bookings } = await bookingList.json();
  assert.equal(bookings.length, 1);
  assert.equal(bookings[0].customerName, "Test Customer");

  const accept = await request(
    `/api/owner/bookings/${bookings[0].id}/response`,
    {
      method: "PATCH",
      cookie,
      body: { status: "accepted" },
    },
  );
  assert.equal(accept.status, 200);
  const currentListings = await (await request("/api/listings")).json();
  assert.equal(
    currentListings.listings.find((item) => item.id === listing.id).status,
    "reserved",
  );

  const sold = await request(`/api/owner/listings/${listing.id}/status`, {
    method: "PATCH",
    cookie,
    body: { status: "sold" },
  });
  assert.equal(sold.status, 200);
});

test("owner authentication rejects a bad password and unrelated origins", async () => {
  const bad = await request("/api/owner/login", {
    method: "POST",
    body: { password: "wrong password" },
  });
  assert.equal(bad.status, 401);
  const blocked = await request("/api/owner/listings", {
    method: "POST",
    body: {},
    origin: "https://bad.example",
  });
  assert.equal(blocked.status, 403);
});

test("owner can add and edit a plot; unauthenticated edits are rejected", async () => {
  assert.equal(
    (await request("/api/owner/listings", { method: "POST", body: {} })).status,
    401,
  );
  const cookie = await ownerCookie();
  const created = await request("/api/owner/listings", {
    method: "POST",
    cookie,
    body: {
      title: "Kakinada Test Plot",
      area: "Turangi",
      price: 99,
      size: 250,
      type: "Residential",
      description: "New listing for backend tests",
      imageUrl: "https://example.com/photo.jpg",
    },
  });
  assert.equal(created.status, 201);
  const { listing } = await created.json();
  assert.equal(listing.price, 99);
  const edit = await request(`/api/owner/listings/${listing.id}`, {
    method: "PUT",
    cookie,
    body: {
      title: "Updated Kakinada Plot",
      area: "Samalkot",
      price: 105,
      size: 300,
      type: "Residential",
      description: "Updated test listing",
      imageUrl: "https://example.com/new.jpg",
    },
  });
  assert.equal(edit.status, 200);
  const publicListings = await (await request("/api/listings")).json();
  assert.ok(
    publicListings.listings.some(
      (item) =>
        item.id === listing.id && item.title === "Updated Kakinada Plot",
    ),
  );
});

test("owner can upload an image and the public listing serves it", async () => {
  const cookie = await ownerCookie();
  const created = await request("/api/owner/listings", {
    method: "POST",
    cookie,
    body: {
      title: "Photo Test Plot",
      area: "Sarpavaram",
      price: 18,
      size: 180,
      type: "Residential",
      description: "Listing with uploaded photo",
      imageData:
        "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jG+8AAAAASUVORK5CYII=",
    },
  });
  assert.equal(created.status, 201);
  const { listing } = await created.json();
  assert.match(listing.image, /^\/uploads\/[a-f0-9]+\.png$/);
  const image = await fetch(`${baseUrl}${listing.image}`);
  assert.equal(image.status, 200);
  assert.match(image.headers.get("content-type"), /image\/png/);
});
