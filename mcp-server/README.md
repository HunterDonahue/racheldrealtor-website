# Rachel's Website MCP Server

A remote MCP server so Rachel can edit racheldrealtor.com — page copy and
blog posts — by asking Claude or ChatGPT in plain language.

## Scope

Deliberately **not** full filesystem access. It can read and rewrite the
four content pages (home, about, contact, valuation) and manage blog posts.
It cannot touch `Layout.astro` (shared header/nav/footer, the TREC broker
compliance notices, structured data), the Worker backend, or any config/
build file — those are the load-bearing plumbing, and a bad natural-language
edit there could break the whole site or drop a legally-required disclosure.
`update_page` also runs a structural sanity check before publishing (Layout
wrapper present, and on the contact/valuation pages, the lead form and spam
honeypot field still present) and refuses to publish if something critical
looks missing.

## Tools

- `list_pages` / `read_page` / `update_page` — read or rewrite the home,
  about, contact, or valuation page.
- `list_recent_posts` / `read_blog_post` — see what's already published so
  a new draft doesn't repeat a topic, or pull up a post to edit.
- `create_blog_post` / `update_blog_post` / `delete_blog_post` — manage
  blog posts.

All writes go directly to the `main` branch of the `racheldrealtor-website`
repo via the GitHub Contents API. Cloudflare Workers Builds picks up the
push and redeploys automatically, usually live within a couple of minutes.
There's no draft/review step — see "Notes / limitations" below.

## Deploying

1. In the Cloudflare dashboard: **Workers & Pages → Create → Import a
   repository**, pick `racheldrealtor-website` again, but set the **root
   directory** to `mcp-server` (this repo hosts two independent Workers —
   the main site and this one — from two subfolders).
2. Build command: leave default (Cloudflare will run `npm install` and use
   `wrangler deploy`, no separate build step needed for this one).
3. Once deployed, add two secrets under **Settings → Variables and
   Secrets**:
   - `GITHUB_TOKEN` — a fine-grained GitHub PAT scoped to just this repo,
     with **Contents: Read and write** permission.
   - `MCP_ACCESS_TOKEN` — any long random string (this is what Rachel
     pastes into Claude/ChatGPT when she adds the connector — treat it like
     a password. Generate one with `openssl rand -hex 32` or similar).
4. Cloudflare will give this Worker its own `*.workers.dev` URL, or you can
   attach a subdomain like `mcp.racheldrealtor.com` under Domains & Routes
   the same way the main site was connected.

## Connecting from Claude or ChatGPT

**Claude (claude.ai):** Settings → Connectors → Add custom connector →
paste the Worker URL. It'll prompt for the access token.

**ChatGPT:** Settings → Apps & Connectors (or "Developer mode" under
Settings → Connectors, depending on current ChatGPT settings layout) →
Add a custom connector → paste the Worker URL and the access token.
OpenAI shows a warning about connecting to third-party servers — that's
expected and fine here since this is a server we built and control.

## Notes / limitations

- Everything publishes immediately — there's no review step before it goes
  live. If that turns out to be too loose in practice, the fix is to switch
  the write tools to open a pull request instead of committing straight to
  `main`, and Hunter reviews/merges before it deploys.
- If an edit breaks the Astro build entirely (bad syntax, etc.), Cloudflare
  Workers Builds fails the deploy and the site stays on its last working
  version rather than going down — but nobody gets notified of that failure
  automatically unless email/Slack alerts are set up on the Cloudflare
  project, which is worth doing once this is in regular use.
- `update_page` intentionally can't touch `Layout.astro`, so the header,
  footer, nav, and TREC broker compliance notices can't be changed or
  accidentally removed through this server.
