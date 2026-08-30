const targets = [
  ["API", process.env.API_URL, "bridgistic-api"],
  ["MCP", process.env.MCP_URL, "bridgistic-mcp"],
];

for (const [name, url, service] of targets) {
  if (!url) throw new Error(`${name}_URL is required`);
  const response = await fetch(url, { redirect: "error", signal: AbortSignal.timeout(15_000) });
  if (!response.ok) throw new Error(`${name} health returned HTTP ${response.status}`);
  const body = await response.json();
  if (body?.ok !== true || body?.service !== service) {
    throw new Error(`${name} health returned an unexpected body`);
  }
  if (!response.headers.get("x-bridgistic-request-id")) {
    throw new Error(`${name} health omitted X-Bridgistic-Request-Id`);
  }
  console.log(`${name}: ${url} is healthy (${service})`);
}

