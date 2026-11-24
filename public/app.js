const fileInput = document.getElementById("file-input");
const browseBtn = document.getElementById("browse-btn");
const dropzone = document.getElementById("upload-form");
const uploadStatus = document.getElementById("upload-status");
const uploadPanel = document.getElementById("upload-panel");
const uploadFileName = document.getElementById("upload-file-name");
const uploadProgressBar = document.getElementById("upload-progress-bar");
const uploadProgressLabel = document.getElementById("upload-progress-label");
const uploadPauseBtn = document.getElementById("upload-pause-btn");
const uploadResumeBtn = document.getElementById("upload-resume-btn");
const uploadRetryBtn = document.getElementById("upload-retry-btn");
const uploadCancelBtn = document.getElementById("upload-cancel-btn");
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

/** 10 MiB parts — above R2's 5 MiB minimum, under the ~100 MiB Worker request limit. */
const PART_SIZE = 10 * 1024 * 1024;
const SIMPLE_UPLOAD_MAX = 20 * 1024 * 1024;

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

function formatBytes(n) {
	if (n < 1024) return `${n} B`;
	if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
	if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
	return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

async function api(path, options) {
	const res = await fetch(path, options);
	const data = await res.json().catch(() => ({}));
	if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
	return data;
}

class UploadController {
	constructor() {
		/** @type {'idle'|'running'|'paused'|'error'|'cancelled'|'done'} */
		this.state = "idle";
		/** @type {File|null} */
		this.file = null;
		this.key = "";
		this.uploadId = "";
		/** @type {Map<number, {partNumber: number, etag: string}>} */
		this.parts = new Map();
		this.totalParts = 0;
		this.nextPart = 1;
		this.abortController = null;
		this.pauseWaiters = [];
		this.queue = [];
		this.busy = false;
	}

	setControls() {
		const active = this.state === "running" || this.state === "paused" || this.state === "error";
		uploadPanel.classList.toggle("hidden", this.state === "idle" || this.state === "done");
		if (this.state === "done") {
			// keep panel visible briefly with success, then hide on next idle
		}
		if (this.state !== "idle") uploadPanel.classList.remove("hidden");

		uploadPauseBtn.classList.toggle("hidden", this.state !== "running");
		uploadResumeBtn.classList.toggle("hidden", this.state !== "paused");
		uploadRetryBtn.classList.toggle("hidden", this.state !== "error");
		uploadCancelBtn.disabled = this.state === "idle" || this.state === "done" || this.state === "cancelled";
		browseBtn.disabled = this.busy || this.queue.length > 0 || this.state === "running" || this.state === "paused";
	}

	updateProgress() {
		if (!this.file) return;
		const completedBytes = Math.min(this.file.size, (this.nextPart - 1) * PART_SIZE);
		const pct = this.file.size === 0 ? 100 : Math.min(100, Math.round((completedBytes / this.file.size) * 100));
		uploadProgressBar.style.width = `${pct}%`;
		uploadProgressLabel.textContent = `${pct}% · ${formatBytes(completedBytes)} / ${formatBytes(this.file.size)} · part ${Math.min(this.nextPart, this.totalParts)}/${this.totalParts}`;
		uploadFileName.textContent = this.file.name;
	}

	async waitIfPaused() {
		while (this.state === "paused") {
			await new Promise((resolve) => this.pauseWaiters.push(resolve));
		}
		if (this.state === "cancelled") throw new Error("Upload cancelled");
	}

	pause() {
		if (this.state !== "running") return;
		this.state = "paused";
		this.abortController?.abort();
		setStatus(uploadStatus, "Paused.", "");
		this.setControls();
	}

	resume() {
		if (this.state !== "paused") return;
		this.state = "running";
		setStatus(uploadStatus, "Resuming…", "");
		this.setControls();
		const waiters = this.pauseWaiters.splice(0);
		for (const resolve of waiters) resolve();
	}

	async cancel() {
		if (this.state === "idle" || this.state === "done") return;
		this.state = "cancelled";
		this.abortController?.abort();
		const waiters = this.pauseWaiters.splice(0);
		for (const resolve of waiters) resolve();
		if (this.uploadId && this.key) {
			try {
				await api("/api/multipart/abort", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ key: this.key, uploadId: this.uploadId }),
				});
			} catch {
				/* ignore */
			}
		}
		setStatus(uploadStatus, "Upload cancelled.", "error");
		this.setControls();
		this.resetSession();
		this.busy = false;
		this.drainQueue();
	}

	retry() {
		if (this.state !== "error" || !this.file) return;
		this.state = "running";
		setStatus(uploadStatus, "Retrying…", "");
		this.setControls();
		this.runCurrent().catch(() => {});
	}

	resetSession() {
		this.file = null;
		this.key = "";
		this.uploadId = "";
		this.parts.clear();
		this.totalParts = 0;
		this.nextPart = 1;
		this.abortController = null;
		this.state = "idle";
		uploadProgressBar.style.width = "0%";
		uploadProgressLabel.textContent = "0%";
		uploadFileName.textContent = "";
		this.setControls();
		uploadPanel.classList.add("hidden");
	}

	enqueue(files) {
		this.queue.push(...files);
		this.drainQueue();
	}

	async drainQueue() {
		if (this.busy) return;
		const next = this.queue.shift();
		if (!next) {
			browseBtn.disabled = false;
			return;
		}
		this.busy = true;
		this.file = next;
		this.key = "";
		this.uploadId = "";
		this.parts.clear();
		this.totalParts = Math.max(1, Math.ceil(next.size / PART_SIZE));
		this.nextPart = 1;
		this.state = "running";
		uploadPanel.classList.remove("hidden");
		this.updateProgress();
		this.setControls();
		try {
			await this.runCurrent();
		} catch {
			/* surfaced via status */
		}
	}

	async runCurrent() {
		try {
			if (!this.file) return;
			if (this.file.size <= SIMPLE_UPLOAD_MAX && !this.uploadId) {
				setStatus(uploadStatus, `Uploading ${this.file.name} (${formatBytes(this.file.size)})…`, "");
				uploadProgressBar.style.width = "50%";
				uploadProgressLabel.textContent = `… · ${formatBytes(this.file.size)}`;
				await this.uploadSimple(this.file);
				uploadProgressBar.style.width = "100%";
				uploadProgressLabel.textContent = `100% · ${formatBytes(this.file.size)} / ${formatBytes(this.file.size)}`;
			} else {
				await this.uploadMultipart();
			}
			if (this.state === "cancelled") return;
			const doneName = this.file.name;
			this.state = "done";
			uploadProgressBar.style.width = "100%";
			uploadProgressLabel.textContent = `100% · ${formatBytes(this.file.size)} / ${formatBytes(this.file.size)}`;
			setStatus(uploadStatus, `Uploaded ${doneName}.`, "ok");
			uploadPauseBtn.classList.add("hidden");
			uploadResumeBtn.classList.add("hidden");
			uploadRetryBtn.classList.add("hidden");
			uploadCancelBtn.disabled = true;
			browseBtn.disabled = this.queue.length > 0;
			await refresh();
			this.file = null;
			this.key = "";
			this.uploadId = "";
			this.parts.clear();
			this.nextPart = 1;
			this.busy = false;
			this.state = "idle";
			this.drainQueue();
		} catch (err) {
			if (this.state === "cancelled") {
				this.busy = false;
				this.drainQueue();
				return;
			}
			if (this.state === "paused" || err?.name === "AbortError") {
				this.state = "paused";
				setStatus(uploadStatus, "Paused.", "");
				this.setControls();
				try {
					await this.waitIfPaused();
					if (this.state === "cancelled") {
						this.busy = false;
						this.drainQueue();
						return;
					}
					this.state = "running";
					this.setControls();
					await this.runCurrent();
				} catch (inner) {
					if (this.state === "cancelled") {
						this.busy = false;
						this.drainQueue();
						return;
					}
					this.state = "error";
					setStatus(uploadStatus, inner.message || "Upload failed", "error");
					this.setControls();
				}
				return;
			}
			this.state = "error";
			setStatus(uploadStatus, err.message || "Upload failed", "error");
			this.setControls();
		}
	}

	async uploadSimple(file) {
		const body = new FormData();
		body.append("file", file, file.name);
		this.abortController = new AbortController();
		const res = await fetch("/api/upload", { method: "POST", body, signal: this.abortController.signal });
		const data = await res.json().catch(() => ({}));
		if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
	}

	async uploadMultipart() {
		if (!this.file) return;
		if (!this.uploadId) {
			setStatus(uploadStatus, `Starting multipart for ${this.file.name}…`, "");
			const created = await api("/api/multipart/create", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					key: this.file.name,
					contentType: this.file.type || "application/octet-stream",
					originalName: this.file.name,
				}),
			});
			this.key = created.key;
			this.uploadId = created.uploadId;
		}

		while (this.nextPart <= this.totalParts) {
			await this.waitIfPaused();
			if (this.state === "cancelled") throw new Error("Upload cancelled");

			const partNumber = this.nextPart;
			if (this.parts.has(partNumber)) {
				this.nextPart += 1;
				this.updateProgress();
				continue;
			}

			const start = (partNumber - 1) * PART_SIZE;
			const end = Math.min(start + PART_SIZE, this.file.size);
			const blob = this.file.slice(start, end);
			const qs = new URLSearchParams({
				key: this.key,
				uploadId: this.uploadId,
				partNumber: String(partNumber),
			});

			this.abortController = new AbortController();
			setStatus(
				uploadStatus,
				`Uploading part ${partNumber}/${this.totalParts}…`,
				"",
			);

			let res;
			try {
				res = await fetch(`/api/multipart/part?${qs}`, {
					method: "PUT",
					headers: { "Content-Type": "application/octet-stream" },
					body: blob,
					signal: this.abortController.signal,
				});
			} catch (err) {
				if (this.state === "paused" || err?.name === "AbortError") {
					this.state = "paused";
					this.setControls();
					throw err;
				}
				throw err;
			}

			const data = await res.json().catch(() => ({}));
			if (!res.ok) throw new Error(data.error || `Part ${partNumber} failed (${res.status})`);

			this.parts.set(partNumber, { partNumber: data.partNumber, etag: data.etag });
			this.nextPart = partNumber + 1;
			this.updateProgress();
		}

		await this.waitIfPaused();
		if (this.state === "cancelled") throw new Error("Upload cancelled");

		const parts = [...this.parts.values()].sort((a, b) => a.partNumber - b.partNumber);
		setStatus(uploadStatus, "Finalizing upload…", "");
		await api("/api/multipart/complete", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ key: this.key, uploadId: this.uploadId, parts }),
		});
	}
}

const uploader = new UploadController();
uploader.setControls();

uploadPauseBtn.addEventListener("click", () => uploader.pause());
uploadResumeBtn.addEventListener("click", () => uploader.resume());
uploadRetryBtn.addEventListener("click", () => uploader.retry());
uploadCancelBtn.addEventListener("click", () => uploader.cancel());

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

function startUploads(files) {
	if (!files?.length || me?.role !== "owner") return;
	uploader.enqueue([...files]);
	fileInput.value = "";
}

browseBtn.addEventListener("click", () => fileInput.click());
fileInput.addEventListener("change", () => startUploads(fileInput.files));

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
dropzone.addEventListener("drop", (event) => startUploads(event.dataTransfer?.files));

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
		uploadPanel.classList.remove("hidden");
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
	uploadPanel.classList.remove("hidden");
});
