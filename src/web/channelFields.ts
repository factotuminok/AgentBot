import type { SettingsView } from "../shared/adminApi";
import { CANT_SEE_CHANNEL, type CategoryChoice, type ChannelChoice, type ChannelListing, CHANNELS_UNCONFIGURED } from "../shared/adminChannels";
import { type AdminClient, AdminApiError } from "./adminClient";
import { CHANNEL_FIELDS } from "./forms";
import { esc } from "./views";

/**
 * The Settings page's Discord channel fields (WEB-20 to WEB-23): typed ids until the bot token and guild id are stored,
 * then dropdowns from the orchestrator's channel listing. When listing fails, each field shows the error with Retry
 * while a hidden input keeps its stored value, so the rest of the form still saves.
 */

/** Dropdowns with more entries than this get a filter box (WEB-20). */
const FILTER_ABOVE = 20;

/** Query parameter of `GET /admin` that reloads the channel list (WEB-23 Refresh and Retry). */
export const REFRESH_CHANNELS = "refreshChannels";

/** The listing for the settings in `view`: unconfigured without a stored token and guild; API errors read as listing errors. */
export async function loadChannelListing(admin: AdminClient, view: SettingsView, refresh: boolean): Promise<ChannelListing> {
	if (!view.config?.discord.guildId || !view.secrets.discordToken) return { state: "unconfigured", message: CHANNELS_UNCONFIGURED };
	try {
		return await admin.call<ChannelListing>("GET", `/channels${refresh ? "?refresh=1" : ""}`);
	} catch (err) {
		if (!(err instanceof AdminApiError)) throw err;
		return { state: "error", error: `The Discord channels could not be listed: ${err.message}` };
	}
}

/** Label HTML (with its hover help) and the `aria-describedby` attribute of a field, as the settings form builds them. */
export interface FieldLabel {
	label: string;
	describedBy: string;
}

type Listed = Extract<ChannelListing, { state: "ok" }>;

/** What is wrong with a channel or category for the bot (WEB-21), and whether it is a watch channel (WEB-22). */
function notes(c: ChannelChoice | CategoryChoice): string[] {
	return [
		...("watchOf" in c && c.watchOf ? [`watch channel of ${c.watchOf}`] : []),
		...(!c.viewable ? [CANT_SEE_CHANNEL] : c.missing.length ? [`missing ${c.missing.join(", ")}`] : []),
	];
}

function optionText(name: string, c: ChannelChoice | CategoryChoice): string {
	const problems = notes(c);
	return problems.length ? `${name} — ${problems.join("; ")}` : name;
}

/** The warning under a field for its current choice; a configured channel that has disappeared reads "unknown channel <id>" (WEB-24). */
function currentWarning(c: ChannelChoice | CategoryChoice | undefined, id: string, name: string): string {
	if (!id) return "";
	if (!c) return `<p class="warning">unknown channel ${esc(id)}: it no longer exists or is not a ${name}; choose another.</p>`;
	const shown = "categoryId" in c ? `#${c.name}` : c.name;
	if (!c.viewable) return `<p class="warning">${esc(shown)}: ${esc(CANT_SEE_CHANNEL)}.</p>`;
	if ("watchOf" in c && c.watchOf) return `<p class="warning">${esc(shown)} is the watch channel of ${esc(c.watchOf)}; choose another channel.</p>`;
	if (c.missing.length) return `<p class="warning">The bot lacks ${esc(c.missing.join(", "))} in ${esc(shown)}.</p>`;
	return "";
}

/** An `<option>`; one the bot can't view is disabled unless it is the current choice, which must stay submittable. */
function option(id: string, text: string, viewable: boolean, current: string): string {
	const selected = id === current;
	return `<option value="${esc(id)}"${selected ? " selected" : ""}${!viewable && !selected ? " disabled data-blocked" : ""}>${esc(text)}</option>`;
}

const unknownOption = (id: string) => `<option value="${esc(id)}" selected>unknown channel ${esc(id)}</option>`;

/**
 * Text channels `offered` keeps, grouped under their categories in Discord's order. `current` stays listed even when it
 * would not be offered (WEB-22).
 */
function channelOptions(listing: Listed, current: string, offered: (c: ChannelChoice) => boolean): string {
	const shown = listing.channels.filter(c => c.id === current || offered(c));
	const html = (list: ChannelChoice[]) => list.map(c => option(c.id, optionText(`#${c.name}`, c), c.viewable, current)).join("");
	const groups = listing.categories.map(cat => {
		const inside = shown.filter(c => c.categoryId === cat.id);
		return inside.length ? `<optgroup label="${esc(cat.name)}">${html(inside)}</optgroup>` : "";
	});
	const unknown = current && !listing.channels.some(c => c.id === current) ? unknownOption(current) : "";
	return unknown + html(shown.filter(c => c.categoryId === null)) + groups.join("");
}

