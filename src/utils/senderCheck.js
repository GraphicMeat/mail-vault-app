import { t } from '../i18n/index.js';
/**
 * Sender verification: checks for spoofing indicators.
 *
 * Returns: { status: 'verified'|'warning'|'danger'|'none', tooltip: string }
 */

function getDomain(email) {
  if (!email) return '';
  const parts = email.split('@');
  return (parts[1] || '').toLowerCase().trim();
}

/**
 * Parse Authentication-Results header for SPF/DKIM/DMARC results.
 */
export function parseAuthResults(header) {
  if (!header) return { spf: null, dkim: null, dmarc: null };

  const results = { spf: null, dkim: null, dmarc: null };

  const spfMatch = header.match(/\bspf=(pass|fail|softfail|neutral|none|temperror|permerror)\b/i);
  if (spfMatch) results.spf = spfMatch[1].toLowerCase();

  const dkimMatch = header.match(/\bdkim=(pass|fail|none|neutral|temperror|permerror)\b/i);
  if (dkimMatch) results.dkim = dkimMatch[1].toLowerCase();

  const dmarcMatch = header.match(/\bdmarc=(pass|fail|none|bestguesspass)\b/i);
  if (dmarcMatch) results.dmarc = dmarcMatch[1].toLowerCase();

  return results;
}

const DKIM_TAGS = [
  ['algorithm', 'a', /^[a-z0-9-]+$/, /\bheader\.a=([A-Za-z0-9-]+)/],
  ['domain', 'd', /^[a-z0-9.-]+$/, /\bheader\.d=([A-Za-z0-9.-]+)/],
  ['selector', 's', /^[a-z0-9._-]+$/, /\bheader\.s=([A-Za-z0-9._-]+)/],
];

/**
 * What the message says about its DKIM signature: algorithm (`rsa-sha256`,
 * `ed25519-sha256`), signing domain and selector. Read tag by tag from the
 * `a=; d=; s=` summary the daemon keeps of the DKIM-Signature header, else from
 * `header.a/d/s=` in Authentication-Results. Null when neither names anything.
 * The key's size is not here: it is in DNS (`dkim_key`).
 */
export function parseDkimSignature(email) {
  if (!email) return null;
  const summary = {};
  for (const part of String(email.dkimSignature || '').split(';')) {
    const [name, ...value] = part.split('=');
    summary[name.trim().toLowerCase()] = value.join('=').trim().toLowerCase();
  }
  const auth = email.authenticationResults || '';
  const out = {};
  for (const [field, tag, ok, resultsPattern] of DKIM_TAGS) {
    const own = summary[tag];
    out[field] = (own && ok.test(own) ? own : auth.match(resultsPattern)?.[1]?.toLowerCase()) || null;
  }
  return out.algorithm || out.domain || out.selector ? out : null;
}

const KEY_TYPE_NAMES = { rsa: 'RSA', ed25519: 'Ed25519', ed448: 'Ed448' };

/** A `dkim_key` answer as the popover prints it: `RSA 2048-bit`, `Ed25519 256-bit`. Empty for none or a revoked key. */
export function formatDkimKey(key) {
  if (!key || key.revoked) return '';
  const name = KEY_TYPE_NAMES[key.keyType] || key.keyType;
  return key.bits ? `${name} ${key.bits}-bit` : name;
}

/**
 * Check sender verification for an email.
 *
 * @param {object} email - EmailHeader with from, replyTo, returnPath, authenticationResults
 * @returns {{ status: 'verified'|'warning'|'danger'|'none', tooltip: string }}
 */
