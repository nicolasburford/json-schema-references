import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const baseRef = process.argv[2] ?? 'origin/main';
const packageJsonPath = 'package.json';
const packageLockPath = 'package-lock.json';

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function readJsonFromGit(ref, path) {
  const contents = execFileSync('git', ['show', `${ref}:${path}`], {
    encoding: 'utf8'
  });
  return JSON.parse(contents);
}

function parseVersion(version) {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/.exec(version);
  if (!match) {
    throw new Error(`Invalid semantic version: ${version}`);
  }

  return match.slice(1, 4).map(Number);
}

function compareVersions(left, right) {
  const leftParts = parseVersion(left);
  const rightParts = parseVersion(right);

  for (let index = 0; index < leftParts.length; index += 1) {
    if (leftParts[index] > rightParts[index]) {
      return 1;
    }

    if (leftParts[index] < rightParts[index]) {
      return -1;
    }
  }

  return 0;
}

const currentPackage = readJson(packageJsonPath);
const currentLock = readJson(packageLockPath);
const basePackage = readJsonFromGit(baseRef, packageJsonPath);

const currentVersion = currentPackage.version;
const lockVersion = currentLock.version;
const lockPackageVersion = currentLock.packages?.['']?.version;
const baseVersion = basePackage.version;

if (currentVersion !== lockVersion || currentVersion !== lockPackageVersion) {
  throw new Error(
    `Version mismatch: package.json=${currentVersion}, package-lock.json=${lockVersion}, package-lock root=${lockPackageVersion}`
  );
}

if (compareVersions(currentVersion, baseVersion) <= 0) {
  throw new Error(
    `Version must be bumped above ${baseVersion} from ${baseRef}; current version is ${currentVersion}.`
  );
}

console.log(
  `Version bump validated: ${baseVersion} (${baseRef}) -> ${currentVersion}`
);
