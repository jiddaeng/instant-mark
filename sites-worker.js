async function serve(request, env) {
  if (!env?.ASSETS?.fetch) {
    return new Response("Static asset service is unavailable.", {
      status: 503,
      headers: { "content-type": "text/plain; charset=utf-8" },
    });
  }

  const response = await env.ASSETS.fetch(request);
  if (response.status !== 404 || request.method !== "GET") {
    return response;
  }

  const acceptsHtml = request.headers
    .get("accept")
    ?.includes("text/html");
  if (!acceptsHtml) {
    return response;
  }

  const indexUrl = new URL("/index.html", request.url);
  return env.ASSETS.fetch(new Request(indexUrl, request));
}

export { serve as fetch };
export default { fetch: serve };
