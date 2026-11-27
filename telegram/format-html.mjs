const DEFAULT_MAX_LENGTH = 4096;
const CODE_BLOCK_OPEN = "<pre><code>";
const CODE_BLOCK_CLOSE = "</code></pre>";
const CODE_BLOCK_OVERHEAD = CODE_BLOCK_OPEN.length + CODE_BLOCK_CLOSE.length;
const FENCE_OPEN_RE = /^[ \t]{0,3}(`{3,})([^`\n]*)$/;
const FENCE_CLOSE_RE = /^[ \t]{0,3}(`{3,})[ \t]*$/;
const HEADING_RE = /^#{1,6}[ \t]+(.+)$/;
const LIST_ITEM_RE = /^([ \t]*)[-*][ \t]+(.*)$/;
const HTTP_SCHEME_RE = /^https?:\/\//i;
const ANY_SCHEME_RE = /^[a-z][a-z0-9+.-]*:/i;

function isControlChar(ch) {
  const code = ch.charCodeAt(0);
  return code <= 0x1f || code === 0x7f;
}

function hasControlChar(value) {
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

function escapeHtmlText(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function escapeHtmlAttr(value) {
  return escapeHtmlText(value).replaceAll('"', "&quot;");
}

function normalizeNewlines(value) {
  return String(value ?? "").replace(/\r\n?/g, "\n");
}

function isWhitespaceChar(ch) {
  return ch === " " || ch === "\t" || ch === "\n" || ch === "\r";
}

function isSafeHttpUrl(rawUrl) {
  if (!HTTP_SCHEME_RE.test(rawUrl) || hasControlChar(rawUrl)) {
    return false;
  }
  try {
    const parsed = new URL(rawUrl);
    return (
      (parsed.protocol === "http:" || parsed.protocol === "https:") &&
      parsed.hostname.length > 0
    );
  } catch {
    return false;
  }
}

function countRun(str, start, ch) {
  let end = start;
  while (end < str.length && str[end] === ch) {
    end += 1;
  }
  return end - start;
}

function matchInlineCode(text, start) {
  const tickCount = countRun(text, start, "`");
  let j = start + tickCount;
  while (j < text.length) {
    if (text[j] === "`") {
      const run = countRun(text, j, "`");
      if (run === tickCount) {
        let code = text.slice(start + tickCount, j);
        if (
          code.length >= 2 &&
          code.startsWith(" ") &&
          code.endsWith(" ") &&
          /[^ ]/.test(code)
        ) {
          code = code.slice(1, -1);
        }
        const end = j + tickCount;
        return { code, raw: text.slice(start, end), end };
      }
      j += run;
      continue;
    }
    j += 1;
  }
  return null;
}

function matchMarkdownLink(text, start) {
  if (text[start] !== "[") return null;

  let j = start + 1;
  let bracketDepth = 1;
  while (j < text.length && bracketDepth > 0) {
    if (text[j] === "`") {
      const codeMatch = matchInlineCode(text, j);
      j = codeMatch ? codeMatch.end : j + countRun(text, j, "`");
      continue;
    }
    if (text[j] === "[") {
      bracketDepth += 1;
    } else if (text[j] === "]") {
      bracketDepth -= 1;
      if (bracketDepth === 0) break;
    }
    j += 1;
  }
  if (bracketDepth !== 0) return null;

  const labelEnd = j;
  if (text[labelEnd + 1] !== "(") return null;

  let k = labelEnd + 2;
  let parenDepth = 1;
  while (k < text.length && parenDepth > 0) {
    const ch = text[k];
    if (isWhitespaceChar(ch) || isControlChar(ch)) {
      return null;
    }
    if (ch === "(") {
      parenDepth += 1;
    } else if (ch === ")") {
      parenDepth -= 1;
      if (parenDepth === 0) break;
    }
    k += 1;
  }
  if (parenDepth !== 0) return null;

  const label = text.slice(start + 1, labelEnd);
  const url = text.slice(labelEnd + 2, k);
  const end = k + 1;
  const raw = text.slice(start, end);
  if (url.length === 0) return null;

  if (isSafeHttpUrl(url) && label.trim().length > 0) {
    return { kind: "safe_link", label, url, raw, end };
  }
  if (ANY_SCHEME_RE.test(url)) {
    return { kind: "unsafe_link", raw, end };
  }
  return null;
}

