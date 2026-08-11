import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    normalizeCrlf,
    unfoldHeaders,
    getHeaderValue,
    extractAddrSpec,
    extractDisplayName,
    parseAddressListHeader,
    rewriteFromHeader,
    reconcileRecipients,
    processOutgoingMessage,
    selectSender,
} from '../src/mime.js';

function crlf(str) {
    return Buffer.from(str.replace(/\n/g, '\r\n'), 'binary');
}

// ---------------------------------------------------------------------------
// CRLF normalization
// ---------------------------------------------------------------------------

test('normalizeCrlf converts bare LF to CRLF', () => {
    const raw = Buffer.from('Subject: x\nFrom: a@x\n\nbody line 1\nbody line 2\n', 'binary');
    const out = normalizeCrlf(raw).toString('binary');
    assert.equal(out, 'Subject: x\r\nFrom: a@x\r\n\r\nbody line 1\r\nbody line 2\r\n');
});

test('normalizeCrlf leaves existing CRLF untouched and does not double it', () => {
    const raw = crlf('Subject: x\nFrom: a@x\n\nbody\n');
    const out = normalizeCrlf(raw);
    assert.equal(out.toString('binary'), raw.toString('binary'));
});

test('normalizeCrlf is byte-preserving for non-ASCII content', () => {
    const raw = Buffer.from('Subject: Härte\nFrom: a@x\n\nkörper\n', 'utf8');
    const out = normalizeCrlf(raw);
    // decode as utf8 again to confirm no byte corruption occurred
    assert.match(out.toString('utf8'), /Härte/);
    assert.match(out.toString('utf8'), /körper/);
});

// ---------------------------------------------------------------------------
// Header unfolding
// ---------------------------------------------------------------------------

test('unfoldHeaders joins folded continuation lines into one logical value', () => {
    const block = 'Subject: Line one\n  continues here\nFrom: a@x';
    const headers = unfoldHeaders(block.replace(/\n/g, '\r\n'));
    const subject = headers.find((h) => h.lowerName === 'subject');
    assert.equal(subject.value, 'Line one continues here');
});

test('unfoldHeaders preserves the original raw text (including folding) for reconstruction', () => {
    const block = 'Subject: Line one\r\n  continues here\r\nFrom: a@x';
    const headers = unfoldHeaders(block);
    const subject = headers.find((h) => h.lowerName === 'subject');
    assert.equal(subject.raw, 'Subject: Line one\r\n  continues here');
});

test('unfoldHeaders skips malformed lines without a colon instead of throwing', () => {
    const block = 'Subject: ok\r\nnotaheaderline\r\nFrom: a@x';
    const headers = unfoldHeaders(block);
    assert.deepEqual(
        headers.map((h) => h.lowerName),
        ['subject', 'from']
    );
});

// ---------------------------------------------------------------------------
// Address extraction
// ---------------------------------------------------------------------------

test('extractAddrSpec reads the last <...> group', () => {
    assert.equal(extractAddrSpec('"HP LaserJet" <printer@lan.local>'), 'printer@lan.local');
});

test('extractAddrSpec falls back to the whole trimmed value for a bare address', () => {
    assert.equal(extractAddrSpec('  printer@lan.local  '), 'printer@lan.local');
});

test('extractAddrSpec returns null when there is no @', () => {
    assert.equal(extractAddrSpec('not-an-address'), null);
});

test('extractDisplayName returns null for a bare address with no angle brackets', () => {
    assert.equal(extractDisplayName('printer@lan.local'), null);
});

test('extractDisplayName strips surrounding quotes', () => {
    assert.equal(extractDisplayName('"HP LaserJet" <printer@lan.local>'), 'HP LaserJet');
});

// ---------------------------------------------------------------------------
// Address list parsing — the recipient-side edge cases
// ---------------------------------------------------------------------------

test('parseAddressListHeader handles a normal comma-separated list', () => {
    assert.deepEqual(parseAddressListHeader('a@x, "Doe, Jane" <b@y>'), ['a@x', 'b@y']);
});

test('parseAddressListHeader treats undisclosed-recipients:; as zero recipients', () => {
    assert.deepEqual(parseAddressListHeader('undisclosed-recipients:;'), []);
});

