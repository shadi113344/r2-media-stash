const fileInput = document.getElementById("file-input");
const browseBtn = document.getElementById("browse-btn");
const dropzone = document.getElementById("upload-form");
const uploadStatus = document.getElementById("upload-status");
const objectList = document.getElementById("object-list");
const emptyState = document.getElementById("empty-state");
const refreshBtn = document.getElementById("refresh-btn");
const uploadSection = document.getElementById("upload-section");
const friendsSection = document.getElementById("friends-section");
const friendList = document.getElementById("friend-list");
const friendsEmpty = document.getElementById("friends-empty");
const friendForm = document.getElementById("friend-form");
const friendNewBtn = document.getElementById("friend-new-btn");
const friendCancelBtn = document.getElementById("friend-cancel-btn");
const friendFilePicks = document.getElementById("friend-file-picks");
const friendFormStatus = document.getElementById("friend-form-status");
const lede = document.getElementById("lede");
const rolePill = document.getElementById("role-pill");
const libraryHeading = document.getElementById("library-heading");

/** @type {{ role: string, label?: string, friendId?: string } | null} */
let me = null;
/** @type {Array<{key: string, sizeLabel: string, contentType: string|null, uploaded: string}>} */
let objectsCache = [];
/** @type {Array<{id: string, label: string, objectKeys: string[]}>} */
let friendsCache = [];

function setStatus(el, message, kind = "") {
	el.textContent = message;
	el.className = `status${kind ? ` ${kind}` : ""}`;
}

function escapeHtml(value) {
	return String(value)
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;")
		.replaceAll('"', "&quot;")
		.replaceAll("'", "&#39;");
}

async function api(path, options) {
	const res = await fetch(path, options);
	const data = await res.json().catch(() => ({}));
	if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
	return data;
}

function renderObjects(objects) {
	objectList.innerHTML = "";
	if (!objects.length) {
		emptyState.classList.remove("hidden");
		emptyState.textContent = me?.role === "friend" ? "No files shared with you yet." : "No files yet.";
		return;
	}
	emptyState.classList.add("hidden");

	for (const obj of objects) {
		const row = document.createElement("article");
		row.className = "object-row";
		const encoded = encodeURIComponent(obj.key).replaceAll("%2F", "/");
		const when = new Date(obj.uploaded).toLocaleString(undefined, {
			dateStyle: "medium",
			timeStyle: "short",
		});
		const deleteBtn =
			me?.role === "owner"
				? `<button type="button" class="btn danger" data-delete="${escapeHtml(obj.key)}">Delete</button>`
				: "";
		row.innerHTML = `
			<div class="object-meta">
				<p class="object-key"><a href="/api/objects/${encoded}" target="_blank" rel="noopener">${escapeHtml(obj.key)}</a></p>
				<p class="object-sub">${escapeHtml(obj.sizeLabel)} · ${escapeHtml(obj.contentType || "unknown type")} · ${escapeHtml(when)}</p>
			</div>
			<div class="object-actions">${deleteBtn}</div>
		`;
		objectList.appendChild(row);
	}
}

function renderFriendFilePicks(selected = []) {
	const selectedSet = new Set(selected);
	if (!objectsCache.length) {
		friendFilePicks.innerHTML = `<p class="empty">Upload files first, then assign them here.</p>`;
		return;
	}
	friendFilePicks.innerHTML = objectsCache
		.map(
			(obj) => `
		<label class="pick">
			<input type="checkbox" name="objectKeys" value="${escapeHtml(obj.key)}" ${selectedSet.has(obj.key) ? "checked" : ""} />
			<span>${escapeHtml(obj.key)}</span>
		</label>`,
		)
		.join("");
}

function renderFriends(friends) {
	friendList.innerHTML = "";
	if (!friends.length) {
		friendsEmpty.classList.remove("hidden");
		return;
	}
	friendsEmpty.classList.add("hidden");

	for (const friend of friends) {
		const card = document.createElement("article");
		card.className = "friend-card";
		const keys =
			friend.objectKeys.length === 0
				? "No files assigned"
				: friend.objectKeys.map((k) => escapeHtml(k)).join(", ");
		card.innerHTML = `
			<div class="friend-meta">
				<p class="friend-name">${escapeHtml(friend.label)}</p>
				<p class="object-sub">${friend.objectKeys.length} file${friend.objectKeys.length === 1 ? "" : "s"} · ${keys}</p>
			</div>
			<div class="object-actions">
				<button type="button" class="btn ghost" data-edit-friend="${escapeHtml(friend.id)}">Edit</button>
				<button type="button" class="btn danger" data-delete-friend="${escapeHtml(friend.id)}">Remove</button>
			</div>
		`;
		friendList.appendChild(card);
	}
}