function findClosingDoubleDelimiter(text, openIdx, ch) {
  const start = openIdx + 2;
  if (start >= text.length || isWhitespaceChar(text[start])) {
    return null;
  }
  if (text[start] === ch) {
    // Allow ***bold italic*** (run of 3) only for '*', never 4+ or space after.
    if (
      ch !== "*" ||
      start + 1 >= text.length ||
      text[start + 1] === "*" ||
      isWhitespaceChar(text[start + 1])
    ) {
      return null;
    }
  }

  let j = start;
  while (j < text.length) {
    if (text[j] === "`") {
      const codeMatch = matchInlineCode(text, j);
      j = codeMatch ? codeMatch.end : j + countRun(text, j, "`");
      continue;
    }
    if (text[j] === "[") {
      const linkMatch = matchMarkdownLink(text, j);
      if (linkMatch) {
        j = linkMatch.end;
        continue;
      }
    }
    if (text[j] === ch && text[j + 1] === ch) {
      const runLen = countRun(text, j, ch);
      if (runLen === 2 && j > start && !isWhitespaceChar(text[j - 1])) {
        return { innerEnd: j, end: j + 2 };
      }
      if (
        ch === "*" &&
        runLen === 3 &&
        j > start &&
        !isWhitespaceChar(text[j - 1])
      ) {
        return { innerEnd: j + 1, end: j + 3 };
      }
      j += runLen;
      continue;
    }
    j += 1;
  }
  return null;
}

function findClosingItalic(text, openIdx) {
  if (
    text[openIdx] !== "*" ||
    text[openIdx - 1] === "*" ||
    text[openIdx + 1] === "*"
  ) {
    return null;
  }
  const start = openIdx + 1;
  if (start >= text.length || isWhitespaceChar(text[start])) {
    return null;
  }

  let j = start;
  while (j < text.length) {
    if (text[j] === "`") {
      const codeMatch = matchInlineCode(text, j);
      j = codeMatch ? codeMatch.end : j + countRun(text, j, "`");
      continue;
    }
    if (text[j] === "[") {
      const linkMatch = matchMarkdownLink(text, j);
      if (linkMatch) {
        j = linkMatch.end;
        continue;
      }
    }
    if (text[j] === "*") {
      const runLen = countRun(text, j, "*");
      if (runLen > 1) {
        j += runLen;
        continue;
      }
      if (j > start && !isWhitespaceChar(text[j - 1])) {
        return { innerEnd: j, end: j + 1 };
      }
    }
    j += 1;
  }
  return null;
}

function pushTextToken(tokens, text) {
  if (text.length === 0) return;
  const last = tokens[tokens.length - 1];
  if (last && last.type === "text") {
    last.text += text;
    last.raw += text;
  } else {
    tokens.push({ type: "text", text, raw: text });
  }
}

