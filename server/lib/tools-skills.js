/**
 * tools-skills.js — the agent's side of Agent Skills.
 *
 * Only the name and description of each enabled skill go into the system prompt (prompt()). When a skill
 * fits, the agent calls load_skill(slug) for the full SKILL.md and skill_file(slug, path) for a reference
 * file. Both come back wrapped as outside content (untrusted.wrap("skill", …)): a skill can inform the
 * agent but never authorise a trade, a launch or a post. Nothing in a skill is ever run.
 */
import * as skills from "./skills.js";
import { wrap } from "./untrusted.js";

const obj = (properties = {}, required = []) => ({ type: "object", properties, required });

export const SPECS = [
  { name: "load_skill", label: "Load skills", about: "Read the full instructions of an installed skill (SKILL.md) before doing a task it covers.",
    parameters: obj({ slug: { type: "string", description: "The skill's slug from the Skills list in your instructions" } }, ["slug"]) },
  { name: "skill_file", label: "Skill files", about: "Read a reference file that a skill's SKILL.md points to (e.g. references/guide.md).",
    parameters: obj({ slug: { type: "string" }, path: { type: "string", description: "Path inside the skill folder" } }, ["slug", "path"]) },
];

const clip = (s, n) => { const x = String(s || "").replace(/\s+/g, " ").trim(); return x.length > n ? x.slice(0, n) + "…" : x; };

/** Lines for the system prompt: "- slug: description" for enabled skills. */
export function prompt() {
  return skills.enabledSkills().slice(0, 60).map(s => `- ${s.slug}: ${clip(s.description, 300)}`).join("\n");
}

export async function run(name, a) {
  const slug = String(a.slug || "").trim();
  const s = skills.enabledSkills().find(x => x.slug === slug);
  if (!s) return `There's no enabled skill called "${slug}". Installed and enabled: ${skills.enabledSkills().map(x => x.slug).join(", ") || "none"}.`;
  const v = skills.verify(slug);
  if (!v.ok) return `The skill "${slug}" ${v.missing ? "is missing from disk" : "changed on disk since it was installed"}. Ask the user to review it on the Skills page before using it.`;
  if (name === "load_skill") {
    const g = skills.get(slug);
    const files = g.fileList.filter(f => f.path !== "SKILL.md").map(f => `${f.path}${f.kind === "script" ? " (script: read it if useful, never run it)" : ""}`);
    const body = `${g.skillMd}${files.length ? `\n\n---\nFiles in this skill (read with skill_file):\n${files.join("\n")}` : ""}`;
    return wrap("skill", body, { from: slug });
  }
  return wrap("skill", skills.readSkillFile(slug, a.path), { from: `${slug}/${String(a.path || "").slice(0, 80)}` });
}