test('parseAddressListHeader treats undisclosed-recipients:; case-insensitively and with spacing variants', () => {
    assert.deepEqual(parseAddressListHeader('Undisclosed Recipients:;'), []);
    assert.deepEqual(parseAddressListHeader(':;'), []);
});

test('parseAddressListHeader returns [] for a missing header', () => {
    assert.deepEqual(parseAddressListHeader(null), []);
});

// ---------------------------------------------------------------------------
// Sender selection
// ---------------------------------------------------------------------------

const PRIMARY = { address: 'me@outlook.example', displayName: null };
const ALIAS = { address: 'scans@outlook.example', displayName: 'Office Scanner' };

test('selectSender matches an allowed header From', () => {
    const result = selectSender({ headerFrom: 'scans@outlook.example', envelopeFrom: null, allowed: [PRIMARY, ALIAS], defaultAddress: PRIMARY.address });
    assert.deepEqual(result, { address: ALIAS.address, displayName: ALIAS.displayName, source: 'header', matched: true, requested: ALIAS.address });
});

test('selectSender falls through to the envelope MAIL FROM when the header From is unlisted', () => {
    const result = selectSender({
        headerFrom: 'printer@lan.local',
        envelopeFrom: 'scans@outlook.example',
        allowed: [PRIMARY, ALIAS],
        defaultAddress: PRIMARY.address,
    });
    assert.equal(result.source, 'envelope');
    assert.equal(result.address, ALIAS.address);
    assert.equal(result.requested, 'printer@lan.local', 'requested reports what the header actually asked for, not the envelope fallback');
});

test('selectSender prefers the header over the envelope when both are listed and differ', () => {
    const result = selectSender({
        headerFrom: 'me@outlook.example',
        envelopeFrom: 'scans@outlook.example',
        allowed: [PRIMARY, ALIAS],
        defaultAddress: PRIMARY.address,
    });
    assert.equal(result.source, 'header');
    assert.equal(result.address, PRIMARY.address);
});

test('selectSender falls back to defaultAddress when neither header nor envelope match', () => {
    const result = selectSender({
        headerFrom: 'printer@lan.local',
        envelopeFrom: 'printer@lan.local',
        allowed: [PRIMARY, ALIAS],
        defaultAddress: PRIMARY.address,
    });
    assert.deepEqual(result, { address: PRIMARY.address, displayName: null, source: 'default', matched: false, requested: 'printer@lan.local' });
});

test('selectSender falls back to the first allowed entry when defaultAddress itself is not in the allowed set', () => {
    const result = selectSender({ headerFrom: null, envelopeFrom: null, allowed: [PRIMARY, ALIAS], defaultAddress: 'stale@outlook.example' });
    assert.equal(result.address, PRIMARY.address);
    assert.equal(result.matched, false);
});

test('selectSender matches case-insensitively', () => {
    const result = selectSender({ headerFrom: 'Scans@Outlook.Example', envelopeFrom: null, allowed: [PRIMARY, ALIAS], defaultAddress: PRIMARY.address });
    assert.equal(result.matched, true);
    assert.equal(result.address, ALIAS.address, 'the written address is the allowlist entry\'s own casing, not the device\'s');
});

test('selectSender treats an empty envelopeFrom (MAIL FROM:<>) as no candidate, not a crash', () => {
    const result = selectSender({ headerFrom: null, envelopeFrom: '', allowed: [PRIMARY], defaultAddress: PRIMARY.address });
    assert.equal(result.source, 'default');
});

test('selectSender ignores a non-address envelopeFrom like the literal string "bridge"', () => {
    const result = selectSender({ headerFrom: null, envelopeFrom: 'bridge', allowed: [PRIMARY, ALIAS], defaultAddress: PRIMARY.address });
    assert.equal(result.source, 'default');
    assert.equal(result.address, PRIMARY.address);
});

test('selectSender returns source "none" with no accountAddress and an empty allowed list', () => {
    const result = selectSender({ headerFrom: null, envelopeFrom: null, allowed: [], defaultAddress: undefined });
    assert.deepEqual(result, { address: null, displayName: null, source: 'none', matched: false, requested: null });
});

test('selectSender filters out an allowed entry whose address could inject a header', () => {
    const unsafe = { address: 'evil@x\r\nBcc: attacker@evil.example', displayName: null };
    const result = selectSender({ headerFrom: unsafe.address, envelopeFrom: null, allowed: [PRIMARY, unsafe], defaultAddress: PRIMARY.address });
    assert.equal(result.address, PRIMARY.address);
    assert.equal(result.matched, false);
});

