import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function shellColors(pi: ExtensionAPI) {
	pi.on("session_start", () => {
		// Respect an explicit NO_COLOR opt-out and existing force-color settings.
		if (process.env.NO_COLOR !== undefined) return;
		process.env.FORCE_COLOR ??= "1";
		process.env.CLICOLOR_FORCE ??= "1";
	});
}
