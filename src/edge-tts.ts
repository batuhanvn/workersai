// Minimal Edge read-aloud client for Workers. Protocol + v2 Sec-MS-GEC ported
// from DIYgod/cloudflare-edge-tts (rany2/edge-tts v7.x).
import { generateSecMsGec } from "./sec-ms-gec";

const TRUSTED_CLIENT_TOKEN = "6A5AA1D4EAFF4E9FB37E23D68491D6F4";
const CHROMIUM_FULL_VERSION = "143.0.3650.75";
const CHROMIUM_MAJOR_VERSION = CHROMIUM_FULL_VERSION.split(".")[0];
const SEC_MS_GEC_VERSION = `2-${CHROMIUM_FULL_VERSION}`;
const SYNTHESIS_URL =
	"https://speech.platform.bing.com/consumer/speech/synthesize/readaloud/edge/v1";

const UPGRADE_HEADERS = {
	"User-Agent": `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${CHROMIUM_MAJOR_VERSION}.0.0.0 Safari/537.36 Edg/${CHROMIUM_MAJOR_VERSION}.0.0.0`,
	"Accept-Language": "en-US,en;q=0.9",
	"Accept-Encoding": "gzip, deflate, br, zstd",
	Pragma: "no-cache",
	"Cache-Control": "no-cache",
	"Sec-WebSocket-Version": "13",
	Upgrade: "websocket",
};

function timestamp() {
	return new Date().toISOString().replace(/[-:.]/g, "").slice(0, -1);
}

function escapeXml(text: string) {
	return text
		.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g, " ")
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&apos;");
}

function parseHeaders(text: string) {
	const headers: Record<string, string> = {};
	for (const line of text.split("\r\n")) {
		const index = line.indexOf(":");
		if (index > 0) headers[line.slice(0, index)] = line.slice(index + 1).trim();
	}
	return headers;
}

function audioFrame(data: ArrayBuffer) {
	const bytes = new Uint8Array(data);
	const headerLength = (bytes[0] << 8) | bytes[1];
	const headers = parseHeaders(
		new TextDecoder().decode(bytes.subarray(2, 2 + headerLength)),
	);
	return { headers, body: bytes.slice(2 + headerLength) };
}

async function openSocket() {
	const url = new URL(SYNTHESIS_URL);
	url.searchParams.set("TrustedClientToken", TRUSTED_CLIENT_TOKEN);
	url.searchParams.set("Sec-MS-GEC", generateSecMsGec(TRUSTED_CLIENT_TOKEN));
	url.searchParams.set("Sec-MS-GEC-Version", SEC_MS_GEC_VERSION);
	url.searchParams.set(
		"ConnectionId",
		crypto.randomUUID().replace(/-/g, ""),
	);
	const muid = Array.from(crypto.getRandomValues(new Uint8Array(16)))
		.map((b) => b.toString(16).padStart(2, "0"))
		.join("")
		.toUpperCase();
	const response = (await fetch(url.toString(), {
		headers: { ...UPGRADE_HEADERS, Cookie: `muid=${muid};` },
	})) as Response & { webSocket?: WebSocket };
	if (response.status !== 101 || !response.webSocket) {
		throw new Error(`websocket upgrade failed: ${response.status}`);
	}
	return response.webSocket;
}

export async function synthesize(
	text: string,
	voice = "tr-TR-EmelNeural",
): Promise<ReadableStream<Uint8Array>> {
	const socket = await openSocket();
	const requestId = crypto.randomUUID().replace(/-/g, "");
	const lang = voice.split("-").slice(0, 2).join("-");
	let received = false;

	const ssml =
		"<speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis' " +
		`xml:lang='${lang}'><voice name='${voice}'><prosody pitch='+0Hz' rate='+0%' volume='+0%'>` +
		`${escapeXml(text)}</prosody></voice></speak>`;

	return new ReadableStream<Uint8Array>({
		start(controller) {
			const fail = (error: unknown) => {
				clearTimeout(timer);
				controller.error(error);
			};
			// The read-aloud service can accept a voice but never respond; the
			// runtime kills a request that hangs ~3.4s, so fail first.
			const timer = setTimeout(() => {
				try {
					socket.close(1000);
				} catch {
					// already closed
				}
				fail(new Error(`no audio from voice ${voice}`));
			}, 2500);

			socket.addEventListener("message", (event) => {
				if (typeof event.data === "string") {
					const path = parseHeaders(event.data).Path;
					if (path === "turn.end") {
						clearTimeout(timer);
						socket.close();
						if (received) controller.close();
						else fail(new Error("no audio received"));
					}
					return;
				}
				const { headers, body } = audioFrame(event.data as ArrayBuffer);
				if (headers.Path !== "audio" || body.length === 0) return;
				if (headers["Content-Type"] !== "audio/mpeg") return;
				received = true;
				clearTimeout(timer);
				controller.enqueue(body);
			});
			socket.addEventListener("error", fail);
			socket.addEventListener("close", () => {
				clearTimeout(timer);
				if (received) controller.close();
			});

			socket.accept();
			socket.send(
				`X-Timestamp:${timestamp()}\r\nContent-Type:application/json; charset=utf-8\r\nPath:speech.config\r\n\r\n` +
					`{"context":{"synthesis":{"audio":{"metadataoptions":{"sentenceBoundaryEnabled":"false","wordBoundaryEnabled":"true"},"outputFormat":"audio-24khz-48kbitrate-mono-mp3"}}}}\r\n`,
			);
			socket.send(
				`X-RequestId:${requestId}\r\nContent-Type:application/ssml+xml\r\nX-Timestamp:${timestamp()}Z\r\nPath:ssml\r\n\r\n${ssml}`,
			);
		},
		cancel() {
			try {
				socket.close(1000);
			} catch {
				// already closed
			}
		},
	});
}
