import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  bumpPatchVersion,
  changelogHasVersion,
  extractUnreleasedBody,
  readAddonVersion,
  releaseChangelog,
  resolveNextReleaseVersion,
  splitChangelogHeaderAndHistory,
  stampReleaseVersionInChangelog,
  writeAddonVersionText,
} from '../../scripts/release-changelog.mjs';

const tmpDirs: string[] = [];

function createTempRepo(version: string, changelog: string) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'farm-waitlist-changelog-'));
  tmpDirs.push(dir);
  fs.mkdirSync(path.join(dir, 'farm-waitlist'), { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'farm-waitlist', 'config.yaml'),
    `name: Farm Waitlist\nversion: "${version}"\nslug: farm-waitlist\n`,
    'utf8'
  );
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

describe('Direct-in-CHANGELOG Release Stamping & Auto-Bump Pipeline', () => {
  it('covers version parsing, updating, semver patch bumping, and heading detection helpers', () => {
    const yaml = `name: Farm Waitlist\nversion: "1.0.7"\nslug: farm-waitlist\n`;
    expect(readAddonVersion(yaml)).toBe('1.0.7');
    expect(readAddonVersion('name: No Version')).toBeNull();
    expect(writeAddonVersionText(yaml, '1.0.8')).toContain('version: "1.0.8"');
    expect(bumpPatchVersion('1.0.7')).toBe('1.0.8');
    expect(() => bumpPatchVersion('not-semver')).toThrow(/non-semver/i);

    const cl = `# Changelog\n\n## [1.0.7] - 2026-11-25\n\n### Added\n\n- Something\n`;
    expect(changelogHasVersion(cl, '1.0.7')).toBe(true);
    expect(changelogHasVersion(cl, '1.0.8')).toBe(false);
  });

  it('splits header, unversioned top notes, and versioned history cleanly across all formats', () => {
    const withUnversioned = `# Changelog

All notable changes to Farm Waitlist are documented in this file.

### Added

- Feature A

### Fixed

- Bug B

## [1.0.7] - 2026-11-25

### Added

- Old Feature`;

    const split1 = splitChangelogHeaderAndHistory(withUnversioned);
    expect(split1.headerPart).toBe(
      '# Changelog\n\nAll notable changes to Farm Waitlist are documented in this file.'
    );
    expect(split1.unversionedPart).toContain('### Added\n\n- Feature A');
    expect(split1.unversionedPart).toContain('### Fixed\n\n- Bug B');
    expect(split1.historyPart).toMatch(/^## \[1\.0\.7\] - 2026-11-25/);

    // Optional ## [Unreleased] header or bare bullets without subheadings
    const withBareBullet = `# Changelog\n\nIntro line.\n\n- Quick hotfix\n\n## [1.0.7] - 2026-11-25\n\n- Old`;
    const split2 = splitChangelogHeaderAndHistory(withBareBullet);
    expect(split2.unversionedPart).toBe('- Quick hotfix');
    expect(extractUnreleasedBody(split2.unversionedPart, split2.historyPart)).toBe(
      '### Changes\n\n- Quick hotfix'
    );

    const withUnreleasedHeading = `# Changelog\n\n## [Unreleased]\n\n### Fixed\n\n- Fix 1\n\n## [1.0.7] - 2026-11-25\n\n- Old`;
    const split3 = splitChangelogHeaderAndHistory(withUnreleasedHeading);
    expect(extractUnreleasedBody(split3.unversionedPart, split3.historyPart)).toBe(
      '### Fixed\n\n- Fix 1'
    );

    // Clean changelog with no unversioned notes
    const clean = `# Changelog\n\nAll notable changes.\n\n## [1.0.7] - 2026-11-25\n\n- Old`;
    const split4 = splitChangelogHeaderAndHistory(clean);
    expect(split4.unversionedPart).toBe('');
    expect(split4.historyPart).toMatch(/^## \[1\.0\.7\]/);

    // stampReleaseVersionInChangelog replaces the unversioned top in-place
    const stamped = stampReleaseVersionInChangelog(
      withUnversioned,
      '1.0.8',
      '2026-11-27',
      '### Added\n\n- Feature A'
    );
    expect(stamped).toContain('## [1.0.8] - 2026-11-27\n\n### Added\n\n- Feature A');
    expect(stamped).not.toContain('- Bug B');
    expect(stamped.indexOf('## [1.0.8]')).toBeLessThan(stamped.indexOf('## [1.0.7]'));
  });

  it('stamps the version header onto unversioned top notes in CHANGELOG.md, mirrors farm-waitlist/CHANGELOG.md, syncs package.json, and writes release notes without creating UNRELEASED.md', () => {
    const dir = createTempRepo(
      '1.0.8',
      `# Changelog

All notable changes to Farm Waitlist are documented in this file.

### Added

- Requested Pickup Date on waitlist cards
- Odoo customer name autocomplete

### Changed

### Fixed

- Email-safe pre-approval rich copy

## [1.0.7] - 2026-11-25

### Features

- Prior release
`
    );

    const notesOutPath = path.join(dir, 'release-notes.md');
    const result = releaseChangelog({
      rootDir: dir,
      dateYmd: '2026-11-27',
      notesOutPath,
      autoBump: true,
      hasTag: () => false,
    });

    expect(result.released).toBe(true);
    expect(result.autoBumped).toBe(false);
    expect(result.version).toBe('1.0.8');

    const rootChangelog = fs.readFileSync(path.join(dir, 'CHANGELOG.md'), 'utf8');
    const addonChangelog = fs.readFileSync(path.join(dir, 'farm-waitlist', 'CHANGELOG.md'), 'utf8');
    expect(addonChangelog).toBe(rootChangelog);

    expect(rootChangelog).toContain('## [1.0.8] - 2026-11-27');
    expect(rootChangelog).toContain('### Added\n\n- Requested Pickup Date on waitlist cards');
    expect(rootChangelog).toContain('### Fixed\n\n- Email-safe pre-approval rich copy');
    expect(rootChangelog).not.toContain('### Changed');
    expect(rootChangelog.indexOf('## [1.0.8]')).toBeLessThan(rootChangelog.indexOf('## [1.0.7]'));

    // After stamping, zero unversioned notes remain at the top and UNRELEASED.md is not created
    expect(splitChangelogHeaderAndHistory(rootChangelog).unversionedPart).toBe('');
    expect(fs.existsSync(path.join(dir, 'UNRELEASED.md'))).toBe(false);

    const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')) as {
      version: string;
    };
    expect(pkg.version).toBe('1.0.8');

    const notesOut = fs.readFileSync(notesOutPath, 'utf8');
    expect(notesOut).toContain('- Requested Pickup Date on waitlist cards');
    expect(notesOut).toContain('- Email-safe pre-approval rich copy');
  });

  it('automatically skips duplicate bullets that already appear in prior released versions', () => {
    const dir = createTempRepo(
      '1.0.7',
      `# Changelog

All notable changes to Farm Waitlist are documented in this file.

### Added

- Already shipped feature from 1.0.7
- Brand new feature for 1.0.8

### Fixed

- Already shipped fix from 1.0.6

## [1.0.7] - 2026-11-25

### Added

- Already shipped feature from 1.0.7

## [1.0.6] - 2026-11-25

### Fixed

- Already shipped fix from 1.0.6
`
    );

    const result = releaseChangelog({
      rootDir: dir,
      dateYmd: '2026-11-27',
      autoBump: true,
      hasTag: () => false,
    });

    expect(result.released).toBe(true);
    expect(result.autoBumped).toBe(true);
    expect(result.version).toBe('1.0.8');
    expect(result.notes).toBe('### Added\n\n- Brand new feature for 1.0.8');

    const updated = fs.readFileSync(path.join(dir, 'CHANGELOG.md'), 'utf8');
    const v108Block = updated.slice(updated.indexOf('## [1.0.8]'), updated.indexOf('## [1.0.7]'));
    expect(v108Block).toContain('- Brand new feature for 1.0.8');
    expect(v108Block).not.toContain('Already shipped feature from 1.0.7');
    expect(v108Block).not.toContain('Already shipped fix from 1.0.6');
    expect(v108Block).not.toContain('### Fixed');
  });

  it('auto-bumps patch version in config.yaml when current version already exists in git tags or CHANGELOG.md', () => {
    const dir = createTempRepo(
      '1.0.7',
      `# Changelog

### Added

- Default README for public availability repo

## [1.0.6] - 2026-11-25

### Added

- Earlier release
`
    );

    const result = releaseChangelog({
      rootDir: dir,
      dateYmd: '2026-11-27',
      autoBump: true,
      hasTag: (v: string) => v === '1.0.7',
    });

    expect(result.released).toBe(true);
    expect(result.autoBumped).toBe(true);
    expect(result.version).toBe('1.0.8');

    const configYaml = fs.readFileSync(path.join(dir, 'farm-waitlist', 'config.yaml'), 'utf8');
    expect(readAddonVersion(configYaml)).toBe('1.0.8');
    const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')) as {
      version: string;
    };
    expect(pkg.version).toBe('1.0.8');

    const changelog = fs.readFileSync(path.join(dir, 'CHANGELOG.md'), 'utf8');
    expect(changelog).toContain('## [1.0.8] - 2026-11-27');
    expect(changelog).toContain('- Default README for public availability repo');
    expect(fs.readFileSync(path.join(dir, 'farm-waitlist', 'CHANGELOG.md'), 'utf8')).toBe(
      changelog
    );
  });

  it('does not double-bump when author manually bumped config.yaml to a new minor/major version', () => {
    const dir = createTempRepo(
      '1.1.0',
      `# Changelog

### Added

- Major feature

## [1.0.7] - 2026-11-25

### Added

- Earlier change
`
    );

    const result = releaseChangelog({
      rootDir: dir,
      dateYmd: '2026-11-27',
      autoBump: true,
      hasTag: (v: string) => v === '1.0.7',
    });

    expect(result.released).toBe(true);
    expect(result.autoBumped).toBe(false);
    expect(result.version).toBe('1.1.0');
  });

  it('leaves top unversioned notes untouched when autoBump is false and version already exists in CHANGELOG.md', () => {
    const changelog = `# Changelog

### Added

- Next feature for 1.0.8

## [1.0.7] - 2026-11-25

### Added

- Something
`;
    const dir = createTempRepo('1.0.7', changelog);

    const result = releaseChangelog({
      rootDir: dir,
      dateYmd: '2026-11-27',
      autoBump: false,
      hasTag: () => false,
    });
    expect(result.released).toBe(false);
    expect(fs.readFileSync(path.join(dir, 'CHANGELOG.md'), 'utf8')).toBe(changelog);
  });

  it('falls back cleanly when a version is released with no unversioned notes at the top of CHANGELOG.md', () => {
    const dir = createTempRepo(
      '1.0.7',
      `# Changelog

All notable changes to Farm Waitlist are documented in this file.

## [1.0.7] - 2026-11-25

### Added

- Earlier change
`
    );

    const result = releaseChangelog({
      rootDir: dir,
      dateYmd: '2026-11-27',
      autoBump: true,
      hasTag: () => false,
      fallbackNotes: '### Changes\n\n- Small tweak from git log',
    });

    expect(result.released).toBe(true);
    expect(result.version).toBe('1.0.8');
    const changelog = fs.readFileSync(path.join(dir, 'CHANGELOG.md'), 'utf8');
    expect(changelog).toContain('## [1.0.8] - 2026-11-27\n\n### Changes\n\n- Small tweak from git log');
  });

  it('resolves the next release version read-only without mutating config.yaml, CHANGELOG.md, or package.json', () => {
    const changelog = `# Changelog

### Added

- Pending feature

## [1.0.7] - 2026-11-25

### Added

- Prior release
`;
    const dir = createTempRepo('1.0.7', changelog);

    const beforeConfig = fs.readFileSync(path.join(dir, 'farm-waitlist', 'config.yaml'), 'utf8');
    const beforePkg = fs.readFileSync(path.join(dir, 'package.json'), 'utf8');

    const resolved = resolveNextReleaseVersion({
      rootDir: dir,
      autoBump: true,
      hasTag: () => false,
    });

    expect(resolved.version).toBe('1.0.8');
    expect(resolved.autoBumped).toBe(true);
    expect(resolved.alreadyReleased).toBe(true);

    expect(fs.readFileSync(path.join(dir, 'farm-waitlist', 'config.yaml'), 'utf8')).toBe(beforeConfig);
    expect(fs.readFileSync(path.join(dir, 'CHANGELOG.md'), 'utf8')).toBe(changelog);
    expect(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')).toBe(beforePkg);
  });
});