function parseInlineTokens(
  text,
  ctx = {
    insideBold: false,
    insideItalic: false,
    insideStrike: false,
    insideLink: false,
  },
) {
  const tokens = [];
  let i = 0;

  while (i < text.length) {
    const ch = text[i];

    if (ch === "`") {
      const codeMatch = matchInlineCode(text, i);
      if (codeMatch) {
        tokens.push({
          type: "code",
          code: codeMatch.code,
          raw: codeMatch.raw,
        });
        i = codeMatch.end;
        continue;
      }
      const run = countRun(text, i, "`");
      pushTextToken(tokens, text.slice(i, i + run));
      i += run;
      continue;
    }

    if (ch === "[") {
      const linkMatch = matchMarkdownLink(text, i);
      if (linkMatch) {
        if (linkMatch.kind === "safe_link" && !ctx.insideLink) {
          tokens.push({
            type: "link",
            href: linkMatch.url,
            raw: linkMatch.raw,
            children: parseInlineTokens(linkMatch.label, {
              ...ctx,
              insideLink: true,
            }),
          });
        } else {
          // Unsafe scheme or already inside a link: render as plain escaped text, never <a>.
          pushTextToken(tokens, linkMatch.raw);
        }
        i = linkMatch.end;
        continue;
      }
      pushTextToken(tokens, "[");
      i += 1;
      continue;
    }

    if (ch === "*" && text[i + 1] === "*") {
      const boldMatch = findClosingDoubleDelimiter(text, i, "*");
      if (boldMatch) {
        const inner = text.slice(i + 2, boldMatch.innerEnd);
        const children = parseInlineTokens(inner, { ...ctx, insideBold: true });
        if (ctx.insideBold) {
          for (const child of children) tokens.push(child);
        } else {
          tokens.push({
            type: "bold",
            raw: text.slice(i, boldMatch.end),
            children,
          });
        }
        i = boldMatch.end;
        continue;
      }
      const run = countRun(text, i, "*");
      pushTextToken(tokens, text.slice(i, i + run));
      i += run;
      continue;
    }

    if (ch === "~" && text[i + 1] === "~") {
      const strikeMatch = findClosingDoubleDelimiter(text, i, "~");
      if (strikeMatch) {
        const inner = text.slice(i + 2, strikeMatch.innerEnd);
        const children = parseInlineTokens(inner, {
          ...ctx,
          insideStrike: true,
        });
        if (ctx.insideStrike) {
          for (const child of children) tokens.push(child);
        } else {
          tokens.push({
            type: "strike",
            raw: text.slice(i, strikeMatch.end),
            children,
          });
        }
        i = strikeMatch.end;
        continue;
      }
      const run = countRun(text, i, "~");
      pushTextToken(tokens, text.slice(i, i + run));
      i += run;
      continue;
    }

    if (ch === "*") {
      const italicMatch = findClosingItalic(text, i);
      if (italicMatch) {
        const inner = text.slice(i + 1, italicMatch.innerEnd);
        const children = parseInlineTokens(inner, {
          ...ctx,
          insideItalic: true,
        });
        if (ctx.insideItalic) {
          for (const child of children) tokens.push(child);
        } else {
          tokens.push({
            type: "italic",
            raw: text.slice(i, italicMatch.end),
            children,
          });
        }
        i = italicMatch.end;
        continue;
      }
      pushTextToken(tokens, "*");
      i += 1;
      continue;
    }

    pushTextToken(tokens, ch);
    i += 1;
  }

  return tokens;
}

function parseLineTokens(line) {
  const headingMatch = HEADING_RE.exec(line);
  if (headingMatch && headingMatch[1].trim().length > 0) {
    const title = headingMatch[1].trimEnd();
    return [
      {
        type: "bold",
        raw: line,
        children: parseInlineTokens(title, {
          insideBold: true,
          insideItalic: false,
          insideStrike: false,
          insideLink: false,
        }),
      },
    ];
  }

  const listMatch = LIST_ITEM_RE.exec(line);
  if (listMatch) {
    const prefix = `${listMatch[1]}• `;
    return [
      { type: "text", text: prefix, raw: prefix },
      ...parseInlineTokens(listMatch[2]),
    ];
  }

  return parseInlineTokens(line);
}

function renderTokens(tokens) {
  let out = "";
  for (const token of tokens) {
    if (token.type === "text") {
      out += escapeHtmlText(token.text);
    } else if (token.type === "code") {
      out += `<code>${escapeHtmlText(token.code)}</code>`;
    } else if (token.type === "link") {
      out += `<a href="${escapeHtmlAttr(token.href)}">${renderTokens(token.children)}</a>`;
    } else if (token.type === "bold") {
      out += `<b>${renderTokens(token.children)}</b>`;
    } else if (token.type === "italic") {
      out += `<i>${renderTokens(token.children)}</i>`;
    } else if (token.type === "strike") {
      out += `<s>${renderTokens(token.children)}</s>`;
    }
  }
  return out;
}

