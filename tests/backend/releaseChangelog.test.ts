import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  UNRELEASED_TEMPLATE,
  extractUnreleasedBody,
  releaseChangelog,
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

describe('Release Changelog Promotion (UNRELEASED.md -> CHANGELOG.md & farm-waitlist/CHANGELOG.md)', () => {
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
    const result = releaseChangelog({ rootDir: dir, dateYmd: '2026-11-24', notesOutPath });

    expect(result.released).toBe(true);
    expect(result.version).toBe('1.0.1');

    const rootChangelog = fs.readFileSync(path.join(dir, 'CHANGELOG.md'), 'utf8');
    const addonChangelog = fs.readFileSync(path.join(dir, 'farm-waitlist', 'CHANGELOG.md'), 'utf8');
    expect(addonChangelog).toBe(rootChangelog);

    // 1.0.1 must appear above 1.0.0, with only non-empty sections (Added & Fixed, no empty Changed)
    expect(rootChangelog).toContain('## [1.0.1] - 2026-11-24');
    expect(rootChangelog).toContain('### Added\n\n- Requested Pickup Date on waitlist cards');
    expect(rootChangelog).toContain('### Fixed\n\n- Email-safe pre-approval rich copy');
    expect(rootChangelog).not.toContain('### Changed');
    expect(rootChangelog.indexOf('## [1.0.1]')).toBeLessThan(rootChangelog.indexOf('## [1.0.0]'));

    // UNRELEASED.md is cleared back to clean template
    expect(fs.readFileSync(path.join(dir, 'UNRELEASED.md'), 'utf8')).toBe(UNRELEASED_TEMPLATE);
    expect(extractUnreleasedBody(UNRELEASED_TEMPLATE)).toBe('');

    // package.json synced to 1.0.1
    const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')) as {
      version: string;
    };
    expect(pkg.version).toBe('1.0.1');

    // Release notes file written for gh release create
    const notesOut = fs.readFileSync(notesOutPath, 'utf8');
    expect(notesOut).toContain('- Requested Pickup Date on waitlist cards');
    expect(notesOut).toContain('- Email-safe pre-approval rich copy');
  });

  it('does not overwrite or wipe UNRELEASED.md when the current config.yaml version is already in CHANGELOG.md', () => {
    const pendingNotes = `# Unreleased Changes\n\n### Added\n\n- Next feature for 1.0.2\n`;
    const dir = createTempRepo(
      '1.0.1',
      pendingNotes,
      `# Changelog\n\n## [1.0.1] - 2026-11-24\n\n### Added\n\n- Something\n`
    );

    const result = releaseChangelog({ rootDir: dir, dateYmd: '2026-11-25' });
    expect(result.released).toBe(false);
    expect(fs.readFileSync(path.join(dir, 'UNRELEASED.md'), 'utf8')).toBe(pendingNotes);
    expect(fs.readFileSync(path.join(dir, 'farm-waitlist', 'CHANGELOG.md'), 'utf8')).toBe(
      fs.readFileSync(path.join(dir, 'CHANGELOG.md'), 'utf8')
    );
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
      fallbackNotes: '### Changes\n\n- Small tweak from git log',
    });

    expect(result.released).toBe(true);
    const changelog = fs.readFileSync(path.join(dir, 'CHANGELOG.md'), 'utf8');
    expect(changelog).toContain('## [1.0.2] - 2026-11-26\n\n### Changes\n\n- Small tweak from git log');
  });
});
