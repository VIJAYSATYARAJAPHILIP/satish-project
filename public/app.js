const $ = (selector) => document.querySelector(selector);
const listingDialog = $("#listing-dialog");
const loginDialog = $("#owner-login-dialog");
const listingRoot = $("#listings");
let listings = [];
let bookings = [];
let currentBookingListing = null;
let ownerUnlocked = false;
let toastTimer;

const escapeHTML = (value) =>
  String(value ?? "").replace(
    /[&<>"']/g,
    (char) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;",
      })[char],
  );
const money = (lakhs) =>
  `₹${Number(lakhs).toLocaleString("en-IN", { maximumFractionDigits: 2 })} lakh`;

async function api(path, options = {}) {
  const headers = {
    ...(options.body ? { "Content-Type": "application/json" } : {}),
    ...options.headers,
  };
  const response = await fetch(path, {
    ...options,
    headers,
    credentials: "same-origin",
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(
      body.error || `Request failed (${response.status}).`,
    );
    error.status = response.status;
    throw error;
  }
  return body;
}

function notify(message, error = false) {
  const toast = $("#toast");
  toast.textContent = message;
  toast.style.background = error ? "#9b2c2c" : "#183c67";
  toast.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove("show"), 3800);
}

async function loadListings() {
  const result = await api("/api/listings");
  listings = result.listings;
  initializeAreas();
  renderListings();
  updateMetrics();
}

function initializeAreas() {
  const select = $("#area-filter");
  const selected = select.value;
  select
    .querySelectorAll("option:not(:first-child)")
    .forEach((option) => option.remove());
  [...new Set(listings.map((item) => item.area))].sort().forEach((area) => {
    const option = document.createElement("option");
    option.value = area;
    option.textContent = area;
    select.append(option);
  });
  select.value = [...select.options].some((option) => option.value === selected)
    ? selected
    : "";
}

function renderListings() {
  const query = $("#search").value.trim().toLowerCase();
  const area = $("#area-filter").value;
  const maxPrice = Number($("#budget-filter").value);
  const matches = listings.filter((item) => {
    const text = `${item.title} ${item.area} ${item.description}`.toLowerCase();
    return (
      text.includes(query) &&
      (!area || item.area === area) &&
      Number(item.price) <= maxPrice
    );
  });
  $("#result-count").innerHTML =
    `<strong>${matches.length}</strong> ${matches.length === 1 ? "plot" : "plots"} found`;
  if (!matches.length) {
    listingRoot.innerHTML =
      '<div class="empty-state"><strong>No plots match those filters</strong>Try another area, search term or maximum budget.</div>';
    return;
  }
  listingRoot.innerHTML = matches
    .map(
      (plot) => `
    <article class="card">
      <div class="card-image"><img src="${escapeHTML(plot.image)}" alt="${escapeHTML(plot.title)}" loading="lazy"><span class="demo-badge">${escapeHTML(plot.status)}</span><span class="price-tag">${money(plot.price)}</span></div>
      <div class="card-body">
        <div class="area">${escapeHTML(plot.area)}, Kakinada</div>
        <h3>${escapeHTML(plot.title)}</h3>
        <p class="card-description">${escapeHTML(plot.description)}</p>
        <div class="card-meta"><span>${escapeHTML(plot.size)} sq. yd.</span><span>${escapeHTML(plot.type)}</span></div>
        <div class="card-footer"><small>${plot.status === "available" ? "Request a booking" : "Not currently available"}</small>${plot.status === "available" ? `<button class="button button-outline small-button" type="button" data-book="${escapeHTML(plot.id)}">Request booking</button>` : `<span class="status ${escapeHTML(plot.status)}">${escapeHTML(plot.status)}</span>`}</div>
      </div>
    </article>`,
    )
    .join("");
  listingRoot.querySelectorAll("[data-book]").forEach((button) => {
    button.addEventListener("click", () => openBooking(button.dataset.book));
  });
}

