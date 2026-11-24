const fileInput = document.getElementById("file-input");
const browseBtn = document.getElementById("browse-btn");
const dropzone = document.getElementById("upload-form");
const uploadStatus = document.getElementById("upload-status");
const objectList = document.getElementById("object-list");
const emptyState = document.getElementById("empty-state");
const refreshBtn = document.getElementById("refresh-btn");

function setStatus(message, kind = "") {
	uploadStatus.textContent = message;
	uploadStatus.className = `status${kind ? ` ${kind}` : ""}`;
}

function escapeHtml(value) {
	return String(value)
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;")
		.replaceAll('"', "&quot;")
		.replaceAll("'", "&#39;");
}

async function listObjects() {
	const res = await fetch("/api/objects");
	const data = await res.json();
	if (!res.ok) throw new Error(data.error || "Failed to list objects");
	return data.objects ?? [];
}

function renderObjects(objects) {
	objectList.innerHTML = "";
	if (!objects.length) {
		emptyState.classList.remove("hidden");
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
		row.innerHTML = `
			<div class="object-meta">
				<p class="object-key"><a href="/api/objects/${encoded}" target="_blank" rel="noopener">${escapeHtml(obj.key)}</a></p>
				<p class="object-sub">${escapeHtml(obj.sizeLabel)} · ${escapeHtml(obj.contentType || "unknown type")} · ${escapeHtml(when)}</p>
			</div>
			<div class="object-actions">
				<button type="button" class="btn danger" data-delete="${escapeHtml(obj.key)}">Delete</button>
			</div>
		`;
		objectList.appendChild(row);
	}
}

async function refresh() {
	refreshBtn.disabled = true;
	try {
		const objects = await listObjects();
		renderObjects(objects);
	} catch (err) {
		setStatus(err.message || "Could not refresh list", "error");
	} finally {
		refreshBtn.disabled = false;
	}
}

async function uploadFiles(files) {
	if (!files?.length) return;
	const list = [...files];
	setStatus(`Uploading ${list.length} file${list.length === 1 ? "" : "s"}…`);

	let ok = 0;
	const errors = [];

	for (const file of list) {
		const body = new FormData();
		body.append("file", file, file.name);
		try {
			const res = await fetch("/api/upload", { method: "POST", body });
			const data = await res.json();
			if (!res.ok) throw new Error(data.error || `Upload failed for ${file.name}`);
			ok += 1;
		} catch (err) {
			errors.push(err.message || String(err));
		}
	}

	if (errors.length) {
		setStatus(
			`Uploaded ${ok}/${list.length}. ${errors[0]}${errors.length > 1 ? ` (+${errors.length - 1} more)` : ""}`,
			ok ? "ok" : "error",
		);
	} else {
		setStatus(`Uploaded ${ok} file${ok === 1 ? "" : "s"}.`, "ok");
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

dropzone.addEventListener("drop", (event) => {
	uploadFiles(event.dataTransfer?.files);
});

objectList.addEventListener("click", async (event) => {
	const target = event.target;
	if (!(target instanceof HTMLElement)) return;
	const key = target.getAttribute("data-delete");
	if (!key) return;

	if (!confirm(`Delete “${key}”?`)) return;
	target.disabled = true;
	try {
		const encoded = encodeURIComponent(key).replaceAll("%2F", "/");
		const res = await fetch(`/api/objects/${encoded}`, { method: "DELETE" });
		const data = await res.json();
		if (!res.ok) throw new Error(data.error || "Delete failed");
		setStatus(`Deleted ${key}.`, "ok");
		await refresh();
	} catch (err) {
		setStatus(err.message || "Delete failed", "error");
		target.disabled = false;
	}
});

refreshBtn.addEventListener("click", () => refresh());

refresh().catch((err) => setStatus(err.message || "Startup list failed", "error"));
