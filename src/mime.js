// Pure functions: header parsing/folding, From rewrite, envelope/header
// recipient reconciliation, CRLF normalization. No I/O. This is the
// subtlest correctness surface in the project — see mime.test.js.

// ---------------------------------------------------------------------------
// Byte-safe string round-trip. A Buffer <-> 'binary' (latin1) string
// conversion maps each byte to one codepoint 1:1 and is fully lossless in
// both directions, for ANY byte content — including multi-byte UTF-8 text
// and true binary attachment data. We rely on this to manipulate headers as
// strings without ever risking corruption of the body or of non-ASCII
// header bytes we don't touch.
// ---------------------------------------------------------------------------

function toStr(buffer) {
    return buffer.toString('binary');
}

function toBuf(str) {
    return Buffer.from(str, 'binary');
}

// Many legacy devices emit bare LF; Exchange's MIME parser is strict about
// CRLF. Safe to apply to the whole message (not just headers): base64 and
// quoted-printable body parts are line-oriented text, so inserted CR bytes
// are ignored by any decoder. We never advertise CHUNKING/BINARYMIME, so
// SMTP already guarantees line-oriented content — true binary body parts
// are out of scope.
export function normalizeCrlf(buffer) {
    const unified = toStr(buffer).replace(/\r\n/g, '\n').replace(/\r/g, '\n').replace(/\n/g, '\r\n');
    return toBuf(unified);
}

// ---------------------------------------------------------------------------
// Header parsing
// ---------------------------------------------------------------------------

// Splits headers from body on the first blank line. Each header keeps both
// its unfolded `value` (whitespace-joined, used for parsing) and its
// original `raw` text (used for byte-identical reconstruction of headers we
// don't touch — including their original folding).
export function unfoldHeaders(headerBlock) {
    const lines = headerBlock.length ? headerBlock.split('\r\n') : [];
    const headers = [];
    for (const line of lines) {
        if (/^[ \t]/.test(line) && headers.length) {
            const prev = headers[headers.length - 1];
            prev.raw += '\r\n' + line;
            prev.value += ' ' + line.trim();
            continue;
        }
        const idx = line.indexOf(':');
        if (idx === -1) continue; // malformed line — skip defensively, never throw on bad input
        const name = line.slice(0, idx).trim();
        headers.push({ name, lowerName: name.toLowerCase(), value: line.slice(idx + 1).trim(), raw: line });
    }
    return headers;
}

export function serializeHeaders(headers) {
    return headers.map((h) => h.raw).join('\r\n');
}

export function getHeaderValue(headers, lowerName) {
    const matches = headers.filter((h) => h.lowerName === lowerName);
    return matches.length ? matches.map((h) => h.value).join(', ') : null;
}

function splitMessage(buffer) {
    const text = toStr(buffer);
    const boundary = text.indexOf('\r\n\r\n');
    return boundary === -1 ? { headerBlock: text, bodyStr: '' } : { headerBlock: text.slice(0, boundary), bodyStr: text.slice(boundary + 4) };
}

// ---------------------------------------------------------------------------
// Address parsing
// ---------------------------------------------------------------------------

// Splits a header value on top-level commas, respecting quoted strings (a
// display name like "Smith, John" <j@x> must not be split on its internal
// comma). Angle-bracket contents never legally contain an unescaped comma,
// so no separate bracket-depth tracking is needed.
function splitTopLevel(value) {
    const parts = [];
    let current = '';
    let inQuotes = false;
    for (const ch of value) {
        if (ch === '"') inQuotes = !inQuotes;
        if (ch === ',' && !inQuotes) {
            parts.push(current);
            current = '';
            continue;
        }
        current += ch;
    }
    if (current.trim() !== '') parts.push(current);
    return parts;
}

// Last `<...>` group, else the whole trimmed value if it contains an '@'.
export function extractAddrSpec(entry) {
    const trimmed = entry.trim();
    const angleMatch = trimmed.match(/<([^<>]*)>\s*$/);
    const candidate = angleMatch ? angleMatch[1].trim() : trimmed;
    if (!candidate || !candidate.includes('@')) return null;
    return candidate;
}

export function extractDisplayName(value) {
    const trimmed = value.trim();
    const angleIdx = trimmed.lastIndexOf('<');
    if (angleIdx === -1) return null; // bare address, no display name
    let name = trimmed.slice(0, angleIdx).trim();
    if (!name) return null;
    if (name.length >= 2 && name.startsWith('"') && name.endsWith('"')) name = name.slice(1, -1);
    return name || null;
}

export function normalizeAddress(addr) {
    return addr.trim().toLowerCase();
}

// Recognizes only the empty RFC 5322 group form ("undisclosed-recipients:;")
// — the one shape these devices actually emit in the wild. A group with a
// real embedded address list ("team: a@x, b@y;") is not parsed; its
// addresses would be mis-split on the group's internal commas. That's a
// deliberate, documented limitation: dumb SMTP clients don't emit that form.
const EMPTY_GROUP_RE = /^[^:]*:\s*;?\s*$/;

export function parseAddressListHeader(value) {
    if (!value) return [];
    const out = [];
    for (const segment of splitTopLevel(value)) {
        const trimmed = segment.trim();
        if (!trimmed || EMPTY_GROUP_RE.test(trimmed)) continue;
        const addr = extractAddrSpec(trimmed);
        if (addr) out.push(normalizeAddress(addr));
    }
    return out;
}