function openBooking(id) {
  currentBookingListing = listings.find(
    (plot) => String(plot.id) === String(id),
  );
  if (!currentBookingListing || currentBookingListing.status !== "available")
    return;
  $("#dialog-title").textContent = currentBookingListing.title;
  $("#dialog-subtitle").textContent =
    `${currentBookingListing.area}, Kakinada · ${money(currentBookingListing.price)}`;
  $("#dialog-details").textContent =
    `${currentBookingListing.description} Plot size: ${currentBookingListing.size} sq. yd. Your request will be sent securely to the owner for review.`;
  $("#booking-listing-id").value = currentBookingListing.id;
  $("#booking-form").reset();
  listingDialog.showModal();
}

function showPage(name) {
  const ownerPage = name === "owner";
  $("#customer-page").classList.toggle("hidden", ownerPage);
  $("#owner-page").classList.toggle("hidden", !ownerPage);
  $("#customer-tab").classList.toggle("active", !ownerPage);
  $("#owner-tab").classList.toggle("active", ownerPage);
  $("#customer-tab").setAttribute("aria-selected", String(!ownerPage));
  $("#owner-tab").setAttribute("aria-selected", String(ownerPage));
  window.scrollTo({ top: 0, behavior: "smooth" });
}

async function openOwnerPage() {
  if (!ownerUnlocked) {
    try {
      await api("/api/owner/session");
      ownerUnlocked = true;
    } catch {
      $("#login-error").textContent = "";
      $("#owner-password").value = "";
      loginDialog.showModal();
      return;
    }
  }
  showPage("owner");
  await refreshOwnerData();
}

async function refreshOwnerData() {
  const [listingResult, bookingResult] = await Promise.all([
    api("/api/owner/listings"),
    api("/api/owner/bookings"),
  ]);
  listings = listingResult.listings;
  bookings = bookingResult.bookings;
  initializeAreas();
  renderListings();
  renderOwnerListings();
  renderBookings();
  updateMetrics();
}

function updateMetrics() {
  $("#available-count").textContent = listings.filter(
    (item) => item.status === "available",
  ).length;
  $("#sold-count").textContent = listings.filter(
    (item) => item.status === "sold",
  ).length;
  $("#request-count").textContent = bookings.filter(
    (item) => item.status === "pending",
  ).length;
}

function renderOwnerListings() {
  const root = $("#owner-listings");
  root.innerHTML = listings.length
    ? listings
        .map(
          (plot) => `
    <div class="owner-row">
      <img src="${escapeHTML(plot.image)}" alt="${escapeHTML(plot.title)}" loading="lazy">
      <div><h3>${escapeHTML(plot.title)}</h3><p>${escapeHTML(plot.area)} · ${money(plot.price)} · ${escapeHTML(plot.size)} sq. yd.</p></div>
      <span class="status ${escapeHTML(plot.status)}">${escapeHTML(plot.status)}</span>
      <div class="owner-row-actions"><button class="button button-outline small-button" type="button" data-edit="${escapeHTML(plot.id)}">Edit</button>${plot.status === "reserved" ? `<button class="button small-button" type="button" data-status="sold" data-id="${escapeHTML(plot.id)}">Mark sold</button><button class="button button-outline small-button" type="button" data-status="available" data-id="${escapeHTML(plot.id)}">Release</button>` : plot.status === "sold" ? `<button class="button button-outline small-button" type="button" data-status="available" data-id="${escapeHTML(plot.id)}">Mark available</button>` : ""}</div>
    </div>`,
        )
        .join("")
    : '<div class="empty-state"><strong>No plots yet</strong>Add your first listing above.</div>';
  root
    .querySelectorAll("[data-edit]")
    .forEach((button) =>
      button.addEventListener("click", () => editListing(button.dataset.edit)),
    );
  root
    .querySelectorAll("[data-status]")
    .forEach((button) =>
      button.addEventListener("click", () =>
        setListingStatus(button.dataset.id, button.dataset.status),
      ),
    );
}

