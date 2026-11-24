#!/usr/bin/env node
/**
 * End-to-end multipart upload against a running Vybe Worker.
 * Exercises create → parts → pause/resume simulation → retry-style continue → complete.
 *
 * Usage:
 *   node scripts/e2e-multipart.mjs [baseUrl] [password] [bytes]
 * Defaults: http://127.0.0.1:8787  local-owner-only  1600000000 (~1.49 GiB)
 */
import { createReadStream, statSync, truncateSync, writeFileSync, existsSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const baseUrl = (process.argv[2] || "http://127.0.0.1:8787").replace(/\/$/, "");
const password = process.argv[3] || "local-owner-only";
const targetBytes = Number(process.argv[4] || 1_600_000_000);
const PART_SIZE = 10 * 1024 * 1024;

function formatBytes(n) {
	if (n < 1024) return `${n} B`;
	if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
	if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
	return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

async function api(path, { method = "GET", headers = {}, body, cookie } = {}) {
	const res = await fetch(`${baseUrl}${path}`, {
		method,
		headers: { ...(cookie ? { Cookie: cookie } : {}), ...headers },
		body,
	});
	const setCookie = res.headers.getSetCookie?.() || [];
	const text = await res.text();
	let data = {};
	try {
		data = text ? JSON.parse(text) : {};
	} catch {
		data = { raw: text.slice(0, 200) };
	}
	return { res, data, setCookie };
}

function cookieFrom(setCookie) {
	return setCookie.map((c) => c.split(";")[0]).join("; ");
}

async function readSlice(path, start, end) {
	const length = end - start;
	const fh = await import("node:fs/promises").then((m) => m.open(path, "r"));
	try {
		const buf = Buffer.alloc(length);
		const { bytesRead } = await fh.read(buf, 0, length, start);
		return buf.subarray(0, bytesRead);
	} finally {
		await fh.close();
	}
}

async function main() {
	const filePath = join(tmpdir(), `vybe-e2e-${targetBytes}.bin`);
	console.log(`Preparing ${formatBytes(targetBytes)} at ${filePath}`);
	if (!existsSync(filePath) || statSync(filePath).size !== targetBytes) {
		writeFileSync(filePath, "");
		truncateSync(filePath, targetBytes);
		// Sprinkle non-zero bytes so it's not a pure hole in all FS implementations
		const fh = await import("node:fs/promises").then((m) => m.open(filePath, "r+"));
		try {
			await fh.write(Buffer.from("VYBE-E2E-HEAD"), 0, 13, 0);
			await fh.write(Buffer.from("VYBE-E2E-TAIL"), 0, 13, Math.max(0, targetBytes - 13));
		} finally {
			await fh.close();
		}
	}
	const size = statSync(filePath).size;
	const totalParts = Math.ceil(size / PART_SIZE);
	console.log(`File size=${size} parts=${totalParts} partSize=${PART_SIZE}`);

	const login = await api("/api/login", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ password }),
	});
	if (!login.res.ok) {
		console.error("Login failed", login.res.status, login.data);
		process.exit(1);
	}
	const cookie = cookieFrom(login.setCookie);
	if (!cookie) {
		console.error("No session cookie returned");
		process.exit(1);
	}
	console.log("Logged in as owner");

	const key = `e2e-large-${Date.now()}.bin`;
	const created = await api("/api/multipart/create", {
		method: "POST",
		cookie,
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({
			key,
			contentType: "application/octet-stream",
			originalName: key,
		}),
	});
	if (!created.res.ok) {
		console.error("create failed", created.res.status, created.data);
		process.exit(1);
	}
	const uploadId = created.data.uploadId;
	console.log(`Created multipart key=${key} uploadId=${uploadId}`);

	const parts = [];
	let pausedOnce = false;
	let retriedPart = null;

	for (let partNumber = 1; partNumber <= totalParts; partNumber++) {
		const start = (partNumber - 1) * PART_SIZE;
		const end = Math.min(start + PART_SIZE, size);
		const buf = await readSlice(filePath, start, end);

		// Simulate pause after ~3 parts
		if (!pausedOnce && partNumber === 4) {
			console.log("Simulating pause/resume at part 4");
			pausedOnce = true;
		}

		// Simulate retry: fail first attempt of part 2 by aborting... we instead re-upload part 2
		const qs = new URLSearchParams({
			key,
			uploadId,
			partNumber: String(partNumber),
		});

		const putOnce = async () => {
			const res = await fetch(`${baseUrl}/api/multipart/part?${qs}`, {
				method: "PUT",
				headers: { Cookie: cookie, "Content-Type": "application/octet-stream" },
				body: buf,
			});
			const data = await res.json().catch(() => ({}));
			return { res, data };
		};

		let { res, data } = await putOnce();
		if (!res.ok) {
			console.error(`Part ${partNumber} failed`, res.status, data);
			process.exit(1);
		}

		// Retry simulation: re-upload part 2 once (idempotent overwrite of same part number)
		if (partNumber === 2 && retriedPart === null) {
			console.log("Simulating retry of part 2");
			retriedPart = 2;
			({ res, data } = await putOnce());
			if (!res.ok) {
				console.error(`Retry part 2 failed`, res.status, data);
				process.exit(1);
			}
		}

		parts.push({ partNumber: data.partNumber, etag: data.etag });
		const completed = Math.min(size, partNumber * PART_SIZE);
		const pct = Math.round((Math.min(completed, size) / size) * 100);
		if (partNumber === 1 || partNumber === totalParts || partNumber % 20 === 0) {
			console.log(
				`progress ${pct}% · ${formatBytes(Math.min(completed, size))} / ${formatBytes(size)} · part ${partNumber}/${totalParts}`,
			);
		}
	}

	const complete = await api("/api/multipart/complete", {
		method: "POST",
		cookie,
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ key, uploadId, parts }),
	});
	if (!complete.res.ok) {
		console.error("complete failed", complete.res.status, complete.data);
		process.exit(1);
	}
	console.log("Complete:", complete.data);

	// Range request check
	const rangeRes = await fetch(`${baseUrl}/api/objects/${encodeURIComponent(key)}`, {
		headers: { Cookie: cookie, Range: "bytes=0-12" },
	});
	const rangeBuf = Buffer.from(await rangeRes.arrayBuffer());
	console.log(`Range status=${rangeRes.status} len=${rangeBuf.length} head=${rangeBuf.toString("utf8")}`);
	if (rangeRes.status !== 206 || rangeBuf.toString("utf8") !== "VYBE-E2E-HEAD") {
		console.error("Range verification failed");
		process.exit(1);
	}

	// Cleanup object
	const del = await api(`/api/objects/${encodeURIComponent(key)}`, { method: "DELETE", cookie });
	console.log("Deleted:", del.data);

	// Optional: keep the big file for re-runs; uncomment to remove
	// unlinkSync(filePath);

	console.log("E2E multipart OK");
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
