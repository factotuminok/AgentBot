/**
 * 1-based line of `path` inside the JSON text `text`, for the Problems panel (WEB-28): the line of the member's key
 * for an object step, of the element for an array step, and of the deepest step that exists when the rest is missing
 * (a required key reported on its parent). Comments and trailing commas are skipped, since VS Code edits these files
 * as JSON with comments. Undefined when not even the root value can be found, e.g. in an empty file.
 */
export function jsonPathLine(text: string, path: readonly (string | number)[]): number | undefined {
	let pos = 0;
	let best = -1;

	const skipTrivia = () => {
		for (;;) {
			const c = text[pos];
			if (c === " " || c === "\t" || c === "\n" || c === "\r" || c === "\uFEFF") pos++;
			else if (c === "/" && text[pos + 1] === "/") {
				const end = text.indexOf("\n", pos);
				pos = end < 0 ? text.length : end;
			} else if (c === "/" && text[pos + 1] === "*") {
				const end = text.indexOf("*/", pos + 2);
				if (end < 0) throw new SyntaxError("unterminated comment");
				pos = end + 2;
			} else return;
		}
	};

	const readString = (): string => {
		const start = pos++;
		while (pos < text.length) {
			const c = text[pos];
			if (c === "\\") pos += 2;
			else if (c === '"') return JSON.parse(text.slice(start, ++pos)) as string;
			else pos++;
		}
		throw new SyntaxError("unterminated string");
	};

	const LITERAL = /true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/y;

	/** Scans the value at `pos`; `onPath` says the steps before `depth` all matched. */
	const value = (depth: number, onPath: boolean): void => {
		skipTrivia();
		const step = onPath && depth < path.length ? String(path[depth]) : undefined;
		const open = text[pos];
		if (open === "{" || open === "[") {
			const close = open === "{" ? "}" : "]";
			pos++;
			skipTrivia();
			for (let index = 0; text[pos] !== close; index++) {
				if (pos >= text.length) throw new SyntaxError("unterminated container");
				const at = pos;
				let hit: boolean;
				if (open === "{") {
					if (text[pos] !== '"') throw new SyntaxError("expected a key");
					hit = readString() === step;
					skipTrivia();
					if (text[pos++] !== ":") throw new SyntaxError("expected a colon");
				} else hit = String(index) === step;
				// A later duplicate key wins, as in JSON.parse.
				if (hit) best = at;
				value(depth + 1, hit);
				skipTrivia();
				if (text[pos] === ",") {
					pos++;
					skipTrivia();
				} else if (text[pos] !== close) throw new SyntaxError("expected a comma");
			}
			pos++;
		} else if (open === '"') readString();
		else {
			LITERAL.lastIndex = pos;
			if (!LITERAL.exec(text)) throw new SyntaxError("unexpected token");
			pos = LITERAL.lastIndex;
		}
	};

	try {
		skipTrivia();
		if (pos >= text.length) return undefined;
		best = pos;
		value(0, true);
	} catch {
		// A syntax error after the located part leaves `best` valid; VS Code reports the syntax error itself.
	}
	return best < 0 ? undefined : text.slice(0, best).split("\n").length;
}