function parseMarkdownBlocks(normalized) {
  const lines = normalized.split("\n");
  const blocks = [];
  let leadingNewlines = "";
  let pendingBlankCount = 0;
  let i = 0;

  while (i < lines.length && lines[i].trim().length === 0) {
    leadingNewlines += i === 0 ? lines[i] : `\n${lines[i]}`;
    i += 1;
  }
  if (i > 0 && i < lines.length) {
    leadingNewlines += "\n";
  }

  while (i < lines.length) {
    if (lines[i].trim().length === 0) {
      pendingBlankCount += 1;
      i += 1;
      continue;
    }

    const sepBefore =
      blocks.length === 0 ? "" : "\n".repeat(pendingBlankCount + 1);
    pendingBlankCount = 0;

    const fenceMatch = FENCE_OPEN_RE.exec(lines[i]);
    if (fenceMatch) {
      const fence = fenceMatch[1];
      const info = fenceMatch[2];
      const fenceLen = fence.length;
      const startLine = i;
      i += 1;
      const codeLines = [];
      while (i < lines.length) {
        const closeMatch = FENCE_CLOSE_RE.exec(lines[i]);
        if (closeMatch && closeMatch[1].length >= fenceLen) {
          i += 1;
          break;
        }
        codeLines.push(lines[i]);
        i += 1;
      }
      blocks.push({
        type: "code",
        sepBefore,
        fence,
        info,
        codeLines,
        raw: lines.slice(startLine, i).join("\n"),
      });
      continue;
    }

    const paraLines = [];
    while (
      i < lines.length &&
      lines[i].trim().length > 0 &&
      !FENCE_OPEN_RE.test(lines[i])
    ) {
      paraLines.push(lines[i]);
      i += 1;
    }
    blocks.push({
      type: "paragraph",
      sepBefore,
      lines: paraLines,
      raw: paraLines.join("\n"),
    });
  }

  const trailingNewlines =
    pendingBlankCount > 0 ? "\n".repeat(pendingBlankCount) : "";
  return { leadingNewlines, trailingNewlines, blocks };
}

function renderBlockHtml(block) {
  if (block.type === "code") {
    return `${CODE_BLOCK_OPEN}${escapeHtmlText(block.codeLines.join("\n"))}${CODE_BLOCK_CLOSE}`;
  }
  return block.lines
    .map((line) => renderTokens(parseLineTokens(line)))
    .join("\n");
}

function escapedCodePointLength(ch) {
  if (ch === "&") return 5;
  if (ch === "<" || ch === ">") return 4;
  return ch.length;
}

function takePrefixForHtml(
  str,
  start,
  maxEscapedLen,
  maxPlainLen,
  { preferWordBreak = true, requireWordBreak = false } = {},
) {
  let pos = start;
  let escLen = 0;
  let plainLen = 0;
  let lastGoodPos = start;
  let lastWordBreakPos = -1;

  while (pos < str.length) {
    const cp = str.codePointAt(pos);
    const step = cp > 0xffff ? 2 : 1;
    const ch = str.slice(pos, pos + step);
    const addEsc = escapedCodePointLength(ch);
    if (escLen + addEsc > maxEscapedLen || plainLen + step > maxPlainLen) {
      break;
    }
    escLen += addEsc;
    plainLen += step;
    pos += step;
    lastGoodPos = pos;
    if (ch === " " || ch === "\t") {
      lastWordBreakPos = pos;
    }
  }

  if (pos === str.length) {
    return str.length;
  }

  if (preferWordBreak && lastWordBreakPos > start) {
    const hasVisibleBeforeBreak =
      str.slice(start, lastWordBreakPos).trim().length > 0;
    const minWordPos = start + Math.floor((lastGoodPos - start) * 0.35);
    if (
      hasVisibleBeforeBreak &&
      (requireWordBreak || lastWordBreakPos >= minWordPos)
    ) {
      return lastWordBreakPos;
    }
  }

  if (requireWordBreak) {
    return start;
  }
  return lastGoodPos;
}

