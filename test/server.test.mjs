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
const ownerEmail = "vjvijay2025@gmail.com";
const secret = "test-session-secret-0123456789-abcdefghijklmnopqrstuv";
const smtpMessages = [];
let smtpBuffer = "";
let smtpData = false;
let smtpMessage = [];
const smtpServer = createServer((socket) => {
  socket.setEncoding("utf8");
  socket.write("220 test.local ESMTP ready\r\n");
  socket.on("data", (chunk) => {
    smtpBuffer += chunk;
    let newline;
    while ((newline = smtpBuffer.indexOf("\n")) >= 0) {
      const line = smtpBuffer.slice(0, newline).replace(/\r$/, "");
      smtpBuffer = smtpBuffer.slice(newline + 1);
      if (smtpData) {
        if (line === ".") {
          smtpData = false;
          smtpMessages.push(smtpMessage.join("\n"));
          smtpMessage = [];
          socket.write("250 2.0.0 queued\r\n");
        } else smtpMessage.push(line.startsWith("..") ? line.slice(1) : line);
      } else if (/^(EHLO|HELO) /i.test(line)) {
        socket.write(
          "250-test.local\r\n250-AUTH PLAIN LOGIN\r\n250 SIZE 80000000\r\n",
        );
      } else if (/^AUTH PLAIN /i.test(line))
        socket.write("235 2.7.0 authenticated\r\n");
      else if (/^AUTH LOGIN/i.test(line)) socket.write("334 VXNlcm5hbWU6\r\n");
      else if (/^MAIL FROM:/i.test(line) || /^RCPT TO:/i.test(line))
        socket.write("250 2.1.0 accepted\r\n");
      else if (/^DATA$/i.test(line)) {
        smtpData = true;
        socket.write("354 end with dot\r\n");
      } else if (/^RSET$/i.test(line)) socket.write("250 2.0.0 reset\r\n");
      else if (/^QUIT$/i.test(line)) {
        socket.write("221 2.0.0 bye\r\n");
        socket.end();
      } else if (line === "test-user" || line === "test-password")
        socket.write("334 UGFzc3dvcmQ6\r\n");
      else socket.write("250 2.0.0 ok\r\n");
    }
  });
});
smtpServer.listen(0, "127.0.0.1");
await once(smtpServer, "listening");
const smtpPort = smtpServer.address().port;
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
    OWNER_EMAIL: ownerEmail,
    SMTP_HOST: "127.0.0.1",
    SMTP_PORT: String(smtpPort),
    SMTP_SECURE: "false",
    SMTP_USER: "test-user",
    SMTP_PASSWORD: "test-password",
    MAIL_FROM: "Kakinada Test <sender@test.local>",
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
  smtpServer.close();
  await once(smtpServer, "close").catch(() => {});
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
  const underMinimum = await request("/api/owner/listings", {
    method: "POST",
    cookie,
    body: {
      title: "Below Minimum",
      area: "Turangi",
      price: 0.5,
      size: 100,
      type: "Residential",
      description: "This price is below one lakh.",
      imageUrl: "https://example.com/low-price.jpg",
    },
  });
  assert.equal(underMinimum.status, 400);
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