function openFriendForm(friend) {
	friendForm.classList.remove("hidden");
	document.getElementById("friend-form-title").textContent = friend ? "Edit friend" : "Add friend";
	document.getElementById("friend-id").value = friend?.id || "";
	document.getElementById("friend-label").value = friend?.label || "";
	document.getElementById("friend-password").value = "";
	document.getElementById("friend-password").required = !friend;
	document.getElementById("friend-password-hint").textContent = friend
		? "Leave blank to keep the current password."
		: "Required. Share this password with your friend.";
	renderFriendFilePicks(friend?.objectKeys || []);
	setStatus(friendFormStatus, "");
	friendForm.scrollIntoView({ behavior: "smooth", block: "nearest" });
}

function closeFriendForm() {
	friendForm.classList.add("hidden");
	friendForm.reset();
	document.getElementById("friend-id").value = "";
	setStatus(friendFormStatus, "");
}

async function refreshObjects() {
	const data = await api("/api/objects");
	objectsCache = data.objects ?? [];
	renderObjects(objectsCache);
}

async function refreshFriends() {
	if (me?.role !== "owner") return;
	const data = await api("/api/friends");
	friendsCache = data.friends ?? [];
	renderFriends(friendsCache);
}

async function refresh() {
	refreshBtn.disabled = true;
	try {
		await refreshObjects();
		await refreshFriends();
	} catch (err) {
		setStatus(uploadStatus, err.message || "Could not refresh", "error");
	} finally {
		refreshBtn.disabled = false;
	}
}

/** 10 MiB parts — above R2's 5 MiB minimum, under the ~100 MiB Worker request limit. */
const PART_SIZE = 10 * 1024 * 1024;
const SIMPLE_UPLOAD_MAX = 20 * 1024 * 1024;

function formatBytes(n) {
	if (n < 1024) return `${n} B`;
	if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
	if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
	return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

async function uploadFileSimple(file) {
	const body = new FormData();
	body.append("file", file, file.name);
	await api("/api/upload", { method: "POST", body });
}

async function uploadFileMultipart(file, onProgress) {
	const created = await api("/api/multipart/create", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({
			key: file.name,
			contentType: file.type || "application/octet-stream",
			originalName: file.name,
		}),
	});

	const { key, uploadId } = created;
	const totalParts = Math.max(1, Math.ceil(file.size / PART_SIZE));
	const parts = [];

	try {
		for (let partNumber = 1; partNumber <= totalParts; partNumber++) {
			const start = (partNumber - 1) * PART_SIZE;
			const end = Math.min(start + PART_SIZE, file.size);
			const blob = file.slice(start, end);
			const qs = new URLSearchParams({
				key,
				uploadId,
				partNumber: String(partNumber),
			});
			const res = await fetch(`/api/multipart/part?${qs}`, {
				method: "PUT",
				headers: { "Content-Type": "application/octet-stream" },
				body: blob,
			});
			const data = await res.json().catch(() => ({}));
			if (!res.ok) throw new Error(data.error || `Part ${partNumber} failed (${res.status})`);
			parts.push({ partNumber: data.partNumber, etag: data.etag });
			if (onProgress) onProgress(partNumber, totalParts, end, file.size);
		}

		await api("/api/multipart/complete", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ key, uploadId, parts }),
		});
	} catch (err) {
		try {
			await api("/api/multipart/abort", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ key, uploadId }),
			});
		} catch {
			/* ignore abort errors */
		}
		throw err;
	}
}

async function uploadOneFile(file, index, total) {
	const label = total > 1 ? `(${index + 1}/${total}) ` : "";
	if (file.size <= SIMPLE_UPLOAD_MAX) {
		setStatus(uploadStatus, `${label}Uploading ${file.name} (${formatBytes(file.size)})…`);
		await uploadFileSimple(file);
		return;
	}

	await uploadFileMultipart(file, (partNumber, totalParts, bytesDone, bytesTotal) => {
		const pct = Math.min(100, Math.round((bytesDone / bytesTotal) * 100));
		setStatus(
			uploadStatus,
			`${label}Uploading ${file.name}: part ${partNumber}/${totalParts} (${pct}%, ${formatBytes(bytesDone)} / ${formatBytes(bytesTotal)})`,
		);
	});
}