export function checkSenderVerification(email) {
  if (!email?.from) return { status: 'none', tooltip: '' };

  const fromAddress = (email.from.address || '').toLowerCase().trim();
  const fromDomain = getDomain(fromAddress);
  const issues = [];

  // Layer 0: Display name impersonation detection
  const fromName = (email.from.name || '').replace(/^["\\]+|["\\]+$/g, '').replace(/\\"/g, '"').trim();
  const fromNameLower = fromName.toLowerCase();
  if (fromName) {
    // Check if display name looks like an email address that differs from actual sender
    const nameIsEmail = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(fromName);
    if (nameIsEmail && fromNameLower !== fromAddress) {
      const nameDomain = getDomain(fromNameLower);
      // Allow subdomain matches (e.g., name "user@example.com" from "sub.example.com")
      const domainsRelated = nameDomain === fromDomain ||
        fromDomain.endsWith('.' + nameDomain) || nameDomain.endsWith('.' + fromDomain);
      if (!domainsRelated) {
        issues.push({
          level: 'danger',
          text: t('util.senderCheck.displayNameShowsButActual', { fromName, email: email.from.address }),
          details: { displayName: fromName, actualAddress: email.from.address, displayDomain: nameDomain, actualDomain: fromDomain },
        });
      }
    }

    // Check if display name looks like a domain (e.g., "ledger.com") that differs from sender domain
    const nameLooksDomain = /^[a-z0-9.-]+\.[a-z]{2,}$/i.test(fromNameLower);
    if (!nameIsEmail && nameLooksDomain && fromNameLower !== fromDomain) {
      // Allow subdomain matches (e.g., name "snapcraft.io" from "forum.snapcraft.io")
      const domainsRelated = fromDomain.endsWith('.' + fromNameLower) || fromNameLower.endsWith('.' + fromDomain);
      if (!domainsRelated) {
        issues.push({
          level: 'warning',
          text: t('util.senderCheck.senderNameImpersonatesDomainDiffers', { fromName, fromDomain }),
          details: { displayName: fromName, actualDomain: fromDomain },
        });
      }
    }
  }

  // Layer 1: Header mismatch detection
  // replyTo can be a single object { address } (from EmailHeader) or an array (from full Email)
  const replyToAddr = Array.isArray(email.replyTo)
    ? email.replyTo[0]?.address
    : (email.replyTo?.address || (typeof email.replyTo === 'string' ? email.replyTo : null));

  if (replyToAddr) {
    const replyToDomain = getDomain(replyToAddr);
    if (replyToDomain && replyToDomain !== fromDomain) {
      issues.push({
        level: 'warning',
        text: t('util.senderCheck.replyAddressDiffersSender', { replyToAddr }),
      });
    }
  }

  if (email.returnPath) {
    const returnPathDomain = getDomain(email.returnPath);
    if (returnPathDomain && returnPathDomain !== fromDomain) {
      issues.push({
        level: 'info',
        text: t('util.senderCheck.returnPathDomainDiffersSender', { returnPathDomain }),
      });
    }
  }

  // Layer 2: Authentication results
  const auth = parseAuthResults(email.authenticationResults);
  const hasAuthHeaders = auth.spf !== null || auth.dkim !== null || auth.dmarc !== null;

  if (hasAuthHeaders) {
    const failures = [];
    if (auth.spf === 'fail' || auth.spf === 'softfail') failures.push('SPF');
    if (auth.dkim === 'fail') failures.push('DKIM');
    if (auth.dmarc === 'fail') failures.push('DMARC');

    if (failures.length > 0) {
      issues.push({
        level: 'danger',
        text: t('util.senderCheck.senderAuthenticationFailedEmailMay', { failures: failures.join(', ') }),
      });
    }
  }

  // Determine overall status
  if (issues.some(i => i.level === 'danger')) {
    return {
      status: 'danger',
      tooltip: issues.map(i => i.text).join('\n'),
      issues,
    };
  }

  if (issues.some(i => i.level === 'warning')) {
    return {
      status: 'warning',
      tooltip: issues.map(i => i.text).join('\n'),
      issues,
    };
  }

  if (hasAuthHeaders && auth.spf === 'pass' && auth.dkim === 'pass') {
    return {
      status: 'verified',
      tooltip: t('util.senderCheck.senderVerifiedSpfDkimPass'),
      issues: [],
    };
  }

  return { status: 'none', tooltip: '', issues: [] };
}
