import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  UNRELEASED_TEMPLATE,
  extractUnreleasedBody,
  readAddonVersion,
  releaseChangelog,
  resolveNextReleaseVersion,
} from '../../scripts/release-changelog.mjs';

const tmpDirs: string[] = [];

function createTempRepo(version: string, unreleased: string, changelog: string) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'farm-waitlist-changelog-'));
  tmpDirs.push(dir);
  fs.mkdirSync(path.join(dir, 'farm-waitlist'), { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'farm-waitlist', 'config.yaml'),
    `name: Farm Waitlist\nversion: "${version}"\nslug: farm-waitlist\n`,
    'utf8'
  );
  fs.writeFileSync(path.join(dir, 'UNRELEASED.md'), unreleased, 'utf8');
  fs.writeFileSync(path.join(dir, 'CHANGELOG.md'), changelog, 'utf8');
  fs.writeFileSync(
    path.join(dir, 'package.json'),
    JSON.stringify({ name: 'farm-waitlist', version: '1.0.0' }, null, 2) + '\n',
    'utf8'
  );
  return dir;
}

afterEach(() => {
  while (tmpDirs.length > 0) {
    fs.rmSync(tmpDirs.pop()!, { recursive: true, force: true });
  }
});

describe('Release Changelog & Auto-Bump Promotion (UNRELEASED.md -> CHANGELOG.md & farm-waitlist/CHANGELOG.md)', () => {
  it('promotes non-empty UNRELEASED.md sections into both changelogs, syncs package.json, writes release notes, and resets UNRELEASED.md', () => {
    const dir = createTempRepo(
      '1.0.1',
      `# Unreleased Changes

<!-- comment to strip -->

### Added

- Requested Pickup Date on waitlist cards
- Odoo customer name autocomplete

### Changed

### Fixed

- Email-safe pre-approval rich copy
`,
      `# Changelog

All notable changes to Farm Waitlist are documented in this file.

## [1.0.0] - 2026-11-23

### Features

- Initial release
`
    );

    const notesOutPath = path.join(dir, 'release-notes.md');
    const result = releaseChangelog({
      rootDir: dir,
      dateYmd: '2026-11-24',
      notesOutPath,
      autoBump: true,
      hasTag: () => false,
    });

    expect(result.released).toBe(true);
    expect(result.autoBumped).toBe(false);
    expect(result.version).toBe('1.0.1');

    const rootChangelog = fs.readFileSync(path.join(dir, 'CHANGELOG.md'), 'utf8');
    const addonChangelog = fs.readFileSync(path.join(dir, 'farm-waitlist', 'CHANGELOG.md'), 'utf8');
    expect(addonChangelog).toBe(rootChangelog);

    expect(rootChangelog).toContain('## [1.0.1] - 2026-11-24');
    expect(rootChangelog).toContain('### Added\n\n- Requested Pickup Date on waitlist cards');
    expect(rootChangelog).toContain('### Fixed\n\n- Email-safe pre-approval rich copy');
    expect(rootChangelog).not.toContain('### Changed');
    expect(rootChangelog.indexOf('## [1.0.1]')).toBeLessThan(rootChangelog.indexOf('## [1.0.0]'));

    expect(fs.readFileSync(path.join(dir, 'UNRELEASED.md'), 'utf8')).toBe(UNRELEASED_TEMPLATE);
    expect(extractUnreleasedBody(UNRELEASED_TEMPLATE)).toBe('');

    const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')) as {
      version: string;
    };
    expect(pkg.version).toBe('1.0.1');

    const notesOut = fs.readFileSync(notesOutPath, 'utf8');
    expect(notesOut).toContain('- Requested Pickup Date on waitlist cards');
    expect(notesOut).toContain('- Email-safe pre-approval rich copy');
  });

  it('auto-bumps patch version in config.yaml when current version already exists in git tags or CHANGELOG.md', () => {
    const dir = createTempRepo(
      '1.0.1',
      `# Unreleased Changes\n\n### Added\n\n- Default README for public availability repo\n`,
      `# Changelog\n\n## [1.0.0] - 2026-11-23\n\n### Features\n\n- Initial release\n`
    );

    // Simulate v1.0.1 already tagged on GitHub even though CHANGELOG.md hadn't recorded 1.0.1 yet
    const result = releaseChangelog({
      rootDir: dir,
      dateYmd: '2026-11-24',
      autoBump: true,
      hasTag: (v: string) => v === '1.0.1',
    });

    expect(result.released).toBe(true);
    expect(result.autoBumped).toBe(true);
    expect(result.version).toBe('1.0.2');

    // farm-waitlist/config.yaml & package.json must both be updated to 1.0.2
    const configYaml = fs.readFileSync(path.join(dir, 'farm-waitlist', 'config.yaml'), 'utf8');
    expect(readAddonVersion(configYaml)).toBe('1.0.2');
    const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')) as {
      version: string;
    };
    expect(pkg.version).toBe('1.0.2');

    // Both changelogs record 1.0.2 and UNRELEASED.md is cleared
    const changelog = fs.readFileSync(path.join(dir, 'CHANGELOG.md'), 'utf8');
    expect(changelog).toContain('## [1.0.2] - 2026-11-24');
    expect(changelog).toContain('- Default README for public availability repo');
    expect(fs.readFileSync(path.join(dir, 'farm-waitlist', 'CHANGELOG.md'), 'utf8')).toBe(
      changelog
    );
    expect(fs.readFileSync(path.join(dir, 'UNRELEASED.md'), 'utf8')).toBe(UNRELEASED_TEMPLATE);
  });

  it('does not double-bump when author manually bumped config.yaml to a new minor/major version', () => {
    const dir = createTempRepo(
      '1.1.0',
      `# Unreleased Changes\n\n### Added\n\n- Major feature\n`,
      `# Changelog\n\n## [1.0.2] - 2026-11-24\n\n### Added\n\n- Earlier change\n`
    );

    const result = releaseChangelog({
      rootDir: dir,
      dateYmd: '2026-11-25',
      autoBump: true,
      hasTag: (v: string) => v === '1.0.2',
    });

    expect(result.released).toBe(true);
    expect(result.autoBumped).toBe(false);
    expect(result.version).toBe('1.1.0');
  });

  it('leaves UNRELEASED.md untouched when autoBump is false and version already exists in CHANGELOG.md', () => {
    const pendingNotes = `# Unreleased Changes\n\n### Added\n\n- Next feature for 1.0.2\n`;
    const dir = createTempRepo(
      '1.0.1',
      pendingNotes,
      `# Changelog\n\n## [1.0.1] - 2026-11-24\n\n### Added\n\n- Something\n`
    );

    const result = releaseChangelog({
      rootDir: dir,
      dateYmd: '2026-11-25',
      autoBump: false,
      hasTag: () => false,
    });
    expect(result.released).toBe(false);
    expect(fs.readFileSync(path.join(dir, 'UNRELEASED.md'), 'utf8')).toBe(pendingNotes);
  });

  it('falls back cleanly when a version is bumped with an empty UNRELEASED.md', () => {
    const dir = createTempRepo(
      '1.0.2',
      UNRELEASED_TEMPLATE,
      `# Changelog\n\n## [1.0.1] - 2026-11-24\n\n### Added\n\n- Earlier change\n`
    );

    const result = releaseChangelog({
      rootDir: dir,
      dateYmd: '2026-11-26',
      autoBump: true,
      hasTag: () => false,
      fallbackNotes: '### Changes\n\n- Small tweak from git log',
    });

    expect(result.released).toBe(true);
    const changelog = fs.readFileSync(path.join(dir, 'CHANGELOG.md'), 'utf8');
    expect(changelog).toContain('## [1.0.2] - 2026-11-26\n\n### Changes\n\n- Small tweak from git log');
  });

  it('resolves the next release version read-only without mutating config.yaml, CHANGELOG.md, UNRELEASED.md, or package.json', () => {
    const unreleased = `# Unreleased Changes\n\n### Added\n\n- Pending feature\n`;
    const changelog = `# Changelog\n\n## [1.0.3] - 2026-11-24\n\n### Added\n\n- Prior release\n`;
    const dir = createTempRepo('1.0.3', unreleased, changelog);

    const beforeConfig = fs.readFileSync(path.join(dir, 'farm-waitlist', 'config.yaml'), 'utf8');
    const beforePkg = fs.readFileSync(path.join(dir, 'package.json'), 'utf8');

    const resolved = resolveNextReleaseVersion({
      rootDir: dir,
      autoBump: true,
      hasTag: () => false,
    });

    expect(resolved.version).toBe('1.0.4');
    expect(resolved.autoBumped).toBe(true);
    expect(resolved.alreadyReleased).toBe(true);

    // Zero files modified on disk during read-only resolution
    expect(fs.readFileSync(path.join(dir, 'farm-waitlist', 'config.yaml'), 'utf8')).toBe(beforeConfig);
    expect(fs.readFileSync(path.join(dir, 'CHANGELOG.md'), 'utf8')).toBe(changelog);
    expect(fs.readFileSync(path.join(dir, 'UNRELEASED.md'), 'utf8')).toBe(unreleased);
    expect(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')).toBe(beforePkg);
  });
});