function renderBookings() {
  const root = $("#booking-list");
  root.innerHTML = bookings.length
    ? bookings
        .map(
          (booking) => `
    <div class="booking-row"><div><h3>${escapeHTML(booking.customerName)} · ${escapeHTML(booking.phone)}</h3><p>Plot: ${escapeHTML(booking.listingTitle)} · ${escapeHTML(booking.listingArea)}</p><p>${escapeHTML(booking.message || "No extra message")}</p><span class="status ${escapeHTML(booking.status)}">${escapeHTML(booking.status)}</span></div><div class="booking-actions">${booking.status === "pending" ? `<button class="button small-button" type="button" data-response="accepted" data-id="${escapeHTML(booking.id)}">Accept request</button><button class="button button-outline danger-button small-button" type="button" data-response="declined" data-id="${escapeHTML(booking.id)}">Decline</button>` : ""}</div></div>`,
        )
        .join("")
    : '<div class="empty-state"><strong>No booking requests</strong>Customer requests will appear here.</div>';
  root
    .querySelectorAll("[data-response]")
    .forEach((button) =>
      button.addEventListener("click", () =>
        respondToBooking(button.dataset.id, button.dataset.response),
      ),
    );
}

function resetListingForm() {
  $("#listing-form").reset();
  $("#edit-id").value = "";
  $("#listing-form-title").textContent = "Add a plot";
  $("#save-listing").textContent = "Save plot";
  $("#cancel-edit").hidden = true;
  $("#image-preview").hidden = true;
}

function editListing(id) {
  const plot = listings.find((item) => String(item.id) === String(id));
  if (!plot) return;
  $("#edit-id").value = plot.id;
  $("#edit-title").value = plot.title;
  $("#edit-area").value = plot.area;
  $("#edit-price").value = plot.price;
  $("#edit-size").value = plot.size;
  $("#edit-type").value = plot.type;
  $("#edit-description").value = plot.description;
  $("#edit-image-url").value = plot.image.startsWith("https://")
    ? plot.image
    : "";
  $("#edit-image-file").value = "";
  $("#image-preview").src = plot.image;
  $("#image-preview").hidden = false;
  $("#listing-form-title").textContent = "Edit plot";
  $("#save-listing").textContent = "Save changes";
  $("#cancel-edit").hidden = false;
  $("#listing-editor-panel").scrollIntoView({
    behavior: "smooth",
    block: "start",
  });
}

async function fileAsDataUrl(file) {
  if (!file) return "";
  if (file.size > 5 * 1024 * 1024)
    throw new Error("Choose an image smaller than 5 MB.");
  if (!["image/jpeg", "image/png", "image/webp"].includes(file.type))
    throw new Error("Please choose a JPG, PNG, or WebP image.");
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () =>
      reject(new Error("Could not read the selected image."));
    reader.readAsDataURL(file);
  });
}

async function saveListing(event) {
  event.preventDefault();
  const id = $("#edit-id").value;
  const imageFile = $("#edit-image-file").files[0];
  const imageUrl = $("#edit-image-url").value.trim();
  const payload = {
    title: $("#edit-title").value.trim(),
    area: $("#edit-area").value.trim(),
    price: Number($("#edit-price").value),
    size: Number($("#edit-size").value),
    type: $("#edit-type").value.trim(),
    description: $("#edit-description").value.trim(),
    imageUrl,
  };
  try {
    if (imageFile) payload.imageData = await fileAsDataUrl(imageFile);
    else if (!id && !imageUrl)
      throw new Error("Upload a photo or enter an image URL.");
    await api(
      id
        ? `/api/owner/listings/${encodeURIComponent(id)}`
        : "/api/owner/listings",
      {
        method: id ? "PUT" : "POST",
        body: JSON.stringify(payload),
      },
    );
    resetListingForm();
    await refreshOwnerData();
    notify(id ? "Plot details updated." : "Plot added and published.");
  } catch (error) {
    notify(error.message, true);
  }
}

async function setListingStatus(id, status) {
  try {
    await api(`/api/owner/listings/${encodeURIComponent(id)}/status`, {
      method: "PATCH",
      body: JSON.stringify({ status }),
    });
    await refreshOwnerData();
    notify(`Plot marked ${status}.`);
  } catch (error) {
    notify(error.message, true);
  }
}

