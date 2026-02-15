import fs from 'node:fs/promises';
import path from 'node:path';

const MD_LINK_RE = /\[([^\]]+)\]\((<)?([^\)]+?)(>)?(?:\s+"[^"]*")?\)/g;

function stripIdSuffix(fileName) {
  return fileName.replace(/_[A-Za-z0-9]{12,}\.(md)$/i, '.$1').replace(/\.(md)$/i, '');
}

function sanitizeName(name) {
  return name.replace(/[\\/:*?"<>|]/g, '_').trim() || 'untitled';
}

function getFolderTitle(markdown, fileName) {
  const heading = markdown.match(/^#\s+(.+)$/m)?.[1]?.trim();
  if (heading) return sanitizeName(heading);
  return sanitizeName(stripIdSuffix(path.basename(fileName)));
}

function isLikelyFolderMarkdown(markdown) {
  const lines = markdown.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (lines.length < 2) return false;
  const contentLines = lines.filter((line) => !line.startsWith('#'));
  if (contentLines.length === 0) return false;
  return contentLines.every((line) => /^\[[^\]]+\]\((<)?[^\)]+\.md(>)?(\s+"[^"]*")?\)$/i.test(line));
}

async function walk(dir) {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...await walk(fullPath));
    else files.push(fullPath);
  }
  return files;
}

async function ensureDir(dir) {
  await fs.mkdir(dir, { recursive: true });
}

async function fileExists(p) {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

async function moveFileSafely(from, to) {
  await ensureDir(path.dirname(to));
  if (from === to) return to;
  let target = to;
  let index = 1;
  while (await fileExists(target)) {
    const ext = path.extname(to);
    const base = to.slice(0, -ext.length);
    target = `${base}_${index}${ext}`;
    index += 1;
  }
  await fs.rename(from, target);
  return target;
}

function parseLinks(markdown) {
  const links = [];
  for (const match of markdown.matchAll(MD_LINK_RE)) {
    links.push({ text: match[1], target: match[3], raw: match[0] });
  }
  return links;
}

function normalizeAssetName(linkText, sourcePath) {
  const linkTextName = linkText?.trim();
  if (linkTextName && path.extname(linkTextName)) return sanitizeName(linkTextName);
  return sanitizeName(path.basename(sourcePath));
}

async function rewriteAttachmentLinks(mdPath, assetsDir) {
  let markdown = await fs.readFile(mdPath, 'utf8');
  const links = parseLinks(markdown);

  for (const { text, target, raw } of links) {
    if (/\.md($|[?#])/i.test(target)) continue;
    if (/^(https?:|assets\/|#)/i.test(target)) continue;

    const normalizedTarget = target.replace(/^<|>$/g, '');
    const resolved = path.resolve(path.dirname(mdPath), normalizedTarget);
    if (!(await fileExists(resolved))) continue;

    const desiredName = normalizeAssetName(text, resolved);
    const movedPath = await moveFileSafely(resolved, path.join(assetsDir, desiredName));
    const relative = path.relative(path.dirname(mdPath), movedPath).replace(/\\/g, '/');
    markdown = markdown.replace(raw, `[${text}](${relative})`);
  }

  await fs.writeFile(mdPath, markdown, 'utf8');
}

async function normalizeHierarchy(workspaceDir) {
  const allFiles = await walk(workspaceDir);
  const mdFiles = allFiles.filter((file) => file.toLowerCase().endsWith('.md'));

  for (const mdPath of mdFiles) {
    let markdown = await fs.readFile(mdPath, 'utf8');
    if (!isLikelyFolderMarkdown(markdown)) continue;

    const folderName = getFolderTitle(markdown, mdPath);
    const folderPath = path.join(path.dirname(mdPath), folderName);
    await ensureDir(folderPath);

    const links = parseLinks(markdown).filter((link) => /\.md($|[?#])/i.test(link.target));
    for (const link of links) {
      const childTarget = link.target.replace(/^<|>$/g, '');
      const childResolved = path.resolve(path.dirname(mdPath), childTarget);
      if (!(await fileExists(childResolved))) continue;
      const moved = await moveFileSafely(childResolved, path.join(folderPath, path.basename(childResolved)));
      const rel = path.relative(path.dirname(mdPath), moved).replace(/\\/g, '/');
      markdown = markdown.replace(link.raw, `[${link.text}](${rel})`);
    }

    await fs.writeFile(mdPath, markdown, 'utf8');
    await moveFileSafely(mdPath, path.join(folderPath, 'README.md'));
  }
}

export async function normalizeWolaiWorkspace(workspaceDir) {
  const absWorkspace = path.resolve(workspaceDir);
  const assetsDir = path.join(absWorkspace, 'assets');
  await ensureDir(assetsDir);

  await normalizeHierarchy(absWorkspace);

  const filesAfter = await walk(absWorkspace);
  const mdFilesAfter = filesAfter.filter((file) => file.toLowerCase().endsWith('.md'));
  for (const mdPath of mdFilesAfter) {
    await rewriteAttachmentLinks(mdPath, assetsDir);
  }
}

import { fileURLToPath } from 'node:url';

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const workspaceDir = process.argv[2];
  if (!workspaceDir) {
    console.error('Usage: node scripts/normalize_wolai_workspace.js <workspace_dir>');
    process.exit(1);
  }
  normalizeWolaiWorkspace(workspaceDir)
    .then(() => console.log('✅ Wolai workspace normalized.'))
    .catch((error) => {
      console.error('❌ Failed to normalize workspace:', error);
      process.exit(1);
    });
}