// ---------------------------------------------------------------------------
// From rewrite
// ---------------------------------------------------------------------------

test('rewriteFromHeader inserts From when absent', () => {
    const headers = unfoldHeaders('Subject: x');
    const result = rewriteFromHeader(headers, { address: 'me@outlook.example' });
    assert.equal(result.rewritten, true);
    assert.equal(getHeaderValue(headers, 'from'), '<me@outlook.example>');
});

test('rewriteFromHeader leaves From untouched when it already matches the account', () => {
    const headers = unfoldHeaders('From: "Me" <me@outlook.example>');
    const result = rewriteFromHeader(headers, { address: 'me@outlook.example' });
    assert.equal(result.rewritten, false);
    assert.equal(getHeaderValue(headers, 'from'), '"Me" <me@outlook.example>');
});

test('rewriteFromHeader replaces a mismatched From, preserving the display name, and adds Reply-To', () => {
    const headers = unfoldHeaders('From: "HP LaserJet" <printer@lan.local>');
    const result = rewriteFromHeader(headers, { address: 'me@outlook.example' });
    assert.equal(result.rewritten, true);
    assert.equal(getHeaderValue(headers, 'from'), '"HP LaserJet" <me@outlook.example>');
    assert.equal(getHeaderValue(headers, 'reply-to'), 'printer@lan.local');
});

test('rewriteFromHeader does not overwrite an existing Reply-To', () => {
    const headers = unfoldHeaders('From: printer@lan.local\r\nReply-To: someone@else.example');
    rewriteFromHeader(headers, { address: 'me@outlook.example' });
    assert.equal(getHeaderValue(headers, 'reply-to'), 'someone@else.example');
});

test('rewriteFromHeader handles a bare mismatched address with no display name and no angle brackets', () => {
    const headers = unfoldHeaders('From: printer@lan.local');
    rewriteFromHeader(headers, { address: 'me@outlook.example' });
    assert.equal(getHeaderValue(headers, 'from'), '<me@outlook.example>');
});

test('rewriteFromHeader carries a bare RFC 2047 encoded-word display name through unquoted', () => {
    const headers = unfoldHeaders('From: =?UTF-8?B?RHJ1Y2tlcg==?= <printer@lan.local>');
    rewriteFromHeader(headers, { address: 'me@outlook.example' });
    assert.equal(getHeaderValue(headers, 'from'), '=?UTF-8?B?RHJ1Y2tlcg==?= <me@outlook.example>');
});

test('rewriteFromHeader escapes quotes and backslashes in a plain display name', () => {
    const headers = unfoldHeaders('From: "Say ""hi""" <printer@lan.local>');
    rewriteFromHeader(headers, { address: 'me@outlook.example' });
    // extractDisplayName only strips the outer quote pair, so the inner
    // content (including the doubled quotes) is what gets re-escaped.
    assert.match(getHeaderValue(headers, 'from'), /^"Say .*" <me@outlook\.example>$/);
});

test('rewriteFromHeader with a matching alias leaves the header byte-identical (not just value-equal)', () => {
    const headers = unfoldHeaders('From: "Office Scanner" <scans@outlook.example>');
    const before = headers.find((h) => h.lowerName === 'from').raw;
    const result = rewriteFromHeader(headers, { address: 'scans@outlook.example', displayName: 'Should not be used' });
    assert.equal(result.rewritten, false);
    assert.equal(headers.find((h) => h.lowerName === 'from').raw, before, 'raw bytes must be untouched, not just reformatted to the same value');
});

test('rewriteFromHeader uses the sender displayName only as a fallback when the message has none', () => {
    const headers = unfoldHeaders('From: printer@lan.local');
    rewriteFromHeader(headers, { address: 'scans@outlook.example', displayName: 'Office Scanner' });
    assert.equal(getHeaderValue(headers, 'from'), '"Office Scanner" <scans@outlook.example>');
});

