import crypto from 'crypto';
import { isSafeHttpUrl, serializeAvailabilityForHash } from '../shared/generators';
import type { PublicAvailabilityJsonPayload } from '../shared/types';

const GITHUB_API_BASE = 'https://api.github.com';
const REPO_RE = /^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/;
const BRANCH_RE = /^[A-Za-z0-9._/-]+$/;
const SAFE_SEGMENT_RE = /^[A-Za-z0-9._-]+$/;

export interface ValidatedGithubTarget {
  owner: string;
  repoName: string;
  repo: string;
  branch: string;
  filePath: string;
  publicUrl: string;
}

export function validateGithubRepo(rawRepo: string): { owner: string; repoName: string; repo: string } | null {
  const cleaned = rawRepo
    .trim()
    .replace(/^https?:\/\/(www\.)?github\.com\//i, '')
    .replace(/\.git$/i, '')
    .replace(/^\/+|\/+$/g, '');
  const match = REPO_RE.exec(cleaned);
  if (!match) return null;
  const owner = match[1];
  const repoName = match[2];
  if (owner === '.' || owner === '..' || repoName === '.' || repoName === '..') return null;
  return { owner, repoName, repo: `${owner}/${repoName}` };
}

export function validateGithubBranch(rawBranch: string): string | null {
  const branch = (rawBranch || 'main').trim();
  if (!branch || branch.length > 120) return null;
  if (!BRANCH_RE.test(branch)) return null;
  if (branch.startsWith('/') || branch.endsWith('/') || branch.includes('..') || branch.includes('//')) {
    return null;
  }
  return branch;
}

export function validateGithubFilePath(rawPath: string): string | null {
  const trimmed = (rawPath || 'availability.json').trim().replace(/^\/+|\/+$/g, '');
  if (!trimmed || trimmed.length > 200) return null;
  const segments = trimmed.split('/');
  for (const seg of segments) {
    if (!seg || seg === '.' || seg === '..' || !SAFE_SEGMENT_RE.test(seg)) {
      return null;
    }
  }
  return segments.join('/');
}

/**
 * Derives the public GitHub Pages URL for a user-configured repository and file path,
 * or returns a validated custom https/http public URL when provided.
 */
export function deriveGithubPagesPublicUrl(
  rawRepo: string,
  rawPath: string = 'availability.json',
  customPublicUrl?: string
): string | null {
  const custom = (customPublicUrl ?? '').trim();
  if (custom) {
    return isSafeHttpUrl(custom) ? custom : null;
  }
  const parsedRepo = validateGithubRepo(rawRepo);
  const safePath = validateGithubFilePath(rawPath);
  if (!parsedRepo || !safePath) return null;

  const ownerLower = parsedRepo.owner.toLowerCase();
  const repoLower = parsedRepo.repoName.toLowerCase();
  const encodedPath = safePath
    .split('/')
    .map((seg) => encodeURIComponent(seg))
    .join('/');

  if (repoLower === `${ownerLower}.github.io`) {
    return `https://${ownerLower}.github.io/${encodedPath}`;
  }
  return `https://${ownerLower}.github.io/${encodeURIComponent(parsedRepo.repoName)}/${encodedPath}`;
}

export function validateGithubTarget(params: {
  repo: string;
  branch?: string;
  filePath?: string;
  customPublicUrl?: string;
}): ValidatedGithubTarget {
  const parsedRepo = validateGithubRepo(params.repo);
  if (!parsedRepo) {
    throw new Error('Enter a valid GitHub repository in "owner/repo" format (e.g., myfarm/farm-availability).');
  }
  const branch = validateGithubBranch(params.branch ?? 'main');
  if (!branch) {
    throw new Error('Invalid GitHub branch name.');
  }
  const filePath = validateGithubFilePath(params.filePath ?? 'availability.json');
  if (!filePath) {
    throw new Error('Invalid file path (use a simple relative path like "availability.json").');
  }
  const publicUrl = deriveGithubPagesPublicUrl(parsedRepo.repo, filePath, params.customPublicUrl);
  if (!publicUrl) {
    throw new Error('Custom public URL must be a valid https:// or http:// address.');
  }
  return {
    owner: parsedRepo.owner,
    repoName: parsedRepo.repoName,
    repo: parsedRepo.repo,
    branch,
    filePath,
    publicUrl,
  };
}

export function computeAvailabilityPayloadHash(payload: PublicAvailabilityJsonPayload): string {
  return crypto
    .createHash('sha256')
    .update(serializeAvailabilityForHash(payload), 'utf-8')
    .digest('hex');
}

function githubHeaders(token: string): Record<string, string> {
  return {
    Accept: 'application/vnd.github+json',
    Authorization: `Bearer ${token}`,
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'FarmWaitlist-HA-Addon/1.0',
  };
}

function describeGithubHttpError(status: number, bodyMessage: string, target: ValidatedGithubTarget): string {
  if (status === 401) {
    return 'GitHub rejected the token (401 Unauthorized). Your fine-grained token may be invalid or expired — update github_publish_token in Home Assistant Add-on Configuration.';
  }
  if (status === 403) {
    return `GitHub denied write access to ${target.repo} (403 Forbidden). Ensure your fine-grained token has "Contents: Read and write" permission on ${target.repo}.`;
  }
  if (status === 404) {
    return `Repository "${target.repo}" or branch "${target.branch}" was not found (404). Verify the repo name, branch, and token repository access.`;
  }
  return `GitHub API error (${status}): ${bodyMessage || 'Unexpected response'}`;
}

export async function testGithubPublishConnection(params: {
  token: string;
  repo: string;
  branch?: string;
  filePath?: string;
  customPublicUrl?: string;
  fetchFn?: typeof fetch;
}): Promise<{ ok: boolean; message: string; publicUrl: string | null }> {
  const fetchFn = params.fetchFn ?? fetch;
  const token = params.token.trim();
  if (!token) {
    return {
      ok: false,
      message:
        'GitHub publish token is not configured. Add github_publish_token in Home Assistant Add-on Configuration (or GITHUB_PUBLISH_TOKEN in .env).',
      publicUrl: null,
    };
  }

  let target: ValidatedGithubTarget;
  try {
    target = validateGithubTarget(params);
  } catch (err) {
    return {
      ok: false,
      message: err instanceof Error ? err.message : 'Invalid GitHub target configuration',
      publicUrl: null,
    };
  }

  const repoUrl = `${GITHUB_API_BASE}/repos/${encodeURIComponent(target.owner)}/${encodeURIComponent(target.repoName)}`;
  const repoResp = await fetchFn(repoUrl, {
    method: 'GET',
    headers: githubHeaders(token),
  });

  if (!repoResp.ok) {
    let detail = '';
    try {
      const json = (await repoResp.json()) as { message?: string };
      detail = json.message ?? '';
    } catch {
      // ignore parse failure
    }
    return {
      ok: false,
      message: describeGithubHttpError(repoResp.status, detail, target),
      publicUrl: target.publicUrl,
    };
  }

  const repoData = (await repoResp.json()) as {
    full_name?: string;
    private?: boolean;
    permissions?: { push?: boolean };
  };

  if (repoData.permissions && repoData.permissions.push === false) {
    return {
      ok: false,
      message: `Connected to ${target.repo}, but this token does not have push/write permission. Grant "Contents: Read and write" on this repository.`,
      publicUrl: target.publicUrl,
    };
  }

  // Verify branch exists (empty repo may return 404 on branch check; note clearly)
  const branchUrl = `${repoUrl}/branches/${encodeURIComponent(target.branch)}`;
  const branchResp = await fetchFn(branchUrl, {
    method: 'GET',
    headers: githubHeaders(token),
  });
  if (!branchResp.ok && branchResp.status !== 404) {
    return {
      ok: false,
      message: describeGithubHttpError(branchResp.status, 'Unable to verify branch', target),
      publicUrl: target.publicUrl,
    };
  }

  const privacyNote = repoData.private
    ? ' Warning: this repository appears to be private — public GitHub Pages requires a public repo (or GitHub Pro).'
    : '';
  const branchNote =
    branchResp.status === 404
      ? ` Branch "${target.branch}" does not exist yet (initialize the repo with a README on "${target.branch}" first).`
      : '';

  return {
    ok: branchResp.ok,
    message: branchResp.ok
      ? `Connected to ${repoData.full_name || target.repo} (${target.branch}). Ready to publish to ${target.filePath}.${privacyNote}`
      : `Connected to ${repoData.full_name || target.repo}, but${branchNote}${privacyNote}`,
    publicUrl: target.publicUrl,
  };
}

export interface GithubPublishResult {
  published: boolean;
  skipped: boolean;
  reason?: string;
  hash: string;
  publicUrl: string;
  publishedAt: string;
  commitSha?: string;
  readmeCreated?: boolean;
}

export function buildDefaultAvailabilityRepoReadme(target: ValidatedGithubTarget): string {
  return `# Public Availability Data

This repository automatically hosts anonymized, read-only availability data for a website's live availability calendar.

- **Data file:** \`${target.filePath}\`
- **Public feed URL:** ${target.publicUrl}
- **Privacy:** Only general availability status and dates are published here — no customer names, contact details, or order records are ever stored in this repository.

---

*Published automatically by Farm Waitlist. You can freely edit or replace this \`README.md\` — future updates will leave your custom file untouched.*
`;
}

async function ensureAvailabilityRepoReadme(params: {
  token: string;
  target: ValidatedGithubTarget;
  fetchFn: typeof fetch;
}): Promise<boolean> {
  const { token, target, fetchFn } = params;
  if (target.filePath.toLowerCase() === 'readme.md') {
    return false;
  }

  const repoBase = `${GITHUB_API_BASE}/repos/${encodeURIComponent(target.owner)}/${encodeURIComponent(target.repoName)}`;
  try {
    // GitHub's /readme endpoint detects any existing README (README.md, readme.md, README.txt, etc.)
    const checkResp = await fetchFn(
      `${repoBase}/readme?ref=${encodeURIComponent(target.branch)}`,
      {
        method: 'GET',
        headers: githubHeaders(token),
      }
    );
    if (checkResp.status !== 404) {
      return false;
    }

    const readmeContent = buildDefaultAvailabilityRepoReadme(target);
    const putResp = await fetchFn(`${repoBase}/contents/README.md`, {
      method: 'PUT',
      headers: {
        ...githubHeaders(token),
        'Content-Type': 'application/json; charset=utf-8',
      },
      body: JSON.stringify({
        message: 'Add default README explaining automated availability feed',
        content: Buffer.from(readmeContent, 'utf-8').toString('base64'),
        branch: target.branch,
      }),
    });
    return putResp.ok;
  } catch {
    // Non-fatal: never fail live availability publishing because of README initialization
    return false;
  }
}

export async function publishAvailabilityToGithub(params: {
  token: string;
  repo: string;
  branch?: string;
  filePath?: string;
  customPublicUrl?: string;
  payload: PublicAvailabilityJsonPayload;
  previousHash?: string | null;
  force?: boolean;
  fetchFn?: typeof fetch;
}): Promise<GithubPublishResult> {
  const fetchFn = params.fetchFn ?? fetch;
  const token = params.token.trim();
  if (!token) {
    throw new Error(
      'GitHub publish token is not configured. Add github_publish_token in Home Assistant Add-on Configuration (or GITHUB_PUBLISH_TOKEN in .env).'
    );
  }

  const target = validateGithubTarget(params);
  const hash = computeAvailabilityPayloadHash(params.payload);

  if (!params.force && params.previousHash && params.previousHash === hash) {
    return {
      published: false,
      skipped: true,
      reason: 'No availability changes since last publish',
      hash,
      publicUrl: target.publicUrl,
      publishedAt: params.payload.generatedAtIso,
    };
  }

  const encodedPath = target.filePath
    .split('/')
    .map((seg) => encodeURIComponent(seg))
    .join('/');
  const contentsUrl = `${GITHUB_API_BASE}/repos/${encodeURIComponent(target.owner)}/${encodeURIComponent(target.repoName)}/contents/${encodedPath}`;

  // 1. Check existing file SHA (if it already exists on this branch)
  let existingSha: string | undefined;
  const getResp = await fetchFn(`${contentsUrl}?ref=${encodeURIComponent(target.branch)}`, {
    method: 'GET',
    headers: githubHeaders(token),
  });

  if (getResp.ok) {
    const existingData = (await getResp.json()) as { sha?: string };
    if (typeof existingData.sha === 'string' && existingData.sha) {
      existingSha = existingData.sha;
    }
  } else if (getResp.status !== 404) {
    let detail = '';
    try {
      const json = (await getResp.json()) as { message?: string };
      detail = json.message ?? '';
    } catch {
      // ignore
    }
    throw new Error(describeGithubHttpError(getResp.status, detail, target));
  }

  // 2. PUT updated JSON content
  const jsonText = `${JSON.stringify(params.payload, null, 2)}\n`;
  const contentBase64 = Buffer.from(jsonText, 'utf-8').toString('base64');

  const putBody: Record<string, string> = {
    message: params.payload.paused
      ? `Pause farm availability (${params.payload.generatedAtDisplay})`
      : `Update farm availability (${params.payload.generatedAtDisplay})`,
    content: contentBase64,
    branch: target.branch,
  };
  if (existingSha) {
    putBody.sha = existingSha;
  }

  const putResp = await fetchFn(contentsUrl, {
    method: 'PUT',
    headers: {
      ...githubHeaders(token),
      'Content-Type': 'application/json; charset=utf-8',
    },
    body: JSON.stringify(putBody),
  });

  if (!putResp.ok) {
    let detail = '';
    try {
      const json = (await putResp.json()) as { message?: string };
      detail = json.message ?? '';
    } catch {
      // ignore
    }
    throw new Error(describeGithubHttpError(putResp.status, detail, target));
  }

  const putData = (await putResp.json()) as { commit?: { sha?: string } };
  const readmeCreated = await ensureAvailabilityRepoReadme({ token, target, fetchFn });

  return {
    published: true,
    skipped: false,
    hash,
    publicUrl: target.publicUrl,
    publishedAt: params.payload.generatedAtIso,
    commitSha: putData.commit?.sha,
    readmeCreated,
  };
}