function escapeQuotedString(s) {
    return s.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

// RFC 2047 forbids encoded-words inside a quoted-string — wrapping one in
// quotes would stop mail clients from decoding it. We never decode
// encoded-words ourselves (out of scope), but we must not silently corrupt
// one either, so a bare encoded-word display name is carried through
// unquoted instead of being escaped and quoted like plain text.
const ENCODED_WORD_RE = /^(=\?[^?]+\?[BbQq]\?[^?]*\?=\s*)+$/;

// ---------------------------------------------------------------------------
// From rewrite
// ---------------------------------------------------------------------------

// Exchange always sends as the authenticated mailbox; a mismatched From
// gets ErrorSendAsDenied (confirmed against the live API, not just docs).
// Preserves the original display name so "HP LaserJet" still shows up in
// the inbox, and adds Reply-To only if the message doesn't already have one.
export function rewriteFromHeader(headers, accountAddress) {
    const fromIdx = headers.findIndex((h) => h.lowerName === 'from');

    if (fromIdx === -1) {
        headers.unshift({ name: 'From', lowerName: 'from', value: `<${accountAddress}>`, raw: `From: <${accountAddress}>` });
        return { rewritten: true };
    }

    const original = headers[fromIdx];
    const addr = extractAddrSpec(original.value);
    if (addr && normalizeAddress(addr) === normalizeAddress(accountAddress)) {
        return { rewritten: false };
    }

    const displayName = extractDisplayName(original.value);
    const newValue = displayName
        ? ENCODED_WORD_RE.test(displayName)
            ? `${displayName} <${accountAddress}>`
            : `"${escapeQuotedString(displayName)}" <${accountAddress}>`
        : `<${accountAddress}>`;
    headers[fromIdx] = { name: 'From', lowerName: 'from', value: newValue, raw: `From: ${newValue}` };

    if (addr && !headers.some((h) => h.lowerName === 'reply-to')) {
        headers.splice(fromIdx + 1, 0, { name: 'Reply-To', lowerName: 'reply-to', value: addr, raw: `Reply-To: ${addr}` });
    }

    return { rewritten: true };
}

// ---------------------------------------------------------------------------
// Recipient reconciliation
// ---------------------------------------------------------------------------

// Graph derives recipients from MIME headers, not the SMTP envelope. A
// Bcc-only send (RCPT TO addresses that appear in no header) would
// otherwise deliver to nobody with a silent 202 Accepted. E \ H is folded
// into a Bcc header (Exchange strips Bcc on send, so this is exactly Bcc
// semantics); H \ E is left alone and reported, since stripping it would
// violate what the message itself says it wants to do.
export function reconcileRecipients(headers, envelopeTo) {
    const headerAddrs = new Set([
        ...parseAddressListHeader(getHeaderValue(headers, 'to')),
        ...parseAddressListHeader(getHeaderValue(headers, 'cc')),
        ...parseAddressListHeader(getHeaderValue(headers, 'bcc')),
    ]);
    const envelopeAddrs = new Set(envelopeTo.map(normalizeAddress));

    const envelopeOnly = [...envelopeAddrs].filter((a) => !headerAddrs.has(a));
    const headerOnly = [...headerAddrs].filter((a) => !envelopeAddrs.has(a));

    if (envelopeOnly.length) {
        const bccIdx = headers.findIndex((h) => h.lowerName === 'bcc');
        const existing = bccIdx !== -1 ? headers[bccIdx].value.trim() : '';
        const combined = [existing, envelopeOnly.join(', ')].filter(Boolean).join(', ');
        const header = { name: 'Bcc', lowerName: 'bcc', value: combined, raw: `Bcc: ${combined}` };
        if (bccIdx !== -1) headers[bccIdx] = header;
        else headers.push(header);
    }

    return {
        envelopeCount: envelopeAddrs.size,
        headerCount: headerAddrs.size,
        bccAdded: envelopeOnly.length,
        headerOnlyCount: headerOnly.length,
        totalRecipients: new Set([...headerAddrs, ...envelopeAddrs]).size,
    };
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

// rawBuffer: the message exactly as received over SMTP DATA.
// envelopeTo: RCPT TO addresses for this message.
// accountAddress: the connected Outlook account's send-as address.
// fromRewrite: settings.fromRewrite — false passes From through untouched.
// bridgeId: spool message id, added as X-Outlook-Bridge-Id for traceability.
export function processOutgoingMessage(rawBuffer, { envelopeTo, accountAddress, fromRewrite = true, bridgeId }) {
    const normalized = normalizeCrlf(rawBuffer);
    const { headerBlock, bodyStr } = splitMessage(normalized);
    const headers = unfoldHeaders(headerBlock);

    const subject = getHeaderValue(headers, 'subject');
    const originalFrom = getHeaderValue(headers, 'from');

    let rewrittenFrom = false;
    if (fromRewrite && accountAddress) {
        rewrittenFrom = rewriteFromHeader(headers, accountAddress).rewritten;
    }

    const reconcile = reconcileRecipients(headers, envelopeTo);

    if (bridgeId) {
        headers.push({ name: 'X-Outlook-Bridge-Id', lowerName: 'x-outlook-bridge-id', value: bridgeId, raw: `X-Outlook-Bridge-Id: ${bridgeId}` });
    }

    const finalText = serializeHeaders(headers) + '\r\n\r\n' + bodyStr;
    return {
        mime: toBuf(finalText),
        meta: { headerFrom: originalFrom, subject, rewrittenFrom, reconcile },
    };
}
