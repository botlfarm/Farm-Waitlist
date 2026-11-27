import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const CHANGELOG_HEADER = `# Changelog

All notable changes to Farm Waitlist are documented in this file.`;

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function normalizeBulletForDedup(line) {
  return line
    .trim()
    .replace(/^[-*]\s+/, '')
    .replace(/\s+/g, ' ')
    .toLowerCase();
}

/**
 * Extracts the add-on version string from `farm-waitlist/config.yaml`.
 */
export function readAddonVersion(configYamlText) {
  const match = /^version:\s*["']?([^"'\r\n#]+?)["']?\s*(?:#.*)?$/m.exec(configYamlText);
  return match ? match[1].trim() : null;
}

/**
 * Updates the `version:` line in `farm-waitlist/config.yaml` while preserving quotes & formatting.
 */
export function writeAddonVersionText(configYamlText, nextVersion) {
  return configYamlText.replace(
    /^(version:\s*)(["']?)([^"'\r\n#]+?)\2(\s*(?:#.*)?)$/m,
    (_m, prefix, quote, _old, suffix) => {
      const q = quote || '"';
      return `${prefix}${q}${nextVersion}${q}${suffix}`;
    }
  );
}

/**
 * Increments the patch component of a semantic version string (e.g. "1.0.1" -> "1.0.2").
 */
export function bumpPatchVersion(version) {
  const match = /^(\d+)\.(\d+)\.(\d+)(.*)$/.exec(version.trim());
  if (!match) {
    throw new Error(`Cannot auto-bump non-semver version "${version}"`);
  }
  const major = Number(match[1]);
  const minor = Number(match[2]);
  const patch = Number(match[3]) + 1;
  return `${major}.${minor}.${patch}`;
}

/**
 * Checks whether a changelog already contains a top-level heading for `version`.
 */
export function changelogHasVersion(changelogText, version) {
  const re = new RegExp(`^#{1,2}\\s+\\[?v?${escapeRegex(version)}\\]?(?:\\(|\\s|$)`, 'm');
  return re.test(changelogText);
}

/**
 * Checks whether `v<version>` (or `<version>`) already exists as a git tag in `rootDir`.
 */
export function gitTagExists(rootDir, version) {
  try {
    execSync(`git rev-parse -q --verify "refs/tags/v${version}"`, {
      cwd: rootDir,
      stdio: 'ignore',
    });
    return true;
  } catch {
    try {
      execSync(`git rev-parse -q --verify "refs/tags/${version}"`, {
        cwd: rootDir,
        stdio: 'ignore',
      });
      return true;
    } catch {
      return false;
    }
  }
}

/**
 * Splits `CHANGELOG.md` into:
 * - `headerPart`: top `# Changelog` title & intro paragraph(s)
 * - `unversionedPart`: any unversioned notes added above the first `## [x.y.z]` release heading
 * - `historyPart`: everything from the first `## [x.y.z]` release heading onward
 */
export function splitChangelogHeaderAndHistory(changelogText) {
  const normalized = (changelogText ?? '').replace(/\r\n/g, '\n').trim();
  if (!normalized) {
    return {
      headerPart: CHANGELOG_HEADER,
      unversionedPart: '',
      historyPart: '',
    };
  }

  const firstReleaseIdx = normalized.search(/^#{1,2}\s+\[?v?\d+\.\d+\.\d+/m);
  const preHistory = firstReleaseIdx >= 0 ? normalized.slice(0, firstReleaseIdx) : normalized;
  const historyPart = firstReleaseIdx >= 0 ? normalized.slice(firstReleaseIdx).trimStart() : '';

  const preLines = preHistory.split('\n');
  let unversionedStartLine = -1;
  for (let i = 0; i < preLines.length; i += 1) {
    const line = preLines[i].trimEnd();
    if (
      /^##\s+\[?unreleased\]?\b/i.test(line) ||
      /^#{2,3}\s+/.test(line) ||
      /^\s*[-*]\s+/.test(line)
    ) {
      unversionedStartLine = i;
      break;
    }
  }

  if (unversionedStartLine < 0) {
    const headerPart = preHistory.trim() || CHANGELOG_HEADER;
    return { headerPart, unversionedPart: '', historyPart };
  }

  const headerPart = preLines.slice(0, unversionedStartLine).join('\n').trim() || CHANGELOG_HEADER;
  const unversionedPart = preLines.slice(unversionedStartLine).join('\n').trim();

  return { headerPart, unversionedPart, historyPart };
}

/**
 * Parses unversioned notes from the top of `CHANGELOG.md`, strips HTML comments and any
 * optional `## [Unreleased]` header, keeps only non-empty sections, and automatically skips
 * any bullet whose normalized text already exists in `existingHistory` (preventing duplicates).
 */
export function extractUnreleasedBody(unversionedText, existingHistory = '') {
  const withoutComments = (unversionedText ?? '').replace(/<!--[\s\S]*?-->/g, '');
  const lines = withoutComments.split(/\r?\n/);

  const releasedBullets = new Set();
  if (existingHistory) {
    for (const hLine of existingHistory.split(/\r?\n/)) {
      if (/^\s*[-*]\s+/.test(hLine)) {
        const key = normalizeBulletForDedup(hLine);
        if (key) releasedBullets.add(key);
      }
    }
  }

  const sections = [];
  let currentHeading = null;
  let currentLines = [];

  const flush = () => {
    const trimmedLines = currentLines
      .map((line) => line.replace(/\s+$/, ''))
      .filter((line, idx, arr) => {
        if (line.trim() !== '') return true;
        return idx > 0 && idx < arr.length - 1 && arr[idx - 1].trim() !== '';
      });
    const hasContent = trimmedLines.some((line) => line.trim().length > 0);
    if (hasContent) {
      sections.push({
        heading: currentHeading ?? '### Changes',
        body: trimmedLines.join('\n').trim(),
      });
    }
    currentLines = [];
  };

  for (const rawLine of lines) {
    const line = rawLine.trimEnd();
    if (/^#\s+/.test(line) && !/^##/.test(line)) {
      continue;
    }
    if (/^##\s+\[?unreleased\]?\b/i.test(line)) {
      continue;
    }
    const subheading = /^#{2,3}\s+(.+)$/.exec(line);
    if (subheading) {
      flush();
      currentHeading = `### ${subheading[1].trim()}`;
      continue;
    }
    if (/^\s*[-*]\s+/.test(line)) {
      const key = normalizeBulletForDedup(line);
      if (key && releasedBullets.has(key)) {
        continue;
      }
      if (key) {
        releasedBullets.add(key);
      }
    }
    currentLines.push(line);
  }
  flush();

  if (sections.length === 0) {
    return '';
  }

  return sections
    .map((sec) => `${sec.heading}\n\n${sec.body}`)
    .join('\n\n')
    .trim();
}

/**
 * Fallback: builds a `### Changes` bullet list from git commits since the last tag
 * when `CHANGELOG.md` has no unversioned notes at the top on a release.
 */
export function collectGitFallbackNotes(rootDir) {
  try {
    let range = 'HEAD';
    try {
      const lastTag = execSync('git describe --tags --abbrev=0', {
        cwd: rootDir,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim();
      if (lastTag) {
        range = `${lastTag}..HEAD`;
      }
    } catch {
      // No prior tags — inspect recent commits
    }

    const raw = execSync(`git log ${range} --no-merges --pretty=format:%s`, {
      cwd: rootDir,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const bullets = raw
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter((s) => s.length > 0 && !/\[skip ci\]/i.test(s) && !/^chore\(release\):/i.test(s))
      .map((s) => `- ${s}`);

    if (bullets.length > 0) {
      return `### Changes\n\n${bullets.join('\n')}`;
    }
  } catch {
    // Non-git environment or git unavailable
  }
  return '### Changes\n\n- Maintenance release.';
}

/**
 * Stamps `## [<version>] - <dateYmd>` onto the unversioned top of `CHANGELOG.md`
 * (replacing any unversioned block above the previous release cleanly in-place).
 */
export function stampReleaseVersionInChangelog(existingChangelog, version, dateYmd, sectionBody) {
  const { headerPart, historyPart } = splitChangelogHeaderAndHistory(existingChangelog);
  const newSection = `## [${version}] - ${dateYmd}\n\n${sectionBody.trim()}`;

  if (historyPart) {
    return `${headerPart}\n\n${newSection}\n\n${historyPart}\n`;
  }
  return `${headerPart}\n\n${newSection}\n`;
}

/**
 * Resolves the target release version without modifying any files on disk.
 * Used in CI before Docker builds so image tags match the final bumped version
 * while deferring changelog/version file edits until after all builds succeed.
 */
export function resolveNextReleaseVersion(options = {}) {
  const rootDir = options.rootDir ?? process.cwd();
  const autoBump = Boolean(options.autoBump);
  const hasTag =
    typeof options.hasTag === 'function'
      ? options.hasTag
      : (ver) => gitTagExists(rootDir, ver);

  const configPath = path.join(rootDir, 'farm-waitlist', 'config.yaml');
  const rootChangelogPath = path.join(rootDir, 'CHANGELOG.md');

  if (!fs.existsSync(configPath)) {
    throw new Error(`Missing Home Assistant add-on config at ${configPath}`);
  }
  const configYamlRaw = fs.readFileSync(configPath, 'utf8');
  let version = readAddonVersion(configYamlRaw);
  if (!version) {
    throw new Error(`Could not parse version from ${configPath}`);
  }

  const existingChangelog = fs.existsSync(rootChangelogPath)
    ? fs.readFileSync(rootChangelogPath, 'utf8')
    : '';

  const isAlreadyReleased = (ver) => changelogHasVersion(existingChangelog, ver) || hasTag(ver);
  const alreadyReleased = isAlreadyReleased(version);
  let autoBumped = false;

  if (alreadyReleased && autoBump) {
    let guard = 0;
    while (isAlreadyReleased(version) && guard < 100) {
      version = bumpPatchVersion(version);
      guard += 1;
    }
    autoBumped = true;
  }

  return {
    version,
    autoBumped,
    alreadyReleased,
    configYamlRaw,
    existingChangelog,
  };
}

/**
 * Stamps the resolved version heading (`## [<version>] - <YYYY-MM-DD>`) onto the unversioned
 * notes at the top of `CHANGELOG.md`, mirrors it to `farm-waitlist/CHANGELOG.md`, and syncs
 * `farm-waitlist/config.yaml` and `package.json`.
 *
 * When `autoBump: true` (used in CI on pushes to `main`), if the version in
 * `farm-waitlist/config.yaml` is already tagged in git OR already present in `CHANGELOG.md`,
 * the patch version is automatically incremented (e.g. `1.0.7` -> `1.0.8`) and written back
 * to `farm-waitlist/config.yaml` so Home Assistant always detects an updatable release.
 * If the author already manually bumped `config.yaml` (e.g. to `1.1.0`), that version is kept as-is.
 */
export function releaseChangelog(options = {}) {
  const rootDir = options.rootDir ?? process.cwd();
  const dateYmd = options.dateYmd ?? new Date().toISOString().slice(0, 10);
  const autoBump = Boolean(options.autoBump);

  const configPath = path.join(rootDir, 'farm-waitlist', 'config.yaml');
  const rootChangelogPath = path.join(rootDir, 'CHANGELOG.md');
  const addonChangelogPath = path.join(rootDir, 'farm-waitlist', 'CHANGELOG.md');
  const packageJsonPath = path.join(rootDir, 'package.json');

  const resolved = resolveNextReleaseVersion(options);
  const { version, autoBumped, alreadyReleased, configYamlRaw, existingChangelog } = resolved;

  if (alreadyReleased && !autoBump) {
    if (
      !fs.existsSync(addonChangelogPath) ||
      fs.readFileSync(addonChangelogPath, 'utf8') !== existingChangelog
    ) {
      fs.writeFileSync(addonChangelogPath, existingChangelog, 'utf8');
    }
    return { released: false, autoBumped: false, version, notes: '' };
  }

  if (autoBumped) {
    fs.writeFileSync(configPath, writeAddonVersionText(configYamlRaw, version), 'utf8');
  }

  const { unversionedPart, historyPart } = splitChangelogHeaderAndHistory(existingChangelog);
  let sectionBody = extractUnreleasedBody(unversionedPart, historyPart);

  if (!sectionBody) {
    sectionBody =
      typeof options.fallbackNotes === 'string' && options.fallbackNotes.trim()
        ? options.fallbackNotes.trim()
        : collectGitFallbackNotes(rootDir);
  }

  const nextChangelog = stampReleaseVersionInChangelog(
    existingChangelog,
    version,
    dateYmd,
    sectionBody
  );
  fs.writeFileSync(rootChangelogPath, nextChangelog, 'utf8');
  fs.writeFileSync(addonChangelogPath, nextChangelog, 'utf8');

  // Keep package.json version synchronized with farm-waitlist/config.yaml
  if (fs.existsSync(packageJsonPath)) {
    const pkgRaw = fs.readFileSync(packageJsonPath, 'utf8');
    const updatedPkg = pkgRaw.replace(
      /("version"\s*:\s*")([^"]+)(")/,
      `$1${version}$3`
    );
    if (updatedPkg !== pkgRaw) {
      fs.writeFileSync(packageJsonPath, updatedPkg, 'utf8');
    }
  }

  if (options.notesOutPath) {
    fs.writeFileSync(options.notesOutPath, `${sectionBody.trim()}\n`, 'utf8');
  }

  return { released: true, autoBumped, version, notes: sectionBody.trim() };
}

// CLI entrypoint
const isDirectRun =
  process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;

if (isDirectRun) {
  const args = process.argv.slice(2);
  let notesOutPath;
  let autoBump = false;
  let resolveOnly = false;
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === '--auto-bump') {
      autoBump = true;
    } else if (args[i] === '--resolve-version') {
      resolveOnly = true;
    } else if (args[i] === '--notes-out' && args[i + 1]) {
      notesOutPath = args[i + 1];
      i += 1;
    }
  }

  if (resolveOnly) {
    const { version } = resolveNextReleaseVersion({ autoBump });
    process.stdout.write(`${version}\n`);
  } else {
    const result = releaseChangelog({ notesOutPath, autoBump });
    if (result.released) {
      console.log(
        `${result.autoBumped ? 'Auto-bumped add-on version and stamped' : 'Stamped'} v${result.version} at the top of CHANGELOG.md and synced farm-waitlist/CHANGELOG.md`
      );
    } else {
      console.log(
        `v${result.version} is already in CHANGELOG.md — kept unversioned top notes for the next version bump.`
      );
    }
  }
}
