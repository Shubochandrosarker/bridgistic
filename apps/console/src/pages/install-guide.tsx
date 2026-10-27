/**
 * Public "How to install skills" guide, linked from the marketplace footer.
 * Routes: /install-guide and /docs/install.
 * Each method carries a status: "verified" (tested end to end) or "unverified".
 */
import { Link } from "react-router-dom";

type Status = "verified" | "unverified" | "coming-soon";

const badge: Record<Status, string> = {
  verified: "bg-emerald-500/15 text-emerald-300",
  unverified: "bg-amber-500/15 text-amber-300",
  "coming-soon": "bg-white/10 text-white/50",
};
const label: Record<Status, string> = { verified: "Verified", unverified: "Unverified", "coming-soon": "Coming soon" };

function Code({ children }: { children: string }) {
  return <pre className="mt-2 overflow-x-auto rounded-md border border-white/10 bg-black/40 p-3 font-mono text-[12px] text-white/85">{children}</pre>;
}

function Section({ id, title, status, children }: { id: string; title: string; status: Status; children: React.ReactNode }) {
  return (
    <section id={id} className="rounded-lg border border-white/10 bg-[#0B101B] p-5">
      <div className="flex items-center gap-3">
        <h2 className="text-base font-semibold text-white">{title}</h2>
        <span className={`rounded-full px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider ${badge[status]}`}>{label[status]}</span>
      </div>
      <div className="mt-3 space-y-2 text-sm leading-relaxed text-white/70">{children}</div>
    </section>
  );
}

export function InstallGuide() {
  return (
    <div className="min-h-screen bg-[#05070D] text-white">
      <div className="mx-auto max-w-3xl px-5 py-10">
        <nav className="mb-6 text-xs text-white/40">
          <Link to="/marketplace" className="hover:text-white/70">Skills</Link> / <span className="text-white/70">How to install skills</span>
        </nav>
        <h1 className="text-2xl font-bold tracking-tight">How to install Bridgistic skills</h1>
        <p className="mt-3 text-sm text-white/65">
          A skill is a folder with a <span className="font-mono">SKILL.md</span> file (plus optional reference files). Every AI tool below loads
          skills from a folder or takes them as a prompt. Get the files with <b>Download zip</b> on any skill page (free account; Pro skills need a license),
          then follow the section for your tool. Replace <span className="font-mono">&lt;skill&gt;</span> with the skill's slug, e.g. <span className="font-mono">seo-content-brief</span>.
        </p>

        <div className="mt-8 space-y-4">
          <Section id="zip" title="Download zip (works with every tool)" status="unverified">
            <p>On a skill page click <b>Download zip</b>, then unzip into a folder named after the skill:</p>
            <Code>{"mkdir -p <skills-dir>/<skill>\nunzip <skill>.zip -d <skills-dir>/<skill>"}</Code>
            <p>The folder must contain <span className="font-mono">SKILL.md</span> at its top level.</p>
          </Section>

          <Section id="npx" title="npx skills (Claude Code, Cursor, Codex, Gemini CLI, Windsurf…)" status="unverified">
            <p>Free skills install with the open <a className="underline" href="https://github.com/vercel-labs/skills">skills</a> CLI, which copies the skill into every agent it detects:</p>
            <Code>{"npx skills add https://marketplace.bridgistic.app/wordpressistic/<skill>"}</Code>
            <p>Add <span className="font-mono">-g</span> to install for your user instead of the current project. Pro skills are not available this way; use Download zip.</p>
          </Section>

          <Section id="cli" title="Bridgistic CLI" status="coming-soon">
            <Code>{"bridgistic skills install @wordpressistic/<skill>"}</Code>
            <p>The <span className="font-mono">bridgistic</span> CLI is not published to npm yet. Use npx skills or Download zip for now.</p>
          </Section>

          <Section id="claude-code" title="Claude Code" status="unverified">
            <p>Personal (all projects): <span className="font-mono">~/.claude/skills/&lt;skill&gt;/SKILL.md</span>. Project: <span className="font-mono">.claude/skills/&lt;skill&gt;/SKILL.md</span>.</p>
            <Code>{"mkdir -p ~/.claude/skills/<skill> && unzip <skill>.zip -d ~/.claude/skills/<skill>"}</Code>
            <p>Restart Claude Code; the skill is picked up automatically when relevant.</p>
          </Section>

          <Section id="cursor" title="Cursor" status="unverified">
            <p>Project: <span className="font-mono">.agents/skills/&lt;skill&gt;/</span> (or <span className="font-mono">.cursor/skills/</span>). Personal: <span className="font-mono">~/.cursor/skills/&lt;skill&gt;/</span>.</p>
            <p>Alternative: paste the copied prompt into a project rule under <span className="font-mono">.cursor/rules/</span>.</p>
          </Section>

          <Section id="codex" title="OpenAI Codex CLI" status="unverified">
            <p>Personal: <span className="font-mono">~/.codex/skills/&lt;skill&gt;/</span>. Project: <span className="font-mono">.agents/skills/&lt;skill&gt;/</span>.</p>
          </Section>

          <Section id="gemini" title="Gemini CLI" status="unverified">
            <p>Personal: <span className="font-mono">~/.gemini/skills/&lt;skill&gt;/</span>. Project: <span className="font-mono">.agents/skills/&lt;skill&gt;/</span>.</p>
          </Section>

          <Section id="windsurf" title="Windsurf" status="unverified">
            <p>Personal: <span className="font-mono">~/.codeium/windsurf/skills/&lt;skill&gt;/</span>. Project: <span className="font-mono">.windsurf/skills/&lt;skill&gt;/</span>.</p>
          </Section>

          <Section id="claude-ai" title="Claude.ai (web and desktop)" status="unverified">
            <p>Settings → Capabilities → Skills → upload the downloaded <span className="font-mono">&lt;skill&gt;.zip</span>. Or, in any chat, use <b>Prompt → Copy full skill as prompt</b> and paste it as your first message (or into a Project's instructions).</p>
          </Section>

          <Section id="chatgpt" title="ChatGPT and other chat assistants" status="unverified">
            <p>Use <b>Prompt → Copy full skill as prompt</b> on the skill page and paste it at the start of a chat, into Custom Instructions, or into a custom GPT's instructions. Only <span className="font-mono">SKILL.md</span> is copied; attach any extra files from the zip if the skill references them.</p>
          </Section>
        </div>

        <p className="mt-8 text-xs text-white/40">
          Skills are instruction text, not executed code. WordPress writes still pass Plugin Guard and the approval queue.{" "}
          <Link className="underline" to="/marketplace">Back to the directory</Link>
        </p>
      </div>
    </div>
  );
}