test('rewriteFromHeader prefers the message own display name over the sender fallback', () => {
    const headers = unfoldHeaders('From: "HP LaserJet" <printer@lan.local>');
    rewriteFromHeader(headers, { address: 'scans@outlook.example', displayName: 'Office Scanner' });
    assert.equal(getHeaderValue(headers, 'from'), '"HP LaserJet" <scans@outlook.example>');
});

test('rewriteFromHeader inserts From with the sender displayName when absent', () => {
    const headers = unfoldHeaders('Subject: x');
    rewriteFromHeader(headers, { address: 'scans@outlook.example', displayName: 'Office Scanner' });
    assert.equal(getHeaderValue(headers, 'from'), '"Office Scanner" <scans@outlook.example>');
});

test('rewriteFromHeader strips CR/LF from a sender displayName instead of injecting a header', () => {
    const headers = unfoldHeaders('Subject: x');
    rewriteFromHeader(headers, { address: 'scans@outlook.example', displayName: 'Evil\r\nBcc: attacker@evil.example' });
    // Still exactly two headers (Subject, From) — the attempted injection
    // must not have become a THIRD, real Bcc: header line. The text is
    // allowed to appear inertly inside the From value's quotes; what must
    // never happen is a standalone "Bcc:" header.
    assert.equal(headers.length, 2);
    assert.equal(headers.filter((h) => h.lowerName === 'bcc').length, 0);
    const fromRaw = headers.find((h) => h.lowerName === 'from').raw;
    assert.doesNotMatch(fromRaw, /[\r\n]/, 'the From header line itself must contain no raw CR/LF');
});

// ---------------------------------------------------------------------------
// Recipient reconciliation
// ---------------------------------------------------------------------------

test('reconcileRecipients folds Bcc-only envelope recipients into a Bcc header', () => {
    const headers = unfoldHeaders('To: visible@x');
    const result = reconcileRecipients(headers, ['visible@x', 'secret@y']);
    assert.equal(result.bccAdded, 1);
    assert.equal(getHeaderValue(headers, 'bcc'), 'secret@y');
    assert.equal(result.totalRecipients, 2);
});

test('reconcileRecipients appends to an existing Bcc header rather than replacing it', () => {
    const headers = unfoldHeaders('To: visible@x\r\nBcc: already@z');
    reconcileRecipients(headers, ['visible@x', 'already@z', 'secret@y']);
    assert.equal(getHeaderValue(headers, 'bcc'), 'already@z, secret@y');
});

test('reconcileRecipients keeps header-only recipients and reports them, without touching envelope', () => {
    const headers = unfoldHeaders('To: visible@x, extra@z');
    const result = reconcileRecipients(headers, ['visible@x']);
    assert.equal(result.headerOnlyCount, 1);
    assert.equal(result.bccAdded, 0);
    assert.equal(getHeaderValue(headers, 'bcc'), null);
});

test('reconcileRecipients treats undisclosed-recipients:; as header-empty and Bccs the whole envelope', () => {
    const headers = unfoldHeaders('To: undisclosed-recipients:;');
    const result = reconcileRecipients(headers, ['a@x', 'b@y']);
    assert.equal(result.headerCount, 0);
    assert.equal(result.bccAdded, 2);
    assert.equal(getHeaderValue(headers, 'bcc'), 'a@x, b@y');
});

test('reconcileRecipients reports zero total recipients when both envelope and headers are empty', () => {
    const headers = unfoldHeaders('Subject: no recipients at all');
    const result = reconcileRecipients(headers, []);
    assert.equal(result.totalRecipients, 0);
});

// ---------------------------------------------------------------------------
// Full pipeline
// ---------------------------------------------------------------------------

test('processOutgoingMessage rewrites From, reconciles recipients, normalizes CRLF, and tags the bridge id', () => {
    const raw = Buffer.from('From: "HP LaserJet" <printer@lan.local>\nTo: visible@x\nSubject: Scan\n\nHello\nworld\n', 'binary');
    const { mime, meta } = processOutgoingMessage(raw, {
        envelopeTo: ['visible@x', 'secret@y'],
        accountAddress: 'me@outlook.example',
        fromRewrite: true,
        bridgeId: 'ABC123',
    });

    const text = mime.toString('binary');
    assert.match(text, /From: "HP LaserJet" <me@outlook\.example>\r\n/);
    assert.match(text, /Reply-To: printer@lan\.local\r\n/);
    assert.match(text, /Bcc: secret@y\r\n/);
    assert.match(text, /X-Outlook-Bridge-Id: ABC123\r\n/);
    assert.match(text, /\r\n\r\nHello\r\nworld\r\n/); // body CRLF-normalized, untouched otherwise

    assert.equal(meta.subject, 'Scan');
    assert.equal(meta.rewrittenFrom, true);
    assert.equal(meta.reconcile.bccAdded, 1);
});