function splitCodeBlock(block, limit) {
  const fullOpenPlain = `${block.fence}${block.info}\n`;
  const fullClosePlain = `\n${block.fence}`;
  let openPlain = "";
  let closePlain = "";
  if (fullOpenPlain.length + fullClosePlain.length + 1 <= limit) {
    openPlain = fullOpenPlain;
    closePlain = fullClosePlain;
  } else if (8 + 1 <= limit) {
    openPlain = "```\n";
    closePlain = "\n```";
  }

  if (limit <= CODE_BLOCK_OVERHEAD) {
    const raw = block.codeLines.join("\n");
    const pieces = [];
    let pos = 0;
    while (pos < raw.length) {
      let end = takePrefixForHtml(raw, pos, limit, limit, {
        preferWordBreak: true,
        requireWordBreak: false,
      });
      if (end <= pos) {
        const cp = raw.codePointAt(pos);
        end = pos + (cp > 0xffff ? 2 : 1);
      }
      const slice = raw.slice(pos, end);
      pieces.push({ html: escapeHtmlText(slice), plain: slice });
      pos = end;
    }
    return pieces;
  }

  const maxEscaped = limit - CODE_BLOCK_OVERHEAD;
  const maxPlain = limit - openPlain.length - closePlain.length;
  const chunks = [];
  let accLines = [];
  let accEscLen = 0;
  let accPlainLen = 0;

  const flushAcc = () => {
    if (accLines.length === 0) return;
    const raw = accLines.join("\n");
    chunks.push({
      html: `${CODE_BLOCK_OPEN}${escapeHtmlText(raw)}${CODE_BLOCK_CLOSE}`,
      plain: `${openPlain}${raw}${closePlain}`,
    });
    accLines = [];
    accEscLen = 0;
    accPlainLen = 0;
  };

  for (const codeLine of block.codeLines) {
    const lineEscLen = escapeHtmlText(codeLine).length;
    const linePlainLen = codeLine.length;
    const nl = accLines.length > 0 ? 1 : 0;

    if (
      accEscLen + nl + lineEscLen <= maxEscaped &&
      accPlainLen + nl + linePlainLen <= maxPlain
    ) {
      accLines.push(codeLine);
      accEscLen += nl + lineEscLen;
      accPlainLen += nl + linePlainLen;
      continue;
    }

    flushAcc();

    if (lineEscLen <= maxEscaped && linePlainLen <= maxPlain) {
      accLines.push(codeLine);
      accEscLen = lineEscLen;
      accPlainLen = linePlainLen;
      continue;
    }

    let pos = 0;
    while (pos < codeLine.length) {
      let end = takePrefixForHtml(codeLine, pos, maxEscaped, maxPlain, {
        preferWordBreak: true,
        requireWordBreak: false,
      });
      if (end <= pos) {
        const cp = codeLine.codePointAt(pos);
        end = pos + (cp > 0xffff ? 2 : 1);
      }
      const slice = codeLine.slice(pos, end);
      chunks.push({
        html: `${CODE_BLOCK_OPEN}${escapeHtmlText(slice)}${CODE_BLOCK_CLOSE}`,
        plain: `${openPlain}${slice}${closePlain}`,
      });
      pos = end;
    }
  }

  flushAcc();

  if (chunks.length === 0) {
    const plainEnd = takePrefixForHtml(block.raw, 0, limit, limit, {
      preferWordBreak: false,
      requireWordBreak: false,
    });
    chunks.push({
      html: `${CODE_BLOCK_OPEN}${CODE_BLOCK_CLOSE}`,
      plain: block.raw.slice(0, plainEnd),
    });
  }
  return chunks;
}