async function uploadFiles(files) {
	if (!files?.length || me?.role !== "owner") return;
	const list = [...files];
	setStatus(uploadStatus, `Preparing ${list.length} file${list.length === 1 ? "" : "s"}…`);

	let ok = 0;
	const errors = [];
	for (let i = 0; i < list.length; i++) {
		try {
			await uploadOneFile(list[i], i, list.length);
			ok += 1;
		} catch (err) {
			errors.push(`${list[i].name}: ${err.message || String(err)}`);
		}
	}

	if (errors.length) {
		setStatus(
			uploadStatus,
			`Uploaded ${ok}/${list.length}. ${errors[0]}${errors.length > 1 ? ` (+${errors.length - 1} more)` : ""}`,
			ok ? "ok" : "error",
		);
	} else {
		setStatus(uploadStatus, `Uploaded ${ok} file${ok === 1 ? "" : "s"}.`, "ok");
	}
	fileInput.value = "";
	await refresh();
}

browseBtn.addEventListener("click", () => fileInput.click());
fileInput.addEventListener("change", () => uploadFiles(fileInput.files));

["dragenter", "dragover"].forEach((eventName) => {
	dropzone.addEventListener(eventName, (event) => {
		event.preventDefault();
		dropzone.classList.add("is-dragging");
	});
});
["dragleave", "drop"].forEach((eventName) => {
	dropzone.addEventListener(eventName, (event) => {
		event.preventDefault();
		dropzone.classList.remove("is-dragging");
	});
});
dropzone.addEventListener("drop", (event) => uploadFiles(event.dataTransfer?.files));

objectList.addEventListener("click", async (event) => {
	const target = event.target;
	if (!(target instanceof HTMLElement)) return;
	const key = target.getAttribute("data-delete");
	if (!key) return;
	if (!confirm(`Delete “${key}”?`)) return;
	target.disabled = true;
	try {
		const encoded = encodeURIComponent(key).replaceAll("%2F", "/");
		await api(`/api/objects/${encoded}`, { method: "DELETE" });
		setStatus(uploadStatus, `Deleted ${key}.`, "ok");
		await refresh();
	} catch (err) {
		setStatus(uploadStatus, err.message || "Delete failed", "error");
		target.disabled = false;
	}
});

friendNewBtn.addEventListener("click", () => openFriendForm(null));
friendCancelBtn.addEventListener("click", () => closeFriendForm());

friendList.addEventListener("click", async (event) => {
	const target = event.target;
	if (!(target instanceof HTMLElement)) return;
	const editId = target.getAttribute("data-edit-friend");
	if (editId) {
		const friend = friendsCache.find((f) => f.id === editId);
		if (friend) openFriendForm(friend);
		return;
	}
	const deleteId = target.getAttribute("data-delete-friend");
	if (!deleteId) return;
	const friend = friendsCache.find((f) => f.id === deleteId);
	if (!confirm(`Remove friend “${friend?.label || deleteId}”?`)) return;
	target.disabled = true;
	try {
		await api(`/api/friends/${encodeURIComponent(deleteId)}`, { method: "DELETE" });
		closeFriendForm();
		await refreshFriends();
	} catch (err) {
		setStatus(friendFormStatus, err.message || "Remove failed", "error");
		target.disabled = false;
	}
});

friendForm.addEventListener("submit", async (event) => {
	event.preventDefault();
	const id = document.getElementById("friend-id").value;
	const label = document.getElementById("friend-label").value.trim();
	const password = document.getElementById("friend-password").value;
	const objectKeys = [...friendFilePicks.querySelectorAll('input[name="objectKeys"]:checked')].map(
		(input) => input.value,
	);

	const payload = { label, objectKeys };
	if (password) payload.password = password;
	if (!id && !password) {
		setStatus(friendFormStatus, "Password is required for a new friend.", "error");
		return;
	}

	try {
		if (id) {
			await api(`/api/friends/${encodeURIComponent(id)}`, {
				method: "PUT",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(payload),
			});
			setStatus(friendFormStatus, "Friend updated.", "ok");
		} else {
			await api("/api/friends", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ ...payload, password }),
			});
			setStatus(friendFormStatus, "Friend created. Share their password out of band.", "ok");
		}
		closeFriendForm();
		await refreshFriends();
	} catch (err) {
		setStatus(friendFormStatus, err.message || "Save failed", "error");
	}
});

refreshBtn.addEventListener("click", () => refresh());

async function boot() {
	me = await api("/api/me");
	rolePill.textContent = me.role === "owner" ? "Owner" : me.label || "Friend";
	rolePill.classList.remove("hidden");

	if (me.role === "owner") {
		lede.textContent = "Upload files, then assign them to friends with unique passwords.";
		libraryHeading.textContent = "All files";
		uploadSection.classList.remove("hidden");
		friendsSection.classList.remove("hidden");
	} else {
		lede.textContent = `Shared with ${me.label || "you"}. View and download your assigned files.`;
		libraryHeading.textContent = "Shared with you";
	}

	await refresh();
}

boot().catch((err) => {
	lede.textContent = err.message || "Could not load Vybe.";
	setStatus(uploadStatus, err.message || "Startup failed", "error");
});
