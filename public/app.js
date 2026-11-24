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
const mediaGrid = document.getElementById("media-grid");
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
const heroTitle = document.getElementById("hero-title");
const heroKicker = document.getElementById("hero-kicker");
const libraryHeading = document.getElementById("library-heading");
const playerModal = document.getElementById("player-modal");
const playerStage = document.getElementById("player-stage");
const playerTitle = document.getElementById("player-title");
const playerMeta = document.getElementById("player-meta");
const playerNote = document.getElementById("player-note");
const playerDownload = document.getElementById("player-download");
const playerCopy = document.getElementById("player-copy");
const playerClose = document.getElementById("player-close");

/** @type {{ role: string, label?: string, friendId?: string } | null} */
let me = null;
/** @type {Array<MediaObject>} */
let objectsCache = [];
/** @type {Array<{id: string, label: string, objectKeys: string[]}>} */
let friendsCache = [];
/** @type {MediaObject|null} */
let activeObject = null;

/**
 * @typedef {{
 *   key: string,
 *   name: string,
 *   size: number,
 *   sizeLabel: string,
 *   uploaded: string,
 *   contentType: string|null,
 *   hasThumbnail: boolean,
 *   thumbnailUrl: string|null,
 *   mediaUrl: string
 * }} MediaObject
 */

/** 10 MiB parts — above R2's 5 MiB minimum, under the ~100 MiB Worker request limit. */
const PART_SIZE = 10 * 1024 * 1024;
const SIMPLE_UPLOAD_MAX = 20 * 1024 * 1024;

const VIDEO_EXT = new Set([
	"mp4",
	"webm",
	"ogg",
	"ogv",
	"mov",
	"m4v",
	"mkv",
	"avi",
	"mpeg",
	"mpg",
	"3gp",
]);
const IMAGE_EXT = new Set(["jpg", "jpeg", "png", "gif", "webp", "avif", "bmp", "svg"]);
/** Extensions that Chromium/Firefox commonly refuse or struggle with in <video>. */
const RISKY_VIDEO_EXT = new Set(["mkv", "avi", "mpeg", "mpg"]);

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

function extOf(name) {
	const base = name.split("/").pop() || name;
	const i = base.lastIndexOf(".");
	return i >= 0 ? base.slice(i + 1).toLowerCase() : "";
}

function kindOf(obj) {
	const type = (obj.contentType || "").toLowerCase();
	const ext = extOf(obj.name || obj.key);
	if (type.startsWith("image/") || IMAGE_EXT.has(ext)) return "image";
	if (type.startsWith("video/") || VIDEO_EXT.has(ext)) return "video";
	return "file";
}

function mediaUrlFor(obj) {
	return obj.mediaUrl || `/api/objects/${encodeURIComponent(obj.key).replaceAll("%2F", "/")}`;
}

function absoluteMediaUrl(obj) {
	return new URL(mediaUrlFor(obj), window.location.origin).toString();
}

function formatWhen(iso) {
	try {
		return new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
	} catch {
		return iso;
	}
}

function typeLabel(obj) {
	const type = obj.contentType;
	if (type) return type;
	const ext = extOf(obj.name || obj.key);
	return ext ? ext.toUpperCase() : "file";
}

function glyphFor(obj) {
	const ext = extOf(obj.name || obj.key);
	if (ext) return ext.slice(0, 4);
	const kind = kindOf(obj);
	if (kind === "video") return "VID";
	if (kind === "image") return "IMG";
	return "FILE";
}

/**
 * Heuristic playability for browser <video>.
 * Plays well: MP4 (H.264/AVC + AAC), WebM (VP8/VP9/AV1 + Opus/Vorbis), Ogg.
 * Often fails: MKV containers, HEVC/H.265, Dolby Digital Plus (E-AC-3 / DDP), trueHD.
 */