function select(name: string, label: FieldLabel, options: string, count: number, extra = ""): string {
	const id = `select-${name}`;
	const filter = count > FILTER_ABOVE ? ` <input type="search" placeholder="Filter" aria-label="Filter the list" data-filter-for="${esc(id)}">` : "";
	return `<label><span>${label.label}</span> <select id="${esc(id)}" name="${esc(name)}"${extra}${label.describedBy}>${options}</select>${filter}</label>`;
}

/**
 * One channel field of the settings form, from its current text in `config` (a comma list for ask-only channels).
 * A dropdown never offers watch channels or a channel chosen in another field (WEB-22). `typed` is the plain input
 * used before the bot token and guild id are stored (WEB-23).
 */
export function channelFieldHtml(name: string, config: Record<string, string>, listing: ChannelListing, label: FieldLabel, typed: string): string {
	const value = config[name] ?? "";
	if (listing.state === "unconfigured") return `${typed}<p class="hint">${esc(listing.message)}</p>`;
	if (listing.state === "error") {
		const invite = listing.inviteLink ? ` <a href="${esc(listing.inviteLink)}">Invite the bot</a>` : "";
		return `<div class="channel-field"><label><span>${label.label}</span> <input type="hidden" name="${esc(name)}" value="${esc(value)}">
<span class="error" role="alert">${esc(listing.error)}${invite} <button type="submit" form="channels-refresh">Retry</button></span></label></div>`;
	}

	if (name === CHANNEL_FIELDS.category) {
		const current = listing.categories.find(c => c.id === value);
		const options = listing.categories.map(c => option(c.id, optionText(c.name, c), c.viewable, value)).join("");
		const none = `<option value="">None: create watch channels at the top level</option>`;
		return `<div class="channel-field">${select(name, label, none + (value && !current ? unknownOption(value) : "") + options, listing.categories.length)}${currentWarning(current, value, "category")}</div>`;
	}

	const byId = new Map(listing.channels.map(c => [c.id, c]));
	const work = config[CHANNEL_FIELDS.work] ?? "";
	const asks = (config[CHANNEL_FIELDS.ask] ?? "").split(/[\s,]+/).filter(Boolean);
	const free = (c: ChannelChoice) => !c.watchOf && c.id !== work && !asks.includes(c.id);
	if (name === CHANNEL_FIELDS.work) {
		const choose = value ? "" : `<option value="">Choose a channel</option>`;
		const refresh = ` <button type="submit" form="channels-refresh">Refresh channel list</button>`;
		return `<div class="channel-field">${select(name, label, choose + channelOptions(listing, value, free), listing.channels.length, " data-channel-pick")}${refresh}${currentWarning(byId.get(value), value, "text channel")}</div>`;
	}

	const rows = asks.map(id => {
		const c = byId.get(id);
		return `<li><input type="hidden" name="${esc(name)}" value="${esc(id)}" data-ask-channel>${esc(c ? optionText(`#${c.name}`, c) : `unknown channel ${id}`)}
<label style="display:inline"><input type="checkbox" name="${esc(name)}.remove" value="${esc(id)}"> Remove</label>${currentWarning(c, id, "text channel")}</li>`;
	});
	const add = select(
		`${name}.add`,
		{ label: "Add ask-only channel", describedBy: label.describedBy },
		`<option value="">Choose a channel to add</option>${channelOptions(listing, "", free)}`,
		listing.channels.length,
		" data-channel-pick",
	);
	return `<div class="channel-field"><span>${label.label}</span>${rows.length ? `<ul>${rows.join("\n")}</ul>` : `<p class="hint">None yet.</p>`}${add}</div>`;
}

/**
 * Outside the settings form: the GET form behind Refresh and Retry, and the script that keeps WEB-22 while choosing (a
 * channel picked in one field is disabled in the others) and filters long lists.
 */
export const CHANNEL_EXTRAS = `<form id="channels-refresh" method="get" action="/admin"><input type="hidden" name="${REFRESH_CHANNELS}" value="1"></form>
<script>
(function () {
	var picks = Array.prototype.slice.call(document.querySelectorAll("select[data-channel-pick]"));
	function sync() {
		var taken = {};
		document.querySelectorAll("input[data-ask-channel]").forEach(function (input) { taken[input.value] = input; });
		picks.forEach(function (select) { if (select.value) taken[select.value] = select; });
		picks.forEach(function (select) {
			Array.prototype.forEach.call(select.options, function (option) {
				if (!option.value || option.hasAttribute("data-blocked") || option.selected) return;
				option.disabled = !!taken[option.value] && taken[option.value] !== select;
			});
		});
	}
	picks.forEach(function (select) { select.addEventListener("change", sync); });
	sync();
	document.querySelectorAll("input[data-filter-for]").forEach(function (box) {
		var select = document.getElementById(box.getAttribute("data-filter-for"));
		box.addEventListener("input", function () {
			var q = box.value.trim().toLowerCase();
			Array.prototype.forEach.call(select.options, function (option) {
				option.hidden = !!q && !option.selected && option.textContent.toLowerCase().indexOf(q) < 0;
			});
		});
	});
})();
</script>`;
