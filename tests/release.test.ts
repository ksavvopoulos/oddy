import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { verifyAnnotatedTag, verifyReleaseVersions } from '../scripts/verify-release.mjs';

const packageJson = { version: '0.13.2' };
const lockfile = { version: '0.13.2', packages: { '': { version: '0.13.2' } } };
const manifest = { manifest_version: 3, version: '0.13.2' };
const verify = (overrides: Record<string, unknown> = {}) =>
  verifyReleaseVersions({
    packageJson,
    lockfile,
    tag: 'v0.13.2',
    manifests: [manifest],
    ...overrides
  });
const directories: string[] = [];
const script = fileURLToPath(new URL('../scripts/verify-release.mjs', import.meta.url));
function fixture() {
  const cwd = mkdtempSync(join(tmpdir(), 'oddy-release-'));
  directories.push(cwd);
  const git = (...args: string[]) =>
    execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  git('init', '--quiet');
  git('config', 'user.name', 'Release test');
  git('config', 'user.email', 'release-test@example.invalid');
  git('config', 'commit.gpgsign', 'false');
  git('config', 'tag.gpgsign', 'false');
  writeFileSync(join(cwd, 'package.json'), JSON.stringify(packageJson));
  writeFileSync(join(cwd, 'package-lock.json'), JSON.stringify(lockfile));
  writeFileSync(join(cwd, 'manifest.json'), JSON.stringify(manifest));
  git('add', '.');
  git('commit', '--quiet', '-m', 'Release fixture');
  return { cwd, git, commit: git('rev-parse', 'HEAD') };
}
afterEach(() =>
  directories.splice(0).forEach((directory) => rmSync(directory, { recursive: true, force: true }))
);

describe('release version agreement', () => {
  it('accepts matching source, lockfile, tag and multiple built manifests', () => {
    expect(verify({ manifests: [manifest, { ...manifest }] })).toBe('0.13.2');
    expect(verify({ tag: undefined, manifests: [] })).toBe('0.13.2');
  });

  it.each(['0.13.1', 'v0.13.1', 'v0.13.2-beta.1', 'v0.13.2/other', 'v0.13.2\nmalicious'])(
    'rejects a mismatched or malformed tag %s',
    (tag) => {
      expect(() => verify({ tag })).toThrow('Release tag');
    }
  );

  it.each(['01.13.2', '0.13.2-beta.1', '65536.0.1', '0.0.0', '0.13', undefined])(
    'rejects invalid extension version %s',
    (version) => {
      expect(() => verify({ packageJson: { version } })).toThrow('Chrome-compatible');
    }
  );

  it.each([
    { ...lockfile, version: '0.13.0' },
    { ...lockfile, packages: { '': { version: '0.13.0' } } },
    { version: '0.13.2' }
  ])('rejects drift in either lockfile root', (lockfile) => {
    expect(() => verify({ lockfile })).toThrow('package-lock.json');
  });

  it.each([
    { ...manifest, version: '0.13.0' },
    { ...manifest, manifest_version: 2 },
    { ...manifest, version_name: '0.13.1' }
  ])('rejects wrong manifest versions, including a misleading display version', (manifest) => {
    expect(() => verify({ manifests: [manifest] })).toThrow('Every built/archived manifest');
  });

  it('does not accept a correct unpacked manifest when the archived one differs', () => {
    expect(() => verify({ manifests: [manifest, { ...manifest, version: '0.13.1' }] })).toThrow();
  });
});

describe('annotated release tags', () => {
  it('accepts a clean tree and an annotated tag on the expected HEAD', () => {
    const { cwd, git, commit } = fixture();
    git('tag', '-a', 'v0.13.2', '-m', 'Oddy 0.13.2');
    expect(verifyAnnotatedTag({ cwd, tag: 'v0.13.2', commit })).toBe(commit);
  });

  it('rejects lightweight tags', () => {
    const { cwd, git, commit } = fixture();
    git('tag', 'v0.13.2');
    expect(() => verifyAnnotatedTag({ cwd, tag: 'v0.13.2', commit })).toThrow('annotated');
  });

  it('rejects tags on an older commit and a mismatched event SHA', () => {
    const { cwd, git, commit } = fixture();
    git('tag', '-a', 'v0.13.2', '-m', 'Oddy 0.13.2');
    expect(() => verifyAnnotatedTag({ cwd, tag: 'v0.13.2', commit: 'a'.repeat(40) })).toThrow(
      'must match'
    );
    writeFileSync(join(cwd, 'extra.txt'), 'new commit');
    git('add', '.');
    git('commit', '--quiet', '-m', 'Later commit');
    expect(() => verifyAnnotatedTag({ cwd, tag: 'v0.13.2', commit })).toThrow('must match');
  });

  it('rejects dirty or untracked release input', () => {
    const { cwd, git, commit } = fixture();
    git('tag', '-a', 'v0.13.2', '-m', 'Oddy 0.13.2');
    writeFileSync(join(cwd, 'unexpected.txt'), 'uncommitted');
    expect(() => verifyAnnotatedTag({ cwd, tag: 'v0.13.2', commit })).toThrow('clean working tree');
  });

  it('checks versions and the real tag through the CLI', () => {
    const { cwd, git, commit } = fixture();
    git('tag', '-a', 'v0.13.2', '-m', 'Oddy 0.13.2');
    const output = execFileSync(
      process.execPath,
      [
        script,
        '--tag',
        'v0.13.2',
        '--require-tag',
        '--commit',
        commit,
        '--manifest',
        'manifest.json',
        '--manifest',
        'manifest.json'
      ],
      { cwd, encoding: 'utf8' }
    );
    expect(output).toContain('Verified release version 0.13.2');
    expect(() =>
      execFileSync(process.execPath, [script, '--tag', 'v0.13.1'], { cwd, stdio: 'pipe' })
    ).toThrow();
  });
});

describe('release workflow guardrails', () => {
  const workflow = readFileSync(
    new URL('../.github/workflows/release.yml', import.meta.url),
    'utf8'
  );

  it('pins every action to a commit and keeps publication separate from building', () => {
    const actions = [...workflow.matchAll(/uses: (\S+)/g)].map((match) => match[1]!);
    expect(actions.length).toBeGreaterThan(0);
    for (const action of actions) expect(action).toMatch(/^actions\/[\w-]+@[a-f0-9]{40}$/);
    expect(workflow).toContain('contents: read');
    expect(workflow).toContain('needs: build');
    expect(workflow).toContain('contents: write');
    expect(workflow.slice(workflow.indexOf('  publish:'))).not.toContain('npm ci');
  });

  it('verifies the ZIP, checksum, tag and commit before publishing without overwriting', () => {
    expect(workflow).toContain('--require-tag --commit');
    expect(workflow).toContain('unzip -t');
    expect(workflow).toContain('--manifest "$RUNNER_TEMP/archived-manifest.json"');
    expect(workflow).toContain('sha256sum --check');
    expect(workflow).toContain('test "$remote_commit" = "$RELEASE_COMMIT"');
    expect(workflow).toContain('digest-mismatch: error');
    expect(workflow).toContain('--verify-tag --draft --generate-notes');
    expect(workflow).toContain('--draft=false');
    expect(workflow).not.toMatch(/--clobber|git push|git tag -f|wxt submit|npm publish/);
  });
});
