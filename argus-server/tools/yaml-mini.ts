// Minimal YAML parser for runbook files
// Handles the subset used by our runbooks: strings, numbers, booleans, lists,
// nested objects, and multiline strings (>, |)

export type YamlValue = string | number | boolean | null | YamlValue[] | { [key: string]: YamlValue };
type YamlObject = { [key: string]: YamlValue };

interface KeyValueResult { key: string; value: YamlValue; nextIdx: number }
interface ValueResult { value: YamlValue; nextIdx: number }

export function parse(text: string): YamlObject {
  const lines = text.split("\n");
  return parseTopLevel(lines);
}

function getIndent(line: string): number {
  const match = line.match(/^(\s*)/);
  return match ? match[1].length : 0;
}

function parseScalar(val: string): YamlValue {
  if (val === "null" || val === "~") return null;
  if (val === "true") return true;
  if (val === "false") return false;
  if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
    return val.slice(1, -1);
  }
  const num = Number(val);
  if (!isNaN(num) && val !== "") return num;
  return val;
}

function parseTopLevel(lines: string[]): YamlObject {
  const doc: YamlObject = {};
  let i = 0;
  while (i < lines.length) {
    if (!lines[i].trim() || lines[i].trimStart().startsWith("#")) { i++; continue; }
    const result = parseKeyValue(lines, i, 0);
    if (result) {
      doc[result.key] = result.value;
      i = result.nextIdx;
    } else {
      i++;
    }
  }
  return doc;
}

function parseKeyValue(lines: string[], startIdx: number, baseIndent: number): KeyValueResult | null {
  const line = lines[startIdx];
  if (!line) return null;
  const trimmed = line.trimStart();
  const indent = getIndent(line);
  if (indent < baseIndent) return null;
  if (trimmed.startsWith("- ") || trimmed.startsWith("#") || !trimmed) return null;

  const colonIdx = trimmed.indexOf(":");
  if (colonIdx === -1) return null;

  const key = trimmed.slice(0, colonIdx).trim();
  const afterColon = trimmed.slice(colonIdx + 1).trim();

  if (afterColon === ">" || afterColon === "|") {
    // Multiline folded/literal string
    const mlResult = readMultiline(lines, startIdx + 1, indent + 2, afterColon);
    return { key, value: mlResult.value, nextIdx: mlResult.nextIdx };
  }

  if (afterColon !== "") {
    // Inline value
    return { key, value: parseScalar(afterColon), nextIdx: startIdx + 1 };
  }

  // Nested value: could be an object or a list
  let nextIdx = startIdx + 1;
  // Skip blanks
  while (nextIdx < lines.length && !lines[nextIdx].trim()) nextIdx++;
  if (nextIdx >= lines.length) return { key, value: null, nextIdx };

  const nextIndent = getIndent(lines[nextIdx]);
  const nextTrimmed = lines[nextIdx].trimStart();

  if (nextTrimmed.startsWith("- ")) {
    // List
    const listResult = parseListContent(lines, nextIdx, nextIndent);
    return { key, value: listResult.value, nextIdx: listResult.nextIdx };
  }

  // Nested object
  const objResult = parseObjectContent(lines, nextIdx, nextIndent);
  return { key, value: objResult.value, nextIdx: objResult.nextIdx };
}

function parseObjectContent(lines: string[], startIdx: number, baseIndent: number): ValueResult {
  const obj: YamlObject = {};
  let i = startIdx;
  while (i < lines.length) {
    if (!lines[i].trim() || lines[i].trimStart().startsWith("#")) { i++; continue; }
    const indent = getIndent(lines[i]);
    if (indent < baseIndent) break;
    const result = parseKeyValue(lines, i, baseIndent);
    if (result) {
      obj[result.key] = result.value;
      i = result.nextIdx;
    } else {
      i++;
    }
  }
  return { value: obj, nextIdx: i };
}

function parseListContent(lines: string[], startIdx: number, listIndent: number): { value: YamlValue[]; nextIdx: number } {
  const items: YamlValue[] = [];
  let i = startIdx;
  while (i < lines.length) {
    if (!lines[i].trim()) { i++; continue; }
    const indent = getIndent(lines[i]);
    if (indent < listIndent) break;
    const trimmed = lines[i].trimStart();
    if (indent === listIndent && trimmed.startsWith("- ")) {
      const itemResult = parseListItem(lines, i, listIndent);
      items.push(itemResult.value);
      i = itemResult.nextIdx;
    } else {
      break;
    }
  }
  return { value: items, nextIdx: i };
}