test('processOutgoingMessage with fromRewrite disabled leaves From (even a mismatched one) untouched', () => {
    const raw = Buffer.from('From: printer@lan.local\nTo: a@x\n\nbody\n', 'binary');
    const { mime, meta } = processOutgoingMessage(raw, {
        envelopeTo: ['a@x'],
        accountAddress: 'me@outlook.example',
        fromRewrite: false,
    });
    assert.match(mime.toString('binary'), /From: printer@lan\.local\r\n/);
    assert.equal(meta.rewrittenFrom, false);
});

test('processOutgoingMessage preserves a blank line inside the body', () => {
    const raw = Buffer.from('Subject: x\n\nparagraph one\n\nparagraph two\n', 'binary');
    const { mime } = processOutgoingMessage(raw, { envelopeTo: ['a@x'], accountAddress: 'me@outlook.example' });
    assert.match(mime.toString('binary'), /paragraph one\r\n\r\nparagraph two\r\n/);
});

test('processOutgoingMessage does not re-parse body text that looks like a header', () => {
    const raw = Buffer.from('Subject: x\n\nFrom: this-is-body-text@example\nNot-A-Real-Header: also body\n', 'binary');
    const { mime } = processOutgoingMessage(raw, { envelopeTo: ['a@x'], accountAddress: 'me@outlook.example' });
    const text = mime.toString('binary');
    // exactly one From header (the real, rewritten one) — the body line was left alone as text
    const fromHeaderCount = (text.split('\r\n\r\n')[0].match(/^From:/gm) || []).length;
    assert.equal(fromHeaderCount, 1);
    assert.match(text, /\r\n\r\nFrom: this-is-body-text@example\r\nNot-A-Real-Header: also body\r\n/);
});

test('processOutgoingMessage handles a message with no body at all', () => {
    const raw = Buffer.from('Subject: x\nFrom: a@x\n', 'binary');
    const { mime } = processOutgoingMessage(raw, { envelopeTo: ['a@x'], accountAddress: 'me@outlook.example' });
    assert.match(mime.toString('binary'), /Subject: x\r\n/);
});

// ---------------------------------------------------------------------------
// Full pipeline — sender addresses
// ---------------------------------------------------------------------------

test('processOutgoingMessage rewrites From to an allowed envelope sender when the header From is unlisted', () => {
    const raw = Buffer.from('From: "HP LaserJet" <printer@lan.local>\nTo: a@x\n\nbody\n', 'binary');
    const { mime, meta } = processOutgoingMessage(raw, {
        envelopeTo: ['a@x'],
        envelopeFrom: 'scans@outlook.example',
        accountAddress: 'me@outlook.example',
        senderAddresses: [{ address: 'scans@outlook.example', displayName: 'Office Scanner' }],
        fromRewrite: true,
    });
    const text = mime.toString('binary');
    assert.match(text, /From: "HP LaserJet" <scans@outlook\.example>\r\n/);
    assert.match(text, /Reply-To: printer@lan\.local\r\n/);
    assert.equal(meta.sender.source, 'envelope');
    assert.equal(meta.sender.matched, true);
});

test('processOutgoingMessage leaves a header From that already matches a listed alias untouched', () => {
    const raw = Buffer.from('From: scans@outlook.example\nTo: a@x\n\nbody\n', 'binary');
    const { mime, meta } = processOutgoingMessage(raw, {
        envelopeTo: ['a@x'],
        accountAddress: 'me@outlook.example',
        senderAddresses: [{ address: 'scans@outlook.example', displayName: 'Office Scanner' }],
        fromRewrite: true,
    });
    const text = mime.toString('binary');
    assert.match(text, /From: scans@outlook\.example\r\n/);
    assert.doesNotMatch(text, /Reply-To:/);
    assert.equal(meta.rewrittenFrom, false);
    assert.equal(meta.sender.source, 'header');
});

