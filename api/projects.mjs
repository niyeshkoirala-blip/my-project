// Serverless function: builds the project list live from your public GitHub repos,
// with descriptions written by Groq from each README.
//
// GROQ_API_KEY lives in Vercel's env vars — never in index.html, where any visitor
// could read it and spend your credits.
//
// The response is CDN-cached (see Cache-Control below), so the browser fetches this
// on every page load but Groq only actually runs about once a day.

const USER = 'niyeshkoirala-blip';
const SKIP = new Set(['my-project']); // the portfolio itself
const MODEL = 'llama-3.3-70b-versatile';

const SYSTEM = `You write portfolio copy for a junior developer's personal site.
Given a GitHub repo's README, reply with JSON only:
{
  "title": "the project's real display name, as a human would write it — 'Pitch Side News', 'GAMBIT'. If the README gives the project a name, use it. Never just the uppercased repo slug ('FOOTBALLAUTO' is wrong). Max 40 chars.",
  "sub": "lowercase subtitle naming the shape of the work, e.g. 'full-stack · engine built from scratch'. Max 50 chars.",
  "description": "2-4 sentences, concrete. Name what it actually does and the hard parts that show engineering skill. Plain prose, no marketing fluff, no bullet points, no first person.",
  "tags": ["3-5 stack tags, e.g. 'React', 'Node', 'SQLite'"]
}
Base everything on the README. Never invent features it does not mention.`;

// A token is optional, but serverless egress IPs are shared — without one you're
// sharing GitHub's 60 req/hr anonymous limit with strangers.
const ghHeaders = raw => ({
  Accept: raw ? 'application/vnd.github.raw' : 'application/vnd.github+json',
  ...(process.env.GITHUB_TOKEN ? { Authorization: 'Bearer ' + process.env.GITHUB_TOKEN } : {}),
});

async function gh(path, raw = false) {
  const r = await fetch('https://api.github.com' + path, { headers: ghHeaders(raw) });
  if (!r.ok) throw Object.assign(new Error('GitHub ' + r.status + ' on ' + path), { status: r.status });
  return raw ? r.text() : r.json();
}

// /readme only finds README.*, but some repos document themselves in SETUP.md
// or similar — fall back to the biggest root-level .md before giving up.
async function docs(name, branch) {
  const readme = await gh(`/repos/${USER}/${name}/readme`, true).catch(() => '');
  if (readme.trim()) return readme;
  const tree = await gh(`/repos/${USER}/${name}/git/trees/${encodeURIComponent(branch)}`).catch(() => ({ tree: [] }));
  const md = (tree.tree || []).filter(t => t.type === 'blob' && /\.md$/i.test(t.path)).sort((a, b) => b.size - a.size)[0];
  if (!md) return '';
  return gh(`/repos/${USER}/${name}/contents/${encodeURIComponent(md.path)}?ref=${encodeURIComponent(branch)}`, true).catch(() => '');
}

async function describe(repo, readme, key) {
  const r = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: MODEL,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: SYSTEM },
        {
          role: 'user',
          content:
            `Repo: ${repo.name}\n` +
            `GitHub description: ${repo.description || 'none'}\n` +
            `Main language: ${repo.language || 'unknown'}\n\n` +
            `README:\n${readme.slice(0, 8000)}`, // ponytail: truncate, READMEs past 8k are changelog
        },
      ],
    }),
  });
  if (!r.ok) throw new Error('Groq ' + r.status + ': ' + (await r.text()).slice(0, 200));
  const out = JSON.parse((await r.json()).choices[0].message.content);
  if (!out.title || !out.description || !Array.isArray(out.tags)) {
    throw new Error('Groq returned an unusable shape: ' + JSON.stringify(out).slice(0, 200));
  }
  return out;
}

export default async function handler(req, res) {
  const key = process.env.GROQ_API_KEY;
  if (!key) return res.status(500).json({ error: 'GROQ_API_KEY is not set on the server' });

  try {
    const repos = (await gh(`/users/${USER}/repos?per_page=100&sort=pushed`))
      .filter(r => !r.fork && !r.archived && !SKIP.has(r.name));

    // one bad repo shouldn't blank the whole section
    const projects = (await Promise.all(repos.map(async r => {
      try {
        const readme = await docs(r.name, r.default_branch);
        if (!readme.trim()) return null;
        const ai = await describe(r, readme, key);
        return {
          repo: r.name,
          title: ai.title,
          sub: ai.sub || '',
          description: ai.description,
          tags: ai.tags.slice(0, 5),
          homepage: r.homepage || '',
          url: r.html_url,
        };
      } catch (e) {
        console.error(`${r.name}: ${e.message}`);
        return null;
      }
    }))).filter(Boolean);

    if (!projects.length) return res.status(502).json({ error: 'no projects could be built' });

    // browser refetches each load; the CDN answers instantly and revalidates in the
    // background, so only the day's first visitor ever waits on Groq.
    res.setHeader('Cache-Control', 's-maxage=86400, stale-while-revalidate=604800');
    res.json(projects);
  } catch (e) {
    console.error(e);
    res.status(502).json({ error: e.message });
  }
}