function playability(obj) {
	const kind = kindOf(obj);
	if (kind === "image") return { mode: "image", label: "View", badge: null, note: null };
	if (kind !== "video") return { mode: "file", label: "Open", badge: null, note: null };

	const type = (obj.contentType || "").toLowerCase();
	const ext = extOf(obj.name || obj.key);
	const name = (obj.name || obj.key).toLowerCase();

	const mentionsHevc =
		/hevc|h\.?265|x265|hev1|hvc1/.test(name) || /hevc|h\.?265/.test(type);
	const mentionsDdp = /ddp|e-?ac-?3|dolby|atmos|truehd|dts/.test(name);
	const riskyContainer = RISKY_VIDEO_EXT.has(ext) || type.includes("matroska") || type.includes("x-matroska");

	if (mentionsHevc || mentionsDdp || riskyContainer) {
		return {
			mode: "video-risky",
			label: "Try play",
			badge: "May not play",
			note:
				"This file likely uses a container or codec Chrome and Firefox cannot decode in-browser " +
				"(common with .mkv + HEVC/x265 and Dolby Digital Plus). Download and open in VLC or similar.",
		};
	}

	if (ext === "mp4" || ext === "m4v" || ext === "webm" || ext === "ogg" || ext === "ogv" || type.includes("mp4") || type.includes("webm")) {
		return { mode: "video", label: "Play", badge: null, note: null };
	}

	return {
		mode: "video-risky",
		label: "Try play",
		badge: "Check playback",
		note: "Browser support for this video format varies. If it fails to play, download instead.",
	};
}

async function api(path, options) {
	const res = await fetch(path, options);
	const data = await res.json().catch(() => ({}));
	if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
	return data;
}

async function captureVideoThumbnail(file) {
	const type = (file.type || "").toLowerCase();
	const ext = extOf(file.name);
	if (!type.startsWith("video/") && !VIDEO_EXT.has(ext)) return null;
	if (RISKY_VIDEO_EXT.has(ext) || type.includes("matroska")) return null;

	const url = URL.createObjectURL(file);
	try {
		const video = document.createElement("video");
		video.muted = true;
		video.playsInline = true;
		video.preload = "auto";
		video.src = url;

		await new Promise((resolve, reject) => {
			const timer = setTimeout(() => reject(new Error("thumb timeout")), 8000);
			video.onloadeddata = () => {
				clearTimeout(timer);
				resolve();
			};
			video.onerror = () => {
				clearTimeout(timer);
				reject(new Error("thumb load failed"));
			};
		});

		const seekTo = Math.min(1, (video.duration || 2) * 0.1);
		if (Number.isFinite(seekTo) && seekTo > 0) {
			await new Promise((resolve) => {
				video.onseeked = () => resolve();
				try {
					video.currentTime = seekTo;
				} catch {
					resolve();
				}
			});
		}

		const canvas = document.createElement("canvas");
		const w = video.videoWidth || 640;
		const h = video.videoHeight || 360;
		const maxW = 640;
		const scale = Math.min(1, maxW / w);
		canvas.width = Math.max(1, Math.round(w * scale));
		canvas.height = Math.max(1, Math.round(h * scale));
		const ctx = canvas.getContext("2d");
		if (!ctx) return null;
		ctx.drawImage(video, 0, 0, canvas.width, canvas.height);

		const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.82));
		return blob;
	} catch {
		return null;
	} finally {
		URL.revokeObjectURL(url);
	}
}

async function captureImageThumbnail(file) {
	const type = (file.type || "").toLowerCase();
	const ext = extOf(file.name);
	if (!type.startsWith("image/") && !IMAGE_EXT.has(ext)) return null;
	if (ext === "svg") return null;

	const url = URL.createObjectURL(file);
	try {
		const img = new Image();
		img.src = url;
		await new Promise((resolve, reject) => {
			img.onload = () => resolve();
			img.onerror = () => reject(new Error("image thumb failed"));
		});
		const canvas = document.createElement("canvas");
		const maxW = 640;
		const scale = Math.min(1, maxW / img.naturalWidth);
		canvas.width = Math.max(1, Math.round(img.naturalWidth * scale));
		canvas.height = Math.max(1, Math.round(img.naturalHeight * scale));
		const ctx = canvas.getContext("2d");
		if (!ctx) return null;
		ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
		return await new Promise((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.82));
	} catch {
		return null;
	} finally {
		URL.revokeObjectURL(url);
	}
}