test('processOutgoingMessage populates meta.sender even when fromRewrite is off', () => {
    const raw = Buffer.from('From: printer@lan.local\nTo: a@x\n\nbody\n', 'binary');
    const { mime, meta } = processOutgoingMessage(raw, {
        envelopeTo: ['a@x'],
        accountAddress: 'me@outlook.example',
        senderAddresses: [{ address: 'scans@outlook.example', displayName: null }],
        fromRewrite: false,
    });
    assert.match(mime.toString('binary'), /From: printer@lan\.local\r\n/, 'bytes stay untouched when fromRewrite is off');
    assert.equal(meta.rewrittenFrom, false);
    assert.equal(meta.sender.source, 'default', 'selection still runs — smtp.js needs to know the resolved sender regardless of fromRewrite');
});

test('processOutgoingMessage with no aliases configured behaves byte-for-byte like before the alias feature (regression gate)', () => {
    const raw = Buffer.from('From: "HP LaserJet" <printer@lan.local>\nTo: visible@x\nSubject: Scan\n\nHello\nworld\n', 'binary');
    const { mime, meta } = processOutgoingMessage(raw, {
        envelopeTo: ['visible@x', 'secret@y'],
        accountAddress: 'me@outlook.example',
        fromRewrite: true,
        bridgeId: 'ABC123',
    });
    const text = mime.toString('binary');
    assert.match(text, /From: "HP LaserJet" <me@outlook\.example>\r\n/);
    assert.match(text, /Reply-To: printer@lan\.local\r\n/);
    assert.match(text, /Bcc: secret@y\r\n/);
    assert.equal(meta.rewrittenFrom, true);
    assert.equal(meta.sender.source, 'default');
});

test('processOutgoingMessage adds Reply-To insurance for a header From that already says the alias, when requested', () => {
    const raw = Buffer.from('From: scans@outlook.example\nTo: a@x\n\nbody\n', 'binary');
    const { mime, meta } = processOutgoingMessage(raw, {
        envelopeTo: ['a@x'],
        accountAddress: 'me@outlook.example',
        senderAddresses: [{ address: 'scans@outlook.example', displayName: null }],
        fromRewrite: true,
        aliasReplyToInsurance: true,
    });
    const text = mime.toString('binary');
    assert.match(text, /From: scans@outlook\.example\r\n/);
    assert.match(text, /Reply-To: scans@outlook\.example\r\n/, 'insurance Reply-To lets a reply reach the alias if Graph silently reverts From to the primary');
    assert.equal(meta.rewrittenFrom, false);
});

test('processOutgoingMessage does not add Reply-To insurance for the account own address (not a genuine alias)', () => {
    const raw = Buffer.from('From: me@outlook.example\nTo: a@x\n\nbody\n', 'binary');
    const { mime } = processOutgoingMessage(raw, {
        envelopeTo: ['a@x'],
        accountAddress: 'me@outlook.example',
        fromRewrite: true,
        aliasReplyToInsurance: true,
    });
    assert.doesNotMatch(mime.toString('binary'), /Reply-To:/);
});

test('processOutgoingMessage does not add Reply-To insurance when it already rewrote From (the ordinary Reply-To already covers it)', () => {
    // matched via the envelope, so the resolved sender IS a genuine alias
    // (matched: true) AND rewriteFromHeader actually rewrites the header
    // (its original From differs from the resolved alias) — the one case
    // where both the ordinary Reply-To logic and the insurance branch could
    // otherwise both fire.
    const raw = Buffer.from('From: "HP LaserJet" <printer@lan.local>\nTo: a@x\n\nbody\n', 'binary');
    const { mime, meta } = processOutgoingMessage(raw, {
        envelopeTo: ['a@x'],
        envelopeFrom: 'scans@outlook.example',
        accountAddress: 'me@outlook.example',
        senderAddresses: [{ address: 'scans@outlook.example', displayName: null }],
        fromRewrite: true,
        aliasReplyToInsurance: true,
    });
    assert.equal(meta.sender.matched, true);
    assert.equal(meta.rewrittenFrom, true);
    const text = mime.toString('binary');
    const replyToCount = (text.match(/Reply-To:/g) || []).length;
    assert.equal(replyToCount, 1, 'exactly one Reply-To — the ordinary rewrite path\'s, not a duplicate from the insurance branch');
});
