'use strict';

// Pure helpers for the code host a pull request lives on: remote URL parsing,
// host detection, ticket id derivation and the ticket.md rendering. No I/O
// here, so test/intake.js can exercise all of it without git or a network.
//
// Used by runtime/pr.js and cli/pr-target.js.

const HOSTS = ['github', 'bitbucket', 'none'];

// Bitbucket Cloud REST API. Kept as host + base path rather than one URL
// string: the request is built from the parts anyway.
const BITBUCKET_API = { hostname: 'api.bitbucket.org', basePath: '/2.0' };

// Parse a git remote URL into its host and owner/repo path.
//   git@host:owner/repo.git
//   ssh://git@host[:port]/owner/repo.git
//   https://[user@]host/owner/repo[.git]
// Returns null for anything else (a local path, an empty string).
function parseRemote(url) {
  const raw = String(url || '').trim();
  if (!raw) {return null;}
  let hostname = '';
  let rest = '';
  let m = raw.match(/^[\w.-]+@([^:/]+):(?!\/)(.+)$/); // scp-like ssh
  if (m) {
    hostname = m[1];
    rest = m[2];
  } else {
    m = raw.match(/^(?:ssh|git|https?|git\+ssh):\/\/(?:[^@/]+@)?([^/:]+)(?::\d+)?\/(.+)$/i);
    if (!m) {return null;}
    hostname = m[1];
    rest = m[2];
  }
  const parts = rest.replace(/\/+$/, '').replace(/\.git$/i, '').split('/').filter(Boolean);
  if (parts.length < 2) {return null;}
  const repo = parts[parts.length - 1];
  const owner = parts.slice(0, -1).join('/');
  return { hostname: hostname.toLowerCase(), owner, repo, slug: `${owner}/${repo}` };
}

// github for github.com and GitHub Enterprise hosts named like it, bitbucket
// for Bitbucket Cloud. A self-hosted Bitbucket Server has a different API, so
// it is "none" rather than a half-working "bitbucket".
function detectHost(remote) {
  if (!remote || !remote.hostname) {return 'none';}
  const h = remote.hostname;
  if (h === 'github.com' || h.endsWith('.github.com') || /(^|[.-])github([.-]|$)/.test(h)) {return 'github';}
  if (h === 'bitbucket.org' || h.endsWith('.bitbucket.org')) {return 'bitbucket';}
  return 'none';
}

// repo.host wins when set; otherwise detect it from the remote.
function resolveHost(configured, remote) {
  const want = String(configured || '').trim().toLowerCase();
  if (want) {
    if (!HOSTS.includes(want)) {
      throw new Error(`repo.host "${configured}" is not one of ${HOSTS.join(', ')} (or empty to detect it)`);
    }
    return { kind: want, detected: false };
  }
  return { kind: detectHost(remote), detected: true };
}

function compile(pattern, anchored, flags) {
  return new RegExp(anchored ? `^(?:${pattern})$` : `(?:${pattern})`, flags || '');
}

// The ticket id for a PR: a key found in the title, else in the source branch,
// else the pseudo-id PR-<n>. Every candidate must also match the pattern end
// to end, so the id is one the rest of the runtime accepts.
function deriveTicketId(pr, pattern) {
  const pat = pattern || '[A-Z]+-[0-9]+';
  let exact;
  let sources;
  try {
    exact = compile(pat, true);
    // A title is prose, so match it as written ("Fixes ABC-123"). Branch
    // names are usually lower case ("feature/abc-123-login"), as in run.js.
    sources = [
      ['title', pr.title, compile(pat, false, 'g')],
      ['branch', pr.sourceBranch, compile(pat, false, 'gi')],
    ];
  } catch (err) {
    return { id: null, source: 'error', reason: `tracker.ticketPattern is not a valid regular expression: ${err.message}` };
  }
  for (const [source, text, search] of sources) {
    const hits = String(text || '').match(search) || [];
    for (const hit of hits) {
      const id = hit.toUpperCase();
      if (exact.test(id)) {return { id, source };}
    }
  }
  const pseudo = `PR-${pr.number}`;
  if (exact.test(pseudo)) {return { id: pseudo, source: 'pseudo' };}
  return {
    id: null,
    source: 'pseudo',
    reason:
      `no ticket key in the PR title or branch, and the pseudo-id "${pseudo}" does not match ` +
      `tracker.ticketPattern (${pat}). Widen the pattern, for example "(?:${pat})|PR-[0-9]+", ` +
      'or pass a ticket id yourself: qc-check run <ID>.',
  };
}