async function uploadThumbnailFor(key, file) {
	let blob = await captureVideoThumbnail(file);
	if (!blob) blob = await captureImageThumbnail(file);
	if (!blob) return;

	const body = new FormData();
	body.append("key", key);
	body.append("file", blob, "thumb.jpg");
	try {
		await api("/api/thumbnails", { method: "POST", body });
	} catch {
		/* thumbnail is best-effort */
	}
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
			let uploadedKey = this.file.name;
			if (this.file.size <= SIMPLE_UPLOAD_MAX && !this.uploadId) {
				setStatus(uploadStatus, `Uploading ${this.file.name} (${formatBytes(this.file.size)})…`, "");
				uploadProgressBar.style.width = "50%";
				uploadProgressLabel.textContent = `… · ${formatBytes(this.file.size)}`;
				const result = await this.uploadSimple(this.file);
				uploadedKey = result.key || this.file.name;
				uploadProgressBar.style.width = "100%";
				uploadProgressLabel.textContent = `100% · ${formatBytes(this.file.size)} / ${formatBytes(this.file.size)}`;
			} else {
				await this.uploadMultipart();
				uploadedKey = this.key || this.file.name;
			}
			if (this.state === "cancelled") return;

			setStatus(uploadStatus, "Generating thumbnail…", "");
			await uploadThumbnailFor(uploadedKey, this.file);

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
		this.key = data.key || file.name;
		return data;
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
			setStatus(uploadStatus, `Uploading part ${partNumber}/${this.totalParts}…`, "");

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

function thumbHtml(obj) {
	const kind = kindOf(obj);
	const play = playability(obj);
	const badge = play.badge
		? `<span class="media-badge warn">${escapeHtml(play.badge)}</span>`
		: kind === "video"
			? `<span class="media-badge">Video</span>`
			: kind === "image"
				? `<span class="media-badge">Image</span>`
				: "";

	if (obj.hasThumbnail && obj.thumbnailUrl) {
		return `
			<div class="media-thumb">
				<img src="${escapeHtml(obj.thumbnailUrl)}" alt="" loading="lazy" />
				${badge}
			</div>`;
	}

	if (kind === "image") {
		return `
			<div class="media-thumb">
				<img src="${escapeHtml(mediaUrlFor(obj))}" alt="" loading="lazy" />
				${badge}
			</div>`;
	}

	return `
		<div class="media-thumb">
			<div class="media-thumb-fallback">
				<span class="file-glyph">${escapeHtml(glyphFor(obj))}</span>
			</div>
			${badge}
		</div>`;
}

function renderObjects(objects) {
	mediaGrid.innerHTML = "";
	if (!objects.length) {
		emptyState.classList.remove("hidden");
		emptyState.textContent = me?.role === "friend" ? "No files shared with you yet." : "No files yet.";
		return;
	}
	emptyState.classList.add("hidden");

	for (const obj of objects) {
		const play = playability(obj);
		const card = document.createElement("article");
		card.className = "media-card";
		card.dataset.key = obj.key;

		const deleteBtn =
			me?.role === "owner"
				? `<button type="button" class="btn danger sm" data-delete="${escapeHtml(obj.key)}">Delete</button>`
				: "";

		card.innerHTML = `
			${thumbHtml(obj)}
			<div class="media-body">
				<p class="media-name" title="${escapeHtml(obj.name || obj.key)}">${escapeHtml(obj.name || obj.key)}</p>
				<p class="media-meta">${escapeHtml(obj.sizeLabel)} · ${escapeHtml(typeLabel(obj))} · ${escapeHtml(formatWhen(obj.uploaded))}</p>
				<div class="media-actions">
					<button type="button" class="btn primary sm" data-open="${escapeHtml(obj.key)}">${escapeHtml(play.label)}</button>
					<a class="btn ghost sm" href="${escapeHtml(mediaUrlFor(obj))}" download="${escapeHtml(obj.name || obj.key)}">Download</a>
					<button type="button" class="btn ghost sm" data-copy="${escapeHtml(obj.key)}">Copy link</button>
					${deleteBtn}
				</div>
			</div>
		`;
		mediaGrid.appendChild(card);
	}
}

function clearPlayerStage() {
	playerStage.innerHTML = "";
	playerNote.classList.add("hidden");
	playerNote.textContent = "";
}

function showDownloadFallback(obj, message) {
	clearPlayerStage();
	playerStage.innerHTML = `
		<div class="player-fallback">
			<h3>Can’t play in this browser</h3>
			<p>${escapeHtml(message)}</p>
		</div>`;
	playerNote.textContent = message;
	playerNote.classList.remove("hidden");
}

function openPlayer(obj) {
	activeObject = obj;
	const play = playability(obj);
	const url = mediaUrlFor(obj);

	playerTitle.textContent = obj.name || obj.key;
	playerMeta.textContent = `${obj.sizeLabel} · ${typeLabel(obj)} · ${formatWhen(obj.uploaded)}`;
	playerDownload.href = url;
	playerDownload.setAttribute("download", obj.name || obj.key);
	clearPlayerStage();

	if (play.mode === "image") {
		const img = document.createElement("img");
		img.src = url;
		img.alt = obj.name || obj.key;
		playerStage.appendChild(img);
	} else if (play.mode === "video" || play.mode === "video-risky") {
		if (play.note) {
			playerNote.textContent = play.note;
			playerNote.classList.remove("hidden");
		}

		const video = document.createElement("video");
		video.controls = true;
		video.playsInline = true;
		video.preload = "metadata";
		video.src = url;
		video.setAttribute("controlsList", "nodownload");

		const onFail = () => {
			showDownloadFallback(
				obj,
				play.note ||
					"This video could not be decoded in your browser. Download it and open with VLC or another desktop player.",
			);
		};

		video.addEventListener("error", onFail);
		video.addEventListener("loadedmetadata", () => {
			if (!Number.isFinite(video.duration) || video.duration === 0) {
				/* some containers report oddly; keep trying */
			}
		});

		playerStage.appendChild(video);

		const tryPlay = video.play();
		if (tryPlay && typeof tryPlay.catch === "function") {
			tryPlay.catch(() => {
				/* autoplay blocked is fine; user can press play */
			});
		}

		if (play.mode === "video-risky") {
			// After a short wait, if readyState is still nothing useful and error fired, fallback already shown.
			window.setTimeout(() => {
				if (video.error) onFail();
			}, 2500);
		}
	} else {
		showDownloadFallback(obj, "This file type isn’t previewable in the browser. Download to open it locally.");
	}

	if (typeof playerModal.showModal === "function") {
		playerModal.showModal();
	} else {
		playerModal.setAttribute("open", "");
	}
}

function closePlayer() {
	clearPlayerStage();
	activeObject = null;
	if (typeof playerModal.close === "function") playerModal.close();
	else playerModal.removeAttribute("open");
}

async function copyLink(obj) {
	const url = absoluteMediaUrl(obj);
	try {
		await navigator.clipboard.writeText(url);
		return true;
	} catch {
		window.prompt("Copy link", url);
		return false;
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
		<label class="file-pick">
			<input type="checkbox" name="objectKeys" value="${escapeHtml(obj.key)}" ${selectedSet.has(obj.key) ? "checked" : ""} />
			<span>${escapeHtml(obj.name || obj.key)}</span>
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
		const row = document.createElement("article");
		row.className = "friend-row";
		const count = friend.objectKeys.length;
		row.innerHTML = `
			<div>
				<h3>${escapeHtml(friend.label)}</h3>
				<p>${count} file${count === 1 ? "" : "s"} assigned</p>
			</div>
			<div class="friend-row-actions">
				<button type="button" class="btn ghost sm" data-edit-friend="${escapeHtml(friend.id)}">Edit</button>
				<button type="button" class="btn danger sm" data-delete-friend="${escapeHtml(friend.id)}">Remove</button>
			</div>
		`;
		friendList.appendChild(row);
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
		uploadPanel.classList.remove("hidden");
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
		dropzone.classList.add("dragover");
	});
});
["dragleave", "drop"].forEach((eventName) => {
	dropzone.addEventListener(eventName, (event) => {
		event.preventDefault();
		dropzone.classList.remove("dragover");
	});
});
dropzone.addEventListener("drop", (event) => startUploads(event.dataTransfer?.files));

