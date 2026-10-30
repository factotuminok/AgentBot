import { errorMessage } from "./log";

/**
 * Reads a mounted internal token (SEC-14) that the process cannot work without: throws, naming `variable`, when the
 * variable is unset or the file cannot be read or is empty.
 */
export async function readTokenFile(path: string | undefined, variable: string): Promise<string> {
	if (!path) throw new Error(`${variable} must be set`);
	let token: string;
	try {
		token = (await Bun.file(path).text()).trim();
	} catch (err) {
		throw new Error(`${variable} ${path} could not be read: ${errorMessage(err)}`);
	}
	if (!token) throw new Error(`${variable} ${path} is empty`);
	return token;
}
