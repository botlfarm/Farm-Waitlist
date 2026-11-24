import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export const UNRELEASED_TEMPLATE = `# Unreleased Changes

<!--
Add bullet points under the sections below as features, changes, and fixes are made.
When \`farm-waitlist/config.yaml\` is bumped to a new version and pushed to \`main\`,
GitHub Actions automatically moves these notes into \`CHANGELOG.md\` and
\`farm-waitlist/CHANGELOG.md\`, syncs \`package.json\`, and resets this file for the next release.
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
 * Checks whether a changelog already contains a top-level heading for `version`.
 */
export function changelogHasVersion(changelogText, version) {
  const re = new RegExp(`^#{1,2}\\s+\\[?v?${escapeRegex(version)}\\]?(?:\\(|\\s|$)`, 'm');
  return re.test(changelogText);
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
        // Keep single blank lines between items only
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
    // Skip top-level "# Unreleased..." title
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
 * when `UNRELEASED.md` has no manual entries on a version bump.
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

  // If the file already starts with a `# Changelog` header (and optional intro before first release heading)
  const firstReleaseIdx = trimmed.search(/^#{1,2}\s+\[?v?\d+\.\d+\.\d+/m);
  if (firstReleaseIdx > 0) {
    const headerPart = trimmed.slice(0, firstReleaseIdx).trimEnd();
    const historyPart = trimmed.slice(firstReleaseIdx).trimStart();
    return `${headerPart}\n\n${newSection}\n\n${historyPart}\n`;
  }

  return `${CHANGELOG_HEADER}\n${newSection}\n\n${trimmed}\n`;
}

/**
 * Promotes `UNRELEASED.md` into root `CHANGELOG.md` and `farm-waitlist/CHANGELOG.md`
 * whenever `farm-waitlist/config.yaml` specifies a version not yet recorded in `CHANGELOG.md`.
 * Also syncs `package.json` version and resets `UNRELEASED.md` for the next release batch.
 */
export function releaseChangelog(options = {}) {
  const rootDir = options.rootDir ?? process.cwd();
  const dateYmd = options.dateYmd ?? new Date().toISOString().slice(0, 10);
  const configPath = path.join(rootDir, 'farm-waitlist', 'config.yaml');
  const rootChangelogPath = path.join(rootDir, 'CHANGELOG.md');
  const addonChangelogPath = path.join(rootDir, 'farm-waitlist', 'CHANGELOG.md');
  const unreleasedPath = path.join(rootDir, 'UNRELEASED.md');
  const packageJsonPath = path.join(rootDir, 'package.json');

  if (!fs.existsSync(configPath)) {
    throw new Error(`Missing Home Assistant add-on config at ${configPath}`);
  }
  const version = readAddonVersion(fs.readFileSync(configPath, 'utf8'));
  if (!version) {
    throw new Error(`Could not parse version from ${configPath}`);
  }

  const existingChangelog = fs.existsSync(rootChangelogPath)
    ? fs.readFileSync(rootChangelogPath, 'utf8')
    : '';

  // Already released: keep UNRELEASED.md untouched so ongoing work keeps accumulating,
  // and ensure farm-waitlist/CHANGELOG.md stays mirrored with root CHANGELOG.md.
  if (changelogHasVersion(existingChangelog, version)) {
    if (
      !fs.existsSync(addonChangelogPath) ||
      fs.readFileSync(addonChangelogPath, 'utf8') !== existingChangelog
    ) {
      fs.writeFileSync(addonChangelogPath, existingChangelog, 'utf8');
    }
    return { released: false, version, notes: '' };
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

  return { released: true, version, notes: sectionBody.trim() };
}

// CLI entrypoint
const isDirectRun =
  process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;

if (isDirectRun) {
  const args = process.argv.slice(2);
  let notesOutPath;
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === '--notes-out' && args[i + 1]) {
      notesOutPath = args[i + 1];
      i += 1;
    }
  }
  const result = releaseChangelog({ notesOutPath });
  if (result.released) {
    console.log(
      `Promoted UNRELEASED.md into CHANGELOG.md and farm-waitlist/CHANGELOG.md for v${result.version}`
    );
  } else {
    console.log(
      `v${result.version} is already in CHANGELOG.md — kept UNRELEASED.md for the next version bump.`
    );
  }
}