mediaGrid.addEventListener("click", async (event) => {
	const target = event.target;
	if (!(target instanceof HTMLElement)) return;

	const openKey = target.getAttribute("data-open");
	if (openKey) {
		const obj = objectsCache.find((o) => o.key === openKey);
		if (obj) openPlayer(obj);
		return;
	}

	const copyKey = target.getAttribute("data-copy");
	if (copyKey) {
		const obj = objectsCache.find((o) => o.key === copyKey);
		if (!obj) return;
		const ok = await copyLink(obj);
		target.textContent = ok ? "Copied" : "Copy link";
		window.setTimeout(() => {
			target.textContent = "Copy link";
		}, 1400);
		return;
	}

	const deleteKey = target.getAttribute("data-delete");
	if (!deleteKey) return;
	if (!confirm(`Delete “${deleteKey}”?`)) return;
	target.disabled = true;
	try {
		const encoded = encodeURIComponent(deleteKey).replaceAll("%2F", "/");
		await api(`/api/objects/${encoded}`, { method: "DELETE" });
		setStatus(uploadStatus, `Deleted ${deleteKey}.`, "ok");
		uploadPanel.classList.remove("hidden");
		await refresh();
	} catch (err) {
		setStatus(uploadStatus, err.message || "Delete failed", "error");
		target.disabled = false;
	}
});