async function respondToBooking(id, status) {
  try {
    await api(`/api/owner/bookings/${encodeURIComponent(id)}/response`, {
      method: "PATCH",
      body: JSON.stringify({ status }),
    });
    await refreshOwnerData();
    notify(
      status === "accepted"
        ? "Booking accepted; plot reserved."
        : "Booking request declined.",
    );
  } catch (error) {
    notify(error.message, true);
  }
}

async function submitBooking(event) {
  event.preventDefault();
  const button = $("#booking-submit");
  button.disabled = true;
  try {
    const result = await api("/api/bookings", {
      method: "POST",
      body: JSON.stringify({
        listingId: $("#booking-listing-id").value,
        customerName: $("#customer-name").value.trim(),
        phone: $("#customer-phone").value.trim(),
        message: $("#customer-message").value.trim(),
      }),
    });
    listingDialog.close();
    $("#booking-form").reset();
    notify(result.message);
    await loadListings();
  } catch (error) {
    notify(error.message, true);
  } finally {
    button.disabled = false;
  }
}

async function signIn(event) {
  event.preventDefault();
  const button = $("#owner-login-form button[type=submit]");
  button.disabled = true;
  $("#login-error").textContent = "";
  try {
    await api("/api/owner/login", {
      method: "POST",
      body: JSON.stringify({ password: $("#owner-password").value }),
    });
    ownerUnlocked = true;
    loginDialog.close();
    $("#owner-login-form").reset();
    await openOwnerPage();
  } catch (error) {
    $("#login-error").textContent = error.message;
  } finally {
    button.disabled = false;
  }
}

async function signOut() {
  try {
    await api("/api/owner/logout", { method: "POST", body: "{}" });
  } catch {
    /* The local UI should still lock if the session has expired. */
  }
  ownerUnlocked = false;
  showPage("customer");
  notify("Signed out.");
}

$("#year").textContent = new Date().getFullYear();
$("#filter-form").addEventListener("submit", (event) => event.preventDefault());
$("#search").addEventListener("input", renderListings);
$("#area-filter").addEventListener("change", renderListings);
$("#budget-filter").addEventListener("change", renderListings);
$("#customer-tab").addEventListener("click", () => {
  showPage("customer");
  loadListings().catch((error) => notify(error.message, true));
});
$("#owner-tab").addEventListener("click", () =>
  openOwnerPage().catch((error) => notify(error.message, true)),
);
$("#owner-login-form").addEventListener("submit", signIn);
$("#logout-button").addEventListener("click", signOut);
$("#listing-form").addEventListener("submit", saveListing);
$("#booking-form").addEventListener("submit", submitBooking);
$("#cancel-edit").addEventListener("click", resetListingForm);
$("#edit-image-file").addEventListener("change", () => {
  const file = $("#edit-image-file").files[0];
  if (!file) return;
  const preview = $("#image-preview");
  preview.src = URL.createObjectURL(file);
  preview.hidden = false;
});
$("#edit-image-url").addEventListener("input", () => {
  const url = $("#edit-image-url").value.trim();
  if (url && !$("#edit-image-file").files[0]) {
    $("#image-preview").src = url;
    $("#image-preview").hidden = false;
  }
});
document.querySelectorAll("[data-close]").forEach((button) => {
  button.addEventListener("click", () => $(`#${button.dataset.close}`).close());
});
[listingDialog, loginDialog].forEach((dialog) =>
  dialog.addEventListener("click", (event) => {
    if (event.target === dialog) dialog.close();
  }),
);

loadListings().catch((error) => {
  $("#result-count").textContent = "Could not load listings.";
  listingRoot.innerHTML = `<div class="empty-state"><strong>Website connection failed</strong>${escapeHTML(error.message)}. Start the website server and refresh.</div>`;
});
setInterval(() => {
  if (!$("#owner-page").classList.contains("hidden") && ownerUnlocked) {
    refreshOwnerData().catch((error) => notify(error.message, true));
  } else if (!$("#customer-page").classList.contains("hidden")) {
    loadListings().catch(() => {});
  }
}, 30000);
