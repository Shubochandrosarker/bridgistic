# Bridgistic official OpenAI directory submission

The official route is the OpenAI Plugins dashboard, not a custom connector or
an entry in the Claude marketplace. The portable package lives in
`openai-plugin/` and is uploaded as a ZIP with `plugin.json`, `mcp.json`, and
the referenced icon.

## Release workflow

1. Prepare and run the dedicated reviewer tenant cases documented in
   `openai-plugin/REVIEW-NOTES.md`.
2. Record the walkthrough and add its public URL to `plugin.json` as
   `extensions.com.openai.review.demo_recording_url`.
3. Build a ZIP whose root contains `plugin.json`, `mcp.json`, and `assets/`.
4. In the OpenAI Plugins dashboard choose **Upload new or existing plugin**,
   choose the verified WordPressistic developer identity, and upload the ZIP.
5. In **MCPs**, connect the one declared server, complete the exact domain
   challenge, authenticate the reviewer tenant, and inspect the tool scan.
6. In **Metadata & Skills → Review information**, enter reviewer credentials
   privately and save the details.
7. Submit the draft for review only after the automated required findings are
   clear. Publish the approved draft when ready.

## Important boundaries

- The stable MCP origin is `https://mcp.bridgistic.app/mcp`. Keep it unchanged
  for future updates.
- The OpenAI challenge token is a deployment secret, not package metadata.
- Never put reviewer credentials, client secrets, access tokens, or private
  WordPress URLs in the ZIP.
- Hosted MCP tool changes can be rescanned after deployment; metadata, icons and
  review materials require a new package ZIP/version.

Official references:

- [Package your plugin](https://developers.openai.com/plugins/build/plugins)
- [Upload and submit your plugin](https://developers.openai.com/plugins/deploy/submission)
- [Remote MCP server review requirements](https://developers.openai.com/plugins/deploy/app-review)
- [Authenticate users](https://developers.openai.com/plugins/build/auth)
