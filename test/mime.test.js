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
// From rewrite
// ---------------------------------------------------------------------------

test('rewriteFromHeader inserts From when absent', () => {
    const headers = unfoldHeaders('Subject: x');
    const result = rewriteFromHeader(headers, 'me@outlook.example');
    assert.equal(result.rewritten, true);
    assert.equal(getHeaderValue(headers, 'from'), '<me@outlook.example>');
});

test('rewriteFromHeader leaves From untouched when it already matches the account', () => {
    const headers = unfoldHeaders('From: "Me" <me@outlook.example>');
    const result = rewriteFromHeader(headers, 'me@outlook.example');
    assert.equal(result.rewritten, false);
    assert.equal(getHeaderValue(headers, 'from'), '"Me" <me@outlook.example>');
});

test('rewriteFromHeader replaces a mismatched From, preserving the display name, and adds Reply-To', () => {
    const headers = unfoldHeaders('From: "HP LaserJet" <printer@lan.local>');
    const result = rewriteFromHeader(headers, 'me@outlook.example');
    assert.equal(result.rewritten, true);
    assert.equal(getHeaderValue(headers, 'from'), '"HP LaserJet" <me@outlook.example>');
    assert.equal(getHeaderValue(headers, 'reply-to'), 'printer@lan.local');
});

test('rewriteFromHeader does not overwrite an existing Reply-To', () => {
    const headers = unfoldHeaders('From: printer@lan.local\r\nReply-To: someone@else.example');
    rewriteFromHeader(headers, 'me@outlook.example');
    assert.equal(getHeaderValue(headers, 'reply-to'), 'someone@else.example');
});

test('rewriteFromHeader handles a bare mismatched address with no display name and no angle brackets', () => {
    const headers = unfoldHeaders('From: printer@lan.local');
    rewriteFromHeader(headers, 'me@outlook.example');
    assert.equal(getHeaderValue(headers, 'from'), '<me@outlook.example>');
});

test('rewriteFromHeader carries a bare RFC 2047 encoded-word display name through unquoted', () => {
    const headers = unfoldHeaders('From: =?UTF-8?B?RHJ1Y2tlcg==?= <printer@lan.local>');
    rewriteFromHeader(headers, 'me@outlook.example');
    assert.equal(getHeaderValue(headers, 'from'), '=?UTF-8?B?RHJ1Y2tlcg==?= <me@outlook.example>');
});

test('rewriteFromHeader escapes quotes and backslashes in a plain display name', () => {
    const headers = unfoldHeaders('From: "Say ""hi""" <printer@lan.local>');
    rewriteFromHeader(headers, 'me@outlook.example');
    // extractDisplayName only strips the outer quote pair, so the inner
    // content (including the doubled quotes) is what gets re-escaped.
    assert.match(getHeaderValue(headers, 'from'), /^"Say .*" <me@outlook\.example>$/);
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
