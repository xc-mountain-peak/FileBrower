import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export function parseUrlList(rawContent: string): string[] {
  return rawContent
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [firstCell] = line.split(',');
      return firstCell.trim().replace(/^"|"$/g, '');
    })
    .filter(Boolean);
}

export function normalizeTargetUrl(value: string): string {
  const trimmed = value.trim();

  if (/^https?:\/\//i.test(trimmed) || /^file:\/\//i.test(trimmed)) {
    return trimmed;
  }

  if (path.isAbsolute(trimmed)) {
    return pathToFileURL(trimmed).toString();
  }

  return trimmed;
}

export async function readTextFile(filePath: string): Promise<string> {
  return fs.readFile(filePath, 'utf8');
}
