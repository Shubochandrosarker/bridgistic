// www.bridgistic.app → https://bridgistic.app (301), keeping path and query.
// Every other host (the apex, *.pages.dev previews) passes through unchanged.
export async function onRequest(context) {
  const url = new URL(context.request.url);
  if (url.hostname === "www.bridgistic.app") {
    url.hostname = "bridgistic.app";
    url.protocol = "https:";
    url.port = "";
    return Response.redirect(url.toString(), 301);
  }
  return context.next();
}
