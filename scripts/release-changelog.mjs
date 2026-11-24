import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export const UNRELEASED_TEMPLATE = `# Unreleased Changes

<!--
Add bullet points under the sections below as features, changes, and fixes are made.
When pushed to \`main\`, GitHub Actions automatically ensures a fresh version in
\`farm-waitlist/config.yaml\` (auto-bumping the patch version if it was already released),
moves these notes into \`CHANGELOG.md\` and \`farm-waitlist/CHANGELOG.md\`,
syncs \`package.json\`, and resets this file for the next release.
-->

### Added

### Changed

### Fixed
`;

const CHANGELOG_HEADER = `# Changelog

All notable changes to Farm Waitlist are documented in this file.
`;

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
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
 * Parses `UNRELEASED.md` and returns only sections that contain real bullet/text content.
 * Returns empty string if no entries have been added yet.
 */
export function extractUnreleasedBody(unreleasedText) {
  const withoutComments = unreleasedText.replace(/<!--[\s\S]*?-->/g, '');
  const lines = withoutComments.split(/\r?\n/);

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
        heading: currentHeading,
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
    const subheading = /^#{2,3}\s+(.+)$/.exec(line);
    if (subheading) {
      flush();
      currentHeading = `### ${subheading[1].trim()}`;
      continue;
    }
    currentLines.push(line);
  }
  flush();

  if (sections.length === 0) {
    return '';
  }

  return sections
    .map((sec) => (sec.heading ? `${sec.heading}\n\n${sec.body}` : sec.body))
    .join('\n\n')
    .trim();
}

/**
 * Fallback: builds a `### Changes` bullet list from git commits since the last tag
 * when `UNRELEASED.md` has no manual entries on a release.
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
 * Prepends a newly formatted release section right below the top `# Changelog` title.
 */
export function prependReleaseSection(existingChangelog, version, dateYmd, sectionBody) {
  const newSection = `## [${version}] - ${dateYmd}\n\n${sectionBody.trim()}`;
  const trimmed = existingChangelog.trim();

  if (!trimmed) {
    return `${CHANGELOG_HEADER}\n${newSection}\n`;
  }

  const firstReleaseIdx = trimmed.search(/^#{1,2}\s+\[?v?\d+\.\d+\.\d+/m);
  if (firstReleaseIdx > 0) {
    const headerPart = trimmed.slice(0, firstReleaseIdx).trimEnd();
    const historyPart = trimmed.slice(firstReleaseIdx).trimStart();
    return `${headerPart}\n\n${newSection}\n\n${historyPart}\n`;
  }

  return `${CHANGELOG_HEADER}\n${newSection}\n\n${trimmed}\n`;
}

/**
 * Promotes `UNRELEASED.md` into root `CHANGELOG.md` and `farm-waitlist/CHANGELOG.md`,
 * syncs `package.json`, and resets `UNRELEASED.md`.
 *
 * When `autoBump: true` (used in CI on pushes to `main`), if the version in
 * `farm-waitlist/config.yaml` is already tagged in git OR already present in `CHANGELOG.md`,
 * the patch version is automatically incremented (e.g. `1.0.1` -> `1.0.2`) and written back
 * to `farm-waitlist/config.yaml` so Home Assistant always detects an updatable release.
 * If the author already manually bumped `config.yaml` (e.g. to `1.1.0`), that version is kept as-is.
 */
export function releaseChangelog(options = {}) {
  const rootDir = options.rootDir ?? process.cwd();
  const dateYmd = options.dateYmd ?? new Date().toISOString().slice(0, 10);
  const autoBump = Boolean(options.autoBump);
  const hasTag =
    typeof options.hasTag === 'function'
      ? options.hasTag
      : (ver) => gitTagExists(rootDir, ver);

  const configPath = path.join(rootDir, 'farm-waitlist', 'config.yaml');
  const rootChangelogPath = path.join(rootDir, 'CHANGELOG.md');
  const addonChangelogPath = path.join(rootDir, 'farm-waitlist', 'CHANGELOG.md');
  const unreleasedPath = path.join(rootDir, 'UNRELEASED.md');
  const packageJsonPath = path.join(rootDir, 'package.json');

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
  let autoBumped = false;

  if (isAlreadyReleased(version)) {
    if (!autoBump) {
      if (
        !fs.existsSync(addonChangelogPath) ||
        fs.readFileSync(addonChangelogPath, 'utf8') !== existingChangelog
      ) {
        fs.writeFileSync(addonChangelogPath, existingChangelog, 'utf8');
      }
      return { released: false, autoBumped: false, version, notes: '' };
    }

    let guard = 0;
    while (isAlreadyReleased(version) && guard < 100) {
      version = bumpPatchVersion(version);
      guard += 1;
    }
    autoBumped = true;
    fs.writeFileSync(configPath, writeAddonVersionText(configYamlRaw, version), 'utf8');
  }

  const unreleasedRaw = fs.existsSync(unreleasedPath)
    ? fs.readFileSync(unreleasedPath, 'utf8')
    : '';
  let sectionBody = extractUnreleasedBody(unreleasedRaw);

  if (!sectionBody) {
    sectionBody =
      typeof options.fallbackNotes === 'string' && options.fallbackNotes.trim()
        ? options.fallbackNotes.trim()
        : collectGitFallbackNotes(rootDir);
  }

  const nextChangelog = prependReleaseSection(existingChangelog, version, dateYmd, sectionBody);
  fs.writeFileSync(rootChangelogPath, nextChangelog, 'utf8');
  fs.writeFileSync(addonChangelogPath, nextChangelog, 'utf8');
  fs.writeFileSync(unreleasedPath, UNRELEASED_TEMPLATE, 'utf8');

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
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === '--auto-bump') {
      autoBump = true;
    } else if (args[i] === '--notes-out' && args[i + 1]) {
      notesOutPath = args[i + 1];
      i += 1;
    }
  }
  const result = releaseChangelog({ notesOutPath, autoBump });
  if (result.released) {
    console.log(
      `${result.autoBumped ? 'Auto-bumped add-on version and promoted' : 'Promoted'} UNRELEASED.md into CHANGELOG.md and farm-waitlist/CHANGELOG.md for v${result.version}`
    );
  } else {
    console.log(
      `v${result.version} is already in CHANGELOG.md — kept UNRELEASED.md for the next version bump.`
    );
  }
}
