import { deflateRawSync } from "node:zlib";

/** One zip entry; `mode` is the Unix mode including the file type (`0o120777` makes a symlink). */
export interface ZipItem {
	path: string;
	data?: string | Uint8Array;
	mode?: number;
	deflate?: boolean;
	/** Overrides the size recorded in the headers (a lying archive). */
	declaredSize?: number;
	/** Overrides the CRC recorded in the headers (a damaged archive). */
	crc?: number;
}

/** A minimal zip writer for tests: arbitrary names, modes and sizes, which real zip tools refuse to produce. */
export function makeZip(items: ZipItem[]): Uint8Array<ArrayBuffer> {
	const encoder = new TextEncoder();
	const locals: Uint8Array[] = [];
	const centrals: Uint8Array[] = [];
	let offset = 0;
	for (const item of items) {
		const name = encoder.encode(item.path);
		const raw = typeof item.data === "string" ? encoder.encode(item.data) : (item.data ?? new Uint8Array());
		const method = item.deflate ? 8 : 0;
		const body = item.deflate ? new Uint8Array(deflateRawSync(raw)) : raw;
		const crc = item.crc ?? Bun.hash.crc32(raw);
		const size = item.declaredSize ?? raw.length;
		const mode = item.mode ?? (item.path.endsWith("/") ? 0o040755 : 0o100644);

		const local = new DataView(new ArrayBuffer(30));
		local.setUint32(0, 0x04034b50, true);
		local.setUint16(4, 20, true);
		local.setUint16(6, 0x800, true);
		local.setUint16(8, method, true);
		local.setUint32(14, crc, true);
		local.setUint32(18, body.length, true);
		local.setUint32(22, size, true);
		local.setUint16(26, name.length, true);
		locals.push(new Uint8Array(local.buffer), name, body);

		const central = new DataView(new ArrayBuffer(46));
		central.setUint32(0, 0x02014b50, true);
		central.setUint16(4, (3 << 8) | 20, true);
		central.setUint16(6, 20, true);
		central.setUint16(8, 0x800, true);
		central.setUint16(10, method, true);
		central.setUint32(16, crc, true);
		central.setUint32(20, body.length, true);
		central.setUint32(24, size, true);
		central.setUint16(28, name.length, true);
		central.setUint32(38, (mode << 16) >>> 0, true);
		central.setUint32(42, offset, true);
		centrals.push(new Uint8Array(central.buffer), name);
		offset += 30 + name.length + body.length;
	}
	const cdSize = centrals.reduce((sum, part) => sum + part.length, 0);
	const end = new DataView(new ArrayBuffer(22));
	end.setUint32(0, 0x06054b50, true);
	end.setUint16(8, items.length, true);
	end.setUint16(10, items.length, true);
	end.setUint32(12, cdSize, true);
	end.setUint32(16, offset, true);
	return Buffer.concat([...locals, ...centrals, new Uint8Array(end.buffer)]);
}
