export { WorkersAIDurableObject } from "~/durable";
import { handler } from "~/connect";
import { synthesize } from "~/edge-tts";

const DEFAULT_TTS_VOICE = "tr-TR-EmelNeural";

async function handleTts(request: Request, env: Env) {
	const cors = { "access-control-allow-origin": "*" };
	if (request.headers.get("authorization") !== `Bearer ${env.TTS_API_TOKEN}`) {
		return new Response("Unauthorized", { status: 401, headers: cors });
	}
	let body: { text?: unknown; voice?: unknown };
	try {
		body = await request.json();
	} catch {
		return new Response("Invalid JSON", { status: 400, headers: cors });
	}
	if (typeof body.text !== "string" || body.text.trim() === "") {
		return new Response("text is required", { status: 400, headers: cors });
	}
	const voice =
		typeof body.voice === "string" && body.voice.trim() !== ""
			? body.voice.trim()
			: DEFAULT_TTS_VOICE;
	try {
		const audio = await synthesize(body.text.trim().slice(0, 5000), voice);
		return new Response(audio, {
			headers: { ...cors, "content-type": "audio/mpeg" },
		});
	} catch (error) {
		return new Response(`TTS error: ${error}`, { status: 502, headers: cors });
	}
}

export default {
	async fetch(request, env, ctx): Promise<Response> {
		const { pathname } = new URL(request.url);
		if (request.method === "POST" && pathname === "/tts") {
			return handleTts(request, env);
		}
		if (request.method === "GET" && pathname === "/websocket") {
			const upgradeHeader = request.headers.get("Upgrade");
			if (upgradeHeader !== "websocket") {
				return new Response("Expected Upgrade: websocket", {
					status: 400,
				});
			}
			const searchParams = new URL(request.url).searchParams;
			const accessToken = searchParams.get("accessToken");
			if (!accessToken) {
				return new Response("Unauthorized", { status: 401 });
			}
			const token = await env.KV.get(`anonymous_access_token:${accessToken}`);
			if (!token) {
				return new Response("Unauthorized", { status: 401 });
			}
			const id: DurableObjectId =
				env.WORKERS_AI_DURABLE_OBJECT.idFromName(accessToken);
			const stub = env.WORKERS_AI_DURABLE_OBJECT.get(id);
			return stub.fetch(request);
		}
		const origin = request.headers.get("Origin");
		if (request.method === "OPTIONS" && origin) {
			return new Response(null, {
				headers: {
					"Access-Control-Allow-Origin": origin ?? "*",
					"Access-Control-Allow-Methods": "GET, POST",
					"Access-Control-Allow-Headers": "*",
					"Access-Control-Max-Age": "86400",
				},
			});
		}
		const response = await handler.fetch(request, env, ctx);
		const corsHeaders = new Headers(response.headers);
		corsHeaders.set("Access-Control-Allow-Origin", origin ?? "*");
		return new Response(response.body, {
			headers: corsHeaders,
			status: response.status,
			statusText: response.statusText,
		});
	},
} satisfies ExportedHandler<Env>;