// --- normalise the two hosts' payloads to one shape --------------------------

function fromGithub(j) {
  const author = j.author || {};
  return {
    host: 'github',
    number: j.number,
    title: j.title || '',
    description: j.body || '',
    sourceBranch: j.headRefName || '',
    targetBranch: j.baseRefName || '',
    commit: j.headRefOid || '',
    author: author.name || author.login || '',
    state: j.state || '',
    url: j.url || '',
  };
}

function fromBitbucket(j) {
  const src = j.source || {};
  const dst = j.destination || {};
  const author = j.author || {};
  return {
    host: 'bitbucket',
    number: j.id,
    title: j.title || '',
    description: j.description || (j.summary && j.summary.raw) || '',
    sourceBranch: (src.branch && src.branch.name) || '',
    targetBranch: (dst.branch && dst.branch.name) || '',
    commit: (src.commit && src.commit.hash) || '',
    author: author.display_name || author.nickname || '',
    state: j.state || '',
    url: (j.links && j.links.html && j.links.html.href) || '',
  };
}

// Same markdown shape as `tracker.js get --save`: a "# <ID> - <title>" heading,
// a Source line, a one-line summary, then ## sections. The workflow reads it
// as the ticket.
function renderTicket(pr, ticketId, fetchedAt) {
  const at = (fetchedAt || new Date().toISOString()).slice(0, 16);
  const id = ticketId || `PR-${pr.number}`;
  const lines = [
    `# ${id} - ${pr.title}`,
    '',
    `Source: ${pr.url || `pull request #${pr.number}`} (fetched ${at}Z)`,
    `Type: Pull request · Status: ${pr.state || '?'} · Author: ${pr.author || '?'} · Host: ${pr.host}`,
    `Branch under test: ${pr.sourceBranch} -> ${pr.targetBranch} · Head commit: ${pr.commit || '?'}`,
    '',
    '## Description',
    '',
    String(pr.description || '').trim() || '(empty)',
    '',
    '## Pull request',
    '',
    `- Number: #${pr.number}`,
    `- Source branch (under test): ${pr.sourceBranch}`,
    `- Target branch: ${pr.targetBranch}`,
    `- Head commit: ${pr.commit || '?'}`,
    `- Author: ${pr.author || '?'}`,
    '',
    'This ticket was generated from the pull request: the acceptance criteria are',
    'whatever the description states. Where it states none, derive them from the',
    'diff against the target branch and say so in the plan.',
  ];
  return `${lines.join('\n')}\n`;
}

// What a comment write would do, without doing it. Shared by --dry-run and
// the real call, so the dry run shows exactly what is sent.
function planComment({ kind, remote, number, body, updateId }) {
  const n = String(number);
  if (kind === 'github') {
    const repoArg = remote.hostname === 'github.com' ? remote.slug : `${remote.hostname}/${remote.slug}`;
    if (updateId) {
      return {
        kind,
        action: 'update',
        where: `${repoArg} PR #${n}, comment ${updateId}`,
        command: ['gh', 'api', '--method', 'PATCH', `repos/${remote.slug}/issues/comments/${updateId}`, '--input', '<json body>'],
        hostname: remote.hostname,
        repoArg,
        body,
      };
    }
    return {
      kind,
      action: 'create',
      where: `${repoArg} PR #${n}`,
      command: ['gh', 'pr', 'comment', n, '-R', repoArg, '--body-file', '<file>'],
      repoArg,
      body,
    };
  }
  if (kind === 'bitbucket') {
    const base = `${BITBUCKET_API.basePath}/repositories/${encodeURIComponent(remote.owner)}/${encodeURIComponent(remote.repo)}/pullrequests/${encodeURIComponent(n)}/comments`;
    return {
      kind,
      action: updateId ? 'update' : 'create',
      where: `${remote.slug} PR #${n}${updateId ? `, comment ${updateId}` : ''}`,
      method: updateId ? 'PUT' : 'POST',
      hostname: BITBUCKET_API.hostname,
      path: updateId ? `${base}/${encodeURIComponent(String(updateId))}` : base,
      payload: { content: { raw: body } },
      body,
    };
  }
  throw new Error(`cannot comment on a pull request when the host is "${kind}"`);
}

module.exports = {
  HOSTS,
  BITBUCKET_API,
  parseRemote,
  detectHost,
  resolveHost,
  deriveTicketId,
  fromGithub,
  fromBitbucket,
  renderTicket,
  planComment,
};