function flattenInlineTokens(tokens, wrappers = [], out = []) {
  for (const token of tokens) {
    if (token.type === "text") {
      out.push({ kind: "text", text: token.text, wrappers });
    } else if (token.type === "code") {
      out.push({ kind: "code", code: token.code, raw: token.raw, wrappers });
    } else if (token.type === "link") {
      out.push({
        kind: "link",
        html: `<a href="${escapeHtmlAttr(token.href)}">${renderTokens(token.children)}</a>`,
        plain: token.raw,
        wrappers,
      });
    } else if (token.type === "bold") {
      flattenInlineTokens(token.children, [...wrappers, "b"], out);
    } else if (token.type === "italic") {
      flattenInlineTokens(token.children, [...wrappers, "i"], out);
    } else if (token.type === "strike") {
      flattenInlineTokens(token.children, [...wrappers, "s"], out);
    }
  }
  return out;
}

function closingTagsStr(tags) {
  let out = "";
  for (let i = tags.length - 1; i >= 0; i -= 1) {
    out += `</${tags[i]}>`;
  }
  return out;
}

function tagTransition(fromTags, toTags) {
  let common = 0;
  while (
    common < fromTags.length &&
    common < toTags.length &&
    fromTags[common] === toTags[common]
  ) {
    common += 1;
  }
  const closeStr = closingTagsStr(fromTags.slice(common));
  let openStr = "";
  for (let i = common; i < toTags.length; i += 1) {
    openStr += `<${toTags[i]}>`;
  }
  return { closeStr, openStr };
}

function wrapperOverhead(tags) {
  let total = 0;
  for (const tag of tags) {
    total += tag.length * 2 + 5; // <t></t>
  }
  return total;
}

