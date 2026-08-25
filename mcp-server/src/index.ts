import { McpServer } from "@modelcontextprotocol/server";
import { createMcpHandler } from "agents/mcp/server";
import { z } from "zod";

export interface Env {
  MCP_ACCESS_TOKEN: string;
  GITHUB_TOKEN: string;
}

const REPO_OWNER = "HunterDonahue";
const REPO_NAME = "racheldrealtor-website";
const BLOG_DIR = "src/content/blog";

// Only these page files are editable through this server. Layout.astro (shared
// header/footer/nav/TREC compliance footer/structured data), the Worker backend,
// and all config/build files are intentionally out of reach — a bad edit there
// risks breaking the whole site or dropping a legally-required broker disclosure,
// not just one page.
const PAGE_PATHS: Record<string, string> = {
  home: "src/pages/index.astro",
  about: "src/pages/about.astro",
  contact: "src/pages/contact.astro",
  valuation: "src/pages/valuation.astro",
};

function slugify(title: string): string {
  return title
    .toLowerCase()
    .replace(/['"]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-+|-+$)/g, "")
    .slice(0, 80);
}

function b64encode(input: string): string {
  return btoa(unescape(encodeURIComponent(input)));
}

function b64decode(input: string): string {
  return decodeURIComponent(escape(atob(input.replace(/\n/g, ""))));
}

async function githubRequest(env: Env, path: string, init: RequestInit = {}): Promise<Response> {
  return fetch(`https://api.github.com/repos/${REPO_OWNER}/${REPO_NAME}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${env.GITHUB_TOKEN}`,
      "User-Agent": "racheldrealtor-blog-mcp",
      Accept: "application/vnd.github+json",
      ...(init.headers ?? {}),
    },
  });
}

async function getFile(env: Env, path: string): Promise<{ content: string; sha: string } | null> {
  const res = await githubRequest(env, `/contents/${path}`);
  if (!res.ok) return null;
  const data = (await res.json()) as { content: string; sha: string };
  return { content: b64decode(data.content), sha: data.sha };
}

async function putFile(
  env: Env,
  path: string,
  content: string,
  message: string,
  sha?: string
): Promise<Response> {
  return githubRequest(env, `/contents/${path}`, {
    method: "PUT",
    body: JSON.stringify({
      message,
      content: b64encode(content),
      branch: "main",
      ...(sha ? { sha } : {}),
    }),
  });
}

/** Guards against edits that would silently break the build or drop lead-capture wiring. */
function checkPageStructure(page: string, content: string): string | null {
  if (!content.includes("import Layout from")) return "Missing the Layout import — this would break the page.";
  if (!content.includes("<Layout")) return "Missing the <Layout> wrapper — every page must render inside it.";
  if (!content.includes("</Layout>")) return "Missing the closing </Layout> tag.";
  if (page === "contact" || page === "valuation") {
    if (!content.includes('name="hp_company"')) {
      return "This page's spam-protection field (hp_company) is missing from the new content — keep that hidden field intact.";
    }
    if (!content.includes('name="formType"')) {
      return "The hidden formType field is missing — the lead form won't work without it.";
    }
    if (!content.includes("/api/submit")) {
      return "The form no longer posts to /api/submit — leads wouldn't be captured.";
    }
  }
  return null;
}