function parseListItem(lines: string[], startIdx: number, dashIndent: number): ValueResult {
  const line = lines[startIdx];
  const trimmed = line.trimStart();
  const afterDash = trimmed.slice(2).trimStart();

  if (!afterDash) {
    // Empty list item
    return { value: null, nextIdx: startIdx + 1 };
  }

  // Check if the first part has a colon — it's an object in a list
  const colonIdx = afterDash.indexOf(":");
  if (colonIdx === -1) {
    // Scalar list item
    return { value: parseScalar(afterDash), nextIdx: startIdx + 1 };
  }

  // It's an object in a list.
  const contentIndent = dashIndent + 2;
  let obj: YamlObject = {};

  // First, handle the key:value on the same line as "- "
  const firstKey = afterDash.slice(0, colonIdx).trim();
  const firstVal = afterDash.slice(colonIdx + 1).trim();

  if (firstVal === ">" || firstVal === "|") {
    const mlResult = readMultiline(lines, startIdx + 1, contentIndent + 2, firstVal);
    obj[firstKey] = mlResult.value;
    const j = mlResult.nextIdx;
    obj = { ...obj, ...parseRemainingItemKeys(lines, j, contentIndent) };
    const endIdx = findItemEnd(lines, startIdx, dashIndent);
    return { value: obj, nextIdx: endIdx };
  }

  if (firstVal !== "") {
    obj[firstKey] = parseScalar(firstVal);
  } else {
    obj[firstKey] = null;
  }

  // Now scan subsequent lines at contentIndent for more keys
  let i = startIdx + 1;
  while (i < lines.length) {
    if (!lines[i].trim()) { i++; continue; }
    const lineIndent = getIndent(lines[i]);
    if (lineIndent <= dashIndent) break;
    if (lineIndent === contentIndent) {
      const t = lines[i].trimStart();
      if (t.startsWith("- ")) break; // next list item
      const ci = t.indexOf(":");
      if (ci !== -1) {
        const k = t.slice(0, ci).trim();
        const v = t.slice(ci + 1).trim();
        if (v === ">" || v === "|") {
          const mlResult = readMultiline(lines, i + 1, contentIndent + 2, v);
          obj[k] = mlResult.value;
          i = mlResult.nextIdx;
        } else if (v !== "") {
          obj[k] = parseScalar(v);
          i++;
        } else {
          obj[k] = null;
          i++;
        }
      } else {
        i++;
      }
    } else if (lineIndent > contentIndent) {
      i++;
    } else {
      i++;
    }
  }

  return { value: obj, nextIdx: i };
}

function parseRemainingItemKeys(lines: string[], startIdx: number, contentIndent: number): YamlObject {
  const obj: YamlObject = {};
  let i = startIdx;
  while (i < lines.length) {
    if (!lines[i].trim()) { i++; continue; }
    const indent = getIndent(lines[i]);
    if (indent < contentIndent) break;
    const t = lines[i].trimStart();
    if (t.startsWith("- ")) break;
    const ci = t.indexOf(":");
    if (ci !== -1) {
      const k = t.slice(0, ci).trim();
      const v = t.slice(ci + 1).trim();
      if (v === ">" || v === "|") {
        const mlResult = readMultiline(lines, i + 1, indent + 2, v);
        obj[k] = mlResult.value;
        i = mlResult.nextIdx;
      } else if (v !== "") {
        obj[k] = parseScalar(v);
        i++;
      } else {
        obj[k] = null;
        i++;
      }
    } else {
      i++;
    }
  }
  return obj;
}

function findItemEnd(lines: string[], startIdx: number, dashIndent: number): number {
  let i = startIdx + 1;
  while (i < lines.length) {
    if (!lines[i].trim()) { i++; continue; }
    const indent = getIndent(lines[i]);
    if (indent <= dashIndent) {
      if (indent === dashIndent && lines[i].trimStart().startsWith("- ")) return i;
      if (indent < dashIndent) return i;
      return i;
    }
    i++;
  }
  return i;
}

function readMultiline(lines: string[], startIdx: number, contentIndent: number, mode: string): { value: string; nextIdx: number } {
  const parts: string[] = [];
  let i = startIdx;
  while (i < lines.length) {
    if (!lines[i].trim()) { i++; continue; }
    const indent = getIndent(lines[i]);
    if (indent < contentIndent) break;
    parts.push(lines[i].trimStart());
    i++;
  }
  if (mode === ">") {
    return { value: parts.join(" ").replace(/\s+/g, " ").trim(), nextIdx: i };
  }
  return { value: parts.join("\n"), nextIdx: i };
}