function splitOversizedLine(line, limit) {
  const items = flattenInlineTokens(parseLineTokens(line));
  const chunks = [];
  let openTags = [];
  let bodyHtml = "";
  let plainBuf = "";
  let emittedAny = false;

  const flush = () => {
    if (bodyHtml.length === 0) return;
    let trimmedHtml = bodyHtml;
    while (trimmedHtml.endsWith(" ") || trimmedHtml.endsWith("\t")) {
      trimmedHtml = trimmedHtml.slice(0, -1);
    }
    const trimmedPlain = plainBuf.trimEnd();
    if (trimmedPlain.trim().length > 0) {
      let fullHtml = trimmedHtml + closingTagsStr(openTags);
      // Guard against empty formatting wrappers left after trimming spaces.
      while (/<(b|i|s)><\/\1>/.test(fullHtml)) {
        fullHtml = fullHtml.replace(/<(b|i|s)><\/\1>/g, "");
      }
      if (fullHtml.length > 0) {
        chunks.push({ html: fullHtml, plain: trimmedPlain });
        emittedAny = true;
      }
    }
    openTags = [];
    bodyHtml = "";
    plainBuf = "";
  };

  const effectiveWrappers = (wrappers, extraMin = 5) =>
    wrapperOverhead(wrappers) + extraMin <= limit ? wrappers : [];

  const appendTextPiece = (text, wrappers, preserveLeadingSpace) => {
    let remaining = text;
    let firstPass = preserveLeadingSpace;

    while (remaining.length > 0) {
      if (bodyHtml.length === 0 && !firstPass) {
        remaining = remaining.replace(/^[ \t]+/, "");
        if (remaining.length === 0) break;
      }
      firstPass = false;

      const targetWrappers = effectiveWrappers(wrappers, 5);
      const { closeStr, openStr } = tagTransition(openTags, targetWrappers);
      const closeAtEndLen = closingTagsStr(targetWrappers).length;
      const availHtml =
        limit -
        bodyHtml.length -
        closeStr.length -
        openStr.length -
        closeAtEndLen;
      const availPlain = limit - plainBuf.length;

      if (availHtml <= 0 || availPlain <= 0) {
        if (bodyHtml.length > 0) {
          flush();
          continue;
        }
        break;
      }

      let end = takePrefixForHtml(remaining, 0, availHtml, availPlain, {
        preferWordBreak: true,
        requireWordBreak: bodyHtml.length > 0,
      });

      if (end === 0) {
        if (bodyHtml.length > 0) {
          flush();
          continue;
        }
        // Even one escaped char didn't fit on an empty chunk: take 1 code point without wrappers.
        const cp = remaining.codePointAt(0);
        end = cp > 0xffff ? 2 : 1;
        const piece = remaining.slice(0, end);
        remaining = remaining.slice(end);
        chunks.push({ html: escapeHtmlText(piece), plain: piece });
        emittedAny = true;
        continue;
      }

      const rawPiece = remaining.slice(0, end);
      remaining = remaining.slice(end);
      const piece = remaining.length > 0 ? rawPiece.trimEnd() : rawPiece;

      if (piece.length > 0) {
        if (bodyHtml.length === 0 && piece.trim().length === 0) {
          continue;
        }
        bodyHtml += closeStr + openStr + escapeHtmlText(piece);
        plainBuf += piece;
        openTags = targetWrappers;
      }

      if (remaining.length > 0) {
        flush();
      }
    }
  };

  const appendCodePiece = (code, raw, wrappers) => {
    const targetWrappers = effectiveWrappers(wrappers, 13 + 5);
    const atomicHtml = `<code>${escapeHtmlText(code)}</code>`;
    const atomicPlain = raw;

    const tryAtomic = () => {
      const { closeStr, openStr } = tagTransition(openTags, targetWrappers);
      const closeAtEndLen = closingTagsStr(targetWrappers).length;
      if (
        bodyHtml.length +
          closeStr.length +
          openStr.length +
          atomicHtml.length +
          closeAtEndLen <=
          limit &&
        plainBuf.length + atomicPlain.length <= limit
      ) {
        bodyHtml += closeStr + openStr + atomicHtml;
        plainBuf += atomicPlain;
        openTags = targetWrappers;
        return true;
      }
      return false;
    };

    if (tryAtomic()) return;
    if (bodyHtml.length > 0) {
      flush();
      if (tryAtomic()) return;
    }

    // Oversized single inline code span: split cleanly across <code>...</code> chunks.
    const codeWrapperOverhead = 13; // <code></code>
    const useCodeTag =
      wrapperOverhead(targetWrappers) + codeWrapperOverhead + 5 <= limit;
    if (!useCodeTag) {
      appendTextPiece(code, [], false);
      return;
    }

    const maxEsc =
      limit - wrapperOverhead(targetWrappers) - codeWrapperOverhead;
    const useTicksInPlain = limit >= 3;
    const maxPlain = useTicksInPlain ? limit - 2 : limit;
    const openWrappers = targetWrappers.map((t) => `<${t}>`).join("");
    const closeWrappers = closingTagsStr(targetWrappers);

    let pos = 0;
    while (pos < code.length) {
      let end = takePrefixForHtml(code, pos, maxEsc, maxPlain, {
        preferWordBreak: true,
        requireWordBreak: false,
      });
      if (end <= pos) {
        const cp = code.codePointAt(pos);
        end = pos + (cp > 0xffff ? 2 : 1);
      }
      const slice = code.slice(pos, end);
      chunks.push({
        html: `${openWrappers}<code>${escapeHtmlText(slice)}</code>${closeWrappers}`,
        plain: useTicksInPlain ? `\`${slice}\`` : slice,
      });
      emittedAny = true;
      pos = end;
    }
  };

  for (let idx = 0; idx < items.length; idx += 1) {
    const item = items[idx];
    if (item.kind === "text") {
      appendTextPiece(item.text, item.wrappers, idx === 0 && !emittedAny);
    } else if (item.kind === "code") {
      appendCodePiece(item.code, item.raw, item.wrappers);
    } else if (item.kind === "link") {
      const targetWrappers = effectiveWrappers(item.wrappers, 15);
      const tryAtomicLink = () => {
        const { closeStr, openStr } = tagTransition(openTags, targetWrappers);
        const closeAtEndLen = closingTagsStr(targetWrappers).length;
        if (
          bodyHtml.length +
            closeStr.length +
            openStr.length +
            item.html.length +
            closeAtEndLen <=
            limit &&
          plainBuf.length + item.plain.length <= limit
        ) {
          bodyHtml += closeStr + openStr + item.html;
          plainBuf += item.plain;
          openTags = targetWrappers;
          return true;
        }
        return false;
      };

      if (tryAtomicLink()) continue;
      if (bodyHtml.length > 0) {
        flush();
        if (tryAtomicLink()) continue;
      }
      // Single <a> exceeds maxLength on its own: fall back to escaped plain text.
      appendTextPiece(item.plain, item.wrappers, false);
    }
  }

  flush();
  return chunks;
}