test("owner can upload multiple photos and videos for one plot", async () => {
  const cookie = await ownerCookie();
  const png =
    "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jG+8AAAAASUVORK5CYII=";
  const mp4Bytes = Buffer.alloc(20);
  mp4Bytes.write("ftyp", 4, "ascii");
  const mp4 = `data:video/mp4;base64,${mp4Bytes.toString("base64")}`;
  const response = await request("/api/owner/listings", {
    method: "POST",
    cookie,
    body: {
      title: "Gallery Test Plot",
      area: "Turangi",
      price: 44,
      size: 210,
      type: "Residential",
      description: "Listing with a photo and a video",
      mediaFiles: [
        { dataUrl: png, type: "image" },
        { dataUrl: png, type: "image" },
        { dataUrl: mp4, type: "video" },
      ],
    },
  });
  assert.equal(response.status, 201);
  const { listing } = await response.json();
  assert.equal(listing.media.length, 3);
  assert.deepEqual(listing.media.map((item) => item.mediaType).sort(), [
    "image",
    "image",
    "video",
  ]);
  const video = await fetch(
    `${baseUrl}${listing.media.find((item) => item.mediaType === "video").url}`,
  );
  assert.equal(video.status, 200);
  assert.match(video.headers.get("content-type"), /video\/mp4/);
  const removeCoverId = listing.media.find(
    (item) => item.url === listing.image,
  ).id;
  const removeVideoId = listing.media.find(
    (item) => item.mediaType === "video",
  ).id;
  const edit = await request(`/api/owner/listings/${listing.id}`, {
    method: "PUT",
    cookie,
    body: {
      title: listing.title,
      area: listing.area,
      price: listing.price,
      size: listing.size,
      type: listing.type,
      description: listing.description,
      removeMediaIds: [removeCoverId, removeVideoId],
    },
  });
  assert.equal(edit.status, 200);
  const { listing: updated } = await edit.json();
  assert.equal(updated.media.length, 1);
  assert.equal(updated.media[0].mediaType, "image");
  assert.equal(updated.image, updated.media[0].url);
});

test("owner can remove a post without deleting its booking history", async () => {
  const cookie = await ownerCookie();
  const listingResponse = await request("/api/owner/listings", {
    method: "POST",
    cookie,
    body: {
      title: "Delete Test Plot",
      area: "Samalkot",
      price: 21,
      size: 180,
      type: "Residential",
      description: "Will be removed",
      imageUrl: "https://example.com/delete.jpg",
    },
  });
  const { listing } = await listingResponse.json();
  const booking = await request("/api/bookings", {
    method: "POST",
    body: {
      listingId: listing.id,
      customerName: "Keep History",
      phone: "9000000001",
    },
  });
  assert.equal(booking.status, 201);
  const deleted = await request(`/api/owner/listings/${listing.id}`, {
    method: "DELETE",
    cookie,
  });
  assert.equal(deleted.status, 200);
  const publicListings = await (await request("/api/listings")).json();
  assert.ok(!publicListings.listings.some((item) => item.id === listing.id));
  const bookingResponse = await request("/api/owner/bookings", { cookie });
  const { bookings } = await bookingResponse.json();
  assert.ok(bookings.some((item) => item.customerName === "Keep History"));
});

test("owner can reset password using the emailed one-time code", async () => {
  const priorSession = await ownerCookie();
  const requestCode = await request("/api/owner/forgot-password", {
    method: "POST",
    body: { email: ownerEmail },
  });
  assert.equal(requestCode.status, 202);
  const requestResult = await requestCode.json();
  assert.ok(!JSON.stringify(requestResult).match(/\b\d{6}\b/));
  assert.equal(smtpMessages.length, 1);
  assert.match(smtpMessages[0], new RegExp(`To:.*${ownerEmail}`, "i"));
  const match = smtpMessages[0].match(/reset code is[\s:=]+(\d{6})/i);
  assert.ok(match, "email contains a six-digit reset code");
  const code = match[1];

  const wrongCode = await request("/api/owner/reset-password", {
    method: "POST",
    body: {
      email: ownerEmail,
      code: "000000" === code ? "000001" : "000000",
      newPassword: "replacement-test-password",
    },
  });
  assert.equal(wrongCode.status, 400);

  const reset = await request("/api/owner/reset-password", {
    method: "POST",
    body: { email: ownerEmail, code, newPassword: "replacement-test-password" },
  });
  assert.equal(reset.status, 200);
  assert.equal(
    (await request("/api/owner/session", { cookie: priorSession })).status,
    401,
  );
  assert.equal(
    (await request("/api/owner/login", { method: "POST", body: { password } }))
      .status,
    401,
  );
  assert.equal(
    (
      await request("/api/owner/login", {
        method: "POST",
        body: { password: "replacement-test-password" },
      })
    ).status,
    200,
  );
});