function createServer(env: Env) {
  const server = new McpServer({
    name: "racheldrealtor-website",
    version: "1.0.0",
  });

  // ---------- Pages ----------

  server.registerTool(
    "list_pages",
    {
      description: "List the editable pages on racheldrealtor.com.",
    },
    async () => ({
      content: [
        {
          type: "text",
          text: Object.keys(PAGE_PATHS)
            .map((p) => `${p} — https://racheldrealtor.com/${p === "home" ? "" : p + "/"}`)
            .join("\n"),
        },
      ],
    })
  );

  server.registerTool(
    "read_page",
    {
      description: "Read the current source of one of racheldrealtor.com's pages, to see what's there before editing it.",
      inputSchema: {
        page: z.enum(["home", "about", "contact", "valuation"]),
      },
    },
    async ({ page }) => {
      const file = await getFile(env, PAGE_PATHS[page]);
      if (!file) return { content: [{ type: "text", text: `Could not read ${page}.` }], isError: true };
      return { content: [{ type: "text", text: file.content }] };
    }
  );

  server.registerTool(
    "update_page",
    {
      description:
        "Replace the full source of one of racheldrealtor.com's pages and publish immediately (live within a couple minutes). ALWAYS call read_page first and edit that content rather than writing a page from scratch — this preserves the page's structure, styling, and (on the contact/valuation pages) the lead-capture form and spam protection. Only change the actual copy/text/images, not the component structure, CSS classes, or the Layout wrapper. Site-wide elements (header nav, footer, broker compliance notices, TREC disclosures) live outside these pages and can't be changed here.",
      inputSchema: {
        page: z.enum(["home", "about", "contact", "valuation"]),
        content: z.string().min(50).describe("The complete new file content (the full .astro file, frontmatter included)"),
      },
    },
    async ({ page, content }) => {
      const structureIssue = checkPageStructure(page, content);
      if (structureIssue) {
        return { content: [{ type: "text", text: `Not published — ${structureIssue}` }], isError: true };
      }
      const path = PAGE_PATHS[page];
      const current = await getFile(env, path);
      const res = await putFile(env, path, content, `Update ${page} page`, current?.sha);
      if (!res.ok) {
        return { content: [{ type: "text", text: `Failed to publish (HTTP ${res.status}): ${await res.text()}` }], isError: true };
      }
      return { content: [{ type: "text", text: `Published. Live at racheldrealtor.com within a couple minutes.` }] };
    }
  );

  // ---------- Blog ----------

  server.registerTool(
    "list_recent_posts",
    {
      description:
        "List existing blog posts on racheldrealtor.com (date, title, tags, slug) so a new draft doesn't repeat a topic that's already covered. Call this before drafting a new post.",
    },
    async () => {
      const listRes = await githubRequest(env, `/contents/${BLOG_DIR}`);
      if (!listRes.ok) {
        return { content: [{ type: "text", text: `Could not list posts (HTTP ${listRes.status}).` }], isError: true };
      }
      const files = (await listRes.json()) as { name: string }[];
      const summaries: string[] = [];
      for (const f of files) {
        if (!f.name.endsWith(".md")) continue;
        const file = await getFile(env, `${BLOG_DIR}/${f.name}`);
        if (!file) continue;
        const titleMatch = file.content.match(/title:\s*"([^"]+)"/);
        const dateMatch = file.content.match(/pubDate:\s*([0-9-]+)/);
        const tagsMatch = file.content.match(/tags:\s*\[([^\]]*)\]/);
        summaries.push(
          `${dateMatch?.[1] ?? "????-??-??"} — ${titleMatch?.[1] ?? f.name} (${(tagsMatch?.[1] ?? "").replace(/"/g, "")}) [${f.name.replace(/\.md$/, "")}]`
        );
      }
      summaries.sort().reverse();
      return { content: [{ type: "text", text: summaries.length ? summaries.join("\n") : "No posts found." }] };
    }
  );

  server.registerTool(
    "read_blog_post",
    {
      description: "Read the full current content (frontmatter + Markdown body) of an existing blog post, by slug.",
      inputSchema: { slug: z.string() },
    },
    async ({ slug }) => {
      const file = await getFile(env, `${BLOG_DIR}/${slug}.md`);
      if (!file) return { content: [{ type: "text", text: `No post found with slug "${slug}".` }], isError: true };
      return { content: [{ type: "text", text: file.content }] };
    }
  );

  const blogFrontmatterShape = {
    title: z.string().min(5).describe("Post title"),
    description: z.string().min(10).describe("One or two sentence summary used for previews and SEO"),
    body: z
      .string()
      .min(200)
      .describe(
        "Full post body in Markdown, using ## for section headings. Do not include the title as an H1 — start directly with the intro paragraph. Aim for 350-550 words."
      ),
    tags: z
      .array(z.string())
      .min(1)
      .max(2)
      .describe("1-2 tags from: 'Buying Tips', 'Selling Tips', 'Neighborhood Guide', 'Market Update', 'Financing', 'Home Prep'"),
    heroImage: z
      .enum(["/images/house-1.jpg", "/images/house-2.jpg", "/images/house-3.jpg", "/images/house-4.jpg", "/images/house-5.jpg"])
      .default("/images/house-1.jpg")
      .describe("Hero image — pick one of the existing site photos"),
  };

  server.registerTool(
    "create_blog_post",
    {
      description:
        "Publish a NEW real-estate blog post to racheldrealtor.com. Goes live immediately (no draft/review step). MUST be real-estate focused only, Fair Housing safe (no discriminatory or steering language, no coded language about who a neighborhood is 'for'), and must not make guaranteed home-value or investment-return claims (TREC advertising compliance). Write in Rachel's direct, practical, personal voice — 'Real Estate. Real Life.' Always call list_recent_posts first to avoid repeating a topic.",
      inputSchema: blogFrontmatterShape,
    },
    async ({ title, description, body, tags, heroImage }) => {
      const slug = slugify(title);
      if (!slug) return { content: [{ type: "text", text: "Couldn't derive a URL slug from that title." }], isError: true };
      const path = `${BLOG_DIR}/${slug}.md`;
      const existing = await getFile(env, path);
      if (existing) {
        return {
          content: [{ type: "text", text: `A post with slug "${slug}" already exists. Use update_blog_post instead.` }],
          isError: true,
        };
      }
      const today = new Date().toISOString().slice(0, 10);
      const frontmatter =
        `---\n` +
        `title: "${title.replace(/"/g, '\\"')}"\n` +
        `description: "${description.replace(/"/g, '\\"')}"\n` +
        `pubDate: ${today}\n` +
        `heroImage: "${heroImage}"\n` +
        `tags: ${JSON.stringify(tags)}\n` +
        `---\n\n`;
      const res = await putFile(env, path, frontmatter + body.trim() + "\n", `Add blog post: ${title}`);
      if (!res.ok) {
        return { content: [{ type: "text", text: `Failed to publish (HTTP ${res.status}): ${await res.text()}` }], isError: true };
      }
      return {
        content: [{ type: "text", text: `Published. Live at https://racheldrealtor.com/blog/${slug}/ within a couple minutes.` }],
      };
    }
  );

  server.registerTool(
    "update_blog_post",
    {
      description:
        "Edit an existing blog post (by slug). Always call read_blog_post first so you're editing the real current content, not guessing. Only the fields you pass are changed — omit any field you want left as-is. Same TREC/Fair Housing guardrails as create_blog_post apply.",
      inputSchema: {
        slug: z.string(),
        title: blogFrontmatterShape.title.optional(),
        description: blogFrontmatterShape.description.optional(),
        body: blogFrontmatterShape.body.optional(),
        tags: blogFrontmatterShape.tags.optional(),
        heroImage: blogFrontmatterShape.heroImage.optional(),
      },
    },
    async ({ slug, title, description, body, tags, heroImage }) => {
      const path = `${BLOG_DIR}/${slug}.md`;
      const existing = await getFile(env, path);
      if (!existing) return { content: [{ type: "text", text: `No post found with slug "${slug}".` }], isError: true };

      const currentTitle = existing.content.match(/title:\s*"([^"]+)"/)?.[1] ?? slug;
      const currentDesc = existing.content.match(/description:\s*"([^"]+)"/)?.[1] ?? "";
      const currentDate = existing.content.match(/pubDate:\s*([0-9-]+)/)?.[1] ?? new Date().toISOString().slice(0, 10);
      const currentHero = existing.content.match(/heroImage:\s*"([^"]+)"/)?.[1] ?? "/images/house-1.jpg";
      const currentBody = existing.content.replace(/^---[\s\S]*?---\n+/, "");

      const newFrontmatter =
        `---\n` +
        `title: "${(title ?? currentTitle).replace(/"/g, '\\"')}"\n` +
        `description: "${(description ?? currentDesc).replace(/"/g, '\\"')}"\n` +
        `pubDate: ${currentDate}\n` +
        `heroImage: "${heroImage ?? currentHero}"\n` +
        `tags: ${JSON.stringify(tags ?? [])}\n` +
        `---\n\n`;
      const newContent = newFrontmatter + (body ?? currentBody).trim() + "\n";

      const res = await putFile(env, path, newContent, `Update blog post: ${title ?? currentTitle}`, existing.sha);
      if (!res.ok) {
        return { content: [{ type: "text", text: `Failed to update (HTTP ${res.status}): ${await res.text()}` }], isError: true };
      }
      return { content: [{ type: "text", text: `Updated. Live at https://racheldrealtor.com/blog/${slug}/ within a couple minutes.` }] };
    }
  );

  server.registerTool(
    "delete_blog_post",
    {
      description: "Permanently remove a blog post from racheldrealtor.com by slug.",
      inputSchema: { slug: z.string() },
    },
    async ({ slug }) => {
      const path = `${BLOG_DIR}/${slug}.md`;
      const existing = await getFile(env, path);
      if (!existing) return { content: [{ type: "text", text: `No post found with slug "${slug}".` }], isError: true };
      const res = await githubRequest(env, `/contents/${path}`, {
        method: "DELETE",
        body: JSON.stringify({ message: `Remove blog post: ${slug}`, sha: existing.sha, branch: "main" }),
      });
      if (!res.ok) {
        return { content: [{ type: "text", text: `Failed to delete (HTTP ${res.status}): ${await res.text()}` }], isError: true };
      }
      return { content: [{ type: "text", text: `Deleted "${slug}".` }] };
    }
  );

  return server;
}

function unauthorized(): Response {
  return new Response("Unauthorized", { status: 401, headers: { "WWW-Authenticate": "Bearer" } });
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const auth = request.headers.get("Authorization") ?? "";
    if (!env.MCP_ACCESS_TOKEN || auth !== `Bearer ${env.MCP_ACCESS_TOKEN}`) {
      return unauthorized();
    }
    return createMcpHandler(() => createServer(env))(request, env, ctx);
  },
} satisfies ExportedHandler<Env>;