export function markdownToTelegramHtml(text) {
  const normalized = normalizeNewlines(text);
  if (normalized.length === 0) return "";
  const { leadingNewlines, trailingNewlines, blocks } =
    parseMarkdownBlocks(normalized);
  if (blocks.length === 0) {
    return escapeHtmlText(normalized);
  }
  let out = leadingNewlines;
  for (const block of blocks) {
    out += block.sepBefore + renderBlockHtml(block);
  }
  return out + trailingNewlines;
}

export function splitTelegramHtmlChunks(text, maxLength = DEFAULT_MAX_LENGTH) {
  const normalized = normalizeNewlines(text);
  if (normalized.trim().length === 0) return [];

  const limit = Math.max(
    1,
    Math.floor(Number(maxLength) || DEFAULT_MAX_LENGTH),
  );
  const { blocks } = parseMarkdownBlocks(normalized);
  if (blocks.length === 0) return [];

  let wholeHtml = "";
  let wholePlain = "";
  for (const block of blocks) {
    wholeHtml += block.sepBefore + renderBlockHtml(block);
    wholePlain += block.sepBefore + block.raw;
  }
  if (wholeHtml.length <= limit && wholePlain.length <= limit) {
    return [{ html: wholeHtml, plain: wholePlain }];
  }

  const chunks = [];
  let curHtml = "";
  let curPlain = "";

  const flushCurrent = () => {
    if (curHtml.length > 0) {
      chunks.push({ html: curHtml, plain: curPlain });
      curHtml = "";
      curPlain = "";
    }
  };

  const tryAppend = (piece, sep) => {
    const useSep = curHtml.length > 0 ? sep : "";
    if (
      curHtml.length + useSep.length + piece.html.length <= limit &&
      curPlain.length + useSep.length + piece.plain.length <= limit
    ) {
      curHtml += useSep + piece.html;
      curPlain += useSep + piece.plain;
      return true;
    }
    return false;
  };

  for (const block of blocks) {
    const blockPiece = { html: renderBlockHtml(block), plain: block.raw };
    if (tryAppend(blockPiece, block.sepBefore)) {
      continue;
    }

    flushCurrent();

    if (tryAppend(blockPiece, "")) {
      continue;
    }

    if (block.type === "code") {
      const codeChunks = splitCodeBlock(block, limit);
      for (let i = 0; i < codeChunks.length - 1; i += 1) {
        chunks.push(codeChunks[i]);
      }
      if (codeChunks.length > 0) {
        const last = codeChunks[codeChunks.length - 1];
        curHtml = last.html;
        curPlain = last.plain;
      }
      continue;
    }

    for (let lineIdx = 0; lineIdx < block.lines.length; lineIdx += 1) {
      const line = block.lines[lineIdx];
      const linePiece = {
        html: renderTokens(parseLineTokens(line)),
        plain: line,
      };
      const sep = lineIdx === 0 ? "" : "\n";

      if (tryAppend(linePiece, sep)) {
        continue;
      }

      flushCurrent();

      if (tryAppend(linePiece, "")) {
        continue;
      }

      const lineChunks = splitOversizedLine(line, limit);
      for (let i = 0; i < lineChunks.length - 1; i += 1) {
        chunks.push(lineChunks[i]);
      }
      if (lineChunks.length > 0) {
        const last = lineChunks[lineChunks.length - 1];
        curHtml = last.html;
        curPlain = last.plain;
      }
    }
  }

  flushCurrent();
  return chunks;
}
