import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const versionPattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

export function verifyReleaseVersions({ packageJson, lockfile, tag, manifests = [] }) {
  const version = packageJson.version;
  if (
    typeof version !== 'string' ||
    !versionPattern.test(version) ||
    version.split('.').some((part) => Number(part) > 65535) ||
    version === '0.0.0'
  ) {
    throw new Error('Use a stable Chrome-compatible X.Y.Z package version (components 0–65535).');
  }
  if (lockfile.version !== version || lockfile.packages?.['']?.version !== version) {
    throw new Error('package.json and both package-lock.json root versions must match.');
  }
  if (tag !== undefined && tag !== `v${version}`) {
    throw new Error(`Release tag must be v${version}; received ${tag}.`);
  }
  for (const manifest of manifests) {
    if (
      manifest.manifest_version !== 3 ||
      manifest.version !== version ||
      (manifest.version_name !== undefined && manifest.version_name !== version)
    ) {
      throw new Error(`Every built/archived manifest must be MV3 with version ${version}.`);
    }
  }
  return version;
}

export function verifyAnnotatedTag({ cwd, tag, commit }) {
  if (typeof tag !== 'string' || !tag.startsWith('v') || !versionPattern.test(tag.slice(1))) {
    throw new Error('An explicit stable vX.Y.Z release tag is required.');
  }
  if (commit !== undefined && !/^[a-f0-9]{40}$/.test(commit)) {
    throw new Error('The expected release commit must be a full Git SHA.');
  }
  const git = (...args) =>
    execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  const ref = `refs/tags/${tag}`;
  if (git('cat-file', '-t', ref) !== 'tag') {
    throw new Error('Release tags must be annotated; use git tag -a.');
  }
  const head = git('rev-parse', 'HEAD');
  if (git('rev-parse', `${ref}^{commit}`) !== head || (commit !== undefined && commit !== head)) {
    throw new Error('The release tag, checked-out HEAD, and expected commit must match.');
  }
  if (git('status', '--porcelain')) {
    throw new Error('Release validation requires a clean working tree.');
  }
  return head;
}

export async function main(args = process.argv.slice(2), cwd = process.cwd()) {
  const { values } = parseArgs({
    args,
    options: {
      tag: { type: 'string' },
      manifest: { type: 'string', multiple: true },
      'require-tag': { type: 'boolean', default: false },
      commit: { type: 'string' }
    }
  });
  const json = async (path) => JSON.parse(await readFile(resolve(cwd, path), 'utf8'));
  const version = verifyReleaseVersions({
    packageJson: await json('package.json'),
    lockfile: await json('package-lock.json'),
    tag: values.tag,
    manifests: await Promise.all((values.manifest ?? []).map(json))
  });
  if (values.commit && !values['require-tag']) {
    throw new Error('--commit requires --require-tag.');
  }
  if (values['require-tag']) verifyAnnotatedTag({ cwd, tag: values.tag, commit: values.commit });
  console.log(`Verified release version ${version}${values.tag ? ` (${values.tag})` : ''}.`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(`Release validation failed: ${error.message}`);
    process.exitCode = 1;
  });
}