playerClose.addEventListener("click", () => closePlayer());
playerModal.addEventListener("close", () => clearPlayerStage());
playerModal.addEventListener("click", (event) => {
	if (event.target === playerModal) closePlayer();
});

playerCopy.addEventListener("click", async () => {
	if (!activeObject) return;
	const ok = await copyLink(activeObject);
	playerCopy.textContent = ok ? "Copied" : "Copy link";
	window.setTimeout(() => {
		playerCopy.textContent = "Copy link";
	}, 1400);
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

document.addEventListener("keydown", (event) => {
	if (event.key === "Escape" && playerModal.open) closePlayer();
});

async function boot() {
	me = await api("/api/me");
	rolePill.textContent = me.role === "owner" ? "Owner" : "Friend";
	rolePill.classList.remove("hidden");

	if (me.role === "owner") {
		heroKicker.textContent = "Your library";
		heroTitle.textContent = "Vybe";
		lede.textContent = "Upload media, assign files to friends, and stream what browsers can play.";
		libraryHeading.textContent = "All media";
		uploadSection.classList.remove("hidden");
		friendsSection.classList.remove("hidden");
	} else {
		heroKicker.textContent = "Shared with you";
		heroTitle.textContent = me.label || "Friend";
		lede.textContent = "Browse your shared media — play videos, view images, or download anything.";
		libraryHeading.textContent = "Your media";
	}

	await refresh();
}

boot().catch((err) => {
	heroTitle.textContent = "Vybe";
	lede.textContent = err.message || "Could not load Vybe.";
	setStatus(uploadStatus, err.message || "Startup failed", "error");
	uploadPanel.classList.remove("hidden");
});
